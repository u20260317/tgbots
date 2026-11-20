// ============================================================
// 03 强制订阅 Bot（单文件 · Cloudflare Workers）
// 两种模式同时生效：
//  A. 私聊门禁：用户用 Bot 前必须先加入指定的频道/群，未加入只给加入按钮，
//     点「✅ 我已加入」复查，通过后才放行（放行后展示 UNLOCK_TEXT 内容/链接）。
//  B. 群内守卫：把 Bot 拉进你的群并设管理员，用户在群里发言时若未订阅指定频道，
//     Bot 删除该条消息并 @ 提醒（提醒消息 60 秒后尝试删除需 Cron/外部触发，
//     本单文件版保留提醒，由管理员或用户自行删除，见 README 说明）。
// 必填变量：
//   BOT_TOKEN       BotFather Token（Secret）
//   REQUIRED_CHATS  必须加入的频道/群，英文逗号隔开，如 @mychannel,-1001234567890
// 选填：
//   REQUIRED_LINKS  与上面一一对应的邀请链接，英文逗号隔开；
//                   公开频道不填会自动用 https://t.me/用户名
//   WEBHOOK_SECRET  Webhook 密钥
//   UNLOCK_TEXT     订阅通过后展示的内容（支持放资源链接）
//   GUARD_GROUP_ID  守卫模式只守这一个群的 ID（不填则 Bot 所在的任何群都守）
// 前提：Bot 必须是 REQUIRED_CHATS 里每个频道/群的管理员（否则查不到成员状态），
//       守卫群里需有删除消息权限。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

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

const requiredChats = (env) =>
  String(env.REQUIRED_CHATS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const requiredLinks = (env) =>
  String(env.REQUIRED_LINKS || "")
    .split(",")
    .map((s) => s.trim());

function linkFor(env, chat, idx) {
  const links = requiredLinks(env);
  if (links[idx]) return links[idx];
  if (String(chat).startsWith("@")) return "https://t.me/" + chat.slice(1);
  return null; // 私有频道又没填链接时不给按钮，只提示
}

// 返回未加入的频道列表
// ============================================================
// 【核心模块】订阅状态校验（核心判定）
// 逐个查 getChatMember，返回用户还没加入的频道/群清单；门禁和守卫都靠它判定。
// ============================================================
async function missingSubs(env, userId) {
  const missing = [];
  for (const [i, chat] of requiredChats(env).entries()) {
    const r = await tg(env, "getChatMember", {
      chat_id: chat,
      user_id: userId,
    });
    const st = r?.result?.status;
    if (
      !r.ok ||
      !["member", "administrator", "creator", "restricted"].includes(st)
    )
      missing.push({ chat, idx: i });
  }
  return missing;
}

// ============================================================
// 【核心模块】加入引导键盘
// 按未加入清单生成「加入按钮 + 我已加入验证按钮」。
// ============================================================
function joinKeyboard(env, missing) {
  const rows = missing.map((m) => {
    const link = linkFor(env, m.chat, m.idx);
    return link
      ? [{ text: `➕ 加入 ${m.chat}`, url: link }]
      : [{ text: `请先加入 ${m.chat}`, callback_data: "noop" }];
  });
  rows.push([{ text: "✅ 我已加入，点我验证", callback_data: "check" }]);
  return { inline_keyboard: rows };
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
  { command: "start", description: "开始使用 / 检查订阅" },
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("force-subscribe bot is running.", {
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
// 【核心模块】业务主流程
// 订阅校验业务主流程（私聊门禁 + 群内守卫）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    if (cq.data === "noop")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "请联系管理员获取邀请链接",
      });
    if (cq.data === "check") {
      const missing = await missingSubs(env, cq.from.id);
      if (missing.length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "还没检测到加入：" + missing.map((m) => m.chat).join("、"),
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 验证通过",
      });
      await tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: unlockedText(env),
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // ---- 群内守卫 ----
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    if (
      env.GUARD_GROUP_ID &&
      String(msg.chat.id) !== String(env.GUARD_GROUP_ID)
    )
      return;
    if (!msg.from || msg.from.is_bot) return;
    // 管理员豁免
    const me = await tg(env, "getChatMember", {
      chat_id: msg.chat.id,
      user_id: msg.from.id,
    });
    if (["administrator", "creator"].includes(me?.result?.status)) return;
    const missing = await missingSubs(env, msg.from.id);
    if (!missing.length) return;
    await tg(env, "deleteMessage", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    const kb = joinKeyboard(env, missing);
    await send(
      env,
      msg.chat.id,
      `⚠️ ${msg.from.first_name || "你好"}，先加入 ${missing.map((m) => m.chat).join("、")} 才能在本群发言，你刚才的消息已删除。`,
      { reply_markup: kb },
    );
    return;
  }

  // ---- 私聊门禁 ----
  if (msg.chat.type !== "private") return;
  const missing = await missingSubs(env, msg.from.id);
  if (missing.length)
    return send(
      env,
      msg.chat.id,
      "🔒 使用本 Bot 前，请先加入下面全部频道/群组，加入后点「✅ 我已加入」验证：",
      { reply_markup: joinKeyboard(env, missing) },
    );
  return send(env, msg.chat.id, unlockedText(env));
}

function unlockedText(env) {
  return (
    env.UNLOCK_TEXT ||
    "🎉 已验证订阅，欢迎使用！\n（把这里换成你的资源链接/内容说明：在 Worker 变量里设置 UNLOCK_TEXT）"
  );
}
