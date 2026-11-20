// ============================================================
// 34 视频解析下载 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 用户贴视频页链接（YouTube/TikTok/IG/X/B站等），Bot 给出画质按钮，
// 点选后调用「解析服务」拿直链，再用 sendVideo 回传到聊天。
// ⚠️ Workers 里跑不了 yt-dlp/ffmpeg，解析必须外置：RESOLVER_API 填一个
// 你信任的解析服务地址（cobalt 兼容协议，见下方解析层注释），
// 不填则 Bot 只回演示提示、不实际解析。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// RESOLVER_API 解析服务基地址（如自建 cobalt 实例 https://你的实例域名）
// DL_DAILY_LIMIT 每人每日下载次数，默认 20
// ADMIN_ID 管理员数字 ID（看 /dlstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（存待选任务与用量计数）。
// 键设计：dl:<任务ID> 存待选链接（10 分钟过期）；dl:cnt:<用户ID>:<日期> 存当日次数。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ⚖️ 版权：只下载你有权下载的内容（自己上传的、无版权或已获授权的）。
// 本 Bot 不绕 DRM、不破付费墙；解析服务的合规性由部署者自担。
// 拼装来源：模块 32（视频下载管线）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
const dayKey = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const URL_RE = /https?:\/\/[^\s]+/i;

// ============================================================
// 解析层（可替换）
// resolveMedia(pageUrl, kind) → { url:直链, title, size?:字节数} 或抛错。
// 默认实现走 cobalt 兼容协议：POST {RESOLVER_API}/ ，JSON 体 {url, videoQuality,
// downloadMode}，响应 {status:"tunnel"/"redirect", url, filename}。
// 换解析源只改这一个函数：自建 cobalt、其他解析 API、自己的外置下载服务都行。
// 注意：解析源返回的直链常带时效与防盗链，拿到后要立刻用，别存。
// ============================================================
async function resolveMedia(env, pageUrl, kind) {
  if (!env.RESOLVER_API)
    throw new Error(
      "未配置解析服务（演示模式）：管理员需设置 RESOLVER_API 为 cobalt 兼容解析服务地址后才能真正下载。",
    );
  const base = env.RESOLVER_API.replace(/\/$/, "");
  const r = await fetch(base + "/", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      url: pageUrl,
      videoQuality: "720",
      downloadMode: kind === "a" ? "audio" : "auto",
      filenameStyle: "basic",
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.url)
    throw new Error(data?.error?.code || `解析服务 HTTP ${r.status}`);
  // 尝试探一下大小（有些 CDN 不给 content-length，拿不到就 undefined）
  let size;
  try {
    const h = await fetch(data.url, { method: "HEAD" });
    size = Number(h.headers.get("content-length")) || undefined;
  } catch (e) {}
  return { url: data.url, title: data.filename || "video", size };
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
const COMMANDS_USER = [{ command: "start", description: "使用说明" }];
const COMMANDS_ADMIN = [
  { command: "dlstats", description: "今日下载统计（管理员）" },
];
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
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("video-download bot is running.", {
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
// 贴链接 → 存任务 → 画质按钮（回调 dl:<v视频/a音频/x取消>:<任务ID>）→
// 解析 → 先探大小：>50MB（Bot API 上限）直接回直链；否则 sendVideo 传 URL，
// Telegram 拉不动（防盗链等）时兜底回直链。任务只认发起人，防别人替你点。
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
    if (!data.startsWith("dl:")) return;
    const [, kind, taskId] = data.split(":");
    const chatId = cq.message.chat.id;
    const raw = await env.BOT_KV.get("dl:" + taskId);
    if (!raw)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "任务已过期，重新发链接吧",
        show_alert: true,
      });
    const task = JSON.parse(raw);
    if (task.uid !== cq.from.id)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这是别人发的链接，等他自己选",
        show_alert: true,
      });
    if (kind === "x") {
      await env.BOT_KV.delete("dl:" + taskId);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: "已取消。",
      });
    }
    // 用量护栏（点选时才计数）
    const limit = Number(env.DL_DAILY_LIMIT) || 20;
    const cntKey = `dl:cnt:${cq.from.id}:${dayKey()}`;
    const used = Number(await env.BOT_KV.get(cntKey)) || 0;
    if (used >= limit) {
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `今天已下载 ${limit} 次，明天再来`,
        show_alert: true,
      });
    }
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "⏳ 解析中，稍等…",
    });
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: "⏳ 正在解析并拉取，视频大的话多等一会儿…",
    });
    try {
      const media = await resolveMedia(env, task.url, kind);
      await env.BOT_KV.put(cntKey, String(used + 1), {
        expirationTtl: 172800,
      });
      await env.BOT_KV.delete("dl:" + taskId);
      const MB = 1024 * 1024;
      if (media.size && media.size > 50 * MB) {
        return send(
          env,
          chatId,
          `📦 文件约 ${(media.size / MB).toFixed(1)}MB，超过 Bot API 50MB 上限，没法直接发进聊天。\n直链（有时效，尽快下）：\n${media.url}`,
        );
      }
      const payload =
        kind === "a"
          ? { chat_id: chatId, audio: media.url, caption: media.title }
          : {
              chat_id: chatId,
              video: media.url,
              caption: `${media.title}\n⚖️ 请只下载你有权下载的内容。`,
              supports_streaming: true,
            };
      const r = await tg(
        env,
        kind === "a" ? "sendAudio" : "sendVideo",
        payload,
      );
      if (!r.ok)
        return send(
          env,
          chatId,
          `😅 Telegram 没拉动这个直链（可能防盗链），直接给你链接自己下：\n${media.url}`,
        );
      return;
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 解析失败：${String(e.message || e).slice(0, 250)}`,
      );
    }
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🎬 视频解析下载 Bot\n\n把视频页链接发给我（YouTube/TikTok/IG/X/B站等），选画质后我把视频发回聊天。\n\n⚖️ 只下载你有权下载的内容；本 Bot 不绕 DRM、不破付费墙。\n⚠️ 超过 50MB 的文件受 Bot API 限制，只能回直链。",
    );

  if (cmd === "/dlstats") {
    if (!isAdmin(env, msg.from.id))
      return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "dl:cnt:", limit: 1000 });
    let users = 0,
      total = 0;
    for (const k of list.keys) {
      if (!k.name.endsWith(":" + dayKey())) continue;
      total += Number(await env.BOT_KV.get(k.name)) || 0;
      users++;
    }
    return send(env, chatId, `📊 今日下载：${total} 次 · ${users} 人`);
  }

  const m = text.match(URL_RE);
  if (m) {
    const taskId = newId();
    await env.BOT_KV.put(
      "dl:" + taskId,
      JSON.stringify({ url: m[0], uid: msg.from.id, t: Date.now() }),
      { expirationTtl: 600 },
    );
    return send(env, chatId, `收到链接：\n${m[0]}\n选一个：`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎬 视频", callback_data: `dl:v:${taskId}` },
            { text: "🎵 只要音频", callback_data: `dl:a:${taskId}` },
            { text: "❌ 取消", callback_data: `dl:x:${taskId}` },
          ],
        ],
      },
    });
  }
}
