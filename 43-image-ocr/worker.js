// ============================================================
// 43 图片处理 / OCR Bot（单文件 · Cloudflare Workers · KV 可选）
// 功能：
// 发图提字（OCR）、改尺寸、转格式、生成引用图。Workers 里没有本地
// 图像引擎，所有活都外包：OCR 走 OCR.space、改尺寸/转格式走
// wsrv.nl 图片代理、引用图走可选的外部渲染服务，Bot 只做编排。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// OCR_API_KEY OCR.space 的 Key（Secret）；不填用官方免费演示 Key
// "helloworld"（额度很小、仅供试玩，正式用去 ocr.space 免费申请）
// OCR_LANG 识别语言，默认 chs（简中），可选 eng/jpn/kor 等
// QUOTE_API 引用图渲染服务地址；不填则 /quote 给出未配置提示
// ADMIN_ID 本 Bot 无管理员命令，可不填
// KV 可选：绑定 BOT_KV 后按天计数用量（键 ocr:cnt:<用户>:<日期>），
// 不绑也能用，只是不计数。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 37（图片处理/OCR）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
// 字节回传：处理结果用 multipart 直接发文件，不把第三方临时链接填给 TG（会过期）。
async function sendBytes(env, chatId, field, bytes, filename, type, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append(field, new Blob([bytes], { type: type || undefined }), filename);
  const method = field === "photo" ? "sendPhoto" : "sendDocument";
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    { method: "POST", body: form },
  );
  return r.json().catch(() => ({}));
}

// ============================================================
// 取 TG 文件直链
// getFile 两步：file_id → file_path → 拼下载地址。直链带 token 等于
// 临时钥匙：只发给处理服务，别写进日志和回复消息。
// ============================================================
async function tgFileUrl(env, fileId) {
  const r = await tg(env, "getFile", { file_id: fileId });
  if (!r.ok) throw new Error("getFile 失败");
  return `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${r.result.file_path}`;
}

// ============================================================
// OCR 提字（OCR.space）
// 传图片 URL 给 OCR.space，取引擎 2 的解析文本。未配 OCR_API_KEY
// 时用免费演示 key helloworld 并在回复里注明限制；换别家 OCR 只改
// 这一函数。用量计数走 ocr: 前缀（新前缀，已查模块 04 注册表）。
// ============================================================
async function ocrImage(env, imageUrl, lang) {
  const form = new FormData();
  form.append("url", imageUrl);
  form.append("language", lang || env.OCR_LANG || "chs");
  form.append("OCREngine", "2");
  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: env.OCR_API_KEY || "helloworld" },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  const text = data?.ParsedResults?.[0]?.ParsedText?.trim();
  if (!text) throw new Error(data?.ErrorMessage?.[0] || "没有识别出文字");
  return text;
}
async function bumpCount(env, uid) {
  if (!env.BOT_KV) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `ocr:cnt:${uid}:${day}`;
  const n = Number((await env.BOT_KV.get(key)) || 0) + 1;
  await env.BOT_KV.put(key, String(n), { expirationTtl: 172800 });
}

