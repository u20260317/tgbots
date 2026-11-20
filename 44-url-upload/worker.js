// ============================================================
// 44 URL 上传转存 Bot（单文件 · Cloudflare Workers · KV 可选）
// 功能：
// 用户丢一个外网链接进来，Bot 把文件搬进 Telegram：先 HEAD 体检
// （大小/类型）+ SSRF 私有地址拦截，再按大小三路分流——≤20MB 让
// Telegram 服务器自己抓、20-50MB Worker 中转上传、>50MB 回直链。
// 转存成功后顺手存一份 file_id（f: 前缀，与 06 文件分享同约定），
// 回一个取件链接，别人点链接即可领取，不重复搬运。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// BOT_USERNAME 本 Bot 用户名（不带 @），拼取件链接用；不填则不回链接
// ADMIN_ID 本 Bot 无管理员命令，可不填
// KV 可选：绑定 BOT_KV 后才有取件码功能；不绑也能转存，只是不存档。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 40（URL 转存）+ 模块 08（文件存储）+ 模块 01（骨架）
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
const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// ============================================================
// URL 安全与体检（SSRF 防护 + HEAD 探活）
// 只许 http/https，字面拦掉 localhost 与私有/保留地址段——Bot 的
// fetch 是以服务器身份发出的，不能被当成扫内网的跳板。体检先
// HEAD 拿 content-length/type，源站回 405 时放行、靠中转时实测
// 大小兜底；超时用 AbortSignal 掐断，挂死的源站不拖住 webhook。
// ============================================================
function isSafePublicUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (
    /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fe80"))
    return false;
  return true;
}
async function probeUrl(u, timeoutMs = 8000) {
  const r = await fetch(u, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok && r.status !== 405) throw new Error("源站返回 " + r.status);
  return {
    size: Number(r.headers.get("content-length") || 0),
    type: r.headers.get("content-type") || "",
  };
}

// ============================================================
// 三路分流转存
// A. ≤20MB：sendDocument/sendVideo 的参数直接填 URL，TG 服务器去抓；
// B. A 失败或 20-50MB：Worker fetch 拉回字节 multipart 上传；
// C. >50MB：回原链接并说明。文件名从 URL 尾段取，取不到按类型拼。
// 转存成功把 file_id 存 f:<取件码>（与 06 同约定），回取件链接。
// ============================================================
const MB = 1024 * 1024;
function filenameOf(u, type) {
  let tail = "";
  try {
    tail = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
  } catch {}
  if (tail && tail.includes(".")) return tail.slice(0, 128);
  const ext = (type.split("/")[1] || "bin").split(";")[0];
  return `file.${ext}`;
}
async function relayUrlToChat(env, chatId, u, fromId) {
  if (!isSafePublicUrl(u))
    return send(env, chatId, "⛔ 这个链接不合法或指向内网/保留地址，已拒绝。");
  let probe;
  try {
    probe = await probeUrl(u);
  } catch (e) {
    return send(
      env,
      chatId,
      "😵 源站探不到：" + String(e.message || e).slice(0, 150),
    );
  }
  if (probe.size > 50 * MB)
    return send(
      env,
      chatId,
      `📦 文件约 ${Math.round(probe.size / MB)}MB，超过 Bot API 50MB 上限，先给你原链接：\n${u}`,
    );
  const isVideo = probe.type.startsWith("video/");
  const method = isVideo ? "sendVideo" : "sendDocument";
  const field = isVideo ? "video" : "document";
  let result = null;
  if (!probe.size || probe.size <= 20 * MB) {
    const r = await tg(env, method, { chat_id: chatId, [field]: u });
    if (r.ok) result = r.result;
    // TG 抓取失败（防盗链/超时）→ 落到路线 B 再试一次
  }
  if (!result) {
    let resp;
    try {
      resp = await fetch(u, { signal: AbortSignal.timeout(60000) });
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 下载失败：" + String(e.message || e).slice(0, 150),
      );
    }
    if (!resp.ok)
      return send(env, chatId, "😵 下载失败，源站返回 " + resp.status);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 50 * MB)
      return send(
        env,
        chatId,
        `📦 文件约 ${Math.round(buf.byteLength / MB)}MB，超过 50MB 上限，原链接：\n${u}`,
      );
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      field,
      new Blob([buf], { type: probe.type || undefined }),
      filenameOf(u, probe.type),
    );
    const up = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      { method: "POST", body: form },
    );
    const data = await up.json().catch(() => ({}));
    if (!data.ok)
      return send(
        env,
        chatId,
        "😵 上传到 Telegram 失败：" + (data.description || ""),
      );
    result = data.result;
  }
  // 存档 + 取件链接（需要 KV 与 BOT_USERNAME 才完整）
  const fileObj = result?.document || result?.video;
  if (env.BOT_KV && fileObj?.file_id) {
    const code = newCode();
    await env.BOT_KV.put(
      "f:" + code,
      JSON.stringify({
        kind: field,
        id: fileObj.file_id,
        name: filenameOf(u, probe.type),
        caption: "",
      }),
    );
    if (env.BOT_USERNAME)
      await send(
        env,
        chatId,
        `✅ 已转存「${filenameOf(u, probe.type)}」\n🔗 取件链接：https://t.me/${env.BOT_USERNAME}?start=f_${code}\n（任何人点链接即可领取；删档在 KV 里删键 f:${code}）`,
      );
  }
  return result;
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 无管理员命令，COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "up", description: "转存链接：/up 网址" },
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
      return new Response("url-upload bot is running.", {
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
// 私聊/群里直接贴链接即转存，也可 /up <链接>；/start f_<码> 领取
// 已转存文件。转存的是用户提供的链接内容，版权责任在提供者。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start") {
    const m = text.match(/\/start(?:@\w+)?\s+f_(\w+)/);
    if (m) {
      if (!env.BOT_KV)
        return send(env, chatId, "⚠️ 本 Bot 未绑定 KV，取件功能不可用。");
      const raw = await env.BOT_KV.get("f:" + m[1]);
      if (!raw) return send(env, chatId, "😢 这个取件码不存在或已删除。");
      const f = JSON.parse(raw);
      const method =
        {
          document: "sendDocument",
          video: "sendVideo",
          photo: "sendPhoto",
          audio: "sendAudio",
        }[f.kind] || "sendDocument";
      return tg(env, method, {
        chat_id: chatId,
        [f.kind]: f.id,
        caption: f.caption || undefined,
      });
    }
    return send(
      env,
      chatId,
      "🔗 URL 转存 Bot\n\n把外网文件链接直接发给我（或 /up <链接>），我把它搬进 Telegram 发回给你：小文件 TG 直抓、中文件我中转、超过 50MB 只能回链接。\n转存成功还会给一个取件链接（需管理员绑 KV 并配 BOT_USERNAME），别人点开就能领取。\n\n⚖️ 只转存你有权分发的内容。",
    );
  }

  let target = null;
  if (cmd === "/up") target = text.replace(/^\/up(@\w+)?\s*/, "").trim();
  else {
    const m = text.match(/https?:\/\/[^\s]+/);
    if (m && !text.startsWith("/")) target = m[0];
  }
  if (target) {
    await send(env, chatId, "⏳ 正在体检并转存，稍等…");
    return relayUrlToChat(env, chatId, target, msg.from.id);
  }
}
