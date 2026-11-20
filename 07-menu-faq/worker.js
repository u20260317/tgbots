// ============================================================
// 07 菜单导航 / 关键词自动回复 Bot（单文件 · Cloudflare Workers）
// 用法：直接改下面 CONFIG 里的菜单、页面文案和关键词，不用改其它代码。
//   PAGES：每个页面 = 一段文字 + 若干按钮（按钮可跳页面 page:xxx 或打开链接 url）
//   KEYWORDS：用户消息包含关键词 -> 自动回复对应文字
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

// ==================== 在这里改内容 ====================
// ============================================================
// 【核心模块】配置数据（本 Bot 的核心内容区）
// 菜单页面、按钮、关键词全在这里定义；改内容只改这里，不用动下面逻辑。
// ============================================================
const CONFIG = {
  homePage: "home",
  pages: {
    home: {
      text: "👋 欢迎！点下面菜单了解我们：",
      buttons: [
        [
          { text: "📖 关于我们", page: "about" },
          { text: "💰 价格/服务", page: "price" },
        ],
        [{ text: "❓ 常见问题", page: "faq" }],
        [
          { text: "🌐 官网", url: "https://example.com" },
          { text: "📣 频道", url: "https://t.me/telegram" },
        ],
      ],
    },
    about: {
      text: "📖 关于我们\n\n这里写介绍……",
      buttons: [[{ text: "⬅️ 返回主页", page: "home" }]],
    },
    price: {
      text: "💰 价格/服务\n\n这里写价格表……",
      buttons: [[{ text: "⬅️ 返回主页", page: "home" }]],
    },
    faq: {
      text: "❓ 常见问题\n\nQ：怎么联系真人？\nA：直接在本对话留言即可。",
      buttons: [[{ text: "⬅️ 返回主页", page: "home" }]],
    },
  },
  keywords: [
    {
      keys: ["价格", "多少钱", "收费"],
      reply: "💰 价格请看菜单里的「价格/服务」，也可以直接留言咨询。",
    },
    {
      keys: ["客服", "真人", "联系"],
      reply: "🙋 直接把问题发在这里就行，管理员看到会回复。",
    },
    { keys: ["官网", "网址"], reply: "🌐 官网：https://example.com" },
  ],
  fallback: "🤔 没听懂。可以点 /start 打开菜单，或直接留言给管理员。",
};
// ==================== 内容区结束 ====================

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

// ============================================================
// 【核心模块】菜单渲染
// 把 CONFIG 里的页面定义渲染成 inline 键盘并负责翻页编辑。
// ============================================================
function keyboard(pageId) {
  const p = CONFIG.pages[pageId];
  if (!p?.buttons?.length) return undefined;
  return {
    inline_keyboard: p.buttons.map((row) =>
      row.map((b) =>
        b.url
          ? { text: b.text, url: b.url }
          : { text: b.text, callback_data: "pg:" + b.page },
      ),
    ),
  };
}
const showPage = (env, chatId, pageId, editMsgId) => {
  const p = CONFIG.pages[pageId] || CONFIG.pages[CONFIG.homePage];
  const payload = {
    chat_id: chatId,
    text: p.text,
    reply_markup: keyboard(pageId),
  };
  return editMsgId
    ? tg(env, "editMessageText", { ...payload, message_id: editMsgId })
    : tg(env, "sendMessage", payload);
};

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [{ command: "start", description: "打开菜单" }];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("menu-faq bot is running.", {
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
      const cm = await tg(env, "setMyCommands", { commands: COMMANDS });
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
// 菜单与自动回复业务主流程（菜单翻页、关键词匹配）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    if (String(cq.data || "").startsWith("pg:")) {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      await showPage(
        env,
        cq.message.chat.id,
        cq.data.slice(3),
        cq.message.message_id,
      );
    }
    return;
  }
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const text = msg.text || "";
  if (
    text.startsWith("/start") ||
    text.startsWith("/menu") ||
    text.startsWith("/help")
  )
    return showPage(env, msg.chat.id, CONFIG.homePage);
  for (const k of CONFIG.keywords)
    if (k.keys.some((w) => text.includes(w)))
      return send(env, msg.chat.id, k.reply);
  return send(env, msg.chat.id, CONFIG.fallback);
}
