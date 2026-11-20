// ============================================================
// 64 TTS 语音合成 Bot（单文件 · Cloudflare Workers）
// 功能：
// 把文字读出来：/tts 文本，或回复一条文字消息发 /tts，Bot 调外部
// TTS API 合成后以语音条（sendVoice）回传；长文本按句子自动分段，
// 一段一条语音。音色在下方 CONFIG 改（VOICE）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// TTS_API_URL TTS 接口地址（OpenAI audio/speech 兼容口径，
// 如 https://api.openai.com/v1/audio/speech，未配时 /tts 给申请说明）
// TTS_API_KEY 上述接口的 Key（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// 选填 KV：Bindings 添加 KV，变量名 BOT_KV（只用于每日限额计数
// tts:cnt:<用户ID>:<日期>；不绑 KV 也能合成，只是不限量）。
// ⚠️ Workers 没有本地语音合成/转码能力：接口必须能直接返回
// ogg/opus 才能发语音条；返回 mp3 时自动退化为 sendAudio 音频文件。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 30（语音转文字的反向）+ 模块 19（外部 API）+ 模块 01（骨架）
// ============================================================

// ============================================================
// 配置区
// VOICE 音色（OpenAI 口径可选 alloy/echo/fable/onyx/nova/shimmer，
// 换其他厂商接口时以对方文档为准）；MODEL 合成模型；
// SEG_LIMIT 单段最长字数（接口普遍有单次上限，长文本靠分段）；
// DAILY_LIMIT 每人每天最多合成段数（绑了 KV 才生效）。
// ============================================================
const CONFIG = {
  VOICE: "alloy",
  MODEL: "tts-1",
  SEG_LIMIT: 400,
  DAILY_LIMIT: 30,
};

// ============================================================
// Telegram Bot API 通信层
// 统一封装 tg()：JSON 请求走这里；发语音要传二进制文件，
// 单独用 tgForm() 走 multipart/form-data（JSON 里塞不进音频字节）。
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
async function tgForm(env, method, fields, fileField, blob, filename) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  fd.append(fileField, blob, filename);
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      body: fd,
    },
  );
  return r.json().catch(() => ({}));
}

// ============================================================
// 文本分段
// 按句末标点切句再贪心拼段，每段不超过 SEG_LIMIT；
// 单句本身超长的按字数硬切。语音是一段一条，段界落在句界听感最好。
// ============================================================
function splitText(text, limit) {
  const sentences = text.match(/[^。！？!?\n]+[。！？!?\n]?/g) || [text];
  const segs = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > limit) {
      if (cur) segs.push(cur);
      cur = "";
      for (let i = 0; i < s.length; i += limit)
        segs.push(s.slice(i, i + limit));
      continue;
    }
    if ((cur + s).length > limit) {
      if (cur) segs.push(cur);
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

// ============================================================
// TTS 合成（OpenAI audio/speech 兼容口径）
// POST {model, input, voice, response_format:"opus"}，返回音频字节。
// 先要 opus 是为了 sendVoice（语音条只吃 OGG/Opus）；对方不支持
// opus 返回别的格式时，按 content-type 退化为 sendAudio 发文件。
// ============================================================
async function synthesize(env, text) {
  const r = await fetch(env.TTS_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.TTS_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model: CONFIG.MODEL,
      input: text,
      voice: CONFIG.VOICE,
      response_format: "opus",
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`TTS 接口 HTTP ${r.status}：${t.slice(0, 120)}`);
  }
  const type = r.headers.get("content-type") || "";
  const buf = await r.arrayBuffer();
  return { buf, type };
}
async function sendSpeech(env, chatId, text) {
  const { buf, type } = await synthesize(env, text);
  const blob = new Blob([buf], { type: type || "audio/ogg" });
  if (type.includes("mpeg") || type.includes("mp3"))
    return tgForm(
      env,
      "sendAudio",
      { chat_id: chatId, title: text.slice(0, 30) },
      "audio",
      blob,
      "speech.mp3",
    );
  return tgForm(
    env,
    "sendVoice",
    { chat_id: chatId },
    "voice",
    blob,
    "speech.ogg",
  );
}

