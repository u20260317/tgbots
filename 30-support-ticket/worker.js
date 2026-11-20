// ============================================================
// 30 客服工单 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：用户私聊发消息（或 /ticket 描述）即生成带编号的工单，工单卡
// 发到客服群；客服在群里回复工单卡（或工单下的任何一条转发）就直接
// 回到用户；用户后续消息自动续到同一张未关闭工单；客服点卡上按钮
// 关闭工单。比 02 双向 Bot 多了编号、状态和多人客服协作。
// 必填变量：BOT_TOKEN（Secret）、ADMIN_ID（管理员数字 ID，逗号分隔）
// 选填：SUPPORT_CHAT_ID（客服群 ID；不填则工单卡发给第一个管理员私聊）、
// WEBHOOK_SECRET
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV
// （键：ticket:<编号>、userticket:<用户ID>、tmap:<客服侧消息ID>）。
// 命令：用户 /ticket 问题描述 开单、/myticket 看我的工单；
// 管理员 /tickets 列未关闭工单。客服回复工单消息即回用户，无需命令。
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
const supportChat = (env) => env.SUPPORT_CHAT_ID || admins(env)[0];
const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;
const fmtTime = (ts) =>
  new Date(ts).toISOString().replace("T", " ").slice(5, 16) + " UTC";

