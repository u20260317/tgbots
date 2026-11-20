// ============================================================
// 06 文件存储分享 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：管理员把文件/图片/视频发给 Bot -> Bot 存下 file_id 并生成短码链接
//       https://t.me/你的Bot用户名?start=f_<短码>
//       任何人点链接打开 Bot，即可收到该文件。适合做资源分发、频道引流。
// 必填变量：
//   BOT_TOKEN     BotFather Token（Secret）
//   ADMIN_ID      管理员数字 ID，多个英文逗号隔开（只有管理员能存文件）
//   BOT_USERNAME  Bot 用户名（不带 @，用于拼分享链接）
// 选填：WEBHOOK_SECRET
// ⚠️ 需要 KV：Worker -> Settings -> Bindings -> 添加 KV Namespace，
//    变量名必须叫 BOT_KV（只存 短码->file_id 映射，不存文件本身，文件在 TG 服务器上）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

const admins = (env) => String(env.ADMIN_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

function fileOf(msg) {
  if (msg.document) return { kind: "document", id: msg.document.file_id, name: msg.document.file_name || "文件" };
  if (msg.photo?.length) return { kind: "photo", id: msg.photo[msg.photo.length - 1].file_id, name: "图片" };
  if (msg.video) return { kind: "video", id: msg.video.file_id, name: msg.video.file_name || "视频" };
  if (msg.audio) return { kind: "audio", id: msg.audio.file_id, name: msg.audio.file_name || "音频" };
  if (msg.voice) return { kind: "voice", id: msg.voice.file_id, name: "语音" };
  if (msg.animation) return { kind: "animation", id: msg.animation.file_id, name: "动图" };
  return null;
}
const sendByKind = (env, chat_id, f, caption) =>
  tg(env, { document: "sendDocument", photo: "sendPhoto", video: "sendVideo", audio: "sendAudio", voice: "sendVoice", animation: "sendAnimation" }[f.kind] || "sendDocument",
    { chat_id, [f.kind]: f.id, caption: caption || undefined });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/") return new Response("file-store bot is running.", { headers: { "content-type": "text/plain;charset=utf-8" } });
    if (url.pathname === "/setWebhook") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const hook = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message"] });
      return Response.json({ setWebhook: hook, telegram: r });
    }
    if (url.pathname !== "/webhook" || request.method !== "POST") return new Response("not found", { status: 404 });
    if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET)
      return new Response("forbidden", { status: 403 });
    const update = await request.json().catch(() => ({}));
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};

async function handle(env, update) {
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  if (!env.BOT_KV) return send(env, msg.chat.id, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），管理员还没配置好。");
  const text = msg.text || "";

  // 取文件：/start f_xxxxxx
  const m = text.match(/^\/start(?:@\w+)?\s+f_(\w+)/);
  if (m) {
    const raw = await env.BOT_KV.get("f:" + m[1]);
    if (!raw) return send(env, msg.chat.id, "😢 这个分享链接已失效或不存在。");
    const f = JSON.parse(raw);
    await sendByKind(env, msg.chat.id, f, f.caption);
    return send(env, msg.chat.id, "✅ 就是上面这个文件，保存好哦。");
  }
  if (text.startsWith("/start"))
    return send(env, msg.chat.id, admins(env).includes(String(msg.from.id))
      ? "📦 文件分享 Bot（管理员）：直接把文件/图片/视频发给我，我回你一个专属分享链接，别人点链接就能找我领取该文件。"
      : "📦 你好，我是文件领取 Bot。请通过管理员分享的专属链接打开我来领取文件。");

  // 管理员存文件
  const f = fileOf(msg);
  if (f) {
    if (!admins(env).includes(String(msg.from.id))) return send(env, msg.chat.id, "⛔ 只有管理员能存文件。");
    const c = code();
    await env.BOT_KV.put("f:" + c, JSON.stringify({ ...f, caption: msg.caption || "" }));
    const link = `https://t.me/${env.BOT_USERNAME}?start=f_${c}`;
    return send(env, msg.chat.id, `✅ 已保存「${f.name}」\n\n🔗 分享链接：\n${link}\n\n任何人点开链接即可向我领取该文件。删除分享：在 KV 里删除键 f:${c}`);
  }
  return send(env, msg.chat.id, "把文件发给我（管理员），或通过分享链接打开我领取文件。");
}
