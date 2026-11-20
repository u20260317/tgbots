// ============================================================
// 47 翻译进阶 Bot（单文件 · Cloudflare Workers · 群开关需 KV）
// 功能：
// 27 号翻译的四管线升级版：文档翻译（.txt/.srt 下载→分段译→译文
// 文件回传）、语音翻译（语音→STT→翻译→文字）、图片翻译（图→OCR
// →翻译）、群自动翻译（管理员开开关，群内异语消息自动回帖译文）。
// 私聊发纯文本仍是 27 的自动互译。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// TRANSLATE_API 自定义翻译接口（POST {text,target} 回 {text}）；
// 不填用 Google gtx 免费接口（非官方、可能被限流，见 README）
// STT_API_KEY / STT_API_BASE / STT_MODEL 语音转写（Whisper 兼容）；
// 不配 STT_API_KEY 则语音翻译明确提示未配置
// OCR_API_KEY OCR.space 的 Key；不填用免费演示 key helloworld
// ADMIN_ID 本 Bot 无管理员命令，可不填（群开关认群管理员身份）
// KV：群自动翻译开关存 autotr:<群ID>，用这个功能才需要绑 BOT_KV。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 31（翻译进阶）+ 27（翻译引擎）+ 模块 30（语音转写）
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
const hasChinese = (s) => /[一-鿿]/.test(s);
const autoTarget = (text) => (hasChinese(text) ? "en" : "zh-CN");
async function isGroupAdmin(env, chatId, userId) {
  const r = await tg(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}

// ============================================================
// 翻译引擎（可替换）
// 配了 TRANSLATE_API 走自定义接口；没配走 27 号同款 gtx 免费接口。
// 管线代码只认 translateText(env, text, target) 这一个签名，换引擎
// 只改这一函数。返回译文字符串，失败返回 null。
// ============================================================
async function translateText(env, text, target) {
  if (env.TRANSLATE_API) {
    try {
      const r = await fetch(env.TRANSLATE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, target }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.text) return data.text;
    } catch {}
    return null;
  }
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || !Array.isArray(data[0])) return null;
  return data[0].map((seg) => seg[0] || "").join("");
}

// ============================================================
// 长文本分段翻译
// 按段落切、逐段译再拼回；切分只在空行/句末下刀，不把句子劈两半。
// ============================================================
function splitForTranslate(text, maxLen = 1500) {
  const parts = [];
  let buf = "";
  for (const para of text.split(/\n\s*\n/)) {
    if ((buf + "\n\n" + para).length > maxLen && buf) {
      parts.push(buf);
      buf = para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
    while (buf.length > maxLen) {
      const cut = Math.max(
        buf.lastIndexOf("。", maxLen),
        buf.lastIndexOf(". ", maxLen),
      );
      const at = cut > 200 ? cut + 1 : maxLen;
      parts.push(buf.slice(0, at));
      buf = buf.slice(at);
    }
  }
  if (buf) parts.push(buf);
  return parts;
}
async function translateLong(env, text, target) {
  const out = [];
  for (const part of splitForTranslate(text)) {
    const t = await translateText(env, part, target);
    if (t == null) return null;
    out.push(t);
  }
  return out.join("\n\n");
}

// ============================================================
// 文档翻译管线
// 下载.txt/.srt/.md（≤5MB）→ 解码 → translateLong → 译文打包成
// 文件 multipart 回传。docx/pdf 的文本抽取 Workers 本地做不了，
// 明确提示改发纯文本文件，不假装支持。
// ============================================================
async function handleDocTranslate(env, msg, target) {
  const chatId = msg.chat.id;
  const doc = msg.document;
  const name = doc.file_name || "file.txt";
  if (!/\.(txt|srt|md)$/i.test(name))
    return send(
      env,
      chatId,
      "文档翻译目前只支持.txt /.srt /.md 纯文本文件（docx/pdf 的文本抽取需要外部解析服务，本 Bot 不假装支持）。",
    );
  if (doc.file_size > 5 * 1024 * 1024)
    return send(env, chatId, "文件超过 5MB，先拆小一点再发。");
  const gf = await tg(env, "getFile", { file_id: doc.file_id });
  if (!gf.ok) return send(env, chatId, "文件没取到，再发一次试试。");
  const buf = await (
    await fetch(
      `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`,
    )
  ).arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const translated = await translateLong(env, text, target || autoTarget(text));
  if (translated == null)
    return send(env, chatId, "😢 翻译接口暂时不可用，稍后再试。");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "document",
    new Blob([translated], { type: "text/plain;charset=utf-8" }),
    name.replace(/(\.[^.]+)$/, "") + ".译文.txt",
  );
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form },
  );
  const data = await r.json().catch(() => ({}));
  if (!data.ok)
    return send(env, chatId, "😵 译文回传失败：" + (data.description || ""));
}