// ============================================================
// 每日限额（KV 计数，可选）
// tts:cnt:<用户ID>:<UTC日期> 记已合成段数；合成前预检、成功后累加。
// 没绑 KV 时直接放行——限额是防滥用不是功能本体，README 会写清。
// ============================================================
const dayKey = () => new Date().toISOString().slice(0, 10);
async function usedToday(env, uid) {
  if (!env.BOT_KV) return 0;
  return Number((await env.BOT_KV.get(`tts:cnt:${uid}:${dayKey()}`)) || 0);
}
async function addUsed(env, uid, n) {
  if (!env.BOT_KV) return;
  const key = `tts:cnt:${uid}:${dayKey()}`;
  const cur = Number((await env.BOT_KV.get(key)) || 0);
  await env.BOT_KV.put(key, String(cur + n), { expirationTtl: 48 * 3600 });
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "tts", description: "朗读文本，如 /tts 你好世界（或回复消息）" },
  { command: "voice", description: "当前音色与配置" },
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
    for (const id of ids) {
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
    }
  }
  return r;
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
      return new Response("tts bot is running.", {
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
// /tts 三种取文本：命令后跟文本 > 回复的消息文本 > 报错给用法。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      `🔊 TTS 语音合成 Bot\n\n/tts 想朗读的文本 → 回你语音条\n或回复任意一条文字消息发 /tts 朗读它。\n长文本自动按句分段（每段 ≤ ${CONFIG.SEG_LIMIT} 字），一段一条语音。当前音色：${CONFIG.VOICE}。`,
    );
  if (cmd === "/voice")
    return send(
      env,
      chatId,
      `🎙️ 当前配置：音色 ${CONFIG.VOICE} · 模型 ${CONFIG.MODEL} · 每日上限 ${CONFIG.DAILY_LIMIT} 段${env.BOT_KV ? "" : "（未绑 KV，限额未生效）"}\n改音色：改 worker.js 顶部 CONFIG.VOICE 后重新部署。`,
    );
  if (cmd !== "/tts") return;

  if (!env.TTS_API_URL)
    return send(
      env,
      chatId,
      "⚠️ 还没配置 TTS 接口，读不了。\n需要两个变量：TTS_API_URL（OpenAI audio/speech 兼容接口地址，如 https://api.openai.com/v1/audio/speech）和 TTS_API_KEY。\nKey 申请：OpenAI 在 platform.openai.com 注册后创建 API Key；也可以用任何兼容该口径的第三方/自建接口。配置办法见 README。",
    );

  let content = text.replace(/^\/tts(@\w+)?\s*/, "").trim();
  if (!content && msg.reply_to_message?.text)
    content = msg.reply_to_message.text.trim();
  if (!content)
    return send(
      env,
      chatId,
      "用法：/tts 要朗读的文本，或回复一条消息发 /tts。",
    );

  const segs = splitText(content, CONFIG.SEG_LIMIT);
  const used = await usedToday(env, uid);
  if (env.BOT_KV && used + segs.length > CONFIG.DAILY_LIMIT)
    return send(
      env,
      chatId,
      `🚫 今天的额度不够了：已用 ${used}/${CONFIG.DAILY_LIMIT} 段，这段文本要 ${segs.length} 段。明天再来，或缩短文本。`,
    );
  await send(env, chatId, `🔊 合成中（${segs.length} 段）…`);
  let done = 0;
  try {
    for (const seg of segs) {
      const r = await sendSpeech(env, chatId, seg);
      if (!r.ok) throw new Error(r.description || "Telegram 发送语音失败");
      done++;
    }
  } catch (e) {
    await addUsed(env, uid, done);
    return send(
      env,
      chatId,
      `😵 合成中断（已发 ${done}/${segs.length} 段）：${String(e.message || e).slice(0, 180)}`,
    );
  }
  await addUsed(env, uid, done);
}
