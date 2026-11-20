// ============================================================
// 26 竞答游戏 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：群里 /quiz 开局，Bot 逐题发题+选项按钮，第一个答对的人得分
// 自动出下一题；全部答完（或 /stopquiz 提前结束）公布本场排名。
// 每场得分会累计进赛季总榜，/quiztop 随时看。
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET、ADMIN_ID（管理员可强制结束任何一场）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV
// （键：quiz:<会话ID> 存进行中的场次；quizpts:<用户ID> 存赛季总分）。
// 换题库：改下面 CONFIG 的 QUESTIONS 数组即可（answer 是正确选项下标，从 0 数）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

// ==================== 在这里改题库 ====================
const QUESTIONS = [
  {
    q: "地球上最大的海洋是？",
    options: ["大西洋", "太平洋", "印度洋", "北冰洋"],
    answer: 1,
  },
  { q: "水的化学式是？", options: ["CO2", "O2", "H2O", "NaCl"], answer: 2 },
  {
    q: "中国最长的河流是？",
    options: ["黄河", "珠江", "黑龙江", "长江"],
    answer: 3,
  },
  { q: "1 + 2 × 3 = ？", options: ["9", "7", "6", "5"], answer: 1 },
  {
    q: "比特币的创始人化名是？",
    options: ["中本聪", "V 神", "马斯克", "孙宇晨"],
    answer: 0,
  },
  { q: "一年有多少个节气？", options: ["12", "20", "24", "36"], answer: 2 },
  {
    q: "光速约为每秒多少公里？",
    options: ["3 万", "30 万", "300 万", "15 万"],
    answer: 1,
  },
  {
    q: "《西游记》的作者一般认为是？",
    options: ["罗贯中", "施耐庵", "吴承恩", "曹雪芹"],
    answer: 2,
  },
];
const POINTS_PER_QUESTION = 10; // 每答对一题得分
// ==================== 题库区结束 ====================

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
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】竞答场次与赛季榜存储（KV）
// quiz:<会话ID> = { idx, scores:{uid:{name,pts}}, wrong:{uid:[下标]}, starter }
// quizpts:<用户ID> = { name, pts } 赛季累计，/quiztop 时全量扫描排序。
// ============================================================
async function getSession(env, chatId) {
  const raw = await env.BOT_KV.get("quiz:" + chatId);
  return raw ? JSON.parse(raw) : null;
}
async function putSession(env, chatId, s) {
  await env.BOT_KV.put("quiz:" + chatId, JSON.stringify(s));
}
async function addSeasonPoints(env, user, pts) {
  const raw = await env.BOT_KV.get("quizpts:" + user.id);
  const rec = raw ? JSON.parse(raw) : { name: who(user), pts: 0 };
  rec.pts += pts;
  rec.name = who(user);
  await env.BOT_KV.put("quizpts:" + user.id, JSON.stringify(rec));
}
function questionText(s) {
  const q = QUESTIONS[s.idx];
  return `🧠 第 ${s.idx + 1}/${QUESTIONS.length} 题\n\n${q.q}`;
}
const questionKb = (s) => ({
  inline_keyboard: QUESTIONS[s.idx].options.map((o, i) => [
    { text: o, callback_data: `quiz:${i}` },
  ]),
});
function rankText(scores, title) {
  const rows = Object.values(scores).sort((a, b) => b.pts - a.pts);
  if (!rows.length) return `${title}\n（无人得分）`;
  return (
    title +
    "\n" +
    rows.map((r, i) => `${i + 1}. ${r.name} — ${r.pts} 分`).join("\n")
  );
}