// ============================================================
// 语音翻译管线（STT → 翻译）
// transcribeVoice 与 35 号同实现（getFile 下载 + Whisper 兼容接口）。
// 没配 STT_API_KEY 时明确提示未配置，不静默失败。
// ============================================================
async function transcribeVoice(env, fileId) {
  const gf = await tg(env, "getFile", { file_id: fileId });
  const path = gf?.result?.file_path;
  if (!path) throw new Error("getFile 失败（文件可能超过 20MB 下载上限）");
  const fileResp = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`,
  );
  if (!fileResp.ok) throw new Error(`下载语音失败 HTTP ${fileResp.status}`);
  const blob = await fileResp.blob();
  const ext = (path.split(".").pop() || "ogg").toLowerCase();
  const form = new FormData();
  form.append("file", blob, `voice.${ext}`);
  form.append("model", env.STT_MODEL || "whisper-1");
  const base = (env.STT_API_BASE || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.STT_API_KEY}` },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.text)
    throw new Error(data?.error?.message || `转写接口 HTTP ${r.status}`);
  return data.text.trim();
}
async function handleVoiceTranslate(env, msg, target) {
  const chatId = msg.chat.id;
  if (!env.STT_API_KEY)
    return send(
      env,
      chatId,
      "⚠️ 管理员还没配置语音转写服务（STT_API_KEY），语音翻译暂时不可用。文字和图片翻译不受影响。",
    );
  if ((msg.voice?.duration || 0) > 300)
    return send(env, chatId, "语音超过 5 分钟，先切短一点再发。");
  try {
    const text = await transcribeVoice(env, msg.voice.file_id);
    const translated = await translateText(
      env,
      text,
      target || autoTarget(text),
    );
    if (translated == null)
      return send(env, chatId, "😢 翻译接口暂时不可用，稍后再试。");
    return send(env, chatId, `🗣️ 原文：${text}\n\n🌐 译文：${translated}`, {
      reply_to_message_id: msg.message_id,
    });
  } catch (e) {
    return send(
      env,
      chatId,
      "😵 语音翻译失败：" + String(e.message || e).slice(0, 200),
    );
  }
}

// ============================================================
// 图片翻译管线（OCR → 翻译）
// OCR 走 OCR.space（与 43 同路线），提字后走 translateText。
// ============================================================
async function ocrImage(env, imageUrl) {
  const form = new FormData();
  form.append("url", imageUrl);
  form.append("language", "chs");
  form.append("OCREngine", "2");
  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: env.OCR_API_KEY || "helloworld" },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  const text = data?.ParsedResults?.[0]?.ParsedText?.trim();
  if (!text) throw new Error(data?.ErrorMessage?.[0] || "图片里没认出文字");
  return text;
}
async function handlePhotoTranslate(env, msg, target) {
  const photo = msg.photo[msg.photo.length - 1];
  const gf = await tg(env, "getFile", { file_id: photo.file_id });
  if (!gf.ok) return send(env, msg.chat.id, "图片没取到，再发一次试试。");
  try {
    const text = await ocrImage(
      env,
      `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`,
    );
    const translated = await translateText(
      env,
      text,
      target || autoTarget(text),
    );
    if (translated == null)
      return send(env, msg.chat.id, "😢 翻译接口暂时不可用，稍后再试。");
    return send(
      env,
      msg.chat.id,
      `🖼️ 图中文字：${text.slice(0, 500)}\n\n🌐 译文：${translated}`,
      { reply_to_message_id: msg.message_id },
    );
  } catch (e) {
    return send(
      env,
      msg.chat.id,
      "😵 图片翻译失败：" + String(e.message || e).slice(0, 200),
    );
  }
}

