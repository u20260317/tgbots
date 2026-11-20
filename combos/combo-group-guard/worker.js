// ============================================================
// 组合 · 社群守卫（03 强制订阅 + 04 群管理）
// 单文件 · Cloudflare Workers · 无状态免数据库
// 群内处理顺序（拼装的关键）：
// 新人入群 -> 欢迎 + 按钮验证禁言（04）
// 普通发言 -> 管理员豁免 -> 先查强制订阅（03，不过删帖+提醒并结束）
// -> 再过违禁词/防链接（04）
// 管理员命令 -> /ban /mute /unmute /warn /pin /rules（04）
// 私聊：强制订阅门禁（03），通过后展示 UNLOCK_TEXT。
// 必填变量：BOT_TOKEN（Secret）、REQUIRED_CHATS
// 选填：REQUIRED_LINKS、GUARD_GROUP_ID、WEBHOOK_SECRET、WELCOME_TEXT、
// RULES_TEXT、BAD_WORDS、ANTI_LINK=1、CAPTCHA=0 可关新人验证、UNLOCK_TEXT
// 前提：Bot 是群管理员（删/封/禁/置顶权限），且是 REQUIRED_CHATS 各频道的管理员；
// BotFather 里给本 Bot /setprivacy 选 Disable，否则读不到普通群消息。
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
const NO_PERMS = {
  can_send_messages: false,
  can_send_media_messages: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};
