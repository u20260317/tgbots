// ============================================================
// 14 付费会员 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：用户选套餐 -> Bot 给收款说明 -> 用户点「我已付款」-> 管理员按钮确认
// -> Bot 自动发一次性邀请链接（48 小时内有效、限 1 人）-> 记录到期时间
// -> 每天 Cron 巡检，到期自动踢出并通知（续费后重新走购买流程）。
// 这是「人工收款确认」模式：钱走你自己的收款渠道，Bot 只管订单和权限，
// 不碰资金，最稳妥。要全自动收款可把确认环节换成支付回调，见 README。
// 套餐在下面 CONFIG 里改（id / 名称 / 价格文案 / 天数）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开
// TARGET_CHAT_ID 付费群/频道 ID（-100 开头，Bot 须为管理员且有邀请/封禁权限）
// PAYMENT_INFO 收款说明原文（如收款地址/二维码链接/付款备注要求）
// 选填：WEBHOOK_SECRET
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（键：order:<订单号>、sub:<用户ID>）。
// ⚠️ 到期踢人需要 Cron：Worker -> Triggers 加一条每天的 Cron（如 15 3 * * *），
// 代码里的 scheduled() 会自动巡检；不加 Cron 则只靠管理员手动 /kick。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

// ==================== 在这里改套餐 ====================
const PLANS = [
  { id: "m1", name: "月卡", price: "30 USDT", days: 30 },
  { id: "q1", name: "季卡", price: "80 USDT", days: 90 },
  { id: "y1", name: "年卡", price: "300 USDT", days: 365 },
];
// ==================== 套餐区结束 ====================

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
const adminChat = (env) => admins(env)[0];
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;
const fmtDay = (ts) => new Date(ts).toISOString().slice(0, 10);

// ============================================================
// 【核心模块】订单与会员存储（KV）
// order:<订单号> = { user, name, plan, status:waitpay|waitconfirm|done|reject, t}
// sub:<用户ID> = { plan, name, expires:到期毫秒, chat}，到期巡检和续费都认这份记录。
// ============================================================
async function getKV(env, key) {
  const raw = await env.BOT_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function putKV(env, key, val) {
  await env.BOT_KV.put(key, JSON.stringify(val));
}

// ============================================================
// 【核心模块】支付确认流
// 用户点「我已付款」-> 管理员收到确认卡 -> 通过则开发邀请链接+记会员，拒绝则通知用户。
// ============================================================
async function notifyAdminOrder(env, orderId, order) {
  return tg(env, "sendMessage", {
    chat_id: adminChat(env),
    text: `💰 付费会员订单待确认\n订单号：${orderId}\n用户：${order.name}\n套餐：${order.planName}（${order.price} / ${order.days} 天）\n请核对收款后点按钮：`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ 已收款，通过", callback_data: `payok:${orderId}` },
          { text: "❌ 未收到，拒绝", callback_data: `payno:${orderId}` },
        ],
      ],
    },
  });
}
async function grantMembership(env, orderId, order) {
  const link = await tg(env, "createChatInviteLink", {
    chat_id: env.TARGET_CHAT_ID,
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 48 * 3600,
    name: "vip" + order.user,
  });
  if (!link.ok)
    return { ok: false, error: link.description || "邀请链接创建失败" };
  const prev = await getKV(env, "sub:" + order.user);
  const base = prev && prev.expires > Date.now() ? prev.expires : Date.now(); // 续费顺延
  const expires = base + order.days * 86400 * 1000;
  await putKV(env, "sub:" + order.user, {
    plan: order.plan,
    name: order.name,
    expires,
    chat: env.TARGET_CHAT_ID,
  });
  order.status = "done";
  await putKV(env, "order:" + orderId, order);
  await send(
    env,
    order.user,
    `🎉 收款确认，会员已开通！\n套餐：${order.planName}，有效期至 ${fmtDay(expires)}\n\n👇 你的专属一次性邀请链接（48 小时内点开加入，限你本人）：\n${link.result.invite_link}`,
  );
  return { ok: true };
}

// ============================================================
// 【核心模块】到期巡检（Cron 触发）
// 每天扫 sub: 记录，到期的踢出目标群/频道（ban 后立刻 unban = 只踢不永封）并私聊通知。
// ============================================================
async function sweepExpired(env) {
  const list = await env.BOT_KV.list({ prefix: "sub:", limit: 1000 });
  let kicked = 0;
  for (const k of list.keys) {
    const sub = await getKV(env, k.name);
    if (!sub || sub.expires > Date.now()) continue;
    const userId = k.name.slice(4);
    await tg(env, "banChatMember", { chat_id: sub.chat, user_id: userId });
    await tg(env, "unbanChatMember", {
      chat_id: sub.chat,
      user_id: userId,
      only_if_banned: true,
    });
    await env.BOT_KV.delete(k.name);
    await send(
      env,
      userId,
      "⏰ 你的付费会员已到期，已移出会员群/频道。续费请重新打开我选套餐购买。",
    ).catch(() => {});
    kicked++;
  }
  return kicked;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// fetch 管 Bot 交互，scheduled 管到期巡检，两条路共用上面的存储与支付模块。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("paid-membership bot is running.", {
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
  async scheduled(event, env, ctx) {
    if (env.BOT_KV) ctx.waitUntil(sweepExpired(env));
  },
};