// ============================================================
// 群自动翻译
// 开关存 KV autotr:<群ID> = 目标语言码，空 = 关闭。群内文本先粗判
// 语言（中文字符判 zh、纯拉丁判 en），与目标不一致才回帖译文；
// 短句、命令、纯表情跳过，防刷屏。
// ============================================================
function roughLang(text) {
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[a-zA-Z]/.test(text)) return "en";
  return "";
}
async function handleAutoTranslate(env, msg) {
  if (!env.BOT_KV || !msg.text || msg.text.startsWith("/")) return;
  const target = await env.BOT_KV.get("autotr:" + msg.chat.id);
  if (!target) return;
  const src = roughLang(msg.text);
  if (!src || src === target || msg.text.length < 4) return;
  const translated = await translateText(
    env,
    msg.text,
    target === "zh" ? "zh-CN" : target,
  );
  if (translated)
    return send(env, msg.chat.id, "🌐 " + translated, {
      reply_to_message_id: msg.message_id,
    });
}

// ============================================================
// 管理员白名单与分级命令菜单
// 群开关命令认群管理员身份（业务里 isGroupAdmin 校验），不走菜单分级；
// COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "fy", description: "回复消息翻译（文本/文档/图片/语音）" },
  { command: "autotr", description: "群自动翻译开关：/autotr zh 或 off" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    const ids = String(env.ADMIN_ID || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const id of ids)
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// 标准 webhook 入口：健康检查、/setWebhook 一键挂载、密钥校验、更新分发。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("translate-plus bot is running.", {
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
// 按消息类型分发四条管线；/fy 回复任意消息按其类型选管线并可带
// 目标语言（/fy en）；群文本最后过一遍自动翻译。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const fyTarget = cmd === "/fy" ? text.split(/\s+/)[1] : undefined;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🌐 翻译进阶 Bot\n\n· 私聊发文本：自动中英互译\n· 发.txt/.srt 文档：整篇翻译后回传译文文件\n· 发语音：转写+翻译（需管理员配 STT）\n· 发图片：OCR 提字+翻译\n· 回复任意消息发 /fy（可带语言：/fy ja）按类型翻译\n· 群里管理员发 /autotr zh 开自动翻译、/autotr off 关",
    );

  if (cmd === "/autotr") {
    if (!isGroup) return send(env, chatId, "/autotr 是群里用的开关。");
    if (!env.BOT_KV)
      return send(env, chatId, "⚠️ 本 Bot 未绑定 KV，存不了开关状态。");
    if (!(await isGroupAdmin(env, chatId, msg.from.id)))
      return send(env, chatId, "⛔ 只有群管理员能改自动翻译开关。");
    const arg = (text.split(/\s+/)[1] || "").toLowerCase();
    if (arg === "off") {
      await env.BOT_KV.delete("autotr:" + chatId);
      return send(env, chatId, "✅ 群自动翻译已关闭。");
    }
    if (["zh", "en", "ja", "ko", "ru"].includes(arg)) {
      await env.BOT_KV.put("autotr:" + chatId, arg);
      return send(
        env,
        chatId,
        `✅ 群自动翻译已开启：异语消息自动译成 ${arg}。`,
      );
    }
    return send(
      env,
      chatId,
      "用法：/autotr zh|en|ja|ko|ru 开启，/autotr off 关闭。",
    );
  }

  if (cmd === "/fy") {
    const t = msg.reply_to_message;
    if (!t)
      return send(env, chatId, "回复一条消息（文本/文档/图片/语音）再发 /fy。");
    if (t.document) return handleDocTranslate(env, t, fyTarget);
    if (t.voice) return handleVoiceTranslate(env, t, fyTarget);
    if (t.photo) return handlePhotoTranslate(env, t, fyTarget);
    if (t.text) {
      const translated = await translateText(
        env,
        t.text,
        fyTarget || autoTarget(t.text),
      );
      if (translated == null)
        return send(env, chatId, "😢 翻译接口暂时不可用，稍后再试。");
      return send(env, chatId, "🌐 " + translated, {
        reply_to_message_id: t.message_id,
      });
    }
    return send(env, chatId, "这条消息没有可翻译的内容。");
  }

  if (msg.document) return handleDocTranslate(env, msg, undefined);
  if (msg.voice) return handleVoiceTranslate(env, msg, undefined);
  if (msg.photo) return handlePhotoTranslate(env, msg, undefined);

  if (text && !text.startsWith("/")) {
    if (isGroup) return handleAutoTranslate(env, msg);
    // 私聊纯文本：27 号同款自动互译
    const translated = await translateText(env, text, autoTarget(text));
    if (translated == null)
      return send(
        env,
        chatId,
        "😢 翻译接口暂时不可用（免费接口可能被限流），稍后再试。",
      );
    return send(env, chatId, "🌐 " + translated);
  }
}
