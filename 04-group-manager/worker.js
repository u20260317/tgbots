// ============================================================
// 04 群管理 Bot（单文件 · Cloudflare Workers）
// 功能：新人验证（点按钮解除禁言，防广告号）/ 欢迎语 / 关键词删帖 /
//       非管理员发链接删帖 / 管理员命令：/ban /mute /unmute /warn /pin /rules
// 必填变量：BOT_TOKEN（Secret）
// 选填变量：
//   WEBHOOK_SECRET  Webhook 密钥
//   WELCOME_TEXT    欢迎语，{name} 会替换成新人名字
//   RULES_TEXT      /rules 展示的群规
//   BAD_WORDS       违禁词，英文逗号隔开，如 赌博,代充,加微信
//   ANTI_LINK       填 1 开启：非管理员发的 http / t.me 链接自动删除
//   CAPTCHA         填 0 关闭新人按钮验证（默认开启）
// 前提：Bot 在群里设为管理员（删除消息、封禁、禁言、置顶权限都要勾）。
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

// ============================================================
// 【核心模块】群管理员权限判定
// 查成员角色决定命令权限与过滤豁免，管理员命令和防链接都先过这里。
// ============================================================
async function isGroupAdmin(env, chatId, userId) {
  const r = await tg(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return ["administrator", "creator"].includes(r?.result?.status);
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "rules", description: "查看群规" },
  { command: "ban", description: "封禁成员（管理员）" },
  { command: "mute", description: "禁言成员（管理员）" },
  { command: "unmute", description: "解除禁言（管理员）" },
  { command: "warn", description: "警告成员（管理员）" },
  { command: "pin", description: "置顶消息（管理员）" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("group-manager bot is running.", {
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
// 群管理业务主流程（新人验证、内容过滤、管理员命令）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  // 新人验证按钮
  const cq = update.callback_query;
  if (cq) {
    if (!String(cq.data || "").startsWith("cap:")) return;
    const targetId = cq.data.split(":")[1];
    if (String(cq.from.id) !== targetId)
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
    await tg(env, "deleteMessage", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
    });
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (msg.chat.type === "private") {
    if ((msg.text || "").startsWith("/start"))
      return send(
        env,
        chatId,
        "👮 群管理 Bot：把我拉进群并设为管理员即可工作。群内发送 /rules 看群规。",
      );
    return;
  }

  // 新人入群：欢迎 + 验证
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
          `${welcome}\n\n🔐 请在 5 分钟内点下方按钮完成验证，否则将一直禁言（超时可退群重进，或联系管理员 /unmute）。`,
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
      } else {
        await send(env, chatId, welcome);
      }
    }
    return;
  }
  if (msg.left_chat_member) return;

  const text = msg.text || msg.caption || "";
  const senderIsAdmin =
    msg.from && !msg.from.is_bot
      ? await isGroupAdmin(env, chatId, msg.from.id)
      : false;

  // 管理员命令（需回复某人的消息使用）
  if (text.startsWith("/") && senderIsAdmin) {
    const replyUser = msg.reply_to_message?.from;
    const cmd = text.split(/\s+/)[0].split("@")[0];
    if (cmd === "/rules")
      return send(
        env,
        chatId,
        env.RULES_TEXT ||
          "📜 群规未设置（管理员在 Worker 变量 RULES_TEXT 里填写）。",
      );
    if (!replyUser && ["/ban", "/mute", "/unmute", "/warn"].includes(cmd))
      return send(
        env,
        chatId,
        `用法：回复 ${cmd === "/warn" ? "对方" : "对方"} 的任意一条消息，再发 ${cmd}`,
      );
    if (cmd === "/ban") {
      await tg(env, "banChatMember", {
        chat_id: chatId,
        user_id: replyUser.id,
      });
      return send(env, chatId, `🚫 已封禁 ${replyUser.first_name}`);
    }
    if (cmd === "/mute") {
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
    if (cmd === "/unmute") {
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
    if (cmd === "/warn") {
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
    if (cmd === "/pin" && msg.reply_to_message) {
      await tg(env, "pinChatMessage", {
        chat_id: chatId,
        message_id: msg.reply_to_message.message_id,
      });
      return;
    }
  }
  if (text.split(/\s+/)[0].split("@")[0] === "/rules")
    return send(env, chatId, env.RULES_TEXT || "📜 群规未设置。");

  if (!msg.from || msg.from.is_bot || senderIsAdmin) return;

  // 违禁词
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
  // 防链接
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