// ============================================================
// 【核心模块】工单存储（KV）
// ticket:<编号> = { id, user, name, status:open|closed, cardMsg, created, last }
// userticket:<用户ID> = 未关闭工单编号（一人同时一张，追加消息靠它续单）
// tmap:<客服侧消息ID> = 工单编号（工单卡和每条转发都登记，客服回复任意一条都能路由）
// ============================================================
async function getTicket(env, id) {
  const raw = await env.BOT_KV.get("ticket:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function putTicket(env, t) {
  await env.BOT_KV.put("ticket:" + t.id, JSON.stringify(t));
}
async function openTicketOf(env, userId) {
  const id = await env.BOT_KV.get("userticket:" + userId);
  if (!id) return null;
  const t = await getTicket(env, id);
  return t && t.status === "open" ? t : null;
}
function cardText(t) {
  return `🎫 工单 ${t.id}${t.status === "closed" ? "（已关闭）" : ""}\n用户：${t.name}\n创建：${fmtTime(t.created)} · 最近：${fmtTime(t.last)}\n\n客服操作：回复本卡或工单下任意一条转发消息 = 回复用户。`;
}
const cardKb = (t) =>
  t.status === "closed"
    ? { inline_keyboard: [] }
    : {
        inline_keyboard: [
          [{ text: "✅ 关闭工单", callback_data: `tclose:${t.id}` }],
        ],
      };

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
  { command: "ticket", description: "新建工单" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "tickets", description: "未关闭工单（管理员）" },
];
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
      return new Response("support-ticket bot is running.", {
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
// 用户侧：首条消息建单发卡，后续消息复制转发续单；客服侧：回复被映射的消息即回用户；tclose 按钮关单。
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
  const sc = supportChat(env);

  // ---------- 关闭工单按钮 ----------
  const cq = update.callback_query;
  if (cq) {
    if (!String(cq.data || "").startsWith("tclose:")) return;
    const t = await getTicket(env, cq.data.slice(7));
    if (!t || t.status === "closed")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "工单不存在或已关闭",
        show_alert: true,
      });
    t.status = "closed";
    await putTicket(env, t);
    await env.BOT_KV.delete("userticket:" + t.user);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `已关闭 ${t.id}`,
    });
    await tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: cardText(t),
      reply_markup: cardKb(t),
    });
    return send(
      env,
      t.user,
      `✅ 你的工单 ${t.id} 已由客服关闭。如还有问题，直接发消息会重新开一张新工单。`,
    );
  }

  const msg = update.message;
  if (!msg || !msg.from || msg.from.is_bot) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];

  // ---------- 客服侧：客服群/管理员会话 ----------
  if (String(msg.chat.id) === String(sc)) {
    if (cmd === "/tickets") {
      const list = await env.BOT_KV.list({ prefix: "ticket:", limit: 200 });
      const open = [];
      for (const k of list.keys) {
        const t = await getTicket(env, k.name.slice(7));
        if (t && t.status === "open") open.push(t);
      }
      if (!open.length)
        return send(env, msg.chat.id, "🎫 当前没有未关闭工单。");
      return send(
        env,
        msg.chat.id,
        "🎫 未关闭工单：\n\n" +
          open
            .map((t) => `${t.id} · ${t.name} · 最近 ${fmtTime(t.last)}`)
            .join("\n"),
      );
    }
    // 回复工单卡/转发消息 -> 回给用户
    if (msg.reply_to_message) {
      const tid = await env.BOT_KV.get(
        "tmap:" + msg.reply_to_message.message_id,
      );
      const t = tid && (await getTicket(env, tid));
      if (t) {
        if (t.status === "closed")
          return send(env, msg.chat.id, `工单 ${t.id} 已关闭，回复不会发送。`);
        const r = await tg(env, "copyMessage", {
          chat_id: t.user,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        });
        if (r.ok) {
          t.last = Date.now();
          await putTicket(env, t);
          return;
        }
        return send(env, msg.chat.id, "😢 发送失败（用户可能已屏蔽 Bot）。");
      }
    }
    return; // 客服会话里的其它消息不处理
  }

  // ---------- 用户侧（私聊） ----------
  if (msg.chat.type !== "private") return;
  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      msg.chat.id,
      "🎫 客服工单 Bot\n直接发消息描述你的问题即可开工单，客服回复会转到这里；问题没解决完前，后续消息都会续到同一张工单。\n/myticket 查看我的工单状态。",
    );
  if (cmd === "/myticket") {
    const t = await openTicketOf(env, msg.from.id);
    return send(
      env,
      msg.chat.id,
      t
        ? `你有一张进行中的工单 ${t.id}（创建于 ${fmtTime(t.created)}），直接发消息即可补充。`
        : "你现在没有进行中的工单，直接发消息即可新开一张。",
    );
  }
  if (text.startsWith("/") && cmd !== "/ticket") return;

  if (!sc)
    return send(
      env,
      msg.chat.id,
      "⚠️ 管理员还没配置客服会话（SUPPORT_CHAT_ID 或 ADMIN_ID），工单暂时提交不了。",
    );
  const body =
    cmd === "/ticket" ? text.replace(/^\/ticket(@\w+)?\s*/, "") : null;

  let t = await openTicketOf(env, msg.from.id);
  if (!t) {
    // 建单：先发工单卡，再把首条内容作为回复转发到卡下
    t = {
      id: "TK-" + newCode(),
      user: msg.from.id,
      name: who(msg.from),
      status: "open",
      cardMsg: 0,
      created: Date.now(),
      last: Date.now(),
    };
    const card = await tg(env, "sendMessage", {
      chat_id: sc,
      text: cardText(t),
      reply_markup: cardKb(t),
    });
    if (!card.ok)
      return send(
        env,
        msg.chat.id,
        "😢 工单提交失败（客服会话不可达），请稍后再试。",
      );
    t.cardMsg = card.result.message_id;
    await putTicket(env, t);
    await env.BOT_KV.put("userticket:" + msg.from.id, t.id);
    await env.BOT_KV.put("tmap:" + t.cardMsg, t.id);
    await send(
      env,
      msg.chat.id,
      `🎫 工单已创建：${t.id}\n客服回复会转到这里，继续发消息可以补充说明。`,
    );
  } else {
    t.last = Date.now();
    await putTicket(env, t);
  }
  // 把用户这条消息复制转发到客服侧（挂在工单卡下），登记映射供客服回复路由
  const payload = {
    chat_id: sc,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_to_message_id: t.cardMsg,
  };
  const r = await tg(env, "copyMessage", payload);
  if (r.ok) await env.BOT_KV.put("tmap:" + r.result.message_id, t.id);
}
