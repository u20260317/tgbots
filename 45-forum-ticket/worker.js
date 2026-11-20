// ============================================================
// 45 论坛话题工单 Bot（单文件 · Cloudflare Workers · 需绑定 KV）
// 功能：
// 30 号工单的话题群升级版：用户私聊提单 → Bot 在开了话题功能的
// 客服超级群里 createForumTopic 一单一话题 → 用户后续消息按
// message_thread_id 投进话题 → 客服在话题里直接回复即回达用户 →
// /close 结单（关闭话题，不删，记录还在，可 reopen 复活）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// FORUM_GROUP_ID 客服超级群 ID（负数），必须开启 Topics 且 Bot 是
// 管理员（勾上管理话题权限），否则 createForumTopic 直接报错
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 管理员数字 ID（看 /tickets 工单总览用）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计（沿用模块 30 + 39 的注册约定）：
// ticket:<编号> 工单本体；userticket:<用户ID> 未结工单编号（一人一单）；
// topic:<客服群ID>:<编号> = thread_id；tmap:topic:<thread_id> = 编号（反查）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 39（论坛话题）+ 模块 30/10（工单与审核流）+ 模块 01（骨架）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// ============================================================
// 工单存储（KV，模块 30 约定）
// ticket:<编号> = { id, user, name, status:"open"|"closed", created, last}
// userticket:<用户ID> = 未结工单编号：一人同时一张，追加消息靠它续单。
// ============================================================
async function getTicket(env, id) {
  const raw = id ? await env.BOT_KV.get("ticket:" + id) : null;
  return raw ? JSON.parse(raw) : null;
}
async function saveTicket(env, t) {
  await env.BOT_KV.put("ticket:" + t.id, JSON.stringify(t));
}
async function openTicketOf(env, userId) {
  const id = await env.BOT_KV.get("userticket:" + userId);
  const t = id ? await getTicket(env, id) : null;
  return t && t.status === "open" ? t : null;
}

// ============================================================
// 话题映射与建话题（模块 39）
// topic:<客服群ID>:<工单号> = thread_id；反查 tmap:topic:<thread_id>。
// 建话题后先在话题里发一张工单卡（带 tclose: 关单按钮），用户消息
// 再 copyMessage 进话题——客服看到的是「卡 + 对话」一格一单。
// ============================================================
async function getThread(env, ticketId) {
  const raw = await env.BOT_KV.get(`topic:${env.FORUM_GROUP_ID}:${ticketId}`);
  return raw ? Number(raw) : null;
}
async function openTicketTopic(env, ticket, subject) {
  const r = await tg(env, "createForumTopic", {
    chat_id: Number(env.FORUM_GROUP_ID),
    name: `${ticket.id} · ${subject}`.slice(0, 128),
    icon_color: 0x6fb9f0,
  });
  if (!r.ok) throw new Error(r.description || "createForumTopic 失败");
  const threadId = r.result.message_thread_id;
  await env.BOT_KV.put(
    `topic:${env.FORUM_GROUP_ID}:${ticket.id}`,
    String(threadId),
  );
  await env.BOT_KV.put("tmap:topic:" + threadId, ticket.id);
  await tg(env, "sendMessage", {
    chat_id: Number(env.FORUM_GROUP_ID),
    message_thread_id: threadId,
    text: `🎫 新工单 ${ticket.id}\n用户：${ticket.name}（${ticket.user}）\n直接在本话题里回复即可回达用户；结单点按钮或发 /close`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ 关闭工单", callback_data: `tclose:${ticket.id}` }],
      ],
    },
  });
  return threadId;
}
// 结单：关话题不删话题（记录保留、随时能 reopen），清映射防误投。
async function closeTicket(env, ticket, byStaff) {
  ticket.status = "closed";
  await saveTicket(env, ticket);
  await env.BOT_KV.delete("userticket:" + ticket.user);
  const threadId = await getThread(env, ticket.id);
  if (threadId) {
    await tg(env, "closeForumTopic", {
      chat_id: Number(env.FORUM_GROUP_ID),
      message_thread_id: threadId,
    });
    await env.BOT_KV.delete(`topic:${env.FORUM_GROUP_ID}:${ticket.id}`);
    await env.BOT_KV.delete("tmap:topic:" + threadId);
  }
  await send(
    env,
    ticket.user,
    `🎫 你的工单 ${ticket.id} 已${byStaff ? "由客服" : ""}关闭。有新问题直接再发消息即可开新单。`,
  );
  if (byStaff && threadId)
    await send(env, Number(env.FORUM_GROUP_ID), `工单 ${ticket.id} 已关闭。`, {
      message_thread_id: threadId,
    }).catch(() => {});
}

// ============================================================
// 管理员白名单与分级命令菜单
// 菜单隐藏只是体验，真正的门是业务里的 isAdmin() 校验（数字 ID 白名单）。
// ============================================================
const COMMANDS_USER = [
  { command: "myticket", description: "我的工单状态" },
  { command: "close", description: "关闭我的工单" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "tickets", description: "未结工单总览（管理员）" },
];
const isAdmin = (env, uid) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(uid));
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  const ids = String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids)
    await tg(env, "setMyCommands", {
      commands: [...COMMANDS_USER, ...COMMANDS_ADMIN],
      scope: { type: "chat", chat_id: Number(id) },
    });
  return r;
}

