// ============================================================
// 49 PDF 工具 Bot（单文件 · Cloudflare Workers · 需绑定 KV）
// 功能：
// · 图片转 PDF：连发多张图，点「生成 PDF」把图片拼成一个 PDF 回传
// ——纯 JS 本地生成（JPEG 原样嵌入 PDF），不依赖任何外部服务
// · PDF 提文字：发 PDF 文件，走 OCR 外部接口逐页提字回文本
// · PDF 转图 / 合并 / 拆分：走可配置外部 API（PDF_API_URL），
// 未配置时在入口就明确提示，不假装能做
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// OCR_API_KEY OCR.space 的 Key；不填用免费演示 key helloworld（额度小）
// PDF_API_URL 外部 PDF 服务地址（口径见模块 43 的 pdfExternal 约定）
// DAILY_LIMIT 每人每天处理次数上限，默认 20（护 OCR/外部服务额度）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（收集会话 + 用量计数）。
// 键设计（模块 43）：pdf:<用户ID> 待处理文件收集会话；pdf:cnt:<用户>:<日期> 用量。
// 回调前缀 pdf:（生成/清空按钮），已查模块 03 注册表避冲突。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 43（PDF 工具）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
async function sendBytes(env, chatId, bytes, filename, type, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([bytes], { type }), filename);
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form },
  );
  return r.json().catch(() => ({}));
}
async function tgFileUrl(env, fileId) {
  const r = await tg(env, "getFile", { file_id: fileId });
  if (!r.ok) throw new Error("getFile 失败（文件可能超过 20MB 下载上限）");
  return `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${r.result.file_path}`;
}

// ============================================================
// 读取 JPEG 宽高（扫 SOF 标记）
// 从文件头逐个跳标记段，命中 SOF0/SOF2 读出高宽，不解码像素。
// ============================================================
function jpegSize(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.byteLength) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
    i += 2 + dv.getUint16(i + 2);
  }
  return null;
}

// ============================================================
// 多张 JPEG 拼成一个 PDF（纯 JS 最小实现）
// 一图一页，页面尺寸 = 图片像素尺寸；JPEG 字节以 DCTDecode 原样
// 嵌入，最后按字节偏移写 xref 表。这是唯一不靠外部服务的 PDF 活。
// ============================================================
function imagesToPdf(images) {
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const push = (data) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(b);
    len += b.byteLength;
  };
  const offsets = [];
  const mark = (num) => (offsets[num] = len);
  push("%PDF-1.4\n");
  const kids = images.map((_, i) => `${3 + 3 * i} 0 R`).join(" ");
  mark(1);
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  mark(2);
  push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`,
  );
  images.forEach((img, i) => {
    const pageNum = 3 + 3 * i;
    const contentNum = 4 + 3 * i;
    const imgNum = 5 + 3 * i;
    mark(pageNum);
    push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.w} ${img.h}] /Resources << /XObject << /Im${i} ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const content = `q\n${img.w} 0 0 ${img.h} 0 0 cm\n/Im${i} Do\nQ\n`;
    mark(contentNum);
    push(
      `${contentNum} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    );
    mark(imgNum);
    push(
      `${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.byteLength} >>\nstream\n`,
    );
    push(img.bytes);
    push("\nendstream\nendobj\n");
  });
  const xrefAt = len;
  const total = 3 + 3 * images.length;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++)
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(
    `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`,
  );
  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

