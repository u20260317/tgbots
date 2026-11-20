// ============================================================
// 10 网盘 Bot（私有频道存储 · 单文件 · Cloudflare Workers + 需绑定 KV）
// 原理：文件本体不存在服务器上，而是由 Bot 转存到你的「私有存储频道」，
//       Telegram 就是硬盘；KV 只存一份目录索引（文件名/类型/大小/存储消息ID），
//       用来列表、搜索、取回、删除、生成分享链接。
// 功能（仅主人可用）：
//   直接发文件/图片/视频/音频/文字笔记给 Bot -> 自动转存到私有频道并登记目录
//   /list          最近文件（按钮：取回 / 分享 / 删除，带翻页）
//   /search 关键词  按文件名、说明、标签搜索
//   /tag 短码 标签  给文件打标签（便于搜索）
//   /del 短码      从存储频道和目录中删除
//   /stats         文件数与总大小
//   分享：每个文件有专属链接 https://t.me/Bot用户名?start=d_短码，
//         任何人点开即可向 Bot 领取该文件（链接别外传给不想给的人）。
// 必填变量：
//   BOT_TOKEN          BotFather Token（Secret）
//   ADMIN_ID           主人数字 ID，多个英文逗号隔开（只有主人能存/管文件）
//   STORAGE_CHANNEL_ID 私有存储频道的 -100 数字 ID
//   BOT_USERNAME       Bot 用户名（不带 @，拼分享链接用）
// 选填：WEBHOOK_SECRET
// ⚠️ 需要 KV：Bindings 添加 KV Namespace，变量名必须叫 BOT_KV。
// ⚠️ 前提：先建一个私有频道（不要公开），把 Bot 拉进去设为管理员；
//    频道 ID 用 08-id-tools 查（转发频道消息给它，或用关联群 /id）。
// ⚠️ 限制：单个文件受 Telegram Bot API 上限约束（Bot 下载 20MB / 发送 50MB，
//    转存是服务器间复制，一般 50MB 内稳妥）；这是个人网盘，别存违法内容，
//    重要文件请另做备份，频道被封/误删不在 Bot 能控制的范围内。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

const owners = (env) => String(env.ADMIN_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const isOwner = (env, id) => owners(env).includes(String(id));
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const fmtSize = (n) => !n ? "" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? (n / 1024).toFixed(0) + " KB" : n + " B";
const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);

// ---------- 索引（KV 键 index：数组；单项 {c:短码, n:名, k:类型, s:大小, m:存储消息ID, cap:说明, tag:标签, t:时间}） ----------
async function loadIndex(env) { const raw = await env.BOT_KV.get("index"); return raw ? JSON.parse(raw) : []; }
async function saveIndex(env, idx) { await env.BOT_KV.put("index", JSON.stringify(idx)); }
const findByCode = (idx, code) => idx.find((x) => x.c === code);

function fileOf(msg) {
  if (msg.document) return { kind: "document", name: msg.document.file_name || "未命名文件", size: msg.document.file_size || 0 };
  if (msg.photo?.length) return { kind: "photo", name: "图片 " + fmtDate(Date.now()), size: msg.photo[msg.photo.length - 1].file_size || 0 };
  if (msg.video) return { kind: "video", name: msg.video.file_name || "视频 " + fmtDate(Date.now()), size: msg.video.file_size || 0 };
  if (msg.audio) return { kind: "audio", name: msg.audio.file_name || msg.audio.title || "音频", size: msg.audio.file_size || 0 };
  if (msg.voice) return { kind: "voice", name: "语音 " + fmtDate(Date.now()), size: msg.voice.file_size || 0 };
  if (msg.animation) return { kind: "animation", name: "动图 " + fmtDate(Date.now()), size: msg.animation.file_size || 0 };
  if (msg.video_note) return { kind: "video_note", name: "圆形视频 " + fmtDate(Date.now()), size: msg.video_note.file_size || 0 };
  if (msg.sticker) return { kind: "sticker", name: "贴纸 " + (msg.sticker.emoji || ""), size: msg.sticker.file_size || 0 };
  return null;
}
const KIND_ICON = { document: "📄", photo: "🖼", video: "🎬", audio: "🎵", voice: "🎙", animation: "🎞", video_note: "⭕", sticker: "🏷", note: "📝" };

