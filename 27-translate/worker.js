// ============================================================
// 27 翻译 Bot（单文件 · Cloudflare Workers · 无需 KV）
// 玩法：私聊直接发文字就自动互译（含中文→英文，其它语言→中文）；
// /fy 可指定目标语言；群里回复一条消息发 /fy，把那条翻译成中文。
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET
// 用法：
// 私聊发任意文字 自动互译
// /fy en 你好世界 指定翻成英文（en/ja/ko/fr/de/es/ru 等语言代码）
// /fy 一段外文 不带语言代码时按自动互译规则
// 群里：回复某条消息 + /fy 翻成中文（/fy en 则翻成英文）
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ⚠️ 翻译走 Google 翻译的非官方免费接口（client=gtx），无 Key、免费用，
// 但不是官方 API：随时可能限流或失效，失效时可换其它翻译源，见 README。
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
const hasChinese = (s) => /[\u4e00-\u9fff]/.test(s);

// ============================================================
// 【核心模块】翻译引擎（Google 免费接口）
// translate_a/single?client=gtx 返回分段数组，拼起来即全文；顺带返回检测到的源语言。
// ============================================================
async function translate(text, target) {
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || !Array.isArray(data[0])) return null;
  const out = data[0].map((seg) => seg[0] || "").join("");
  return { text: out, from: data[2] || "auto" };
}
const autoTarget = (text) => (hasChinese(text) ? "en" : "zh-CN");
async function doTranslate(env, chatId, text, target, replyTo) {
  const t = await translate(text, target);
  if (!t)
    return send(
      env,
      chatId,
      "😢 翻译接口暂时不可用（非官方免费接口，可能被限流），稍后再试。",
    );
  const extra = replyTo ? { reply_to_message_id: replyTo } : {};
  return send(env, chatId, `🌐 [${t.from} → ${target}]\n${t.text}`, extra);
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("translate bot is running.", {
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
      return Response.json({ setWebhook: hook, telegram: r });
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
// /fy 解析可选语言代码+文本；群里优先翻译被回复的消息；私聊非命令文字直接自动互译。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const chatId = msg.chat.id;
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/fy") {
    const rest = text.replace(/^\/fy(@\w+)?\s*/, "");
    const m = rest.match(/^([a-z]{2}(?:-[A-Za-z]{2})?)\s+([\s\S]+)$/);
    const target = m ? m[1] : null;
    const body = m ? m[2] : rest;
    // 群里回复消息：翻译被回复的那条
    const replied =
      msg.reply_to_message &&
      (msg.reply_to_message.text || msg.reply_to_message.caption);
    if (replied)
      return doTranslate(
        env,
        chatId,
        replied,
        target || "zh-CN",
        msg.reply_to_message.message_id,
      );
    if (!body)
      return send(
        env,
        chatId,
        "用法：/fy [语言代码] 文本，如 /fy en 你好；或在群里回复一条消息发 /fy。",
      );
    return doTranslate(env, chatId, body, target || autoTarget(body));
  }
  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🌐 翻译 Bot\n私聊直接发文字：中文→英文，其它→中文，自动判断。\n/fy en 文本 指定目标语言（en/ja/ko/fr/de/es/ru…）\n群里回复一条消息发 /fy 即可翻译它。",
    );
  if (text.startsWith("/")) return;
  // 私聊普通文字：自动互译；群里不主动插话（只认 /fy）
  if (msg.chat.type === "private")
    return doTranslate(env, chatId, text, autoTarget(text));
}