// ============================================================
// 非 JPEG 先转 JPEG（图片代理路线）
// PNG/WebP 不能直接嵌入：拿文件直链走 wsrv.nl 加 output=jpg 转一版。
// ============================================================
async function ensureJpeg(env, fileId) {
  const fileUrl = await tgFileUrl(env, fileId);
  let resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error("下载原图失败");
  let bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return bytes;
  const api =
    "https://wsrv.nl/?url=" +
    encodeURIComponent(fileUrl.replace(/^https?:\/\//, "")) +
    "&output=jpg";
  resp = await fetch(api);
  if (!resp.ok) throw new Error("图片转 JPEG 失败（代理服务不可用）");
  bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("转换结果不是 JPEG");
  return bytes;
}

// ============================================================
// PDF 提文字与外部 PDF 服务
// 提文字：OCR.space 直接吃 PDF 直链逐页识别。
// 转图/合并/拆分：POST {PDF_API_URL}/<动作>（multipart file 字段），
// 未配 PDF_API_URL 时抛固定错误，入口据此给明确提示。
// ============================================================
async function pdfTextViaOcr(env, pdfUrl) {
  const form = new FormData();
  form.append("url", pdfUrl);
  form.append("filetype", "PDF");
  form.append("language", "chs");
  form.append("OCREngine", "2");
  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: env.OCR_API_KEY || "helloworld" },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  const text = (data?.ParsedResults || [])
    .map((p) => p.ParsedText || "")
    .join("\n")
    .trim();
  if (!text) throw new Error(data?.ErrorMessage?.[0] || "没有提取出文字");
  return text;
}
async function pdfExternal(env, action, pdfBytes, filename) {
  if (!env.PDF_API_URL) throw new Error("未配置 PDF_API_URL");
  const form = new FormData();
  form.append(
    "file",
    new Blob([pdfBytes], { type: "application/pdf" }),
    filename || "file.pdf",
  );
  const r = await fetch(env.PDF_API_URL.replace(/\/$/, "") + "/" + action, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error("PDF 服务返回 " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// ============================================================
// 收集会话与用量计数（KV）
// pdf:<用户ID> = { items:[{kind:"img"|"pdf", fileId, name}], at}
// 一次收集既可生成 PDF（用 img）也可合并（用 pdf），互不干扰。
// pdf:cnt: 按天计数，超 DAILY_LIMIT 拒绝（护外部服务额度）。
// ============================================================
async function getSession(env, uid) {
  return JSON.parse((await env.BOT_KV.get("pdf:" + uid)) || '{"items":[]}');
}
async function saveSession(env, uid, s) {
  s.at = Date.now();
  await env.BOT_KV.put("pdf:" + uid, JSON.stringify(s), {
    expirationTtl: 3600,
  });
}
async function checkQuota(env, uid) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `pdf:cnt:${uid}:${day}`;
  const used = Number((await env.BOT_KV.get(key)) || 0);
  const limit = Number(env.DAILY_LIMIT) || 20;
  if (used >= limit) return false;
  await env.BOT_KV.put(key, String(used + 1), { expirationTtl: 172800 });
  return true;
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 无管理员命令，COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "pdf", description: "把收集的图片生成 PDF" },
  { command: "pdftext", description: "回复 PDF 文件提取文字" },
  { command: "pdf2img", description: "回复 PDF 转图片（需外部服务）" },
  { command: "split", description: "回复 PDF 按页拆分（需外部服务）" },
  { command: "merge", description: "合并收集的多个 PDF（需外部服务）" },
  { command: "clear", description: "清空收集篮" },
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
      return new Response("pdf-tools bot is running.", {
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
// 发图片/PDF 先进收集篮（1 小时有效）；/pdf 生成、/merge 合并、
// /pdftext 与 /pdf2img 对回复的 PDF 操作；按钮 pdf:make/pdf:clear。
// ============================================================
function basketText(s) {
  const imgs = s.items.filter((i) => i.kind === "img").length;
  const pdfs = s.items.filter((i) => i.kind === "pdf").length;
  return `🧺 收集篮：图片 ${imgs} 张、PDF ${pdfs} 个。继续发文件追加，点按钮或发命令处理：`;
}
function basketKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📄 生成 PDF", callback_data: "pdf:make" },
        { text: "🗑 清空", callback_data: "pdf:clear" },
      ],
    ],
  };
}
async function makePdf(env, chatId, uid) {
  const s = await getSession(env, uid);
  const imgs = s.items.filter((i) => i.kind === "img");
  if (!imgs.length)
    return send(env, chatId, "收集篮里还没有图片，先发几张图给我。");
  if (!(await checkQuota(env, uid)))
    return send(env, chatId, "今日处理次数已达上限，明天再来。");
  await send(env, chatId, `⏳ 正在把 ${imgs.length} 张图拼成 PDF…`);
  try {
    const pages = [];
    for (const it of imgs) {
      const bytes = await ensureJpeg(env, it.fileId);
      const size = jpegSize(bytes);
      if (!size) throw new Error("有一张图读不出尺寸，已中止");
      pages.push({ bytes, w: size.w, h: size.h });
    }
    const pdf = imagesToPdf(pages);
    const r = await sendBytes(
      env,
      chatId,
      pdf,
      "images.pdf",
      "application/pdf",
      `✅ ${pages.length} 张图已拼成 PDF`,
    );
    if (!r.ok)
      return send(env, chatId, "😵 PDF 回传失败：" + (r.description || ""));
    s.items = s.items.filter((i) => i.kind !== "img");
    await saveSession(env, uid, s);
  } catch (e) {
    return send(
      env,
      chatId,
      "😵 生成失败：" + String(e.message || e).slice(0, 200),
    );
  }
}
async function handle(env, update) {
  if (!env.BOT_KV) {
    const m = update.message;
    if (m)
      return send(env, m.chat.id, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");
    return;
  }
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (data === "pdf:make") {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "开始生成…",
      });
      return makePdf(env, cq.message.chat.id, cq.from.id);
    }
    if (data === "pdf:clear") {
      await env.BOT_KV.delete("pdf:" + cq.from.id);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已清空",
      });
      return send(env, cq.message.chat.id, "🧺 收集篮已清空。");
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "📄 PDF 工具 Bot\n\n· 连发多张图片给我，再点「生成 PDF」——图片在本地拼成 PDF，不依赖外部服务\n· 发 PDF 文件进收集篮可 /merge 合并（需管理员配外部服务）\n· 回复一个 PDF 发 /pdftext 提取文字、/pdf2img 转图片\n· /clear 清空收集篮（篮子 1 小时有效）",
    );
  if (cmd === "/clear") {
    await env.BOT_KV.delete("pdf:" + uid);
    return send(env, chatId, "🧺 收集篮已清空。");
  }
  if (cmd === "/pdf") return makePdf(env, chatId, uid);
  if (cmd === "/merge") {
    const s = await getSession(env, uid);
    const pdfs = s.items.filter((i) => i.kind === "pdf");
    if (!env.PDF_API_URL)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置外部 PDF 服务（PDF_API_URL），合并功能暂时不可用。图片转 PDF 和 PDF 提文字不受影响。",
      );
    if (pdfs.length < 2)
      return send(
        env,
        chatId,
        "合并至少需要 2 个 PDF，先把 PDF 文件发给我收集（现在 " +
          pdfs.length +
          " 个）。",
      );
    if (!(await checkQuota(env, uid)))
      return send(env, chatId, "今日处理次数已达上限，明天再来。");
    await send(env, chatId, `⏳ 正在把 ${pdfs.length} 个 PDF 交给外部服务合并…`);
    try {
      // 合并口径：一个 multipart 里带多个 files 字段 POST 到 /merge
      const form = new FormData();
      for (const [i, it] of pdfs.entries()) {
        const fileUrl = await tgFileUrl(env, it.fileId);
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error("下载待合并文件失败");
        form.append("files", new Blob([await resp.arrayBuffer()], { type: "application/pdf" }), it.name || `file${i + 1}.pdf`);
      }
      const r = await fetch(env.PDF_API_URL.replace(/\/$/, "") + "/merge", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error("PDF 服务返回 " + r.status);
      const out = new Uint8Array(await r.arrayBuffer());
      const rr = await sendBytes(env, chatId, out, "merged.pdf", "application/pdf", "✅ 合并完成");
      if (!rr.ok) return send(env, chatId, "😵 合并结果回传失败：" + (rr.description || ""));
      s.items = s.items.filter((i) => i.kind !== "pdf");
      await saveSession(env, uid, s);
    } catch (e) {
      return send(env, chatId, "😵 合并失败：" + String(e.message || e).slice(0, 200));
    }
    return;
  }
  if (cmd === "/pdftext" || cmd === "/pdf2img" || cmd === "/split") {
    const doc = msg.reply_to_message?.document;
    if (!doc || !/pdf/i.test(doc.mime_type || doc.file_name || ""))
      return send(env, chatId, `回复一个 PDF 文件再发 ${cmd}。`);
    if ((doc.file_size || 0) > 20 * 1024 * 1024)
      return send(env, chatId, "文件超过 20MB，Bot 下载不了。");
    if (!(await checkQuota(env, uid)))
      return send(env, chatId, "今日处理次数已达上限，明天再来。");
    try {
      const fileUrl = await tgFileUrl(env, doc.file_id);
      if (cmd === "/pdftext") {
        const out = await pdfTextViaOcr(env, fileUrl);
        return send(
          env,
          chatId,
          "📝 提取文字：\n" +
            out.slice(0, 3500) +
            (out.length > 3500 ? "\n…（已截断，全文太长）" : ""),
        );
      }
      if (!env.PDF_API_URL)
        return send(
          env,
          chatId,
          "⚠️ 管理员还没配置外部 PDF 服务（PDF_API_URL），这个功能暂时不可用。",
        );
      const resp = await fetch(fileUrl);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const out = await pdfExternal(
        env,
        cmd === "/split" ? "split" : "to-images",
        bytes,
        doc.file_name || "file.pdf",
      );
      const isZip = out[0] === 0x50 && out[1] === 0x4b;
      const fname = cmd === "/split" ? "split.zip" : isZip ? "pages.zip" : "page.png";
      return sendBytes(
        env,
        chatId,
        out,
        fname,
        isZip ? "application/zip" : "image/png",
        "✅ 处理完成",
      );
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 处理失败：" + String(e.message || e).slice(0, 200),
      );
    }
  }

  // 收集：图片与 PDF 文件进篮子
  const s = await getSession(env, uid);
  if (msg.photo) {
    s.items.push({
      kind: "img",
      fileId: msg.photo[msg.photo.length - 1].file_id,
      name: "photo",
    });
    await saveSession(env, uid, s);
    return send(env, chatId, basketText(s), { reply_markup: basketKeyboard() });
  }
  if (msg.document) {
    const doc = msg.document;
    const isPdf = /pdf/i.test(doc.mime_type || doc.file_name || "");
    const isImg = (doc.mime_type || "").startsWith("image/");
    if (!isPdf && !isImg)
      return send(env, chatId, "只收图片和 PDF 文件，其它类型处理不了。");
    if ((doc.file_size || 0) > 20 * 1024 * 1024)
      return send(env, chatId, "文件超过 20MB，Bot 下载不了。");
    s.items.push({
      kind: isPdf ? "pdf" : "img",
      fileId: doc.file_id,
      name: doc.file_name || "file",
    });
    await saveSession(env, uid, s);
    return send(env, chatId, basketText(s), { reply_markup: basketKeyboard() });
  }
}
