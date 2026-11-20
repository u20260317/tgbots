// ============================================================
// 59 长文 / 频道总结 Bot（单文件 · Cloudflare Workers，无需 KV）
// 功能：把长内容压成一段摘要（TL;DR）：
// · 私聊发文章链接 → 安全抓取正文 → LLM 总结；
// · 私聊发长文本（或转发来的频道帖）→ 直接总结文本；
// · 群里回复任意长消息发 /tldr → 总结那条消息（带链接的先抓链接）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// AI_API_KEY 大模型 API 的 Key（Secret，OpenAI 兼容口径）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// AI_API_BASE 默认 https://api.openai.com/v1
// AI_MODEL 默认 gpt-4o-mini
// ⚠️ 没配 AI_API_KEY 时只会明确提示「未配置」，不会编造摘要。
// 抓取层带 SSRF 拦截（与 44 同口径）；抓不到正文（付费墙/纯 JS 页）会如实说明。
// 拼装来源：模块 40（安全抓取）+ 模块 25（LLM 客户端）+ 模块 01（骨架）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
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
// 长回复分段发送：Telegram 单条上限 4096 字符。
async function sendLong(env, chatId, text) {
  let rest = String(text);
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf("\n", 4000);
    if (cut < 1000) cut = 4000;
    await send(env, chatId, rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) await send(env, chatId, rest);
}
const NOT_CONFIGURED =
  "⚠️ 本 Bot 还没配置大模型 API（需要管理员设置 AI_API_KEY），暂时总结不了。";

// ============================================================
// 安全抓取 + 正文提取（复用 44 的 SSRF 口径）
// 只许 http/https 公网地址；抓回 HTML 后剥掉 script/style/nav 等噪声，
// 去标签、解实体、压空白，得到纯文本。纯 JS 渲染的页面抓不到正文，
// 提取结果过短时如实报错，不硬凑。
// ============================================================
function isSafePublicUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (
    /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fe80"))
    return false;
  return true;
}
function extractText(html) {
  let s = String(html);
  s = s.replace(
    /<(script|style|nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi,
    " ",
  );
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function fetchArticle(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; tgbots-summarizer/1.0)",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("源站返回 " + r.status);
  const html = await r.text();
  const text = extractText(html);
  if (text.length < 200)
    throw new Error("没抓到正文（可能是付费墙、登录墙或纯 JS 渲染页面）");
  return text.slice(0, 60000);
}
function firstUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>"')]+/);
  return m ? m[0] : null;
}

// ============================================================
// LLM 总结（map-reduce 分段摘要）
// 短文一次总结完；长文先按约 6000 字切段、各段出小结（map），
// 再把小结们拼起来做终版总结（reduce）——单次调用装不下长文时
// 唯一不丢信息的办法，代价是多花几次调用，注释在此说明取舍。
// ============================================================
async function chatLLM(env, system, user) {
  const base = (env.AI_API_BASE || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await r.json().catch(() => ({}));
  const reply = data?.choices?.[0]?.message?.content;
  if (!r.ok || !reply)
    throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return reply;
}
const SUMMARY_RULE =
  "你是摘要助手。用中文输出：第一行一句话总览；然后 3-6 条要点，每条一行、以「· 」开头；最后一行「⚠️ 注意：」加一句最值得注意的点。只依据原文，不编造。";
async function summarize(env, text) {
  if (text.length <= 7000) return chatLLM(env, SUMMARY_RULE, text);
  const chunks = [];
  for (let i = 0; i < text.length; i += 6000)
    chunks.push(text.slice(i, i + 6000));
  const partials = [];
  for (const c of chunks)
    partials.push(
      await chatLLM(
        env,
        "你是摘要助手。用中文把这一段压成 5 句以内的小结，只依据原文。",
        c,
      ),
    );
  return chatLLM(env, SUMMARY_RULE, partials.join("\n\n"));
}

// 管理员白名单与分级命令菜单（本 Bot 无管理员命令，菜单模块照常保留）
const COMMANDS_USER = [
  { command: "tldr", description: "回复一条消息总结它" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  return tg(env, "setMyCommands", { commands: COMMANDS_USER });
}

// ============================================================
// Worker 入口与路由
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("summarizer bot is running.", {
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
        allowed_updates: ["message"],
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

// 统一处理：一份「待总结的文本」走完抓取（若是链接）→ 总结 → 分段发送。
async function runSummarize(env, chatId, rawText) {
  if (!env.AI_API_KEY) return send(env, chatId, NOT_CONFIGURED);
  const url = firstUrl(rawText);
  let content = rawText;
  if (url) {
    if (!isSafePublicUrl(url))
      return send(env, chatId, "⚠️ 这个链接不是可抓取的公网地址，已拒绝。");
    await send(env, chatId, "🔎 正在抓取正文…");
    try {
      content = await fetchArticle(url);
    } catch (e) {
      return send(
        env,
        chatId,
        `⚠️ 抓取失败：${e.message}。可以直接把正文粘贴给我总结。`,
      );
    }
  }
  if (!content || content.trim().length < 100)
    return send(
      env,
      chatId,
      "内容太短了，没什么可总结的（至少发 100 字以上或文章链接）。",
    );
  await send(env, chatId, "✍️ 正在总结…");
  try {
    const out = await summarize(env, content);
    return sendLong(env, chatId, "📝 摘要\n\n" + out);
  } catch (e) {
    return send(env, chatId, `⚠️ 总结失败：${e.message}`);
  }
}

// ============================================================
// 业务主流程
// 私聊：链接/长文本/转发帖都直接总结；群聊：只认 /tldr 回复，避免刷屏。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "📝 长文总结 Bot\n\n私聊把文章链接或长文本发给我，我出摘要；转发频道帖给我也行。\n群里：回复任意一条长消息发 /tldr，我总结那条。",
    );

  if (cmd === "/tldr") {
    const target = msg.reply_to_message;
    if (!target)
      return send(
        env,
        chatId,
        "用法：回复一条长消息（或带链接的消息），再发 /tldr。",
      );
    const t = (target.text || target.caption || "").trim();
    if (!t) return send(env, chatId, "被回复的那条没有可总结的文字。");
    return runSummarize(env, chatId, t);
  }
  if (cmd.startsWith("/")) return;

  if (msg.chat.type === "private") {
    if (firstUrl(text) || text.length >= 300)
      return runSummarize(env, chatId, text);
    return send(
      env,
      chatId,
      "把文章链接或长文本（300 字以上）发给我，我帮你总结。",
    );
  }
  // 群里被转发进来的频道长帖且 @ 了 Bot 的情况不自动处理，避免打扰；只认 /tldr。
}