// ============================================================
// 【核心模块】出题与计分引擎
// sendQuestion 发当前题；finishSession 结算：公布本场排名并把分数并入赛季榜。
// ============================================================
async function sendQuestion(env, chatId, s) {
  const r = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: questionText(s),
    reply_markup: questionKb(s),
  });
  if (r.ok) {
    s.msgId = r.result.message_id;
    await putSession(env, chatId, s);
  }
}
async function finishSession(env, chatId, s, reason) {
  await env.BOT_KV.delete("quiz:" + chatId);
  for (const [uid, rec] of Object.entries(s.scores))
    await addSeasonPoints(env, { id: uid, first_name: rec.name }, rec.pts);
  return send(
    env,
    chatId,
    `🏁 本场竞答结束（${reason}）！\n\n${rankText(s.scores, "🏆 本场排名")}\n\n赛季总榜发 /quiztop 查看。`,
  );
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "quiz", description: "开始竞答" },
  { command: "stopquiz", description: "结束本场竞答" },
  { command: "quiztop", description: "竞答总榜" },
  { command: "start", description: "使用说明" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("quiz-game bot is running.", {
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
      const cm = await tg(env, "setMyCommands", { commands: COMMANDS });
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
// /quiz 开局 -> 按钮答题（quiz: 前缀，答对者得分并推进）-> 自然结束或 /stopquiz 结算；/quiztop 查赛季榜。
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

  // ---------- 答题按钮 ----------
  const cq = update.callback_query;
  if (cq) {
    if (!String(cq.data || "").startsWith("quiz:")) return;
    const chatId = cq.message.chat.id;
    const s = await getSession(env, chatId);
    if (!s)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这场竞答已经结束了",
        show_alert: true,
      });
    if (cq.message.message_id !== s.msgId)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这是上一题，已经作废啦",
      });
    const pick = Number(cq.data.slice(5));
    const q = QUESTIONS[s.idx];
    if (pick === q.answer) {
      const rec = s.scores[cq.from.id] || { name: who(cq.from), pts: 0 };
      rec.pts += POINTS_PER_QUESTION;
      rec.name = who(cq.from);
      s.scores[cq.from.id] = rec;
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `🎉 答对了！+${POINTS_PER_QUESTION} 分`,
      });
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: s.msgId,
        text:
          questionText(s) +
          `\n\n✅ ${who(cq.from)} 抢答成功：${q.options[q.answer]}`,
      });
      s.idx++;
      s.wrong = {};
      if (s.idx >= QUESTIONS.length)
        return finishSession(env, chatId, s, "全部题目答完");
      await putSession(env, chatId, s);
      return sendQuestion(env, chatId, s);
    }
    // 答错：记下这个人试过的选项，防止无脑穷举
    s.wrong = s.wrong || {};
    const tried = s.wrong[cq.from.id] || [];
    if (tried.includes(pick))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这个选项你已经试过啦",
      });
    tried.push(pick);
    s.wrong[cq.from.id] = tried;
    await putSession(env, chatId, s);
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "❌ 不对，再想想（机会留给手快的人）",
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  if (cmd === "/quiz") {
    if (await getSession(env, chatId))
      return send(
        env,
        chatId,
        "本群已有一场竞答在进行中，先打完或 /stopquiz 结束它。",
      );
    const s = { idx: 0, scores: {}, wrong: {}, starter: msg.from.id, msgId: 0 };
    await putSession(env, chatId, s);
    await send(
      env,
      chatId,
      `🧠 竞答开始！共 ${QUESTIONS.length} 题，每题第一个答对 +${POINTS_PER_QUESTION} 分，点按钮抢答。`,
    );
    return sendQuestion(env, chatId, s);
  }
  if (cmd === "/stopquiz") {
    const s = await getSession(env, chatId);
    if (!s) return send(env, chatId, "现在没有进行中的竞答。");
    if (s.starter !== msg.from.id && !admins(env).includes(String(msg.from.id)))
      return send(env, chatId, "只有开局的人或管理员能提前结束。");
    return finishSession(env, chatId, s, "提前结束");
  }
  if (cmd === "/quiztop") {
    const list = await env.BOT_KV.list({ prefix: "quizpts:", limit: 200 });
    const rows = [];
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (raw) rows.push(JSON.parse(raw));
    }
    rows.sort((a, b) => b.pts - a.pts);
    if (!rows.length)
      return send(env, chatId, "赛季榜还是空的，来 /quiz 开一局。");
    return send(
      env,
      chatId,
      "🏆 竞答赛季总榜 Top 10\n\n" +
        rows
          .slice(0, 10)
          .map((r, i) => `${i + 1}. ${r.name} — ${r.pts} 分`)
          .join("\n"),
    );
  }
  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🧠 竞答游戏 Bot\n/quiz 开一局（群里玩最热闹）\n/stopquiz 提前结束并结算\n/quiztop 赛季总榜\n第一个答对的人得分，答错的选项不能重复试。",
    );
}
