// ============================================================
// 42 Mini App 三件套 Bot（单文件 · Cloudflare Workers · 建议绑定 KV）
// 功能：
// 一个 Worker 同时干三件事——Telegram Bot + Mini App 网页 + 后端 API：
// · Bot 侧：/app 发 web_app 按钮（inline 版 + 键盘版两种入口）
// · 网页侧：GET /app 返回一个自包含 HTML 演示页（个人名片 + 留言板），
// 页面在 Telegram 里打开，自带 Telegram.WebApp SDK 交互
// · API 侧：POST /api/verify 验 initData 签名回显可信用户；
// POST /api/message 验签后把留言存进 KV（mini:<用户ID>）
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// APP_URL Mini App 页面的完整地址，即 https://你的Worker域名/app
// （web_app 按钮必须填绝对地址，部署完 Worker 后回来补这个变量）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 留言功能需要 KV：Bindings 添加 KV，变量名 BOT_KV；不绑也能开
// 页面和验签，只是留言存不下来（接口会明确报错）。
// ⚠️ initData 必须在服务端验签：页面里的 initDataUnsafe 是未验签
// 数据，只能预填界面，绝不能当身份凭证（原理见模块 28）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 28（Mini App）+ 模块 01（骨架）+ 模块 02（分级菜单）
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

