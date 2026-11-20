// ============================================================
// 08 ID 查询工具 Bot（单文件 · Cloudflare Workers）
// 配置其它 Bot 时到处要填「我的数字 ID / 频道 ID / 群 ID / file_id」，这个就是干这个的：
//   私聊 /id           -> 你的用户 ID
//   群里 /id           -> 本群 ID + 你的 ID（Bot 需在群里）
//   转发一条消息给 Bot  -> 原作者/原频道 ID（对方开隐私保护时显示其公开信息）
//   发图片/文件/贴纸给 Bot -> 该文件的 file_id
//   /json              -> 回复一条消息时用，返回那条消息的关键字段 JSON
// 必填变量：BOT_TOKEN（Secret）  选填：WEBHOOK_SECRET
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

// ============================================================
// 【核心模块】转发来源解析
// 把 forward_origin 翻译成人类可读的用户/频道/群 ID 信息。
// ============================================================
function originInfo(m) {
  const o = m.forward_origin;
  if (!o) return null;
  if (o.type === "user")
    return `👤 用户：${o.sender_user.first_name}${o.sender_user.username ? " (@" + o.sender_user.username + ")" : ""}\nID：${o.sender_user.id}`;
  if (o.type === "channel")
    return `📣 频道：${o.chat.title}${o.chat.username ? " (@" + o.chat.username + ")" : ""}\nID：${o.chat.id}\n原消息 ID：${o.message_id}`;
  if (o.type === "chat")
    return `👥 群/聊天：${o.sender_chat.title}\nID：${o.sender_chat.id}`;
  if (o.type === "hidden_user")
    return `🙈 对方隐藏了账号：${o.sender_user_name}（拿不到 ID，可让对方直接私聊 Bot 发 /id）`;
  return null;
}
// ============================================================
// 【核心模块】file_id 提取
// 识别消息里的文件类型并返回其 file_id。
// ============================================================
function fileIdOf(m) {
  if (m.document) return ["document", m.document.file_id];
  if (m.photo?.length) return ["photo", m.photo[m.photo.length - 1].file_id];
  if (m.video) return ["video", m.video.file_id];
  if (m.audio) return ["audio", m.audio.file_id];
  if (m.voice) return ["voice", m.voice.file_id];
  if (m.sticker) return ["sticker", m.sticker.file_id];
  if (m.animation) return ["animation", m.animation.file_id];
  if (m.video_note) return ["video_note", m.video_note.file_id];
  return null;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "start", description: "开始使用（回你的 ID 信息）" },
  { command: "id", description: "查我的 ID" },
  { command: "json", description: "查看回复消息的 JSON" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("id-tools bot is running.", {
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
// ID 解析业务主流程（用户/群/转发来源/file_id 查询）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/json" && msg.reply_to_message) {
    const r = msg.reply_to_message;
    const slim = {
      message_id: r.message_id,
      from: r.from,
      chat: r.chat,
      forward_origin: r.forward_origin,
      date: r.date,
    };
    return send(
      env,
      chatId,
      "```json\n" + JSON.stringify(slim, null, 2).slice(0, 3800) + "\n```",
      { parse_mode: "Markdown" },
    );
  }

  if (msg.chat.type === "private") {
    const origin = originInfo(msg);
    if (origin) return send(env, chatId, "🔎 这条转发消息的来源：\n" + origin);
    const f = fileIdOf(msg);
    if (f) return send(env, chatId, `🗂 类型：${f[0]}\nfile_id：\n${f[1]}`);
    return send(
      env,
      chatId,
      `🧾 你的信息\n用户 ID：${msg.from.id}\n用户名：${msg.from.username ? "@" + msg.from.username : "（无）"}\n\n把别人的消息转发给我可查来源 ID；把图片/文件发给我可查 file_id；在群里发 /id 可查群 ID。`,
    );
  }

  // 群里
  if (cmd === "/id" || cmd === "/chatid")
    return send(
      env,
      chatId,
      `👥 本群 ID：${chatId}\n🧾 你的 ID：${msg.from.id}`,
    );
}
