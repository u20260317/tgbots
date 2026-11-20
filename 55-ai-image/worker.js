// ============================================================
// 55 AI 绘图 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：文字画图与改图：
// /draw <描述> 文生图；回复一张图发 /edit <描述> 按描述改图；
// 每张图下方带「🔄 重新生成」按钮；每人每日限额（默认 10 张）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// IMAGE_API_URL 绘图 API 的 base 地址（Secret 或普通变量均可），
// OpenAI 兼容口径如 https://api.openai.com/v1
// IMAGE_API_KEY 绘图 API 的 Key（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// IMAGE_MODEL 模型名，默认 dall-e-3
// IMAGE_SIZE 出图尺寸，默认 1024x1024
// DAILY_LIMIT 每人每日张数，默认 10
// TZ_OFFSET 限额按哪个时区切日，默认 8
// ⚠️ 没配 IMAGE_API_URL/KEY 时 Bot 只会明确提示「未配置」，不会假装出图。
// 键设计：aimg:cnt:<uid>:<日期> 每日用量；aimg:p:<id> 提示词存档（供重画）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 25（AI 用量控制模式）+ 模块 19（外部 API）+ 模块 01（骨架）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const dayKey = (env) =>
  new Date(Date.now() + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
const configured = (env) => !!(env.IMAGE_API_URL && env.IMAGE_API_KEY);
const NOT_CONFIGURED =
  "⚠️ 本 Bot 还没配置绘图 API（需要管理员设置 IMAGE_API_URL 与 IMAGE_API_KEY），暂时画不了图。";

// 以字节方式发图（API 返回 b64 时用）：FormData 直传 sendPhoto。
async function sendPhotoBytes(env, chatId, bytes, caption, replyMarkup) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  if (replyMarkup) fd.append("reply_markup", JSON.stringify(replyMarkup));
  fd.append("photo", new Blob([bytes], { type: "image/png" }), "image.png");
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`,
    {
      method: "POST",
      body: fd,
    },
  );
  return r.json().catch(() => ({}));
}

// ============================================================
// 绘图 API 适配层（换源只改这一个函数）
// OpenAI images 兼容口径：
// · 文生图 POST {base}/images/generations，JSON { model, prompt, n, size}
// · 改图 POST {base}/images/edits，multipart 带 image 文件与 prompt
// 返回统一成 { url} 或 { b64}；接 Kandinsky / SYNTX 等其他口径时，
// 只改这里的请求与解析，下面的流程（限额、发送、重画）不用动。
// ============================================================
async function genImage(env, prompt) {
  const base = env.IMAGE_API_URL.replace(/\/$/, "");
  const r = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.IMAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.IMAGE_MODEL || "dall-e-3",
      prompt,
      n: 1,
      size: env.IMAGE_SIZE || "1024x1024",
    }),
  });
  const data = await r.json().catch(() => ({}));
  const item = data?.data?.[0];
  if (!r.ok || !item)
    throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return item.url ? { url: item.url } : { b64: item.b64_json };
}
async function editImage(env, imgBytes, prompt) {
  const base = env.IMAGE_API_URL.replace(/\/$/, "");
  const fd = new FormData();
  fd.append("model", env.IMAGE_MODEL || "dall-e-3");
  fd.append("prompt", prompt);
  fd.append("image", new Blob([imgBytes], { type: "image/png" }), "source.png");
  const r = await fetch(`${base}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.IMAGE_API_KEY}` },
    body: fd,
  });
  const data = await r.json().catch(() => ({}));
  const item = data?.data?.[0];
  if (!r.ok || !item)
    throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return item.url ? { url: item.url } : { b64: item.b64_json };
}

// ============================================================
// 每日限额（aimg:cnt:<uid>:<日期>）
// 先查后扣：生成成功才 +1，失败不扣额度；超限明确告知明日再来。
// ============================================================
async function quotaLeft(env, uid) {
  const limit = Number(env.DAILY_LIMIT) || 10;
  const used = Number(
    (await env.BOT_KV.get(`aimg:cnt:${uid}:${dayKey(env)}`)) || 0,
  );
  return { limit, used, left: Math.max(0, limit - used) };
}
async function quotaUse(env, uid) {
  const key = `aimg:cnt:${uid}:${dayKey(env)}`;
  const used = Number((await env.BOT_KV.get(key)) || 0) + 1;
  await env.BOT_KV.put(key, String(used), { expirationTtl: 172800 });
}

// 出图并附「重新生成」按钮：提示词先存 aimg:p:<id>，按钮只带短 id（64 字节回调上限）。
async function deliver(env, chatId, uid, prompt, result) {
  const id = newId();
  await env.BOT_KV.put(`aimg:p:${id}`, JSON.stringify({ uid, prompt }), {
    expirationTtl: 604800,
  });
  const kb = {
    inline_keyboard: [
      [{ text: "🔄 重新生成", callback_data: `aimg:re:${id}` }],
    ],
  };
  const caption = `🎨 ${prompt.slice(0, 200)}`;
  if (result.url)
    return tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: result.url,
      caption,
      reply_markup: kb,
    });
  const bytes = Uint8Array.from(atob(result.b64), (c) => c.charCodeAt(0));
  return sendPhotoBytes(env, chatId, bytes, caption, kb);
}
async function runDraw(env, chatId, uid, prompt) {
  const q = await quotaLeft(env, uid);
  if (q.left <= 0)
    return send(env, chatId, `今日额度已用完（${q.limit} 张/天），明天再来 🎨`);
  await send(env, chatId, "🎨 正在生成，稍等几秒…");
  try {
    const result = await genImage(env, prompt);
    await quotaUse(env, uid);
    const q2 = await quotaLeft(env, uid);
    await deliver(env, chatId, uid, prompt, result);
    return send(env, chatId, `今日还剩 ${q2.left} 张额度。`);
  } catch (e) {
    return send(env, chatId, `⚠️ 生成失败：${e.message}（本次不扣额度）`);
  }
}

// 管理员白名单与分级命令菜单（本 Bot 无管理员命令，菜单模块照常保留）
const COMMANDS_USER = [
  { command: "draw", description: "文字画图 /draw <描述>" },
  { command: "edit", description: "回复图片改图 /edit <描述>" },
  { command: "quota", description: "今日剩余额度" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  return tg(env, "setMyCommands", { commands: COMMANDS_USER });
}

// ============================================================
// Worker 入口与路由
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("ai-image bot is running.", {
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

// 取消息里的图片字节：photo 取最大尺寸，document 里图片类型也认。
async function fetchPhotoBytes(env, msg) {
  let fileId = null;
  if (msg.photo?.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && /^image\//.test(msg.document.mime_type || ""))
    fileId = msg.document.file_id;
  if (!fileId) return null;
  const f = await tg(env, "getFile", { file_id: fileId });
  if (!f.ok) return null;
  const r = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`,
  );
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

