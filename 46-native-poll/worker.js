// ============================================================
// 46 原生 Poll/Quiz 与反应 Bot（单文件 · Cloudflare Workers · 需绑定 KV）
// 功能：
// 全部用 Telegram 原生件：/poll 发原生投票、/quiz 发原生竞答
// （correct_option_id + 解析 + 限时），poll_answer 回流记分、
// /qrank 出排行榜；/like 让 Bot 给消息挂反应，群里消息的反应
// 变化被动计数（react:），/likecount 查某条消息的反应统计。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（记分与反应计数用；
// 只发投票不记分的话可以不绑，但本模板默认全功能，按绑 KV 部署）。
// ⚠️ allowed_updates 要含 poll / poll_answer / message_reaction，
// /setWebhook 时已自动带上；反应计数还要求 Bot 是群管理员。
// 键设计（模块 38 注册约定）：npoll:<poll_id> 题目登记、qpts:<用户ID>
// 竞答成绩、react:<群ID>:<消息ID> 反应计数。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 38（原生 Poll/Quiz 与反应）+ 模块 01（骨架）+ 模块 02（分级菜单）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
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

// ============================================================
// 原生投票与 Quiz 竞答（sendPoll）
// options 必须是 InputPollOption 对象数组（{text}），不是字符串。
// Quiz：type:"quiz" + correct_option_id（从 0 数）+ explanation 解析，
// open_period 到点自动关；要靠 poll_answer 记名排行就不能匿名。
// 发完立刻把 { correct, chatId} 登记进 npoll:<poll_id>，答题回流靠它对答案。
// ============================================================
async function sendVotePoll(env, chatId, question, options) {
  const r = await tg(env, "sendPoll", {
    chat_id: chatId,
    question,
    options: options.map((text) => ({ text })),
    is_anonymous: true,
    allows_multiple_answers: false,
  });
  if (r.ok)
    await registerPoll(env, r.result.poll.id, {
      chatId,
      question,
      quiz: false,
    });
  return r;
}
async function sendQuizPoll(
  env,
  chatId,
  { question, options, correct, explanation, seconds = 60 },
) {
  const r = await tg(env, "sendPoll", {
    chat_id: chatId,
    question,
    options: options.map((text) => ({ text })),
    type: "quiz",
    correct_option_id: correct,
    explanation: explanation || undefined,
    open_period: seconds,
    is_anonymous: false,
  });
  if (r.ok)
    await registerPoll(env, r.result.poll.id, {
      chatId,
      question,
      quiz: true,
      correct,
    });
  return r;
}
async function registerPoll(env, pollId, rec) {
  if (env.BOT_KV)
    await env.BOT_KV.put("npoll:" + pollId, JSON.stringify(rec), {
      expirationTtl: 7 * 86400,
    });
}

// ============================================================
// poll_answer 回流记分
// update.poll_answer = { poll_id, user, option_ids}。对错由 Bot 拿
// npoll 登记的 correct 比对；成绩存 qpts:<用户ID>（纯数字，与 13 的
// pts: 分开记账不串味）。答对 +1，答错不扣。
// ============================================================
async function onPollAnswer(env, pa) {
  if (!env.BOT_KV || !pa.user) return;
  const raw = await env.BOT_KV.get("npoll:" + pa.poll_id);
  if (!raw) return;
  const rec = JSON.parse(raw);
  if (!rec.quiz) return;
  const right = pa.option_ids[0] === rec.correct;
  const key = "qpts:" + pa.user.id;
  const score = Number((await env.BOT_KV.get(key)) || 0) + (right ? 1 : 0);
  await env.BOT_KV.put(key, String(score));
}

