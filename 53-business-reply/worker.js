// ============================================================
// 53 Business 代答 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：给 Telegram Business（商业）账号当代答客服：
// · 营业时间内：顾客消息先过关键词答疑表（CONFIG.QA），命中直接自动回；
// · 没命中或营业外：转发给店主本人，营业外还自动回顾客一句「已留言」；
// · 店主在与 Bot 的私聊里「回复」那条转发消息，答复自动回达顾客。
// 前提（缺一不可）：
// · 店主账号是 Telegram Premium 的 Business 账号；
// · 店主在 Telegram 设置 → Telegram Business → Chatbots 里把本 Bot 连上
// 并授权（可按聊天范围授权），连接成功后 Bot 会收到 business_connection 更新；
// · 没连接之前 Bot 收不到任何顾客消息，/biz 会显示「未连接」。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// TZ_OFFSET 营业时间按哪个时区算，默认 8（北京时间）
// ADMIN_ID 兜底管理员（连接信息异常时看 /biz 用）
// 键设计：biz:conn 连接状态；biz:map:<店主侧消息ID> 回复路由；
// biz:away:<顾客chat>:<日期> 营业外自动回复去重；biz:last 最近一位顾客。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 07（转发与回复路由）+ 模块 34（营业时间思路）+ 模块 01（骨架）
// ============================================================

// ============================================================
// 营业时间与关键词答疑表（改这里定制你的店铺）
// OPEN/CLOSE 是当地时间 HH:MM；WORKDAYS 用 0=周日 … 6=周六。
// QA：keywords 任一命中即回 answer；按顺序匹配，先命中先回。
// ============================================================
const CONFIG = {
  OPEN: "09:00",
  CLOSE: "18:00",
  WORKDAYS: [1, 2, 3, 4, 5],
  AWAY_TEXT:
    "您好，本店现在是非营业时间（09:00–18:00，工作日）。您的留言已转交店主，上线后会第一时间回复您 🙏",
  QA: [
    {
      keywords: ["营业时间", "几点开门", "几点营业"],
      answer: "我们每天 09:00–18:00 营业（周一至周五），节假日另行通知。",
    },
    {
      keywords: ["地址", "在哪", "位置"],
      answer: "店铺地址请看频道置顶帖，或直接留言，店主会发定位给您。",
    },
    {
      keywords: ["价格", "多少钱", "报价"],
      answer: "不同款式价格不同，把您想要的款式发过来，马上为您报价。",
    },
  ],
};

// ============================================================
// Telegram Bot API 通信层
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
// 经 Business 连接给顾客发消息：必须带 business_connection_id，chat_id 是顾客那侧的会话 ID。
const sendBiz = (env, connId, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", {
    chat_id,
    business_connection_id: connId,
    text,
    ...extra,
  });
