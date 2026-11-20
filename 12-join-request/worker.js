// ============================================================
// 12 入群申请审核 Bot（单文件 · Cloudflare Workers）
// 处理私有群/频道的 chat_join_request（加入申请），三种模式用 MODE 变量切换：
// review（默认）：申请转发给管理员，按钮「通过/拒绝」，结果通知申请人
// auto：秒通过，并私聊欢迎语（适合靠邀请链接筛选过的场景）
// question：先私聊问申请人一个问题，对方回答转发给管理员再按钮审核（需 KV）
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（或用 REVIEW_CHAT_ID 指到审核群）
// 选填：
// MODE review / auto / question（默认 review）
// REVIEW_CHAT_ID 审核群 ID（填了申请卡发到群，不填发第一个管理员私聊）
// TARGET_CHAT_ID 只处理这一个群/频道的申请（不填则 Bot 所在全部）
// QUESTION_TEXT question 模式的问题，如「从哪知道本群的？进群想找什么资源？」
// WELCOME_TEXT 通过后给申请人的欢迎语
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ question 模式需要 KV：Bindings 添加 KV，变量名 BOT_KV（存 待答题->目标群 的映射）。
// 前提：群/频道要开启「加入需管理员批准」（邀请链接勾选 Request Admin Approval，
// 或群设置里开 Approve new members）；Bot 是该群/频道管理员（邀请成员权限）。
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
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const reviewChat = (env) => env.REVIEW_CHAT_ID || admins(env)[0];
const mode = (env) => (env.MODE || "review").toLowerCase();
const who = (u) =>
  `${u.first_name || ""}${u.last_name ? " " + u.last_name : ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;

// ============================================================
// 【核心模块】申请审核卡
// 把一次申请渲染成带通过/拒绝按钮的消息；按钮 data 编码了 目标群ID:申请人ID，无状态即可定位。
// ============================================================
function reviewCard(env, chat, user, extraText) {
  return {
    chat_id: reviewChat(env),
    text: `🆕 入群申请\n群/频道：${chat.title || chat.id}（${chat.id}）\n申请人：${who(user)}${extraText ? "\n\n💬 他的回答：\n" + extraText : ""}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ 通过", callback_data: `jr:ok:${chat.id}:${user.id}` },
          { text: "❌ 拒绝", callback_data: `jr:no:${chat.id}:${user.id}` },
        ],
      ],
    },
  };
}
async function approve(env, chatId, userId, silent) {
  const r = await tg(env, "approveChatJoinRequest", {
    chat_id: chatId,
    user_id: userId,
  });
  if (r.ok && !silent)
    await send(
      env,
      userId,
      env.WELCOME_TEXT ||
        "🎉 你的加入申请已通过，欢迎加入！回到群/频道即可开始使用。",
    );
  return r;
}
async function decline(env, chatId, userId) {
  const r = await tg(env, "declineChatJoinRequest", {
    chat_id: chatId,
    user_id: userId,
  });
  if (r.ok)
    await send(
      env,
      userId,
      "😢 你的加入申请这次未被通过。如有疑问请联系管理员。",
    );
  return r;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// 注意：allowed_updates 必须包含 chat_join_request，否则 Telegram 根本不会推申请事件。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("join-request bot is running.", {
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
        allowed_updates: ["message", "callback_query", "chat_join_request"],
      });
      return Response.json({ setWebhook: hook, telegram: r });
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
// 申请事件按 MODE 分三路；管理员按钮回调 jr:ok/jr:no 执行通过/拒绝；question 模式下申请人的私聊回复被当作答题转发。
// ============================================================
async function handle(env, update) {
  // ---------- 审核按钮 ----------
  const cq = update.callback_query;
  if (cq) {
    const parts = String(cq.data || "").split(":");
    if (parts[0] !== "jr") return;
    if (
      !isAdmin(env, cq.from.id) &&
      String(cq.message.chat.id) !== String(reviewChat(env))
    )
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "你不是审核员",
        show_alert: true,
      });
    const [, act, chatId, userId] = parts;
    const r =
      act === "ok"
        ? await approve(env, chatId, userId)
        : await decline(env, chatId, userId);
    if (!r.ok)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "操作失败：" + (r.description || "申请可能已过期或被处理"),
        show_alert: true,
      });
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: act === "ok" ? "✅ 已通过" : "已拒绝",
    });
    return tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text:
        cq.message.text +
        `\n\n—— ${act === "ok" ? "✅ 已通过" : "❌ 已拒绝"}（操作人 ${cq.from.first_name || cq.from.id}）`,
    });
  }

  // ---------- 加入申请事件 ----------
  const jr = update.chat_join_request;
  if (jr) {
    if (env.TARGET_CHAT_ID && String(jr.chat.id) !== String(env.TARGET_CHAT_ID))
      return;
    const m = mode(env);
    if (m === "auto") return approve(env, jr.chat.id, jr.from.id);
    if (m === "question") {
      if (!env.BOT_KV) {
        // 没 KV 兜底退回 review 模式，别让申请卡死
        return tg(
          env,
          "sendMessage",
          reviewCard(
            env,
            jr.chat,
            jr.from,
            "（注：question 模式未绑定 KV，已按审核模式处理）",
          ),
        );
      }
      await env.BOT_KV.put(
        "pending:" + jr.from.id,
        JSON.stringify({
          chat: jr.chat.id,
          title: jr.chat.title || "",
          t: Date.now(),
        }),
        { expirationTtl: 7 * 24 * 3600 },
      );
      return send(
        env,
        jr.from.id,
        `👋 你申请加入「${jr.chat.title || "群组"}」需要先回答一个问题：\n\n${env.QUESTION_TEXT || "你从哪知道这里的？进群后想找什么？"}\n\n直接回复本条消息即可，答案会转给管理员审核。`,
      );
    }
    // review 模式
    await send(
      env,
      jr.from.id,
      `⏳ 你的加入申请（${jr.chat.title || "群组"}）已提交，管理员审核后会通知你。`,
    );
    return tg(env, "sendMessage", reviewCard(env, jr.chat, jr.from));
  }

  // ---------- 私聊消息：question 模式的答题 / 常规提示 ----------
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const text = msg.text || "";
  if (text.startsWith("/start")) {
    if (isAdmin(env, msg.from.id))
      return send(
        env,
        msg.chat.id,
        `🛠 入群审核 Bot 运行中，当前模式：${mode(env)}。申请会自动以卡片形式发到${env.REVIEW_CHAT_ID ? "审核群" : "你这里"}，点按钮即可处理。`,
      );
    return send(
      env,
      msg.chat.id,
      "👋 我是入群审核 Bot。请先通过邀请链接提交加入申请，我会引导你完成审核。",
    );
  }
  if (mode(env) === "question" && env.BOT_KV && !isAdmin(env, msg.from.id)) {
    const raw = await env.BOT_KV.get("pending:" + msg.from.id);
    if (raw) {
      const pending = JSON.parse(raw);
      await env.BOT_KV.delete("pending:" + msg.from.id);
      await tg(
        env,
        "sendMessage",
        reviewCard(
          env,
          { id: pending.chat, title: pending.title },
          msg.from,
          text || msg.caption || "(非文字消息)",
        ),
      );
      return send(
        env,
        msg.chat.id,
        "✅ 已把你的回答转给管理员，审核结果会通知你。",
      );
    }
  }
}
