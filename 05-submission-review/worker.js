// ============================================================
// 05 投稿审核 Bot（单文件 · Cloudflare Workers）
// 流程（无状态）：用户私聊投稿（文字/图片/视频/文件）-> 转到审核群/管理员处，
//   带「✅ 通过并发布」「❌ 拒绝」按钮 -> 通过即复制发布到目标频道，
//   并通知投稿人；拒绝同样通知投稿人。定位靠按钮里编码的消息坐标，不用数据库。
// 必填变量：
//   BOT_TOKEN       BotFather Token（Secret）
//   REVIEW_CHAT_ID  审核群 ID（推荐，-100 开头）或管理员个人 ID
//   TARGET_CHANNEL  发布频道 @username 或 -100 数字 ID
// 选填：WEBHOOK_SECRET
// 前提：Bot 是目标频道的管理员；审核群里请把 Bot 也拉进去。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });
const who = (u) => `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/") return new Response("submission-review bot is running.", { headers: { "content-type": "text/plain;charset=utf-8" } });
    if (url.pathname === "/setWebhook") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const hook = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
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
  const cq = update.callback_query;
  if (cq) {
    // data 格式：ok|no : 审核chat的消息id : 投稿人id
    const [act, reviewMsgId, submitterId] = String(cq.data || "").split(":");
    if (act !== "ok" && act !== "no") return;
    const reviewChatId = cq.message.chat.id;
    if (act === "ok") {
      const r = await tg(env, "copyMessage", { chat_id: env.TARGET_CHANNEL, from_chat_id: reviewChatId, message_id: Number(reviewMsgId) });
      if (!r.ok) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "发布失败：" + (r.description || "检查 Bot 是否为频道管理员"), show_alert: true });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "✅ 已发布" });
      await tg(env, "editMessageReplyMarkup", { chat_id: reviewChatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: "✅ 已发布到频道", callback_data: "done" }]] } });
      if (submitterId) await send(env, submitterId, "🎉 你的投稿已通过审核并发布到频道啦，感谢投稿！");
    } else {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "已拒绝" });
      await tg(env, "editMessageReplyMarkup", { chat_id: reviewChatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: "❌ 已拒绝", callback_data: "done" }]] } });
      if (submitterId) await send(env, submitterId, "😢 你的投稿这次未通过审核，欢迎按频道要求修改后再投。");
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  if ((msg.text || "").startsWith("/start"))
    return send(env, msg.chat.id, "✍️ 投稿 Bot：直接把稿件发给我（文字、图片、视频、文件都可以，一条消息 = 一篇投稿），管理员审核通过后会发布到频道，并在这里通知你。");

  // 转发投稿到审核处：先说明，再转发原稿，再给原稿加审核按钮
  await send(env, env.REVIEW_CHAT_ID, `📥 新投稿 · 来自 ${who(msg.from)}`);
  const fwd = await tg(env, "forwardMessage", { chat_id: env.REVIEW_CHAT_ID, from_chat_id: msg.chat.id, message_id: msg.message_id });
  if (!fwd.ok) return send(env, msg.chat.id, "⚠️ 投稿转发失败，请稍后再试。");
  await tg(env, "sendMessage", {
    chat_id: env.REVIEW_CHAT_ID,
    text: "👆 审核上面这篇投稿：",
    reply_to_message_id: fwd.result.message_id,
    reply_markup: { inline_keyboard: [[
      { text: "✅ 通过并发布", callback_data: `ok:${fwd.result.message_id}:${msg.from.id}` },
      { text: "❌ 拒绝", callback_data: `no:${fwd.result.message_id}:${msg.from.id}` },
    ]] },
  });
  return send(env, msg.chat.id, "✅ 已收到投稿，正在等待管理员审核，结果会在这里通知你。");
}