function entryLine(e) {
  return `${KIND_ICON[e.k] || "📦"} ${e.n}${e.s ? " · " + fmtSize(e.s) : ""} · ${fmtDate(e.t)} · 短码 ${e.c}${e.tag ? " · 🏷 " + e.tag : ""}`;
}
function entryKeyboard(e) {
  return { inline_keyboard: [[
    { text: "⬇️ 取回", callback_data: `get:${e.c}` },
    { text: "🔗 分享", callback_data: `shr:${e.c}` },
    { text: "🗑 删除", callback_data: `del:${e.c}` },
  ]] };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/") return new Response("cloud-drive bot is running.", { headers: { "content-type": "text/plain;charset=utf-8" } });
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

async function retrieve(env, chatId, e) {
  const r = await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: env.STORAGE_CHANNEL_ID, message_id: e.m });
  if (!r.ok) await send(env, chatId, "⚠️ 取回失败：" + (r.description || "存储频道里的原文件可能已被删除"));
  return r.ok;
}

async function handle(env, update) {
  // ---------- 按钮 ----------
  const cq = update.callback_query;
  if (cq) {
    const [act, arg] = String(cq.data || "").split(":");
    const idx = await loadIndex(env);
    if (act === "get") {
      // 取回：分享链接场景下非主人点列表按钮不存在，此按钮只出现在主人列表里；分享走 /start 深链
      const e = findByCode(idx, arg);
      if (!e) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "文件不存在或已删除", show_alert: true });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "正在取回…" });
      return retrieve(env, cq.message.chat.id, e);
    }
    if (!isOwner(env, cq.from.id)) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有主人能操作", show_alert: true });
    if (act === "shr") {
      const e = findByCode(idx, arg);
      if (!e) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "文件不存在", show_alert: true });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(env, cq.message.chat.id, `🔗 「${e.n}」分享链接（任何人点开可领取）：\nhttps://t.me/${env.BOT_USERNAME}?start=d_${e.c}`);
    }
    if (act === "del") {
      const e = findByCode(idx, arg);
      if (!e) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "文件不存在", show_alert: true });
      await tg(env, "deleteMessage", { chat_id: env.STORAGE_CHANNEL_ID, message_id: e.m });
      await saveIndex(env, idx.filter((x) => x.c !== arg));
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "🗑 已删除" });
      return tg(env, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `🗑 已删除「${e.n}」（存储频道原件与目录记录都已清除）` });
    }
    if (act === "lp") return showList(env, cq.message.chat.id, idx, Number(arg) || 0, cq);
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  if (!env.BOT_KV) return send(env, msg.chat.id, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。");
  const text = msg.text || "";
  const idx = await loadIndex(env);

  // ---------- 分享深链取件（任何人） ----------
  const dm = text.match(/^\/start(?:@\w+)?\s+d_(\w+)/);
  if (dm) {
    const e = findByCode(idx, dm[1]);
    if (!e) return send(env, msg.chat.id, "😢 这个分享链接已失效（文件可能已被删除）。");
    await retrieve(env, msg.chat.id, e);
    return send(env, msg.chat.id, `✅ 上面就是「${e.n}」，保存到你的收藏或转发留存哦。`);
  }

  // ---------- 以下仅主人 ----------
  if (!isOwner(env, msg.from.id)) {
    if (text.startsWith("/start")) return send(env, msg.chat.id, "🔒 这是私人网盘 Bot，只有主人能存取文件。通过主人分享的链接打开我，可以领取被分享的单个文件。");
    return send(env, msg.chat.id, "🔒 私人网盘，只有主人能用。");
  }

  if (text.startsWith("/start") || text.startsWith("/help"))
    return send(env, msg.chat.id, "☁️ 私人网盘（存储在你的私有频道里）\n\n· 直接发文件/图片/视频/音频/文字给我 = 存入网盘\n· /list 最近文件（按钮取回/分享/删除）\n· /search 关键词 搜索\n· /tag 短码 标签文字 给文件打标签\n· /del 短码 删除\n· /stats 容量统计\n\n文件本体存在存储频道里，Bot 里只留目录；重要文件记得另行备份。");

  if (text.startsWith("/stats")) {
    const total = idx.reduce((a, e) => a + (e.s || 0), 0);
    return send(env, msg.chat.id, `📊 网盘统计\n文件数：${idx.length}\n总大小：${fmtSize(total) || "0 B"}（笔记类不计大小）\n存储位置：私有频道 ${env.STORAGE_CHANNEL_ID}`);
  }
  if (text.startsWith("/list")) return showList(env, msg.chat.id, idx, 0, null);
  if (text.startsWith("/search")) {
    const kw = text.replace(/^\/search(@\w+)?\s*/, "").trim().toLowerCase();
    if (!kw) return send(env, msg.chat.id, "用法：/search 关键词");
    const hits = idx.filter((e) => (e.n + " " + (e.cap || "") + " " + (e.tag || "")).toLowerCase().includes(kw));
    if (!hits.length) return send(env, msg.chat.id, "没搜到包含「" + kw + "」的文件。");
    await send(env, msg.chat.id, `🔍 找到 ${hits.length} 个：`);
    for (const e of hits.slice(0, 10)) await send(env, msg.chat.id, entryLine(e), { reply_markup: entryKeyboard(e) });
    return;
  }
  if (text.startsWith("/tag")) {
    const m = text.match(/^\/tag\s+(\w+)\s+(.+)/);
    if (!m) return send(env, msg.chat.id, "用法：/tag 短码 标签（短码见 /list）");
    const e = findByCode(idx, m[1]);
    if (!e) return send(env, msg.chat.id, "短码不存在。");
    e.tag = m[2].trim();
    await saveIndex(env, idx);
    return send(env, msg.chat.id, `🏷 已给「${e.n}」打上标签：${e.tag}`);
  }
  if (text.startsWith("/del")) {
    const codeArg = text.replace(/^\/del(@\w+)?\s*/, "").trim();
    const e = findByCode(idx, codeArg);
    if (!e) return send(env, msg.chat.id, "用法：/del 短码（短码见 /list），或在列表里点删除按钮。");
    await tg(env, "deleteMessage", { chat_id: env.STORAGE_CHANNEL_ID, message_id: e.m });
    await saveIndex(env, idx.filter((x) => x.c !== codeArg));
    return send(env, msg.chat.id, `🗑 已删除「${e.n}」。`);
  }
  if (text.startsWith("/")) return send(env, msg.chat.id, "命令见 /help；直接发文件或文字就是存入网盘。");

  // ---------- 存入：文件类走 copyMessage，纯文字存为笔记 ----------
  const f = fileOf(msg);
  const caption = msg.caption || "";
  let stored;
  if (f) {
    const payload = { chat_id: env.STORAGE_CHANNEL_ID, from_chat_id: msg.chat.id, message_id: msg.message_id };
    // 只有这些类型支持改说明文字，其余类型带 caption 会被 TG 拒绝
    if (["document", "photo", "video", "audio", "animation"].includes(f.kind)) payload.caption = caption || f.name;
    stored = await tg(env, "copyMessage", payload);
  } else {
    stored = await tg(env, "sendMessage", { chat_id: env.STORAGE_CHANNEL_ID, text });
  }
  if (!stored.ok) return send(env, msg.chat.id, "⚠️ 转存失败：" + (stored.description || "检查 Bot 是否为存储频道管理员、频道 ID 是否正确"));
  const e = {
    c: newCode(),
    n: f ? f.name : (text.slice(0, 40) || "笔记"),
    k: f ? f.kind : "note",
    s: f ? f.size : 0,
    m: stored.result.message_id,
    cap: caption, tag: "", t: Date.now(),
  };
  idx.unshift(e);
  await saveIndex(env, idx);
  return send(env, msg.chat.id, `☁️ 已存入网盘\n${entryLine(e)}\n🔗 分享链接：https://t.me/${env.BOT_USERNAME}?start=d_${e.c}`, { reply_markup: entryKeyboard(e) });
}

async function showList(env, chatId, idx, page, cq) {
  const PAGE = 8;
  if (!idx.length) { if (!cq) await send(env, chatId, "网盘还是空的，直接发个文件给我试试。"); return; }
  const pages = Math.ceil(idx.length / PAGE);
  const p = Math.min(Math.max(page, 0), pages - 1);
  if (cq) await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  await send(env, chatId, `☁️ 网盘文件（第 ${p + 1}/${pages} 页，共 ${idx.length} 个，新的在前）：`);
  for (const e of idx.slice(p * PAGE, p * PAGE + PAGE)) await send(env, chatId, entryLine(e), { reply_markup: entryKeyboard(e) });
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: "⬅️ 上一页", callback_data: `lp:${p - 1}` });
    if (p < pages - 1) nav.push({ text: "下一页 ➡️", callback_data: `lp:${p + 1}` });
    await send(env, chatId, "翻页：", { reply_markup: { inline_keyboard: [nav] } });
  }
}