// ============================================================
// 改尺寸/转格式（wsrv.nl 图片代理）
// url 给原图（去掉协议头），w/h/fit/output 控制变换，fetch 回字节。
// 代理是免费公共服务，可能限流：失败就报错让用户稍后再试，不硬扛。
// ============================================================
async function resizeImage(srcUrl, { w, h, format } = {}) {
  let api =
    "https://wsrv.nl/?url=" +
    encodeURIComponent(srcUrl.replace(/^https?:\/\//, ""));
  if (w) api += `&w=${w}`;
  if (h) api += `&h=${h}`;
  if (w || h) api += "&fit=contain";
  if (format) api += `&output=${format}`;
  const r = await fetch(api);
  if (!r.ok) throw new Error("图片代理返回 " + r.status);
  return {
    bytes: await r.arrayBuffer(),
    type: r.headers.get("content-type") || "image/png",
  };
}

// ============================================================
// 引用图渲染（外部服务，可选）
// 把「谁说了什么」排版成图（头像+名字+气泡），渲染交给 QUOTE_API
//（POST JSON 进、PNG 出）；未配置时明确提示，不假装能做。
// ============================================================
async function makeQuoteImage(env, { text, from }) {
  const avatars = await tg(env, "getUserProfilePhotos", {
    user_id: from.id,
    limit: 1,
  });
  const avatarFileId = avatars?.result?.photos?.[0]?.[0]?.file_id || null;
  const r = await fetch(env.QUOTE_API.replace(/\/$/, "") + "/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, name: from.first_name, avatarFileId }),
  });
  if (!r.ok) throw new Error("渲染服务返回 " + r.status);
  return r.arrayBuffer();
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 无管理员命令，COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "ocr", description: "回复图片提取文字" },
  { command: "resize", description: "回复图片改尺寸：/resize 宽 高" },
  { command: "format", description: "回复图片转格式：/format png" },
  { command: "quote", description: "回复消息生成引用图" },
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
      return new Response("image-ocr bot is running.", {
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
// 私聊直接发图 = OCR；群里回复图片 + /ocr /resize /format 触发；
// 回复任意文本消息 + /quote 生成引用图。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const isPrivate = msg.chat.type === "private";
  const replyPhoto = msg.reply_to_message?.photo;
  const replyPhotoId = replyPhoto
    ? replyPhoto[replyPhoto.length - 1].file_id
    : null;

  async function doOcr(fileId, lang) {
    try {
      const url = await tgFileUrl(env, fileId);
      const out = await ocrImage(env, url, lang);
      await bumpCount(env, msg.from.id);
      const note = env.OCR_API_KEY
        ? ""
        : "\n（当前用 OCR.space 免费演示 Key，额度有限，识别慢/失败请稍后再试）";
      return send(env, chatId, "📝 识别结果：\n" + out + note, {
        reply_to_message_id: msg.message_id,
      });
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 OCR 失败：" + String(e.message || e).slice(0, 200),
      );
    }
  }

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🖼️ 图片处理/OCR Bot\n\n· 私聊直接发图 = 提取图中文字\n· 群里回复图片发 /ocr 提字、/resize 800 600 改尺寸、/format webp 转格式\n· 回复一条消息发 /quote 生成引用图（需管理员配置渲染服务）\n\n识别结果仅供参考，手写体和低清图准确率会下降。",
    );

  if (cmd === "/ocr") {
    const lang = text.split(/\s+/)[1];
    if (replyPhotoId) return doOcr(replyPhotoId, lang);
    if (msg.photo) return doOcr(msg.photo[msg.photo.length - 1].file_id, lang);
    return send(env, chatId, "回复一张图片再发 /ocr（可带语言：/ocr eng）。");
  }

  if (cmd === "/resize" || cmd === "/format") {
    if (!replyPhotoId) return send(env, chatId, `回复一张图片再发 ${cmd}。`);
    try {
      const src = await tgFileUrl(env, replyPhotoId);
      let out;
      if (cmd === "/resize") {
        const [, w, h] = text.split(/\s+/);
        const W = Math.min(4096, Math.max(1, Number(w) || 512));
        const H = h ? Math.min(4096, Math.max(1, Number(h) || 512)) : undefined;
        out = await resizeImage(src, { w: W, h: H });
        await bumpCount(env, msg.from.id);
        return sendBytes(
          env,
          chatId,
          "photo",
          out.bytes,
          `resized-${W}x${H || "auto"}.png`,
          out.type,
          `已改尺寸到 ${W}×${H || "自适应"}`,
        );
      }
      const fmt = (text.split(/\s+/)[1] || "png").toLowerCase();
      if (!["png", "jpg", "webp"].includes(fmt))
        return send(env, chatId, "只支持 png / jpg / webp 三种输出格式。");
      out = await resizeImage(src, { format: fmt });
      await bumpCount(env, msg.from.id);
      return sendBytes(
        env,
        chatId,
        "document",
        out.bytes,
        `converted.${fmt}`,
        out.type,
        `已转成 ${fmt}（以文件发送保原质）`,
      );
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 处理失败：" +
          String(e.message || e).slice(0, 200) +
          "（图片代理是免费公共服务，可能被限流，稍后再试）",
      );
    }
  }

  if (cmd === "/quote") {
    const target = msg.reply_to_message;
    if (!target || !target.text)
      return send(env, chatId, "回复一条文本消息再发 /quote。");
    if (!env.QUOTE_API)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置引用图渲染服务（QUOTE_API），暂时生成不了。渲染管线说明见模块 37。",
      );
    try {
      const bytes = await makeQuoteImage(env, {
        text: target.text,
        from: target.from,
      });
      return sendBytes(env, chatId, "photo", bytes, "quote.png", "image/png");
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 引用图生成失败：" + String(e.message || e).slice(0, 200),
      );
    }
  }

  // 私聊直接发图 = OCR（群里不默认扫图，费额度又吵）
  if (isPrivate && msg.photo)
    return doOcr(msg.photo[msg.photo.length - 1].file_id);
}