// ============================================================
// 消息反应：Bot 点赞 + 被动计数
// setMessageReaction 是「设置」语义：传数组替换、传空数组收回。
// message_reaction 更新（Bot 为群管理员才收得到）按新旧差值计数，
// 聚合存 react:<群ID>:<消息ID> = { emoji: 次数}。
// ============================================================
async function botLike(env, chatId, messageId, emoji = "❤️") {
  return tg(env, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
}
async function onMessageReaction(env, mr) {
  if (!env.BOT_KV) return;
  const key = `react:${mr.chat.id}:${mr.message_id}`;
  const counts = JSON.parse((await env.BOT_KV.get(key)) || "{}");
  const tally = (list, delta) => {
    for (const r of list || [])
      if (r.type === "emoji") counts[r.emoji] = (counts[r.emoji] || 0) + delta;
  };
  tally(mr.new_reaction, +1);
  tally(mr.old_reaction, -1);
  for (const k of Object.keys(counts)) if (counts[k] <= 0) delete counts[k];
  await env.BOT_KV.put(key, JSON.stringify(counts));
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 无管理员命令，COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "poll", description: "发原生投票：/poll 问题 | 选项 | 选项" },
  { command: "quiz", description: "发原生竞答：/quiz 问题 | 答案序号 | 选项…" },
  { command: "qrank", description: "竞答排行榜" },
  { command: "like", description: "回复消息：Bot 给它点个 ❤️" },
  { command: "likecount", description: "回复消息：查它的反应统计" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    const ids = String(env.ADMIN_ID || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const id of ids)
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// allowed_updates 显式带上 poll / poll_answer / message_reaction，
// 默认收不到这三类更新——这是原生件最常见的「没反应」原因。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("native-poll bot is running.", {
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
        allowed_updates: [
          "message",
          "callback_query",
          "poll",
          "poll_answer",
          "message_reaction",
        ],
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
// 业务主流程
// 四路更新：message（命令）、poll_answer（记分）、message_reaction
// （计数）、poll（关闭时播报结果）。
// ============================================================
async function handle(env, update) {
  if (update.poll_answer) return onPollAnswer(env, update.poll_answer);
  if (update.message_reaction)
    return onMessageReaction(env, update.message_reaction);
  if (update.poll && update.poll.is_closed && env.BOT_KV) {
    const raw = await env.BOT_KV.get("npoll:" + update.poll.id);
    if (!raw) return;
    const rec = JSON.parse(raw);
    const total = update.poll.total_voter_count;
    const lines = update.poll.options
      .map((o) => `· ${o.text}：${o.voter_count} 票`)
      .join("\n");
    return send(
      env,
      rec.chatId,
      `📊 「${update.poll.question}」已结束，共 ${total} 人参与：\n${lines}`,
    );
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const body = text.replace(/^\/\w+(@\w+)?\s*/, "");

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🗳️ 原生投票/竞答 Bot（全用 Telegram 原生件）\n\n/poll 问题 | 选项1 | 选项2（匿名投票）\n/quiz 问题 | 答案序号 | 选项1 | 选项2 | 解析（竞答，序号从 1 数；最后一格可写解析）\n/qrank 竞答排行榜\n回复一条消息发 /like，我给它挂个 ❤️；/likecount 查这条消息的反应统计（需我当群管理员）",
    );

  if (cmd === "/poll") {
    const parts = body
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length < 3)
      return send(
        env,
        chatId,
        "格式：/poll 问题 | 选项1 | 选项2（选项 2-10 个）",
      );
    const r = await sendVotePoll(
      env,
      chatId,
      parts[0].slice(0, 300),
      parts.slice(1, 11),
    );
    if (!r.ok)
      return send(env, chatId, "😵 发起失败：" + (r.description || ""));
    return;
  }

  if (cmd === "/quiz") {
    const parts = body.split("|").map((x) => x.trim());
    // 格式：问题 | 答案序号 | 选项1 | 选项2 [| 选项3...] [| 解析:xxx]
    let explanation = "";
    if (parts.length > 3 && /^解析[:：]/.test(parts[parts.length - 1]))
      explanation = parts.pop().replace(/^解析[:：]/, "");
    const correct = Number(parts[1]) - 1;
    const options = parts.slice(2, 12);
    if (
      !parts[0] ||
      !(correct >= 0) ||
      options.length < 2 ||
      correct >= options.length
    )
      return send(
        env,
        chatId,
        "格式：/quiz 问题 | 答案序号(从1数) | 选项1 | 选项2 …（可再加一格「解析:说明」）",
      );
    const r = await sendQuizPoll(env, chatId, {
      question: parts[0].slice(0, 300),
      options,
      correct,
      explanation,
    });
    if (!r.ok)
      return send(env, chatId, "😵 发起失败：" + (r.description || ""));
    return;
  }

  if (cmd === "/qrank") {
    if (!env.BOT_KV) return send(env, chatId, "⚠️ 未绑定 KV，没有成绩记录。");
    const list = await env.BOT_KV.list({ prefix: "qpts:", limit: 1000 });
    const rows = [];
    for (const k of list.keys) {
      const v = Number((await env.BOT_KV.get(k.name)) || 0);
      if (v > 0) rows.push({ uid: k.name.slice(5), score: v });
    }
    rows.sort((a, b) => b.score - a.score);
    if (!rows.length)
      return send(env, chatId, "还没有竞答成绩，先发一道 /quiz 吧。");
    return send(
      env,
      chatId,
      "🏆 竞答排行榜（答对 +1）\n\n" +
        rows
          .slice(0, 10)
          .map((r, i) => `${i + 1}. 用户 ${r.uid} — ${r.score} 分`)
          .join("\n"),
    );
  }

  if (cmd === "/like") {
    const target = msg.reply_to_message;
    if (!target) return send(env, chatId, "回复一条消息再发 /like。");
    const r = await botLike(env, chatId, target.message_id);
    if (!r.ok)
      return send(
        env,
        chatId,
        "😵 挂反应失败：" + (r.description || "可能这个 emoji 在本群被禁用"),
      );
    return;
  }

  if (cmd === "/likecount") {
    const target = msg.reply_to_message;
    if (!target) return send(env, chatId, "回复一条消息再发 /likecount。");
    if (!env.BOT_KV) return send(env, chatId, "⚠️ 未绑定 KV，没有反应统计。");
    const counts = JSON.parse(
      (await env.BOT_KV.get(`react:${chatId}:${target.message_id}`)) || "{}",
    );
    const entries = Object.entries(counts);
    if (!entries.length)
      return send(
        env,
        chatId,
        "这条消息还没有被我记录到的反应变化（我得是群管理员才能收到反应更新）。",
      );
    return send(
      env,
      chatId,
      "📈 这条消息的反应统计：\n" +
        entries.map(([e, n]) => `${e} × ${n}`).join("\n"),
    );
  }
}