const FULL_PERMS = {
  can_send_messages: true,
  can_send_media_messages: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_invite_users: true,
};
async function memberStatus(env, chatId, userId) {
  const r = await tg(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return r?.result?.status;
}
const isGroupAdmin = async (env, chatId, userId) =>
  ["administrator", "creator"].includes(
    await memberStatus(env, chatId, userId),
  );

// ============================================================
// 【核心模块】订阅状态校验（来自 03 · 核心判定）
// 逐个查 getChatMember，返回用户还没加入的频道/群清单；私聊门禁和群内守卫都靠它判定。
// ============================================================
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
  return null;
}
async function missingSubs(env, userId) {
  const missing = [];
  for (const [i, chat] of requiredChats(env).entries()) {
    const st = await memberStatus(env, chat, userId);
    if (!["member", "administrator", "creator", "restricted"].includes(st))
      missing.push({ chat, idx: i });
  }
  return missing;
}
function joinKeyboard(env, missing, checkData = "check") {
  const rows = missing.map((m) => {
    const link = linkFor(env, m.chat, m.idx);
    return link
      ? [{ text: `➕ 加入 ${m.chat}`, url: link }]
      : [{ text: `请先加入 ${m.chat}`, callback_data: "noop" }];
  });
  rows.push([{ text: "✅ 我已加入，点我验证", callback_data: checkData }]);
  return { inline_keyboard: rows };
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("combo-group-guard bot is running.", {
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
// 社群守卫分流中枢：回调分 cap:（新人验证）/check（订阅复查）；群消息串行过订阅与内容过滤；私聊走订阅门禁。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    // 04 新人验证
    if (String(cq.data || "").startsWith("cap:")) {
      if (String(cq.from.id) !== cq.data.split(":")[1])
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这不是你的验证按钮",
          show_alert: true,
        });
      await tg(env, "restrictChatMember", {
        chat_id: cq.message.chat.id,
        user_id: cq.from.id,
        permissions: FULL_PERMS,
      });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 验证通过，可以发言了",
      });
      return tg(env, "deleteMessage", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
      });
    }
    if (cq.data === "noop")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "请联系管理员获取邀请链接",
      });
    if (cq.data === "gcheck") {
      const missing = await missingSubs(env, cq.from.id);
      if (missing.length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "还没检测到加入：" + missing.map((m) => m.chat).join("、"),
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 已验证，现在可以发言了",
      });
      return tg(env, "deleteMessage", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
      });
    }
    // 03 订阅复查（私聊门禁）
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
      return tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: env.UNLOCK_TEXT || "🎉 已验证订阅，欢迎！",
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // ---------- 私聊：订阅门禁（03） ----------
  if (msg.chat.type === "private") {
    const missing = await missingSubs(env, msg.from.id);
    if (missing.length)
      return send(
        env,
        msg.chat.id,
        "🔒 使用本 Bot 前，请先加入下面全部频道/群组，加入后点「✅ 我已加入」验证：",
        { reply_markup: joinKeyboard(env, missing) },
      );
    return send(
      env,
      msg.chat.id,
      env.UNLOCK_TEXT || "🎉 已验证订阅，欢迎使用！",
    );
  }
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
  if (env.GUARD_GROUP_ID && String(msg.chat.id) !== String(env.GUARD_GROUP_ID))
    return;
  const chatId = msg.chat.id;

  // ---------- 新人入群：欢迎 + 验证（04） ----------
  if (msg.new_chat_members?.length) {
    for (const u of msg.new_chat_members) {
      if (u.is_bot) continue;
      const welcome = (
        env.WELCOME_TEXT || "👋 欢迎 {name} 加入！先看群规 /rules，文明发言。"
      ).replace("{name}", u.first_name || "新朋友");
      if (env.CAPTCHA !== "0") {
        await tg(env, "restrictChatMember", {
          chat_id: chatId,
          user_id: u.id,
          permissions: NO_PERMS,
        });
        await send(
          env,
          chatId,
          `${welcome}\n\n🔐 请点下方按钮完成验证后发言（超时可联系管理员 /unmute 解除）：`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ 我是真人，点我验证",
                    callback_data: `cap:${u.id}`,
                  },
                ],
              ],
            },
          },
        );
      } else await send(env, chatId, welcome);
    }
    return;
  }
  if (msg.left_chat_member || !msg.from || msg.from.is_bot) return;

  const text = msg.text || msg.caption || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const senderIsAdmin = await isGroupAdmin(env, chatId, msg.from.id);
  if (cmd === "/rules")
    return send(
      env,
      chatId,
      env.RULES_TEXT ||
        "📜 群规未设置（管理员在 Worker 变量 RULES_TEXT 里填写）。",
    );

  // ---------- 管理员命令（04） ----------
  if (text.startsWith("/") && senderIsAdmin) {
    const replyUser = msg.reply_to_message?.from;
    if (cmd === "/ban" && replyUser) {
      await tg(env, "banChatMember", {
        chat_id: chatId,
        user_id: replyUser.id,
      });
      return send(env, chatId, `🚫 已封禁 ${replyUser.first_name}`);
    }
    if (cmd === "/mute" && replyUser) {
      const hours = Number(text.split(/\s+/)[1]) || 24;
      await tg(env, "restrictChatMember", {
        chat_id: chatId,
        user_id: replyUser.id,
        permissions: NO_PERMS,
        until_date: Math.floor(Date.now() / 1000) + hours * 3600,
      });
      return send(
        env,
        chatId,
        `🔇 已禁言 ${replyUser.first_name} ${hours} 小时`,
      );
    }
    if (cmd === "/unmute" && replyUser) {
      await tg(env, "restrictChatMember", {
        chat_id: chatId,
        user_id: replyUser.id,
        permissions: FULL_PERMS,
      });
      return send(
        env,
        chatId,
        `🔊 已解除 ${replyUser.first_name} 的禁言/验证限制`,
      );
    }
    if (cmd === "/warn" && replyUser) {
      await tg(env, "deleteMessage", {
        chat_id: chatId,
        message_id: msg.reply_to_message.message_id,
      });
      return send(
        env,
        chatId,
        `⚠️ 警告 ${replyUser.first_name}：请遵守群规，再犯将禁言/封禁。`,
      );
    }
    if (cmd === "/pin" && msg.reply_to_message)
      return tg(env, "pinChatMessage", {
        chat_id: chatId,
        message_id: msg.reply_to_message.message_id,
      });
    if (["/ban", "/mute", "/unmute", "/warn"].includes(cmd))
      return send(env, chatId, `用法：回复对方任意一条消息，再发 ${cmd}`);
    return;
  }
  if (senderIsAdmin) return; // 管理员豁免订阅与内容过滤

  // ---------- 第 1 关：强制订阅（03） ----------
  const missing = await missingSubs(env, msg.from.id);
  if (missing.length) {
    await tg(env, "deleteMessage", {
      chat_id: chatId,
      message_id: msg.message_id,
    });
    return send(
      env,
      chatId,
      `⚠️ ${msg.from.first_name || "你好"}，先加入 ${missing.map((m) => m.chat).join("、")} 才能在本群发言，刚才的消息已删除。`,
      { reply_markup: joinKeyboard(env, missing, "gcheck") },
    );
  }

  // ---------- 第 2 关：违禁词 / 防链接（04） ----------
  const bad = String(env.BAD_WORDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (bad.some((w) => text.includes(w))) {
    await tg(env, "deleteMessage", {
      chat_id: chatId,
      message_id: msg.message_id,
    });
    return send(
      env,
      chatId,
      `⚠️ ${msg.from.first_name}，你的消息包含违禁词，已删除。`,
    );
  }
  if (
    env.ANTI_LINK === "1" &&
    /(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(text)
  ) {
    await tg(env, "deleteMessage", {
      chat_id: chatId,
      message_id: msg.message_id,
    });
    return send(
      env,
      chatId,
      `⚠️ ${msg.from.first_name}，本群禁止非管理员发链接，消息已删除。`,
    );
  }
}
