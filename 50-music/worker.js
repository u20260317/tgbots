// ============================================================
// 50 音乐下载 / 识曲 Bot（单文件 · Cloudflare Workers · 需绑定 KV）
// 功能：
// · 贴音乐/视频链接 → 可替换解析层拿音频直链 → sendAudio 回传
// · 发语音/音频片段 → AudD 音频指纹识曲，回歌名/歌手/专辑与链接
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// MUSIC_RESOLVER_API cobalt 兼容解析服务地址；不填则下载走演示模式
// AUDD_API_TOKEN AudD 识曲 Token（Secret）；不填则识曲明确提示未配置
// DAILY_LIMIT 每人每天下载+识曲总次数，默认 10
// ADMIN_ID 管理员数字 ID（看 /musstats 用）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（限额与统计）。
// 键设计（模块 44）：mus:cnt:<用户>:<日期> 每日计数；mus:<用户ID> 累计次数。
// ⚖️ 版权边界：只处理公开可访问、你有权下载的内容；不绕 DRM、
// 不破付费墙、不做盗版分发。解析层是外部服务，Bot 只做通道。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 44（音乐下载与识曲）+ 模块 32（解析层模式）+ 模块 01（骨架）
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
const URL_RE = /https?:\/\/[^\s]+/i;

// ============================================================
// 音乐解析层（可替换）
// resolveMusic(pageUrl) → { url:直链, title, size?} 或抛错。默认走
// cobalt 兼容协议且只要音频（downloadMode:"audio"）；未配
// MUSIC_RESOLVER_API 抛演示模式错误，调用方原样提示。换源只改这里。
// ============================================================
async function resolveMusic(env, pageUrl) {
  if (!env.MUSIC_RESOLVER_API)
    throw new Error(
      "未配置解析服务（演示模式）：管理员需设置 MUSIC_RESOLVER_API 为 cobalt 兼容解析服务地址后才能真正下载。",
    );
  const base = env.MUSIC_RESOLVER_API.replace(/\/$/, "");
  const r = await fetch(base + "/", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      url: pageUrl,
      downloadMode: "audio",
      audioFormat: "mp3",
      filenameStyle: "basic",
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.url)
    throw new Error(data?.error?.code || `解析服务 HTTP ${r.status}`);
  let size;
  try {
    const h = await fetch(data.url, { method: "HEAD" });
    size = Number(h.headers.get("content-length")) || undefined;
  } catch {}
  return { url: data.url, title: data.filename || "audio", size };
}

// ============================================================
// 识曲（AudD 音频指纹）
// 把 TG 文件直链交给 AudD recognize 接口比对指纹，返回最接近的
// 歌曲信息；认不出返回 null（片段太短/太吵/翻唱都可能），回复时
// 用「最接近的是」口径，别把结果说成铁定事实。
// ============================================================
async function recognizeMusic(env, fileId) {
  const gf = await tg(env, "getFile", { file_id: fileId });
  if (!gf.ok) throw new Error("getFile 失败");
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
  const form = new FormData();
  form.append("api_token", env.AUDD_API_TOKEN);
  form.append("url", fileUrl);
  form.append("return", "spotify,apple_music");
  const r = await fetch("https://api.audd.io/", { method: "POST", body: form });
  const data = await r.json().catch(() => ({}));
  const hit = data?.result;
  if (!hit) return null;
  return {
    artist: hit.artist || "",
    title: hit.title || "",
    album: hit.album || "",
    releaseDate: hit.release_date || "",
    songLink: hit.song_link || "",
  };
}

// ============================================================
// sendAudio 回传与大小兜底
// ≤50MB 让 TG 直拉直链；超限或拉失败回直链。caption 带版权口径。
// ============================================================
async function deliverAudio(env, chatId, media) {
  const MB = 1024 * 1024;
  if (media.size && media.size > 50 * MB)
    return send(
      env,
      chatId,
      `📦 文件约 ${(media.size / MB).toFixed(1)}MB，超过 Bot API 50MB 上限。\n直链（有时效，尽快下）：\n${media.url}`,
    );
  const r = await tg(env, "sendAudio", {
    chat_id: chatId,
    audio: media.url,
    caption: `${media.title}\n⚖️ 请只下载你有权下载的内容。`,
  });
  if (!r.ok)
    return send(
      env,
      chatId,
      `😅 Telegram 没拉动这个直链（可能防盗链），直接给你链接：\n${media.url}`,
    );
}