const isAdmin = (env, uid) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(uid));
const tzOffset = (env) => (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;
const localDate = (env, ts = Date.now()) => new Date(ts + tzOffset(env));

// ============================================================
// 连接状态（business_connection）
// 店主在 Business 设置里连接/断开 Bot 时各来一条更新，整体存 biz:conn：
// { id 连接ID, ownerId 店主用户ID, ownerChat 与Bot的私聊ID, enabled, at}。
// 没有这条记录，后面所有代答都无从谈起，/biz 也据此报状态。
// ============================================================
async function getConn(env) {
  const raw = await env.BOT_KV.get("biz:conn");
  return raw ? JSON.parse(raw) : null;
}
async function onConnection(env, bc) {
  if (!bc || !bc.id) return;
  const rec = {
    id: bc.id,
    ownerId: bc.user?.id,
    ownerChat: bc.user_chat_id,
    enabled: !!bc.is_enabled,
    at: Date.now(),
  };
  await env.BOT_KV.put("biz:conn", JSON.stringify(rec));
}

// ============================================================
// 营业时间判定
// 当地墙上时间 + 工作日表；只支持同日区间（09:00-18:00 这类），
// 跨夜营业（如 18:00-02:00）请把 CLOSE 写得比 OPEN 小，判定里已兼容。
// ============================================================
function inBusinessHours(env) {
  const d = localDate(env);
  if (!CONFIG.WORKDAYS.includes(d.getUTCDay())) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const [oh, om] = CONFIG.OPEN.split(":").map(Number);
  const [ch, cm] = CONFIG.CLOSE.split(":").map(Number);
  const open = oh * 60 + om,
    close = ch * 60 + cm;
  return close > open
    ? mins >= open && mins < close
    : mins >= open || mins < close;
}
function matchQA(text) {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  for (const item of CONFIG.QA) {
    if (item.keywords.some((k) => t.includes(k.toLowerCase())))
      return item.answer;
  }
  return null;
}

// ============================================================
// 顾客消息转发给店主（带回复路由）
// 先发一条说明头，再 copyMessage 原样转发顾客消息；把转发件的消息 ID
// 映射到顾客会话存 biz:map:，店主「回复」转发件时据此找回顾客。
// copyMessage 带不过去自定义文本，所以说明头必须单独发一条。
// ============================================================
async function forwardToOwner(env, conn, msg, header) {
  await send(env, conn.ownerChat, header);
  const r = await tg(env, "copyMessage", {
    chat_id: conn.ownerChat,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
  });
  if (r.ok) {
    await env.BOT_KV.put(
      "biz:map:" + r.result.message_id,
      JSON.stringify({ conn: conn.id, cust: msg.chat.id }),
    );
    await env.BOT_KV.put(
      "biz:last",
      JSON.stringify({ conn: conn.id, cust: msg.chat.id, at: Date.now() }),
    );
  }
  return r;
}

// ============================================================
// 管理员白名单与分级命令菜单
// 普通用户（顾客）不设命令菜单；/biz 只对店主与 ADMIN_ID 放行（代码里验）。
// ============================================================
const COMMANDS_USER = [
  { command: "biz", description: "查看 Business 连接状态" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  return tg(env, "setMyCommands", { commands: COMMANDS_USER });
}

// ============================================================
// Worker 入口与路由
// allowed_updates 必须含 business_connection 与 business_message，
// 否则连接事件和顾客消息根本不会推过来（最常见的「连上了没反应」原因）。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("business-reply bot is running.", {
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
        allowed_updates: ["message", "business_connection", "business_message"],
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
// 业务主流程
// 三种更新分流：business_connection 记状态；business_message 是顾客消息；
// message 是普通私聊（店主回顾客 / 店主或管理员查 /biz）。
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) return;

  if (update.business_connection)
    return onConnection(env, update.business_connection);

  // ---------- 顾客消息（经 Business 连接进来） ----------
  const bmsg = update.business_message;
  if (bmsg && bmsg.from && !bmsg.from.is_bot) {
    const conn = await getConn(env);
    if (!conn || !conn.enabled || conn.id !== bmsg.business_connection_id)
      return;
    if (bmsg.from.id === conn.ownerId) return; // 店主自己在该会话发的，不代答
    const custChat = bmsg.chat.id;
    const name =
      [bmsg.from.first_name, bmsg.from.last_name].filter(Boolean).join(" ") ||
      "顾客";
    if (inBusinessHours(env)) {
      const answer = matchQA(bmsg.text || bmsg.caption || "");
      if (answer) {
        await sendBiz(env, conn.id, custChat, answer);
        await env.BOT_KV.put(
          "biz:last",
          JSON.stringify({ conn: conn.id, cust: custChat, at: Date.now() }),
        );
        return;
      }
      return forwardToOwner(
        env,
        conn,
        bmsg,
        `💬 营业中咨询（自动答疑未命中）· 来自 ${name}，回复下一条转发消息即可回顾客：`,
      );
    }
    // 营业外：先自动回一句（每位顾客每天只回一次，防刷屏），再转发留言
    const day = localDate(env).toISOString().slice(0, 10);
    const awayKey = `biz:away:${custChat}:${day}`;
    if (!(await env.BOT_KV.get(awayKey))) {
      await sendBiz(env, conn.id, custChat, CONFIG.AWAY_TEXT);
      await env.BOT_KV.put(awayKey, "1", { expirationTtl: 172800 });
    }
    return forwardToOwner(
      env,
      conn,
      bmsg,
      `🕐 营业外留言 · 来自 ${name}，回复下一条转发消息即可回顾客：`,
    );
  }

  // ---------- 普通私聊：店主回顾客 / 状态查询 ----------
  const msg = update.message;
  if (!msg || !msg.from || msg.chat.type !== "private") return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/ +/)[0].split("@")[0];
  const conn = await getConn(env);

  if (cmd === "/biz" || cmd === "/start") {
    if (!conn)
      return send(
        env,
        msg.chat.id,
        "📴 尚未连接 Business 账号。\n店主请用 Premium 账号打开 Telegram 设置 → Telegram Business → Chatbots，把本 Bot 连上并授权，连接后这里会显示状态。",
      );
    const mine = conn.ownerId === msg.from.id || isAdmin(env, msg.from.id);
    if (!mine)
      return send(
        env,
        msg.chat.id,
        "本 Bot 是店铺代答 Bot，连接状态仅店主可查。",
      );
    return send(
      env,
      msg.chat.id,
      `🏪 Business 代答状态\n连接：${conn.enabled ? "✅ 已连接并启用" : "⛔ 已断开/被停用"}\n营业时间：${CONFIG.OPEN}–${CONFIG.CLOSE}（工作日 ${CONFIG.WORKDAYS.join(",")}，时区偏移 ${Number(env.TZ_OFFSET) || 8} 小时）\n当前：${inBusinessHours(env) ? "营业中（关键词自动答疑）" : "非营业（自动留言+转店主）"}\n答疑条目：${CONFIG.QA.length} 条（改代码顶部 CONFIG.QA）`,
    );
  }

  // 店主回复转发件 → 回达顾客
  if (conn && conn.ownerChat === msg.chat.id && msg.from.id === conn.ownerId) {
    let target = null;
    const replyId = msg.reply_to_message?.message_id;
    if (replyId) {
      const raw = await env.BOT_KV.get("biz:map:" + replyId);
      if (raw) target = JSON.parse(raw);
    }
    if (!target) {
      const raw = await env.BOT_KV.get("biz:last");
      if (raw) target = JSON.parse(raw); // 兜底：没用「回复」时发给最近一位顾客
    }
    if (!target)
      return send(
        env,
        msg.chat.id,
        "没有可回的顾客。请用「回复」功能回复我转发给你的那条顾客消息。",
      );
    if (text) {
      const r = await sendBiz(env, target.conn, target.cust, text);
      return send(
        env,
        msg.chat.id,
        r.ok
          ? "✅ 已回达顾客。"
          : "⚠️ 发送失败，连接可能已断开，用 /biz 看状态。",
      );
    }
    // 店主发的是媒体：用 copyMessage 经连接转发
    const r = await tg(env, "copyMessage", {
      chat_id: target.cust,
      business_connection_id: target.conn,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    return send(
      env,
      msg.chat.id,
      r.ok
        ? "✅ 已回达顾客。"
        : "⚠️ 发送失败，连接可能已断开，用 /biz 看状态。",
    );
  }
}