// ============================================================
// 【核心模块】业务主流程
// 选套餐（plan:）-> 已付款（paid:）-> 管理员确认（payok:/payno:）三段按钮流，另加会员自查与管理员命令。
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
  const cq = update.callback_query;
  if (cq) {
    const [act, arg] = String(cq.data || "").split(":");
    if (act === "plan") {
      const plan = PLANS.find((p) => p.id === arg);
      if (!plan)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "套餐不存在",
          show_alert: true,
        });
      const orderId = newId();
      await putKV(env, "order:" + orderId, {
        user: cq.from.id,
        name: who(cq.from),
        plan: plan.id,
        planName: plan.name,
        price: plan.price,
        days: plan.days,
        status: "waitpay",
        t: Date.now(),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(
        env,
        cq.message.chat.id,
        `🧾 订单 ${orderId}：${plan.name}（${plan.price} / ${plan.days} 天）\n\n💳 请按下面说明付款，付完点「✅ 我已付款」：\n\n${env.PAYMENT_INFO || "（管理员未设置 PAYMENT_INFO）"}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ 我已付款", callback_data: `paid:${orderId}` }],
            ],
          },
        },
      );
    }
    if (act === "paid") {
      const order = await getKV(env, "order:" + arg);
      if (!order || order.user !== cq.from.id)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单不存在",
          show_alert: true,
        });
      if (order.status !== "waitpay")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这笔订单已在处理中",
        });
      order.status = "waitconfirm";
      await putKV(env, "order:" + arg, order);
      await notifyAdminOrder(env, arg, order);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已通知管理员核对收款",
      });
      return send(
        env,
        cq.message.chat.id,
        "⏳ 已提交，管理员核对收款后会自动给你发邀请链接，请稍等。",
      );
    }
    if (act === "payok" || act === "payno") {
      if (!isAdmin(env, cq.from.id))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能确认",
          show_alert: true,
        });
      const order = await getKV(env, "order:" + arg);
      if (!order || order.status !== "waitconfirm")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单状态不对或已处理",
          show_alert: true,
        });
      if (act === "payno") {
        order.status = "reject";
        await putKV(env, "order:" + arg, order);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已拒绝",
        });
        await send(
          env,
          order.user,
          `❌ 订单 ${arg} 未核对到收款，已取消。如已付款请把凭证发给管理员核实。`,
        );
        return tg(env, "editMessageReplyMarkup", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: "❌ 已拒绝", callback_data: "done" }]],
          },
        });
      }
      const r = await grantMembership(env, arg, order);
      if (!r.ok)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "开通失败：" + r.error,
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 已开通并发出邀请链接",
      });
      return tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: "✅ 已开通", callback_data: "done" }]],
        },
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start") {
    const sub = await getKV(env, "sub:" + msg.from.id);
    const rows = PLANS.map((p) => [
      {
        text: `${p.name} · ${p.price} · ${p.days} 天`,
        callback_data: `plan:${p.id}`,
      },
    ]);
    return send(
      env,
      msg.chat.id,
      `👑 付费会员开通\n${sub ? `你当前是会员，有效期至 ${fmtDay(sub.expires)}，选套餐即续费顺延。\n` : ""}\n选择套餐：`,
      { reply_markup: { inline_keyboard: rows } },
    );
  }
  if (cmd === "/my") {
    const sub = await getKV(env, "sub:" + msg.from.id);
    return send(
      env,
      msg.chat.id,
      sub
        ? `👑 你的会员有效期至 ${fmtDay(sub.expires)}（套餐 ${sub.plan}）。`
        : "你还不是会员，发 /start 选套餐开通。",
    );
  }
  if (isAdmin(env, msg.from.id) && cmd === "/subs") {
    const list = await env.BOT_KV.list({ prefix: "sub:", limit: 1000 });
    return send(
      env,
      msg.chat.id,
      `👥 当前有效会员记录：${list.keys.length} 条（详情在 KV 的 sub: 键里）。`,
    );
  }
  if (isAdmin(env, msg.from.id) && cmd === "/kick") {
    const uid = text.split(/\s+/)[1];
    if (!uid) return send(env, msg.chat.id, "用法：/kick <用户ID>");
    await tg(env, "banChatMember", {
      chat_id: env.TARGET_CHAT_ID,
      user_id: uid,
    });
    await tg(env, "unbanChatMember", {
      chat_id: env.TARGET_CHAT_ID,
      user_id: uid,
      only_if_banned: true,
    });
    await env.BOT_KV.delete("sub:" + uid);
    return send(env, msg.chat.id, `已踢出并清除 ${uid} 的会员记录。`);
  }
  if (isAdmin(env, msg.from.id) && cmd === "/sweep") {
    const n = await sweepExpired(env);
    return send(env, msg.chat.id, `🧹 巡检完成，踢出到期会员 ${n} 人。`);
  }
}
