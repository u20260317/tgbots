// ============================================================
// 19 投票问卷 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：用 /poll 一行命令在群里/私聊发起按钮投票，票数实时刷在消息上，
// 可改票；加 anon 前缀发匿名投票（只显示票数不显示谁投了谁）。
// 发起人发 /closepoll 投票ID 截止，Bot 公布最终结果。
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET、ADMIN_ID（管理员也能截止任何投票）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（键：poll:<投票ID>）。
// 用法：
// /poll 今晚吃什么|火锅|烧烤|面条
// /poll anon 周末团建去哪|爬山|露营 （匿名）
// /closepoll 投票ID （截止并公布，ID 在投票消息里）
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 说明：这是自研按钮投票（可改票、可匿名、可跨群统计），和 Telegram 原生
// Poll 的区别是数据在自己 KV 里，能截止公布、防重复计票逻辑可控。
// ============================================================

// ============================================================
// 【核心模块】Telegram Bot API 通信层
// 统一封装 tg()：所有给 Telegram 发的请求都走这里，改 API 地址/加重试只改这一处。
// ============================================================
async function tg(env, method, payload) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return r.json().catch(() => ({}));
}
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】投票存储（KV）
// poll:<投票ID> = { q, options:[], votes:{ 用户ID:选项下标}, anon, closed, creator, chat}
// 一人一票靠 votes 的键去重；改票就是覆盖下标。
// ============================================================
async function getPoll(env, id) {
  const raw = await env.BOT_KV.get("poll:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function putPoll(env, id, poll) {
  await env.BOT_KV.put("poll:" + id, JSON.stringify(poll));
}
function tally(poll) {
  const counts = poll.options.map(() => 0);
  for (const idx of Object.values(poll.votes))
    counts[idx] = (counts[idx] || 0) + 1;
  return counts;
}
function pollText(id, poll) {
  const counts = tally(poll);
  const total = counts.reduce((a, b) => a + b, 0);
  const lines = poll.options.map((o, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    return `${o} — ${counts[i]} 票（${pct}%）${"█".repeat(Math.round(pct / 10))}`;
  });
  let voters = "";
  if (!poll.anon && !poll.closed) {
    const names = Object.entries(poll.votes)
      .slice(0, 15)
      .map(([uid, idx]) => `${poll.names?.[uid] || uid}→${poll.options[idx]}`);
    if (names.length)
      voters = `\n\n最近投票：${names.join("、")}${Object.keys(poll.votes).length > 15 ? " …" : ""}`;
  }
  return (
    `🗳 ${poll.q}${poll.anon ? "（匿名）" : ""}\n\n${lines.join("\n")}\n\n共 ${total} 票 · 投票 ID ${id}${poll.closed ? " · 已截止" : " · 点按钮投票，可改票"}` +
    voters
  );
}
function pollKb(id, poll) {
  if (poll.closed) return { inline_keyboard: [] };
  return {
    inline_keyboard: poll.options.map((o, i) => [
      { text: o, callback_data: `vote:${id}:${i}` },
    ]),
  };
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ============================================================
// 【核心模块】管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
//   · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
//   · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
//     于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
//     的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "poll", description: "发起投票" },
  { command: "closepoll", description: "截止投票" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  // 先注册默认菜单（所有人可见的用户命令）
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  // 再给白名单里每个管理员单独注册全集菜单（只在他私聊里生效）
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    const ids = String(env.ADMIN_ID || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const id of ids) {
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
    }
  }
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("poll-vote bot is running.", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname === "/setWebhook") {
      if (
        !env.WEBHOOK_SECRET ||
        url.searchParams.get("key") !== env.WEBHOOK_SECRET
      )
        return new Response("forbidden", { status: 403 });
      const hook = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", {
        url: hook,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      const cm = await registerCommands(env);
      return Response.json({ setWebhook: hook, telegram: r, commands: cm });
    }
    if (url.pathname !== "/webhook" || request.method !== "POST")
      return new Response("not found", { status: 404 });
    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("x-telegram-bot-api-secret-token") !==
        env.WEBHOOK_SECRET
    )
      return new Response("forbidden", { status: 403 });
    const update = await request.json().catch(() => ({}));
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};

// ============================================================
// 【核心模块】业务主流程
// 发起（/poll 解析竖线分隔）-> 按钮投票（vote: 改票覆盖）-> 截止公布（/closepoll）。
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) {
    const m = update.message;
    if (m)
      return send(
        env,
        m.chat.id,
        "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。",
      );
    return;
  }
  const cq = update.callback_query;
  if (cq) {
    const parts = String(cq.data || "").split(":");
    if (parts[0] !== "vote") return;
    const [, pollId, idxStr] = parts;
    const poll = await getPoll(env, pollId);
    if (!poll || poll.closed)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "投票不存在或已截止",
        show_alert: true,
      });
    poll.votes[cq.from.id] = Number(idxStr);
    poll.names = poll.names || {};
    poll.names[cq.from.id] = who(cq.from);
    await putPoll(env, pollId, poll);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `已投：${poll.options[Number(idxStr)]}`,
    });
    return tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: pollText(pollId, poll),
      reply_markup: pollKb(pollId, poll),
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/poll") {
    let body = text.replace(/^\/poll(@\w+)?\s*/, "");
    const anon = /^anon\s+/i.test(body);
    if (anon) body = body.replace(/^anon\s+/i, "");
    const parts = body
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 3)
      return send(
        env,
        msg.chat.id,
        "用法：/poll 问题|选项1|选项2（2~10 个选项）\n匿名：/poll anon 问题|选项1|选项2",
      );
    if (parts.length > 11) return send(env, msg.chat.id, "选项最多 10 个。");
    const id = newId();
    const poll = {
      q: parts[0],
      options: parts.slice(1),
      votes: {},
      names: {},
      anon,
      closed: false,
      creator: msg.from.id,
      chat: msg.chat.id,
    };
    await putPoll(env, id, poll);
    return tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: pollText(id, poll),
      reply_markup: pollKb(id, poll),
    });
  }
  if (cmd === "/closepoll") {
    const id = text.split(/\s+/)[1];
    const poll = id && (await getPoll(env, id));
    if (!poll) return send(env, msg.chat.id, "用法：/closepoll 投票ID");
    if (
      poll.creator !== msg.from.id &&
      !admins(env).includes(String(msg.from.id))
    )
      return send(env, msg.chat.id, "只有发起人或管理员能截止这个投票。");
    poll.closed = true;
    await putPoll(env, id, poll);
    const counts = tally(poll);
    const best = Math.max(...counts);
    const winners = poll.options.filter(
      (o, i) => counts[i] === best && best > 0,
    );
    return send(
      env,
      msg.chat.id,
      `🏁 投票截止！\n\n${pollText(id, poll)}\n\n${winners.length ? `🏆 最高票：${winners.join("、")}（${best} 票）` : "无人投票。"}`,
    );
  }
  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      msg.chat.id,
      "🗳 投票 Bot\n发起：/poll 问题|选项1|选项2\n匿名：/poll anon 问题|选项1|选项2\n截止：/closepoll 投票ID\n点按钮投票，可改票，票数实时更新。",
    );
}