// ============================================================
// Mini App initData 验签（HMAC-SHA-256）
// 网页把 Telegram.WebApp.initData 原样 POST 过来，本函数按官方算法
// 验签：secret = HMAC(key="WebAppData", data=BOT_TOKEN)，再对排序后
// 的字段串做 HMAC 与 hash 比对；顺带查 auth_date 新鲜度（1 小时）。
// 返回 user 对象 = 身份可信；返回 null = 伪造/过期，接口直接拒绝。
// ============================================================
const enc = new TextEncoder();
async function hmac(keyBytes, dataStr) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dataStr));
  return new Uint8Array(sig);
}
const toHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
async function validateInitData(env, initData, maxAgeSec = 3600) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), env.BOT_TOKEN);
  const calc = toHex(await hmac(secret, dataCheckString));
  if (calc !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

// ============================================================
// Mini App 演示页（Worker 自托管的自包含 HTML）
// 个人名片 + 留言板：打开先 POST /api/verify 拿服务端验签结果再
// 渲染「已验签」徽标；留言提交走 /api/message。页面里只用
// initDataUnsafe 预填界面，身份一律以服务端验签返回为准。
// ============================================================
const APP_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mini App 演示</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#222)}
.card{border:1px solid #8883;border-radius:14px;padding:16px;margin-bottom:16px}
.avatar{width:56px;height:56px;border-radius:50%;background:#5b8def;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#e6f4ea;color:#137333}
.badge.bad{background:#fdecea;color:#a50e0e}
textarea{width:100%;box-sizing:border-box;min-height:72px;border-radius:10px;border:1px solid #8885;padding:10px;font-size:15px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff);font-size:16px;margin-top:10px}
.small{font-size:13px;opacity:.75}
</style>
</head>
<body>
<div class="card">
<div style="display:flex;gap:12px;align-items:center">
<div class="avatar" id="avatar">?</div>
<div>
<div id="name" style="font-size:18px;font-weight:700">加载中…</div>
<div class="small" id="meta">正在向服务端验签…</div>
<span class="badge bad" id="badge">未验签</span>
</div>
</div>
</div>
<div class="card">
<div style="font-weight:700;margin-bottom:8px">📝 给 Bot 留言</div>
<textarea id="text" placeholder="写一句留言，提交后存进 Bot 的 KV，私聊发 /mymsgs 能看到"></textarea>
<button id="submit">提交留言</button>
<div class="small" id="status" style="margin-top:8px"></div>
</div>
<p class="small">演示页由同一个 Worker 托管。身份徽标来自服务端 HMAC 验签，不是页面自说自话。</p>
<script>
var tgApp = window.Telegram.WebApp;
tgApp.ready();
tgApp.expand();
var unsafeUser = (tgApp.initDataUnsafe || {}).user || null;
if (unsafeUser) {
document.getElementById("avatar").textContent = (unsafeUser.first_name || "?").slice(0, 1);
document.getElementById("name").textContent = unsafeUser.first_name + (unsafeUser.last_name? " " + unsafeUser.last_name: "");
document.getElementById("meta").textContent = "ID " + unsafeUser.id + (unsafeUser.username? " · @" + unsafeUser.username: "");
}
fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json"}, body: JSON.stringify({ initData: tgApp.initData})})
.then(function (r) { return r.json();})
.then(function (d) {
var badge = document.getElementById("badge");
if (d.ok) { badge.textContent = "✅ 服务端验签通过"; badge.className = "badge";}
else { badge.textContent = "⛔ 验签失败（可能不是从 Telegram 打开）";}
})
.catch(function () { document.getElementById("badge").textContent = "⛔ 验签请求失败";});
document.getElementById("submit").onclick = function () {
var text = document.getElementById("text").value.trim();
var status = document.getElementById("status");
if (!text) { status.textContent = "先写点内容再提交。"; return;}
status.textContent = "提交中…";
fetch("/api/message", { method: "POST", headers: { "content-type": "application/json"}, body: JSON.stringify({ initData: tgApp.initData, text: text})})
.then(function (r) { return r.json();})
.then(function (d) {
status.textContent = d.ok? "✅ 已保存，去私聊发 /mymsgs 查看。": "⛔ " + (d.error || "提交失败");
if (d.ok) document.getElementById("text").value = "";
})
.catch(function () { status.textContent = "⛔ 网络错误";});
};
</script>
</body>
</html>`;

// ============================================================
// 演示 API（验签后才办事）
// /api/verify：只验签回显用户。/api/message：验签 → 留言存 KV
// mini:<用户ID> = [{ text, at}]（最多留 20 条）。两个接口都先过
// validateInitData，验不过一律 403，绝不信任页面自报的 user.id。
// ============================================================
async function apiVerify(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await validateInitData(env, body.initData || "");
  if (!user)
    return Response.json(
      { ok: false, error: "initData 验签失败" },
      { status: 403 },
    );
  return Response.json({ ok: true, user });
}
async function apiMessage(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await validateInitData(env, body.initData || "");
  if (!user)
    return Response.json(
      { ok: false, error: "initData 验签失败" },
      { status: 403 },
    );
  if (!env.BOT_KV)
    return Response.json(
      { ok: false, error: "Bot 未绑定 KV，留言存不下来" },
      { status: 500 },
    );
  const text = String(body.text || "")
    .trim()
    .slice(0, 500);
  if (!text)
    return Response.json({ ok: false, error: "留言内容为空" }, { status: 400 });
  const key = "mini:" + user.id;
  const list = JSON.parse((await env.BOT_KV.get(key)) || "[]");
  list.unshift({ text, at: Date.now() });
  await env.BOT_KV.put(key, JSON.stringify(list.slice(0, 20)));
  return Response.json({ ok: true });
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 无管理员命令，COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "app", description: "打开 Mini App（消息按钮版）" },
  { command: "kb", description: "打开 Mini App（键盘按钮版）" },
  { command: "mymsgs", description: "看我在应用里留的言" },
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
// Worker 入口与路由（三件套总闸）
// 一个 fetch 分三路：/app 出网页、/api/* 走 API、/webhook 走 Bot。
// 网页地址就是 Worker 自己的域名，不用再单独部署前端。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("mini-app bot is running. Mini App page: /app", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname === "/app")
      return new Response(APP_HTML, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    if (url.pathname === "/api/verify" && request.method === "POST")
      return apiVerify(request, env);
    if (url.pathname === "/api/message" && request.method === "POST")
      return apiMessage(request, env);
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
// /app 发 inline web_app 按钮（群里也能用）；/kb 发键盘 web_app
// 按钮（只有它打开的应用能用 sendData 回传，见 web_app_data 分支）。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  if (msg.web_app_data) {
    // 键盘按钮打开的应用通过 sendData 回传的数据（≤4096 字节）
    return send(
      env,
      chatId,
      "✅ 已收到应用回传的数据：" +
        String(msg.web_app_data.data || "").slice(0, 300),
    );
  }

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🧩 Mini App 三件套演示 Bot\n\n/app 打开演示应用（消息下方按钮）\n/kb 打开演示应用（键盘按钮，只有这种入口能用 sendData 回传）\n应用里可以看个人名片（服务端验签）和留一条言，/mymsgs 查看留言。\n\n网页、API、Bot 是同一个 Worker：网页地址就是 /app。",
    );

  // web_app 按钮的 URL 必须是本 Worker 的 /app：从 BOT 的 webhook 域名推不出来，
  // 用环境变量 APP_URL 显式配置（部署时填 https://你的Worker域名/app）。
  if (cmd === "/app") {
    if (!env.APP_URL)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置 APP_URL（应填本 Worker 的 /app 完整地址）。",
      );
    return send(env, chatId, "点按钮打开 Mini App 👇", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧩 打开演示应用", web_app: { url: env.APP_URL } }],
        ],
      },
    });
  }
  if (cmd === "/kb") {
    if (!env.APP_URL)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置 APP_URL（应填本 Worker 的 /app 完整地址）。",
      );
    if (msg.chat.type !== "private")
      return send(env, chatId, "键盘按钮只在私聊里有，私聊我发 /kb。");
    return send(
      env,
      chatId,
      "点输入框旁键盘上的按钮打开应用 👇（这种入口才能用 sendData 回传数据）",
      {
        reply_markup: {
          keyboard: [
            [{ text: "🧩 打开演示应用", web_app: { url: env.APP_URL } }],
          ],
          resize_keyboard: true,
        },
      },
    );
  }
  if (cmd === "/mymsgs") {
    if (!env.BOT_KV)
      return send(env, chatId, "⚠️ 本 Bot 未绑定 KV，留言功能不可用。");
    const list = JSON.parse(
      (await env.BOT_KV.get("mini:" + msg.from.id)) || "[]",
    );
    if (!list.length)
      return send(env, chatId, "你还没有留言，先 /app 打开应用留一条。");
    return send(
      env,
      chatId,
      "📝 你的留言\n\n" +
        list
          .map(
            (m, i) =>
              `${i + 1}. ${m.text}（${new Date(m.at).toLocaleString("zh-CN")}）`,
          )
          .join("\n"),
    );
  }
}
