// ============================================================
// 22 群活跃统计 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：Bot 在群里默默数数——每日消息量、发言人数、话痨榜、进退群人数，
// /stats 看今日，/stats7 看近 7 天汇总。群运营复盘用。
// 必填变量：BOT_TOKEN（Secret）
// 选填：TZ_OFFSET（按哪个时区切「天」，默认 8）、WEBHOOK_SECRET
// ⚠️ 需要 KV：变量名 BOT_KV（键：stats:<群ID>:<日期>，每条自动 35 天过期）。
// ⚠️ 必须关隐私模式：BotFather /mybots → Bot Settings → Group Privacy →
// Turn off，否则 Bot 只收得到命令和回复，数不全。关完把 Bot 移出群再拉回。
// 命令（群里发）：/stats 今日 · /stats7 近 7 天 · /mystats 我今天说了几句
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
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
const dayKey = (env, back = 0) =>
  new Date(
    Date.now() +
      (Number(env.TZ_OFFSET) || 8) * 3600 * 1000 -
      back * 86400 * 1000,
  )
    .toISOString()
    .slice(0, 10);
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】统计存储（KV）
// stats:<群ID>:<日期> = { msgs, users:{ uid:{name,count}}, joins, leaves}
// 按天分键方便 /stats7 聚合；写入时带 35 天 TTL，旧数据自动清不占地方。
// ============================================================
async function getDay(env, chatId, day) {
  const raw = await env.BOT_KV.get(`stats:${chatId}:${day}`);
  return raw ? JSON.parse(raw) : { msgs: 0, users: {}, joins: 0, leaves: 0 };
}
async function bumpDay(env, chatId, day, fn) {
  const key = `stats:${chatId}:${day}`;
  const d = await getDay(env, chatId, day);
  fn(d);
  await env.BOT_KV.put(key, JSON.stringify(d), {
    expirationTtl: 35 * 24 * 3600,
  });
  return d;
}
function topTalkers(d, n = 5) {
  return Object.values(d.users)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ============================================================
// 【核心模块】Worker 入口与路由
// allowed_updates 含 chat_member，进退群计数靠它（Bot 在群里即可，不需管理员）。
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
  { command: "stats", description: "今日群统计" },
  { command: "stats7", description: "近 7 天群统计" },
  { command: "mystats", description: "我今天发了几条" },
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
      return new Response("group-stats bot is running.", {
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
        allowed_updates: ["message", "chat_member"],
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
// 每条群消息计数（命令除外也计入总消息但单独处理查询）、成员进退计数、三个查询命令。
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) return;
  const cm = update.chat_member;
  if (cm && ["group", "supergroup"].includes(cm.chat.type)) {
    const was = cm.old_chat_member?.status,
      now = cm.new_chat_member?.status;
    const day = dayKey(env);
    if (["left", "kicked"].includes(was || "left") && now === "member")
      await bumpDay(env, cm.chat.id, day, (d) => {
        d.joins++;
      });
    else if (was === "member" && ["left", "kicked"].includes(now))
      await bumpDay(env, cm.chat.id, day, (d) => {
        d.leaves++;
      });
    return;
  }
  const msg = update.message;
  if (!msg || !msg.from || msg.from.is_bot) return;
  if (!["group", "supergroup"].includes(msg.chat.type)) {
    if ((msg.text || "").startsWith("/start"))
      return send(
        env,
        msg.chat.id,
        "📊 群活跃统计 Bot：把我拉进群（并在 BotFather 关掉我的 Group Privacy），我负责数数，群里发 /stats 看报表。",
      );
    return;
  }
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const day = dayKey(env);

  // 查询命令先答，再计数（把命令本身也算一条消息，统计口径简单一致）
  if (cmd === "/mystats") {
    const d = await getDay(env, msg.chat.id, day);
    const mine = d.users[msg.from.id]?.count || 0;
    await send(
      env,
      msg.chat.id,
      `📊 你今天在本群发了 ${mine} 条（全群共 ${d.msgs} 条）。`,
    );
  } else if (cmd === "/stats" || cmd === "/stats7") {
    if (cmd === "/stats") {
      const d = await getDay(env, msg.chat.id, day);
      const top = topTalkers(d);
      await send(
        env,
        msg.chat.id,
        `📊 本群今日（${day}）\n消息：${d.msgs} 条 · 发言人数：${Object.keys(d.users).length}\n进群：${d.joins} · 退群：${d.leaves}\n\n🗣 话痨榜：\n${top.length ? top.map((u, i) => `${i + 1}. ${u.name} — ${u.count} 条`).join("\n") : "（暂无）"}`,
      );
    } else {
      const agg = { msgs: 0, joins: 0, leaves: 0, users: {} };
      for (let i = 0; i < 7; i++) {
        const d = await getDay(env, msg.chat.id, dayKey(env, i));
        agg.msgs += d.msgs;
        agg.joins += d.joins;
        agg.leaves += d.leaves;
        for (const [uid, u] of Object.entries(d.users)) {
          agg.users[uid] = agg.users[uid] || { name: u.name, count: 0 };
          agg.users[uid].count += u.count;
        }
      }
      const top = topTalkers(agg);
      await send(
        env,
        msg.chat.id,
        `📊 本群近 7 天\n消息：${agg.msgs} 条 · 活跃人数：${Object.keys(agg.users).length}\n进群：${agg.joins} · 退群：${agg.leaves} · 净增：${agg.joins - agg.leaves}\n\n🗣 话痨榜：\n${top.length ? top.map((u, i) => `${i + 1}. ${u.name} — ${u.count} 条`).join("\n") : "（暂无）"}`,
      );
    }
  }

  await bumpDay(env, msg.chat.id, day, (d) => {
    d.msgs++;
    const u = d.users[msg.from.id] || { name: who(msg.from), count: 0 };
    u.count++;
    u.name = who(msg.from);
    d.users[msg.from.id] = u;
  });
}
