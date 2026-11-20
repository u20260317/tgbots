// ============================================================
// 39 GitHub 通知 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 把 GitHub 仓库事件推到绑定的 Telegram 聊天（私聊或群）：
// 在聊天里发 /ghbind 拿到专属 Webhook 地址 + 密钥，填进 GitHub 仓库
// Settings → Webhooks；之后 push / Pull Request / Issue / Release
// 事件会格式化成中文消息推过来。每个聊天一份独立密钥，HMAC 验签。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥（管 /setWebhook 与 TG 侧 webhook 验签）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（可在任何群绑定/解绑）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：gh:<聊天ID> = { secret, by, at}，一个聊天一份绑定。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 41（通知适配器）+ 模块 20（推送 API 的 HTTP 入口姿势）+ 模块 01（骨架）
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
const randHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ============================================================
// GitHub Webhook 验签（HMAC-SHA256）
// GitHub 用你填的 Secret 对原始请求体算 HMAC-SHA256，放在
// X-Hub-Signature-256: sha256=<hex>。必须用「原始字节」验，不能先
// JSON 解析再序列化（空格/转义一变签名就对不上）。比较用恒定时间防时序攻击。
// ============================================================
async function hmacHex(secret, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyGithub(secret, rawBody, header) {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = await hmacHex(secret, rawBody);
  return timingSafeEqual(expected, header.slice(7));
}

// ============================================================
// 事件格式化
// 只挑高频事件：ping（连通确认）、push、pull_request、issues、release。
// 其他事件安静返回 200 不推送，避免刷屏；想加事件往 formatEvent 里补分支。
// ============================================================
function formatEvent(event, p) {
  const repo = p?.repository?.full_name || "仓库";
  if (event === "ping")
    return `🔌 GitHub Webhook 连通成功！\n仓库：${repo}\n现在 push / PR / Issue / Release 都会推到这里。`;
  if (event === "push") {
    const commits = (p.commits || []).slice(0, 5);
    const lines = commits.map(
      (c) =>
        `· ${String(c.message || "").split("\n")[0]}（${c.author?.name || "?"}）`,
    );
    const more =
      (p.commits || []).length > 5 ? `\n…共 ${p.commits.length} 个提交` : "";
    return `📦 ${repo} 有新推送\n分支：${String(p.ref || "").replace("refs/heads/", "")}\n${lines.join("\n")}${more}\n${p.compare || ""}`;
  }
  if (event === "pull_request") {
    const pr = p.pull_request || {};
    const act = {
      opened: "🆕 新建",
      closed: pr.merged ? "🟣 已合并" : "🔴 已关闭",
      reopened: "♻️ 重新打开",
    }[p.action];
    if (!act) return null;
    return `${act} PR #${pr.number}：${pr.title}\n作者：${pr.user?.login}\n${pr.html_url}`;
  }
  if (event === "issues") {
    const issue = p.issue || {};
    const act = {
      opened: "🐛 新 Issue",
      closed: "✅ Issue 已关闭",
      reopened: "♻️ Issue 重开",
    }[p.action];
    if (!act) return null;
    return `${act} #${issue.number}：${issue.title}\n作者：${issue.user?.login}\n${issue.html_url}`;
  }
  if (event === "release") {
    if (p.action !== "published") return null;
    const rel = p.release || {};
    return `🚀 ${repo} 发布新版本 ${rel.tag_name}：${rel.name || ""}\n${rel.html_url}`;
  }
  return null;
}

// GitHub 入口：POST /github/<聊天ID>，按该聊天的密钥验签后推送。
async function handleGithub(request, env, chatId) {
  const raw = await env.BOT_KV.get("gh:" + chatId);
  if (!raw) return new Response("not bound", { status: 404 });
  const bind = JSON.parse(raw);
  const body = await request.text();
  const ok = await verifyGithub(
    bind.secret,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  if (!ok) return new Response("bad signature", { status: 401 });
  const event = request.headers.get("x-github-event") || "";
  let payload = {};
  try {
    payload = JSON.parse(body);
  } catch (e) {
    return new Response("bad json", { status: 400 });
  }
  const text = formatEvent(event, payload);
  if (text)
    await send(env, Number(chatId), text, { disable_web_page_preview: true });
  return new Response("ok");
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
  { command: "ghbind", description: "绑定本聊天接收 GitHub 通知" },
  { command: "ghinfo", description: "查看绑定信息" },
  { command: "ghunbind", description: "解除绑定" },
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
// 三条路：/setWebhook 挂载 TG、/webhook 收 TG 更新、/github/<聊天ID> 收 GitHub 事件。
// GitHub 那条不走 TG 的 secret_token，靠每聊天独立的 HMAC 密钥验签。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("github-notify bot is running.", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname.startsWith("/github/") && request.method === "POST") {
      if (!env.BOT_KV) return new Response("KV 未绑定", { status: 500 });
      return handleGithub(request, env, url.pathname.slice("/github/".length));
    }
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
    // 把 Worker 域名带给业务层（拼 GitHub Webhook 地址要用）
    update.__origin = url.origin;
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};

// ============================================================
// 业务主流程
// 绑定/解绑/查看。群里绑定要群管理员（或 Bot 管理员），私聊无限制。
// ============================================================
async function canManage(env, msg) {
  if (msg.chat.type === "private") return true;
  if (isAdmin(env, msg.from.id)) return true;
  const r = await tg(env, "getChatMember", {
    chat_id: msg.chat.id,
    user_id: msg.from.id,
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}

async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const origin = update.__origin || "";

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🔔 GitHub 通知 Bot\n\n1️⃣ 在想收通知的聊天（私聊或群）发 /ghbind\n2️⃣ 把 Bot 给的地址和密钥填进 GitHub 仓库 Settings → Webhooks（Content type 选 application/json）\n3️⃣ 保存后 GitHub 会 ping 一次，连通成功就有消息\n\n支持事件：push、Pull Request、Issue、Release。",
    );
  if (!["/ghbind", "/ghinfo", "/ghunbind"].includes(cmd)) return;
  if (!env.BOT_KV)
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");
  if (!(await canManage(env, msg)))
    return send(env, chatId, "⛔ 群里只有群管理员能管理 GitHub 绑定。");

  if (cmd === "/ghbind") {
    const secret = randHex(24);
    await env.BOT_KV.put(
      "gh:" + chatId,
      JSON.stringify({ secret, by: msg.from.id, at: Date.now() }),
    );
    return send(
      env,
      chatId,
      `✅ 已绑定本聊天。把下面两项填进 GitHub 仓库 Settings → Webhooks → Add webhook：\n\nPayload URL：\n${origin}/github/${chatId}\n\nSecret（只显示这一次，重新 /ghbind 会换新）：\n${secret}\n\nContent type 选 application/json，事件选 Just the push event 或 Let me select（勾 push / Pull requests / Issues / Releases）。`,
    );
  }
  if (cmd === "/ghinfo") {
    const raw = await env.BOT_KV.get("gh:" + chatId);
    if (!raw) return send(env, chatId, "本聊天还没绑定。发 /ghbind 绑定。");
    return send(
      env,
      chatId,
      `🔗 已绑定\nWebhook 地址：${origin}/github/${chatId}\n密钥不回显（忘了就重新 /ghbind 换新，并同步改 GitHub 里的 Secret）。`,
    );
  }
  if (cmd === "/ghunbind") {
    await env.BOT_KV.delete("gh:" + chatId);
    return send(
      env,
      chatId,
      "🔕 已解除绑定。记得去 GitHub 仓库里删掉对应的 Webhook。",
    );
  }
}
