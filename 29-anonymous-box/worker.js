// ============================================================
// 29 匿名信箱 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：箱主用 /mybox 拿到专属链接，任何人点链接后给 Bot 发的消息都会
// 被匿名转给箱主（用 copyMessage 复制，不带任何发送者信息）；箱主直接
// 回复那条转发消息，Bot 再匿名转回给访客，来回都不暴露身份。
// 必填变量：BOT_TOKEN（Secret）、BOT_USERNAME（Bot 用户名，不带 @）
// 选填：WEBHOOK_SECRET
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV
// （键：boxsess:<访客ID> 当前在给谁留言；msgmap:<会话ID>:<消息ID> 回信路由）。
// 命令：/mybox 我的信箱链接 · /stop 结束当前匿名留言会话（访客用）
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 隐私说明：访客 ID 只存在 Bot 自己的 KV 路由表里，箱主看到的只有
// 复制过来的消息本体；但恶意内容请箱主自行拉黑/举报，Bot 不做过滤。
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

// ============================================================
// 【核心模块】匿名路由存储（KV）
// boxsess:<访客ID> = 箱主ID（访客点链接后建立，决定普通消息投给谁）
// msgmap:<会话ID>:<消息ID> = 对方用户ID（每投递一条就记一条，回复时按此路由回信）
// ============================================================
async function deliver(env, fromChatId, msgId, toUserId) {
  const r = await tg(env, "copyMessage", {
    chat_id: toUserId,
    from_chat_id: fromChatId,
    message_id: msgId,
  });
  if (r.ok)
    await env.BOT_KV.put(
      `msgmap:${toUserId}:${r.result.message_id}`,
      String(fromChatId),
    );
  return r;
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
      return new Response("anonymous-box bot is running.", {
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
// 优先级：回复消息先走 msgmap 回信路由；/start box_<箱主ID> 建会话；普通消息按 boxsess 投递。
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) {
    const m = update.message;
    if (m)
      return send(
        env,
        m.chat.id,
        "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。",
      );
    return;
  }
  const msg = update.message;
  if (!msg || !msg.from || msg.chat.type !== "private") return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const myId = msg.from.id;
  const chatId = msg.chat.id;

  // ---------- 回信路由：回复某条转发消息 -> 按映射转给对方 ----------
  if (msg.reply_to_message) {
    const target = await env.BOT_KV.get(
      `msgmap:${chatId}:${msg.reply_to_message.message_id}`,
    );
    if (target) {
      const r = await deliver(env, chatId, msg.message_id, Number(target));
      if (r.ok) return send(env, chatId, "✅ 已匿名转达。");
      return send(env, chatId, "😢 转达失败（对方可能已屏蔽 Bot）。");
    }
  }

  // ---------- 打开信箱链接 ----------
  const startM = text.match(/^\/start(?:@\w+)?\s+box_(\d+)/);
  if (startM) {
    const ownerId = Number(startM[1]);
    if (ownerId === myId)
      return send(
        env,
        chatId,
        "这是你自己的信箱链接，发 /mybox 复制去分享给别人吧。",
      );
    await env.BOT_KV.put("boxsess:" + myId, String(ownerId));
    return send(
      env,
      chatId,
      "📮 你正在给一位用户匿名留言。\n直接发送消息（文字/图片/文件都可以），对方看不到你是谁。\n结束发 /stop；对方回复你的话，会同样匿名转到这里。",
    );
  }

  if (cmd === "/mybox") {
    if (!env.BOT_USERNAME)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置 BOT_USERNAME 变量，链接拼不出来。",
      );
    return send(
      env,
      chatId,
      `📮 你的匿名信箱链接：\nhttps://t.me/${env.BOT_USERNAME}?start=box_${myId}\n\n把链接发到频道/群/主页，任何人点开后给 Bot 发的消息都会匿名转给你；你回复那条消息即可匿名回信。`,
    );
  }
  if (cmd === "/stop") {
    await env.BOT_KV.delete("boxsess:" + myId);
    return send(
      env,
      chatId,
      "已结束当前匿名留言会话。再点别人的信箱链接可重新开始。",
    );
  }
  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "📮 匿名信箱 Bot\n/mybox 拿你的专属信箱链接，别人点链接留言，你收到的是匿名转发，回复即可匿名回信。\n如果你是来留言的：请先点开对方的信箱链接再发消息。",
    );

  // ---------- 普通消息：按当前会话投递 ----------
  if (text.startsWith("/")) return;
  const owner = await env.BOT_KV.get("boxsess:" + myId);
  if (!owner)
    return send(
      env,
      chatId,
      "你现在不在任何留言会话里。先点开对方的信箱链接，或发 /mybox 拿你自己的链接。",
    );
  const r = await deliver(env, chatId, msg.message_id, Number(owner));
  if (!r.ok) return send(env, chatId, "😢 投递失败（箱主可能已屏蔽 Bot）。");
  // 首次投递时给箱主一句操作提示（靠一条独立消息，不占被回复的消息位）
  const hinted = await env.BOT_KV.get("boxhint:" + owner);
  if (!hinted) {
    await env.BOT_KV.put("boxhint:" + owner, "1", {
      expirationTtl: 30 * 24 * 3600,
    });
    await send(
      env,
      Number(owner),
      "📮 上面是你的匿名信箱收到的留言。回复那条消息即可匿名回信，对方看不到你这边的任何信息。",
    );
  }
  return send(env, chatId, "✅ 已匿名送达。");
}