// ============================================================
// 业务主流程
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) {
    const m = update.message;
    if (m)
      return send(
        env,
        m.chat.id,
        "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。",
      );
    return;
  }
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (!data.startsWith("aimg:re:")) return;
    const raw = await env.BOT_KV.get("aimg:p:" + data.slice(8));
    if (!raw)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这张图的提示词已过期，重新 /draw 吧",
        show_alert: true,
      });
    const rec = JSON.parse(raw);
    if (rec.uid !== cq.from.id)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这是别人的图，用 /draw 画你自己的",
        show_alert: true,
      });
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "🔄 重新生成中…",
    });
    if (!configured(env)) return send(env, cq.message.chat.id, NOT_CONFIGURED);
    return runDraw(env, cq.message.chat.id, cq.from.id, rec.prompt);
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || msg.caption || "").trim();
  const cmd = text.split(/ +/)[0].split("@")[0];

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "🎨 AI 绘图 Bot\n\n/draw <描述> 文字画图\n回复任意一张图发 /edit <描述> 按描述改图\n/quota 看今日剩余额度\n\n例：/draw 一只戴墨镜的柴犬，水彩风",
    );
  if (cmd === "/quota") {
    const q = await quotaLeft(env, uid);
    return send(
      env,
      chatId,
      `今日已画 ${q.used} 张，还剩 ${q.left} 张（上限 ${q.limit} 张/天）。`,
    );
  }
  if (cmd === "/draw") {
    const prompt = text.replace(/^\/draw(@\w+)?\s*/, "").trim();
    if (!prompt)
      return send(
        env,
        chatId,
        "用法：/draw <画面描述>，如 /draw 雨夜里的东京小巷，赛博朋克风",
      );
    if (!configured(env)) return send(env, chatId, NOT_CONFIGURED);
    return runDraw(env, chatId, uid, prompt.slice(0, 1000));
  }
  if (cmd === "/edit") {
    const prompt = text.replace(/^\/edit(@\w+)?\s*/, "").trim();
    if (!prompt)
      return send(
        env,
        chatId,
        "用法：回复一张图，再发 /edit <想怎么改>，如 /edit 把背景换成海边日落",
      );
    if (!configured(env)) return send(env, chatId, NOT_CONFIGURED);
    const srcMsg = msg.reply_to_message || msg;
    const bytes = await fetchPhotoBytes(env, srcMsg);
    if (!bytes)
      return send(
        env,
        chatId,
        "没找到要改的图：请回复一张图片发 /edit，或把图片和 /edit 描述发在一起。",
      );
    const q = await quotaLeft(env, uid);
    if (q.left <= 0)
      return send(
        env,
        chatId,
        `今日额度已用完（${q.limit} 张/天），明天再来 🎨`,
      );
    await send(env, chatId, "🖌 正在改图，稍等几秒…");
    try {
      const result = await editImage(env, bytes, prompt.slice(0, 1000));
      await quotaUse(env, uid);
      return deliver(env, chatId, uid, prompt, result);
    } catch (e) {
      return send(
        env,
        chatId,
        `⚠️ 改图失败：${e.message}（本次不扣额度）。注意：部分绘图 API 不支持 edits 改图口径，换支持改图的模型或用 /draw。`,
      );
    }
  }
}
