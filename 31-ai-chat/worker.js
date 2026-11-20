// ============================================================
// 31 AI 聊天 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 接 OpenAI 兼容接口（/chat/completions）的大模型聊天 Bot：
// 私聊发任意文本直接对话，带 per-user 上下文记忆（存 KV）；
// /persona 切换人设（预置 + 自定义），/reset 清空上下文，
// 每人每日用量上限防刷爆 API 额度；群里用 /ask 提问或回复 Bot 消息续聊。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// AI_API_KEY 大模型 API Key（Secret）
// 选填：
// AI_API_BASE 接口基地址，默认 https://api.openai.com/v1（任何 OpenAI 兼容服务均可，如各家厂商/中转的兼容端点）
// AI_MODEL 模型名，默认 gpt-4o-mini
// AI_PERSONA 默认人设（system prompt），不填用内置默认
// AI_DAILY_LIMIT 每人每日最多对话轮数，默认 50
// AI_MAX_TURNS 上下文保留轮数（一问一答算一轮），默认 10
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（看 /aistats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：ai:<用户ID> 存上下文与当前人设；ai:usage:<用户ID>:<日期> 存当日用量。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 25（AI 对话）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const dayKey = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 人设库（CONFIG）
// 预置人设：key 是 /persona 后的名字，value 是 system prompt。
// 想加人设往这里加一行即可；用户也可以 /persona set <文本> 存自己的。
// ============================================================
const PERSONAS = {
  默认: "你是一个友善、简洁的中文 AI 助手，回答问题先给结论，再给必要细节。",
  毒舌: "你是一个毒舌但心善的 AI，说话犀利幽默，吐槽归吐槽，答案必须靠谱。",
  老师: "你是一位耐心的老师，善于把复杂问题拆成小步，用生活例子讲解，最后出一道小练习。",
  程序员:
    "你是一位资深程序员，只聊技术：给代码先给思路，代码带注释，指出边界情况和坑。",
  翻译官:
    "你是翻译官：用户发中文你译成英文，发英文你译成中文，只输出译文，不解释。",
};
const DEFAULT_PERSONA = "默认";

// ============================================================
// 上下文与用量存储（KV）
// ai:<用户ID> = { persona:"当前人设名或自定义文本", custom:bool, msgs:[{role,content}]}
// ai:usage:<用户ID>:<YYYY-MM-DD> = 当日已用轮数（字符串数字，次日自然换键）
// ============================================================
async function getCtx(env, userId) {
  const raw = await env.BOT_KV.get("ai:" + userId);
  return raw ? JSON.parse(raw) : { persona: null, custom: false, msgs: [] };
}
async function saveCtx(env, userId, ctx) {
  await env.BOT_KV.put("ai:" + userId, JSON.stringify(ctx));
}
async function getUsage(env, userId) {
  const raw = await env.BOT_KV.get(`ai:usage:${userId}:${dayKey()}`);
  return Number(raw) || 0;
}
async function bumpUsage(env, userId) {
  const key = `ai:usage:${userId}:${dayKey()}`;
  const n = (Number(await env.BOT_KV.get(key)) || 0) + 1;
  await env.BOT_KV.put(key, String(n), { expirationTtl: 172800 });
  return n;
}
function personaPrompt(ctx, env) {
  if (ctx.persona && ctx.custom) return ctx.persona;
  if (ctx.persona && PERSONAS[ctx.persona]) return PERSONAS[ctx.persona];
  return env.AI_PERSONA || PERSONAS[DEFAULT_PERSONA];
}
function personaName(ctx) {
  if (!ctx.persona) return DEFAULT_PERSONA;
  return ctx.custom ? "自定义" : ctx.persona;
}

// ============================================================
// 大模型调用（OpenAI 兼容）
// POST {AI_API_BASE}/chat/completions，messages = 人设 + 历史 + 本轮问题。
// 历史按 AI_MAX_TURNS 截断（一轮 = user+assistant 两条），控 token 也控成本。
// ============================================================
async function chatAI(env, ctx, userText) {
  const base = (env.AI_API_BASE || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const maxMsgs = (Number(env.AI_MAX_TURNS) || 10) * 2;
  const history = ctx.msgs.slice(-maxMsgs);
  const messages = [
    { role: "system", content: personaPrompt(ctx, env) },
    ...history,
    { role: "user", content: userText },
  ];
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "gpt-4o-mini",
      messages,
    }),
  });
  const data = await r.json().catch(() => ({}));
  const reply = data?.choices?.[0]?.message?.content;
  if (!r.ok || !reply)
    throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return { reply, history };
}

// 长回复分段发送：Telegram 单条上限 4096 字符，按段切开逐条发。
async function sendLong(env, chatId, text, extra = {}) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf("\n", 4000);
    if (cut < 1000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  for (const c of chunks) await send(env, chatId, c, extra);
}

// ============================================================
// 管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
// · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
// · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
// 于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
// 的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "ask", description: "向 AI 提问（群里用）" },
  { command: "persona", description: "查看/切换人设" },
  { command: "reset", description: "清空对话上下文" },
  { command: "me", description: "我今日的用量" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "aistats", description: "今日用量统计（管理员）" },
];
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

