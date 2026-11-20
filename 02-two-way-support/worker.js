// ============================================================
// 02 双向 Bot（客服 / 联系管理员 · 单文件 · Cloudflare Workers）
// 原理（无状态、免数据库）：
//   用户私聊 Bot 发消息 -> Bot 转发给管理员，并附一条带用户 ID 的说明；
//   管理员「回复」那条被转发的消息 -> Bot 把回复复制回给该用户；
//   用户隐藏了转发来源时，用说明里的 ID 执行 /reply <用户ID> <内容> 回复。
// 必填变量：
//   BOT_TOKEN   BotFather Token（Secret）
//   ADMIN_ID    管理员数字 ID，多个用英文逗号隔开
// 选填：
//   WEBHOOK_SECRET   Webhook 密钥
//   WELCOME_TEXT     用户首次打开时的欢迎语（不填用默认）
//   SUPPORT_GROUP_ID 客服群 ID（填了则消息转发到群而不是管理员私聊；
//                    群里任何管理员回复均可，适合多人客服）
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const inbox = (env) => env.SUPPORT_GROUP_ID || admins(env)[0];

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

// 从被转发消息里提取原发送者 ID（新版 Bot API 的 forward_origin）
// ============================================================
// 【核心模块】转发来源解析
// 从 forward_origin / forward_from 里提取原用户 ID，是管理员回复能找对人的关键。
// ============================================================
function originUserId(m) {
  const o = m?.forward_origin;
  if (o?.type === "user") return o.sender_user?.id;
  if (m?.forward_from) return m.forward_from.id;
  return null;
}
function describeUser(u) {
  if (!u) return "未知用户";
  return `${u.first_name || ""}${u.last_name ? " " + u.last_name : ""}${u.username ? " (@" + u.username + ")" : ""} · ID: ${u.id}`;
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
const COMMANDS_USER = [{ command: "start", description: "开始使用" }];
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("two-way-support bot is running.", {
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
// 双向转发业务主流程（用户消息转管理员、管理员回复回达用户）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg) return;
  // 客服群模式：允许在指定的客服群里处理管理员回复；其它群消息一律忽略
  const inSupportGroup =
    env.SUPPORT_GROUP_ID &&
    String(msg.chat.id) === String(env.SUPPORT_GROUP_ID);
  if (msg.chat.type !== "private" && !inSupportGroup) return;
  const target = inbox(env);
  if (!target) return;
  const fromAdmin =
    isAdmin(env, msg.from.id) || String(msg.chat.id) === String(target);
  const text = msg.text || "";

  // ---------- 管理员侧 ----------
  if (fromAdmin) {
    // 1) 回复某条转发消息 -> 回给原用户
    if (msg.reply_to_message) {
      const uid = originUserId(msg.reply_to_message);
      // 回复的是 Bot 的说明条时，从说明文本里抠 ID
      const m2 =
        !uid && (msg.reply_to_message.text || "").match(/ID:\s*(\d{5,})/);
      const userId = uid || (m2 && m2[1]);
      if (userId) {
        const r = await tg(env, "copyMessage", {
          chat_id: userId,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        });
        return send(
          env,
          msg.chat.id,
          r.ok
            ? "✅ 已送达给用户 " + userId
            : "发送失败：" + (r.description || "对方可能已拉黑 Bot"),
        );
      }
      return send(
        env,
        msg.chat.id,
        "⚠️ 这条认不出原用户。请回复「被转发的原消息」，或用 /reply <用户ID> <内容>",
      );
    }
    // 2) /reply <id> <内容>
    const m = text.match(/^\/reply\s+(\d{5,})\s+([\s\S]+)/);
    if (m) {
      const r = await send(env, m[1], m[2]);
      return send(
        env,
        msg.chat.id,
        r.ok ? "✅ 已送达" : "发送失败：" + (r.description || ""),
      );
    }
    if (text.startsWith("/start") || text.startsWith("/help"))
      return send(
        env,
        msg.chat.id,
        "🛠 管理员用法：\n· 直接「回复」用户被转发的消息即可回话（支持文字/图片/文件等任意内容）\n· 对方隐藏转发来源时：/reply <用户ID> <内容>\n· 用户 ID 见每条转发前的说明条",
      );
    return; // 管理员的其它私聊消息不处理，避免自言自语被转发
  }

  // ---------- 用户侧 ----------
  if (text.startsWith("/start"))
    return send(
      env,
      msg.chat.id,
      env.WELCOME_TEXT ||
        "👋 你好！直接把你的问题发在这里，管理员看到后会直接回复你，回复会出现在这个对话里。",
    );
  if (text.startsWith("/"))
    return send(
      env,
      msg.chat.id,
      "直接发送文字、图片或文件即可，管理员会回复你。",
    );

  // 先发说明条（带 ID，兜底回复用），再转发原消息（保留原样、方便回复定位）
  await send(
    env,
    target,
    `💬 新消息 · 来自 ${describeUser(msg.from)}\n回复下面那条转发消息即可回他；认不出时用 /reply ${msg.from.id} 内容`,
  );
  const r = await tg(env, "forwardMessage", {
    chat_id: target,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
  });
  if (r.ok)
    await send(env, msg.chat.id, "✅ 已转达，管理员回复后会直接出现在这里。");
  else await send(env, msg.chat.id, "⚠️ 转达失败，请稍后再试。");
}
