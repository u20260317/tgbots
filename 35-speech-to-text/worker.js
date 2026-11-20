// ============================================================
// 35 语音转文字 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 把语音/音频消息转成文字：私聊发语音自动转写回复；
// 群里默认不开，群管理员发 /stt on 开启后，本群语音自动转写（回复在原语音下）。
// 转写走 Whisper 兼容接口（/audio/transcriptions），带时长护栏防刷额度。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// STT_API_KEY 转写 API Key（Secret）
// 选填：
// STT_API_BASE 接口基地址，默认 https://api.openai.com/v1（任何 Whisper 兼容服务均可）
// STT_MODEL 模型名，默认 whisper-1
// STT_LANG 识别语言，默认 zh（留空则自动检测）
// STT_MAX_SECONDS 单条语音最长秒数，默认 300，超长直接拒绝（护栏）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（可在任何群强制开关）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（只存群开关 stt:on:<群ID>）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ⚠️ 群里用要去 @BotFather /setprivacy 关掉隐私模式，否则收不到普通语音消息。
// 拼装来源：模块 30（语音转文字）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));

// ============================================================
// 语音下载 + 转写（Whisper 兼容）
// 两步走：getFile 拿 file_path → 从 api.telegram.org/file 下载二进制 →
// multipart 表单 POST 到 {STT_API_BASE}/audio/transcriptions。
// Telegram 机器人下载上限 20MB，超大音频 Telegram 侧就拿不到，先在时长上拦。
// ============================================================
async function transcribe(env, fileId) {
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
  if (env.STT_LANG !== "") form.append("language", env.STT_LANG || "zh");
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

// 群自动转写开关：stt:on:<群ID> = "1"，没有就是关。
async function groupEnabled(env, chatId) {
  return (await env.BOT_KV.get("stt:on:" + chatId)) === "1";
}
async function isGroupAdmin(env, chatId, userId) {
  if (isAdmin(env, userId)) return true;
  const r = await tg(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}

// ============================================================
// 管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
// · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
// · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
// 于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
// 的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "stt", description: "群里自动转写开关（群管理员）" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  // 先注册默认菜单（所有人可见的用户命令）
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  // 再给白名单里每个管理员单独注册全集菜单（只在他私聊里生效）
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
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("speech-to-text bot is running.", {
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
// 私聊：语音/音频一律转写。群里：先看开关，再看是不是语音，是才转。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === "private";
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🎙️ 语音转文字 Bot\n\n私聊：直接发语音，我转成文字回给你。\n群里：群管理员发 /stt on 开启自动转写后，本群所有语音都会被转写（回复在原语音下方）。",
    );

  // ---------- 群开关 ----------
  if (cmd === "/stt") {
    if (isPrivate) return send(env, chatId, "私聊不用开开关，直接发语音就行。");
    if (!env.BOT_KV)
      return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");
    const arg = text.split(/\s+/)[1];
    if (arg === "on" || arg === "off") {
      if (!(await isGroupAdmin(env, chatId, msg.from.id)))
        return send(env, chatId, "⛔ 只有群管理员能改这个开关。");
      if (arg === "on") await env.BOT_KV.put("stt:on:" + chatId, "1");
      else await env.BOT_KV.delete("stt:on:" + chatId);
      return send(
        env,
        chatId,
        arg === "on"
          ? "✅ 本群自动转写已开启，发语音试试。"
          : "🔕 本群自动转写已关闭。",
      );
    }
    const on = await groupEnabled(env, chatId);
    return send(
      env,
      chatId,
      `本群自动转写：${on ? "✅ 开" : "❌ 关"}\n群管理员发 /stt on 或 /stt off 切换。`,
    );
  }

  // ---------- 语音/音频转写 ----------
  const media = msg.voice || msg.audio;
  if (!media) return;
  if (!isPrivate) {
    if (!env.BOT_KV || !(await groupEnabled(env, chatId))) return;
  }
  if (!env.STT_API_KEY)
    return send(env, chatId, "⚠️ 管理员还没配置 STT_API_KEY，暂时转不了。");
  const maxSec = Number(env.STT_MAX_SECONDS) || 300;
  if (media.duration && media.duration > maxSec)
    return send(
      env,
      chatId,
      `⏱️ 这条语音 ${media.duration} 秒，超过上限 ${maxSec} 秒，怕烧额度就不转啦。剪短点再发。`,
      { reply_to_message_id: msg.message_id },
    );
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(
    () => {},
  );
  try {
    const out = await transcribe(env, media.file_id);
    return send(
      env,
      chatId,
      `📝 转写：\n${out || "（没听清，好像是空语音）"}`,
      {
        reply_to_message_id: msg.message_id,
      },
    );
  } catch (e) {
    return send(
      env,
      chatId,
      `😵 转写失败：${String(e.message || e).slice(0, 200)}`,
      { reply_to_message_id: msg.message_id },
    );
  }
}