// ============================================================
// 每日限额（KV）
// mus:cnt:<用户>:<日期> 计数，下载与识曲共用一个额度池（两个外部
// 服务都按次花钱/耗额度）；mus:<用户ID> 记累计，给管理员统计用。
// ============================================================
async function checkQuota(env, uid) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `mus:cnt:${uid}:${day}`;
  const used = Number((await env.BOT_KV.get(key)) || 0);
  const limit = Number(env.DAILY_LIMIT) || 10;
  if (used >= limit) return false;
  await env.BOT_KV.put(key, String(used + 1), { expirationTtl: 172800 });
  const total = Number((await env.BOT_KV.get("mus:" + uid)) || 0) + 1;
  await env.BOT_KV.put("mus:" + uid, String(total));
  return true;
}

// ============================================================
// 管理员白名单与分级命令菜单
// /musstats 是管理员命令，进 COMMANDS_ADMIN 只给白名单看；业务里
// 仍有 isAdmin 校验兜底（菜单隐藏不是安全边界）。
// ============================================================
const COMMANDS_USER = [
  { command: "whatsong", description: "回复一段音频/语音识曲" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "musstats", description: "累计使用统计（管理员）" },
];
const isAdmin = (env, uid) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(uid));
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  const ids = String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids)
    await tg(env, "setMyCommands", {
      commands: [...COMMANDS_USER, ...COMMANDS_ADMIN],
      scope: { type: "chat", chat_id: Number(id) },
    });
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
      return new Response("music bot is running.", {
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
// 链接 → 下载管线；语音/音频 → 识曲管线；两条管线共用每日限额，
// 各自的外部服务缺省时只关自己、不互相拖累。
// ============================================================
async function doRecognize(env, chatId, uid, fileId) {
  if (!env.AUDD_API_TOKEN)
    return send(
      env,
      chatId,
      "⚠️ 管理员还没配置识曲服务（AUDD_API_TOKEN），识曲暂时不可用。贴链接下载不受影响。",
    );
  if (!(await checkQuota(env, uid)))
    return send(env, chatId, "今日次数已达上限（下载+识曲共用），明天再来。");
  await send(env, chatId, "🎧 正在识曲，稍等…");
  try {
    const hit = await recognizeMusic(env, fileId);
    if (!hit)
      return send(
        env,
        chatId,
        "🤔 没认出来。片段太短、太吵或翻唱/现场版都可能认不出，换一段 5-15 秒的清晰片段再试。",
      );
    return send(
      env,
      chatId,
      `🎵 最接近的是：\n${hit.artist} — ${hit.title}${hit.album ? `\n专辑：${hit.album}` : ""}${hit.releaseDate ? `\n发行：${hit.releaseDate}` : ""}${hit.songLink ? `\n🔗 ${hit.songLink}` : ""}`,
    );
  } catch (e) {
    return send(
      env,
      chatId,
      "😵 识曲失败：" + String(e.message || e).slice(0, 200),
    );
  }
}
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (!env.BOT_KV)
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🎵 音乐 Bot\n\n· 把音乐/视频链接发给我，我解析出音频发回聊天（需管理员配解析服务）\n· 直接发一段语音/音频（5-15 秒最准），或回复音频发 /whatsong，我来识曲（需管理员配 AudD）\n· 每人每天共 " +
        (Number(env.DAILY_LIMIT) || 10) +
        " 次（下载+识曲共用）\n\n⚖️ 只下载你有权下载的内容；本 Bot 不绕 DRM、不破付费墙。",
    );

  if (cmd === "/musstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "mus:", limit: 1000 });
    let users = 0;
    let total = 0;
    for (const k of list.keys) {
      if (k.name.includes(":cnt:")) continue;
      users++;
      total += Number((await env.BOT_KV.get(k.name)) || 0);
    }
    return send(
      env,
      chatId,
      `📊 累计使用：${users} 位用户、共 ${total} 次（下载+识曲）。`,
    );
  }

  if (cmd === "/whatsong") {
    const t = msg.reply_to_message;
    const fileId = t?.audio?.file_id || t?.voice?.file_id;
    if (!fileId) return send(env, chatId, "回复一段音频或语音再发 /whatsong。");
    return doRecognize(env, chatId, uid, fileId);
  }

  // 直接发语音/音频 = 识曲
  const directFile = msg.audio?.file_id || msg.voice?.file_id;
  if (directFile) return doRecognize(env, chatId, uid, directFile);

  // 链接 = 下载
  const m = text.match(URL_RE);
  if (m && !text.startsWith("/")) {
    if (!(await checkQuota(env, uid)))
      return send(env, chatId, "今日次数已达上限（下载+识曲共用），明天再来。");
    await send(env, chatId, "⏳ 正在解析音频，稍等…");
    try {
      const media = await resolveMusic(env, m[0]);
      return deliverAudio(env, chatId, media);
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 解析失败：" + String(e.message || e).slice(0, 250),
      );
    }
  }
}