// ============================================================
// Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("ai-chat bot is running.", {
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
// 业务主流程
// 私聊文本=直接对话；群里只认 /ask 和回复 Bot 的消息，避免刷屏烧额度。
// 回调前缀 ai: 只管人设选择按钮（与模块 25 注册一致）。
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

  // ---------- 人设选择按钮 ----------
  const cq = update.callback_query;
  if (cq) {
    if (!String(cq.data || "").startsWith("ai:")) return;
    const name = cq.data.slice(3);
    const ctx = await getCtx(env, cq.from.id);
    if (name === "reset") {
      ctx.msgs = [];
      await saveCtx(env, cq.from.id, ctx);
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🧹 上下文已清空",
      });
    }
    if (PERSONAS[name]) {
      ctx.persona = name;
      ctx.custom = false;
      ctx.msgs = [];
      await saveCtx(env, cq.from.id, ctx);
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `🎭 已切换人设：${name}（上下文已清空）`,
      });
    }
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === "private";

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🤖 AI 聊天 Bot\n\n私聊直接发消息就能聊，我会记住上下文。\n/persona 切换人设 · /reset 清空上下文 · /me 看今日用量\n群里请用 /ask 你的问题，或回复我的消息继续聊。",
    );

  // ---------- 用量 ----------
  if (cmd === "/me") {
    const used = await getUsage(env, msg.from.id);
    const limit = Number(env.AI_DAILY_LIMIT) || 50;
    const ctx = await getCtx(env, msg.from.id);
    return send(
      env,
      chatId,
      `🧾 ${who(msg.from)}\n今日已用：${used}/${limit} 轮\n当前人设：${personaName(ctx)}\n上下文：${Math.floor(ctx.msgs.length / 2)} 轮`,
    );
  }

  // ---------- 人设 ----------
  if (cmd === "/persona") {
    const arg = text.replace(/^\/persona(@\w+)?\s*/, "").trim();
    const ctx = await getCtx(env, msg.from.id);
    if (!arg) {
      const kb = Object.keys(PERSONAS).map((n) => [
        {
          text: (n === personaName(ctx) ? "✅ " : "🎭 ") + n,
          callback_data: `ai:${n}`,
        },
      ]);
      kb.push([{ text: "🧹 清空上下文", callback_data: "ai:reset" }]);
      return send(
        env,
        chatId,
        `当前人设：${personaName(ctx)}\n点按钮切换（切换会清空上下文），或：\n/persona set <自定义人设文本>`,
        { reply_markup: { inline_keyboard: kb } },
      );
    }
    if (arg.startsWith("set ")) {
      ctx.persona = arg.slice(4).trim().slice(0, 500);
      ctx.custom = true;
      ctx.msgs = [];
      await saveCtx(env, msg.from.id, ctx);
      return send(env, chatId, "🎭 自定义人设已保存，上下文已清空，开始聊吧。");
    }
    if (PERSONAS[arg]) {
      ctx.persona = arg;
      ctx.custom = false;
      ctx.msgs = [];
      await saveCtx(env, msg.from.id, ctx);
      return send(env, chatId, `🎭 已切换人设：${arg}（上下文已清空）`);
    }
    return send(
      env,
      chatId,
      `没有这个人设。可选：${Object.keys(PERSONAS).join("、")}，或 /persona set <文本> 自定义。`,
    );
  }

  // ---------- 清空上下文 ----------
  if (cmd === "/reset") {
    const ctx = await getCtx(env, msg.from.id);
    ctx.msgs = [];
    await saveCtx(env, msg.from.id, ctx);
    return send(env, chatId, "🧹 上下文已清空，我们重新开始。");
  }

  // ---------- 用量统计（管理员） ----------
  if (cmd === "/aistats") {
    if (!isAdmin(env, msg.from.id))
      return send(env, chatId, "⛔ 只有管理员能看统计。");
    const prefix = `ai:usage:`;
    const list = await env.BOT_KV.list({ prefix, limit: 1000 });
    const today = dayKey();
    let users = 0,
      total = 0;
    for (const k of list.keys) {
      if (!k.name.endsWith(":" + today)) continue;
      total += Number(await env.BOT_KV.get(k.name)) || 0;
      users++;
    }
    return send(
      env,
      chatId,
      `📊 今日 AI 用量\n活跃用户：${users}\n总轮数：${total}\n模型：${env.AI_MODEL || "gpt-4o-mini"}`,
    );
  }

  // ---------- 对话 ----------
  let question = null;
  if (cmd === "/ask") question = text.replace(/^\/ask(@\w+)?\s*/, "").trim();
  else if (isPrivate && !text.startsWith("/")) question = text;
  else if (
    !isPrivate &&
    msg.reply_to_message &&
    msg.reply_to_message.from &&
    msg.reply_to_message.from.is_bot
  )
    question = text;
  if (question === null) return;
  if (!question) return send(env, chatId, "用法：/ask 你的问题");
  if (!env.AI_API_KEY)
    return send(env, chatId, "⚠️ 管理员还没配置 AI_API_KEY，暂时聊不了。");

  const limit = Number(env.AI_DAILY_LIMIT) || 50;
  const used = await getUsage(env, msg.from.id);
  if (used >= limit)
    return send(
      env,
      chatId,
      `🚫 今天已经聊了 ${limit} 轮，达到上限啦，明天再来。`,
    );

  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(
    () => {},
  );
  const ctx = await getCtx(env, msg.from.id);
  try {
    const { reply, history } = await chatAI(env, ctx, question);
    ctx.msgs = [
      ...history,
      { role: "user", content: question },
      { role: "assistant", content: reply },
    ];
    await saveCtx(env, msg.from.id, ctx);
    await bumpUsage(env, msg.from.id);
    return sendLong(env, chatId, reply, {
      reply_to_message_id: isPrivate ? undefined : msg.message_id,
    });
  } catch (e) {
    return send(
      env,
      chatId,
      `😵 AI 接口出错了：${String(e.message || e).slice(0, 200)}\n稍后再试，或让管理员检查 AI_API_BASE / AI_API_KEY / AI_MODEL。`,
    );
  }
}
