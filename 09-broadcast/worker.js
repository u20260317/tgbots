// ============================================================
// 09 订阅群发 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：用户 /start 订阅、/stop 退订；管理员 /broadcast 把消息群发给全部订阅者
//       （直接发 /broadcast <文字>，或回复任意一条消息再发 /broadcast 转发群发）。
// 必填变量：
//   BOT_TOKEN  BotFather Token（Secret）
//   ADMIN_ID   管理员数字 ID，多个英文逗号隔开
// 选填：WEBHOOK_SECRET、WELCOME_TEXT
// ⚠️ 需要 KV：Bindings 里添加 KV Namespace，变量名必须叫 BOT_KV（存订阅者 ID 列表）。
// ⚠️ 规模说明：单次群发是逐个顺序发送，免费版 Worker 有执行时长限制，
//    适合几百人以内的小名单；上千人请分批或升级方案（见 README）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
// ============================================================
// 【核心模块】Telegram Bot API 通信层
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 【核心模块】订阅名单存储（KV）
// 订阅者 ID 列表存 KV 的 subs 键，订阅/退订/群发/清理失效名单都走这两个函数。
// ============================================================
async function subs(env) {
  const raw = await env.BOT_KV.get("subs");
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, list) {
  await env.BOT_KV.put("subs", JSON.stringify([...new Set(list)]));
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ============================================================
// 【核心模块】管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
//   · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
//   · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
//     于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
//     的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "订阅通知" },
  { command: "stop", description: "退订通知" },
];
const COMMANDS_ADMIN = [
  { command: "broadcast", description: "群发（管理员）" },
  { command: "count", description: "订阅人数（管理员）" },
];
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("broadcast bot is running.", {
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
// 【核心模块】业务主流程
// 订阅群发业务主流程（订阅/退订名单维护、管理员群发）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  if (!env.BOT_KV)
    return send(
      env,
      msg.chat.id,
      "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），管理员还没配置好。",
    );
  const text = msg.text || "";
  const uid = msg.from.id;
  const isAdmin = admins(env).includes(String(uid));

  if (text.startsWith("/start")) {
    const list = await subs(env);
    if (!list.includes(uid)) {
      list.push(uid);
      await saveSubs(env, list);
    }
    return send(
      env,
      msg.chat.id,
      env.WELCOME_TEXT || "✅ 已订阅！有重要通知会发到这里。退订发 /stop。",
    );
  }
  if (text.startsWith("/stop")) {
    await saveSubs(
      env,
      (await subs(env)).filter((x) => x !== uid),
    );
    return send(
      env,
      msg.chat.id,
      "已退订，不会再收到群发。重新订阅发 /start。",
    );
  }

  if (isAdmin && text.startsWith("/count"))
    return send(
      env,
      msg.chat.id,
      `👥 当前订阅人数：${(await subs(env)).length}`,
    );

  if (isAdmin && text.startsWith("/broadcast")) {
    const list = await subs(env);
    if (!list.length) return send(env, msg.chat.id, "还没有订阅者。");
    const body = text.replace(/^\/broadcast(@\w+)?\s*/, "");
    const source = msg.reply_to_message;
    if (!body && !source)
      return send(
        env,
        msg.chat.id,
        "用法：/broadcast <文字>，或回复一条消息再发 /broadcast",
      );
    await send(env, msg.chat.id, `📣 开始群发给 ${list.length} 人……`);
    let ok = 0,
      fail = 0;
    const dead = [];
    for (const id of list) {
      const r = source
        ? await tg(env, "copyMessage", {
            chat_id: id,
            from_chat_id: msg.chat.id,
            message_id: source.message_id,
          })
        : await send(env, id, body);
      if (r.ok) ok++;
      else {
        fail++;
        if (/blocked|deactivated|chat not found/i.test(r.description || ""))
          dead.push(id);
      }
      await sleep(40); // 约 25 条/秒，避开 TG 限流
    }
    if (dead.length)
      await saveSubs(
        env,
        list.filter((x) => !dead.includes(x)),
      );
    return send(
      env,
      msg.chat.id,
      `✅ 群发完成：成功 ${ok}，失败 ${fail}${dead.length ? `，已自动清理失效订阅 ${dead.length} 个` : ""}`,
    );
  }

  if (isAdmin)
    return send(
      env,
      msg.chat.id,
      "🛠 管理员命令：/count 看订阅数；/broadcast 群发。",
    );
  return send(env, msg.chat.id, "直接发 /start 订阅通知，/stop 退订。");
}