// ============================================================
// Worker 入口与路由
// 标准 webhook 入口：健康检查、/setWebhook 一键挂载、密钥校验、更新分发。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("forum-ticket bot is running.", {
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
// 业务主流程（双向路由）
// 用户侧（私聊）：首条消息建单+建话题，后续消息 copy 进话题。
// 客服侧（话题群）：带 message_thread_id 的消息反查工单 copy 回用户；
// /close 或工单卡上的 tclose: 按钮结单（关话题不删）。
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) {
    const m = update.message;
    if (m && m.chat.type === "private")
      return send(env, m.chat.id, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");
    return;
  }
  const supportChat = Number(env.FORUM_GROUP_ID || 0);

  const cq = update.callback_query;
  if (cq) {
    if (!String(cq.data || "").startsWith("tclose:")) return;
    const t = await getTicket(env, cq.data.slice("tclose:".length));
    if (!t || t.status !== "open")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "工单已关闭",
      });
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "已关单",
    });
    return closeTicket(env, t, true);
  }

  const msg = update.message;
  if (!msg || !msg.from || msg.from.is_bot) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  // —— 客服侧：客服群里的消息 ——
  if (supportChat && msg.chat.id === supportChat) {
    const threadId = msg.message_thread_id;
    if (!threadId || threadId === 1) return; // General 话题不路由
    const ticketId = await env.BOT_KV.get("tmap:topic:" + threadId);
    if (!ticketId) return;
    const t = await getTicket(env, ticketId);
    if (!t || t.status !== "open") return;
    if (cmd === "/close") return closeTicket(env, t, true);
    if (text.startsWith("/")) return;
    // 客服在话题里的任何消息（文字/图片/文件）原样复制回用户
    return tg(env, "copyMessage", {
      chat_id: t.user,
      from_chat_id: supportChat,
      message_id: msg.message_id,
    });
  }

  // —— 用户侧：只处理私聊 ——
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🎫 客服工单（话题版）\n\n直接把问题发给我就行：我会为你开一张工单，客服在专属话题里回复你，回复会原样送回这里。\n/myticket 看工单状态 · /close 关闭工单",
    );
  if (cmd === "/myticket") {
    const t = await openTicketOf(env, uid);
    return send(
      env,
      chatId,
      t
        ? `🎫 你有一张进行中的工单：${t.id}（直接发消息即可续聊）`
        : "你现在没有进行中的工单，直接发消息即可开单。",
    );
  }
  if (cmd === "/close") {
    const t = await openTicketOf(env, uid);
    if (!t) return send(env, chatId, "你没有进行中的工单。");
    return closeTicket(env, t, false);
  }
  if (cmd === "/tickets") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有管理员能看工单总览。");
    const list = await env.BOT_KV.list({ prefix: "ticket:", limit: 200 });
    const open = [];
    for (const k of list.keys) {
      const t = await getTicket(env, k.name.slice("ticket:".length));
      if (t && t.status === "open") open.push(t);
    }
    if (!open.length) return send(env, chatId, "当前没有未结工单。");
    return send(
      env,
      chatId,
      "🎫 未结工单\n\n" +
        open.map((t) => `· ${t.id} — ${t.name}（${t.user}）`).join("\n"),
    );
  }
  if (text.startsWith("/")) return;

  if (!supportChat)
    return send(
      env,
      chatId,
      "⚠️ 管理员还没配置客服群（FORUM_GROUP_ID），暂时提不了工单。",
    );

  // 建单或续单
  let t = await openTicketOf(env, uid);
  if (!t) {
    t = {
      id: "TK-" + newId().toUpperCase(),
      user: uid,
      name: msg.from.first_name || "用户",
      status: "open",
      created: Date.now(),
      last: Date.now(),
    };
    await saveTicket(env, t);
    await env.BOT_KV.put("userticket:" + uid, t.id);
    try {
      await openTicketTopic(
        env,
        t,
        (msg.text || msg.caption || "（附件）").slice(0, 40),
      );
    } catch (e) {
      return send(
        env,
        chatId,
        "😵 建工单话题失败：" +
          String(e.message || e).slice(0, 180) +
          "\n（多半是客服群没开 Topics 或 Bot 没有管理话题权限，请管理员检查）",
      );
    }
    await send(
      env,
      chatId,
      `🎫 工单 ${t.id} 已创建，客服会在专属话题里处理，直接在这里继续发消息即可补充。`,
    );
  }
  t.last = Date.now();
  await saveTicket(env, t);
  const threadId = await getThread(env, t.id);
  if (threadId)
    await tg(env, "copyMessage", {
      chat_id: supportChat,
      message_thread_id: threadId,
      from_chat_id: chatId,
      message_id: msg.message_id,
    });
}
