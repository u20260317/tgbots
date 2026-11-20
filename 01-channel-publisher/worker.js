// ============================================================
// 01 频道发帖面板 Bot（单文件 · Cloudflare Workers）
// 功能：管理员私聊 Bot 发任意内容 -> 预览 -> 一键发布到频道；
//       网页面板发帖（文字 + 链接按钮 + 可选置顶）；/post 命令带按钮发帖。
// 必填变量（Worker -> Settings -> Variables and Secrets）：
//   BOT_TOKEN     BotFather 给的 Token（设为 Secret）
//   ADMIN_ID      管理员数字 ID，多个用英文逗号隔开
//   CHANNEL_ID    目标频道 @username 或 -100 开头的数字 ID
// 选填：
//   WEBHOOK_SECRET  Webhook 密钥（同时用于 /setWebhook）
//   PANEL_KEY       网页面板口令（不填则网页面板关闭）
// 前提：先把 Bot 拉进频道并设为管理员（至少有发帖权限）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET 一键挂 Webhook。
// ============================================================

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const admins = (env) => String(env.ADMIN_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });

// 解析「文字 | https://链接」每行一个，返回 inline keyboard
function parseButtons(block) {
  const rows = [];
  for (const line of String(block || "").split("\n")) {
    const m = line.trim().match(/^(.+?)\s*[|｜]\s*(https?:\/\/\S+)$/);
    if (m) rows.push([{ text: m[1].trim(), url: m[2].trim() }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function panelHTML() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>频道发帖面板</title><style>body{font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px;background:#111;color:#eee}
textarea,input{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:10px;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{background:#c9a227;color:#111;border:0;padding:12px 20px;border-radius:8px;font-weight:700;cursor:pointer}label{font-size:14px;color:#bbb}</style></head>
<body><h2>📣 频道发帖面板</h2><form method="POST" action="/panel/publish">
<label>面板口令 PANEL_KEY</label><input name="key" type="password" required>
<label>正文（支持 HTML：&lt;b&gt;粗体&lt;/b&gt; &lt;a href=""&gt;链接&lt;/a&gt;）</label><textarea name="text" rows="8" required></textarea>
<label>链接按钮（可选，每行一个：按钮文字 | https://链接）</label><textarea name="buttons" rows="3" placeholder="点我进官网 | https://example.com"></textarea>
<label><input type="checkbox" name="pin" value="1" style="width:auto"> 发布后置顶</label><br><button type="submit">发布到频道</button>
</form></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN 未配置", { status: 500 });

    if (url.pathname === "/") return new Response("channel-publisher bot is running.", { headers: { "content-type": "text/plain;charset=utf-8" } });

    if (url.pathname === "/setWebhook") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const hook = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
      return Response.json({ setWebhook: hook, telegram: r });
    }

    if (url.pathname === "/panel" && request.method === "GET") {
      if (!env.PANEL_KEY) return new Response("网页面板未开启：请先在 Worker 变量里设置 PANEL_KEY", { status: 403 });
      return new Response(panelHTML(), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (url.pathname === "/panel/publish" && request.method === "POST") {
      const form = await request.formData();
      if (!env.PANEL_KEY || form.get("key") !== env.PANEL_KEY) return new Response("口令错误", { status: 403 });
      const kb = parseButtons(form.get("buttons"));
      const r = await tg(env, "sendMessage", { chat_id: env.CHANNEL_ID, text: String(form.get("text") || ""), parse_mode: "HTML", reply_markup: kb, disable_web_page_preview: false });
      if (!r.ok) return new Response("发布失败：" + esc(r.description || "unknown"), { status: 502 });
      if (form.get("pin")) ctx.waitUntil(tg(env, "pinChatMessage", { chat_id: env.CHANNEL_ID, message_id: r.result.message_id, disable_notification: true }));
      return new Response("✅ 已发布到频道，消息 ID：" + r.result.message_id, { headers: { "content-type": "text/plain;charset=utf-8" } });
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
  // 按钮回调：发布 / 发布并置顶
  const cq = update.callback_query;
  if (cq) {
    if (!isAdmin(env, cq.from.id)) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "你不是管理员", show_alert: true });
    const [act, msgId] = String(cq.data || "").split(":");
    if (act === "pub" || act === "pubp") {
      const r = await tg(env, "copyMessage", { chat_id: env.CHANNEL_ID, from_chat_id: cq.message.chat.id, message_id: Number(msgId) });
      if (!r.ok) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "发布失败：" + (r.description || ""), show_alert: true });
      if (act === "pubp") await tg(env, "pinChatMessage", { chat_id: env.CHANNEL_ID, message_id: r.result.message_id, disable_notification: true });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "✅ 已发布" });
      await send(env, cq.message.chat.id, "✅ 已发布到频道。");
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  if (!isAdmin(env, msg.from.id)) return send(env, msg.chat.id, "⛔ 本 Bot 仅管理员可用。你的 ID 是 " + msg.from.id);
  const text = msg.text || msg.caption || "";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    return send(env, msg.chat.id,
      "📣 频道发帖 Bot\n\n用法：\n1）直接把要发的内容（文字/图片/视频/文件）发给我，我给你预览和发布按钮。\n2）带链接按钮发帖：\n/post\n正文……\n---\n按钮文字 | https://链接\n（--- 之后每行一个按钮）\n3）网页面板：打开 Worker 地址 + /panel（需 PANEL_KEY）。");
  }

  // /post 正文 \n---\n 按钮区
  if (text.startsWith("/post")) {
    const body = text.replace(/^\/post(@\w+)?\s*/, "");
    const [main, btnBlock] = body.split(/\n---\n?/);
    if (!main?.trim()) return send(env, msg.chat.id, "正文为空。格式见 /help");
    const r = await tg(env, "sendMessage", { chat_id: env.CHANNEL_ID, text: main.trim(), reply_markup: parseButtons(btnBlock) });
    return send(env, msg.chat.id, r.ok ? "✅ 已发布到频道。" : "发布失败：" + (r.description || ""));
  }

  // 普通内容 -> 预览 + 发布按钮（无状态：靠原消息 ID 复制发布）
  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: "👆 这条就是待发布内容，确认后点下面按钮：",
    reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: [[
      { text: "✅ 发布到频道", callback_data: `pub:${msg.message_id}` },
      { text: "📌 发布并置顶", callback_data: `pubp:${msg.message_id}` },
    ]] },
  });
}
