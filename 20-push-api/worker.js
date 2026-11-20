// ============================================================
// 20 消息推送 API Bot（单文件 · Cloudflare Workers · 无需 KV）
// 玩法：给你的服务器/脚本/自动化一个「往 Telegram 发消息」的网址接口，
// 类似 Server酱 / Bark 的 TG 版：curl 一下，消息就到你的 TG。
// 接口（PUSH_KEY 是你自己设的密钥，URL 里带 key，别泄露）：
// GET https://你的Worker地址/push?key=PUSH_KEY&text=内容
// POST https://你的Worker地址/push?key=PUSH_KEY
// JSON: { "text": "内容", "chat_id": 可选, "parse_mode": "Markdown" 可选}
// chat_id 不填默认发给你自己（DEFAULT_CHAT_ID 或第一个管理员 ADMIN_ID）。
// 想推到群：把 Bot 拉进群，用群的 -100 ID 当 chat_id（先在群里发 /id 查）。
// 必填变量：BOT_TOKEN（Secret）、PUSH_KEY（Secret，自己编一串长的）
// 选填：ADMIN_ID、DEFAULT_CHAT_ID、WEBHOOK_SECRET
// Bot 命令：/start 看自己的推送网址 · /id 查当前会话 ID
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 安全：PUSH_KEY 等于发消息权限，泄露了就改变量值换新；别把带 key 的
// 网址贴到公开仓库/截图里。
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
const defaultChat = (env) =>
  env.DEFAULT_CHAT_ID ||
  String(env.ADMIN_ID || "")
    .split(",")[0]
    .trim();

// ============================================================
// 【核心模块】推送接口（HTTP API）
// 校验 key -> 解析 GET 参数或 POST JSON -> 转发 sendMessage，脚本/服务器告警都走这里。
// ============================================================
async function handlePush(request, env, url) {
  if (!env.PUSH_KEY)
    return Response.json(
      { ok: false, error: "PUSH_KEY 未配置" },
      { status: 500 },
    );
  let body = {};
  if (request.method === "POST") body = await request.json().catch(() => ({}));
  const key = url.searchParams.get("key") || body.key;
  if (key !== env.PUSH_KEY)
    return Response.json({ ok: false, error: "key 不对" }, { status: 403 });
  const text = body.text || url.searchParams.get("text") || "";
  const chatId =
    body.chat_id || url.searchParams.get("chat_id") || defaultChat(env);
  if (!text)
    return Response.json({ ok: false, error: "text 为空" }, { status: 400 });
  if (!chatId)
    return Response.json(
      {
        ok: false,
        error:
          "没配默认 chat：填 DEFAULT_CHAT_ID 或 ADMIN_ID，或请求里带 chat_id",
      },
      { status: 400 },
    );
  const payload = { chat_id: chatId, text: String(text).slice(0, 4000) };
  const pm = body.parse_mode || url.searchParams.get("parse_mode");
  if (pm) payload.parse_mode = pm;
  const r = await tg(env, "sendMessage", payload);
  return Response.json(
    {
      ok: !!r.ok,
      telegram: r.ok
        ? { message_id: r.result?.message_id, chat: r.result?.chat?.id }
        : r,
    },
    { status: r.ok ? 200 : 502 },
  );
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 一个 Worker 两个入口：/push 走推送接口，/webhook 走 Bot 命令，互不干扰。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "start", description: "我的推送网址" },
  { command: "id", description: "查当前会话 ID" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("push-api bot is running.", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname === "/push") return handlePush(request, env, url);
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
    ctx.waitUntil(handle(env, update, url.origin));
    return new Response("ok");
  },
};

// ============================================================
// 【核心模块】业务主流程
// 只做两件事：告诉用户他自己的推送网址、报当前会话 ID（配群推送时用）。
// ============================================================
async function handle(env, update, origin) {
  const msg = update.message;
  if (!msg) return;
  const text = msg.text || "";
  if (text.startsWith("/id"))
    return send(
      env,
      msg.chat.id,
      `本会话 chat_id：${msg.chat.id}\n你的用户 ID：${msg.from.id}`,
    );
  if (text.startsWith("/start")) {
    const mine = `${origin}/push?key=${env.PUSH_KEY || "你的PUSH_KEY"}&chat_id=${msg.chat.id}&text=`;
    return send(
      env,
      msg.chat.id,
      `📮 你的专属推送网址（GET 请求即可发消息到这里）：\n${mine}测试消息\n\n示例：curl "${mine}服务器告警"\nPOST JSON 也支持：{"text":"内容","chat_id":${msg.chat.id}}\n\n⚠️ 网址里带密钥，别外传；泄露就去 Worker 改 PUSH_KEY 变量。`,
    );
  }
}
