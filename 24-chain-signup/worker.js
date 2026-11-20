// ============================================================
// 24 接龙报名 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：群里发 /jielong 主题 建一个接龙，成员点「✋ 我接龙」按钮名字就
// 按顺序排进名单（再点一次取消），名单实时刷在消息上；发起人或
// 管理员 /closechain 截止。活动报名、拼单、值班认领都适用。
// 必填变量：BOT_TOKEN（Secret）
// 选填：ADMIN_ID（管理员可截止任何接龙）、WEBHOOK_SECRET、
// MAX_ENTRIES（名单上限，默认 200）
// ⚠️ 需要 KV：变量名 BOT_KV（键：chain:<接龙ID>）。
// 命令（群里用）：/jielong 周六羽毛球局 · /closechain 接龙ID
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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】接龙存储（KV）
// chain:<接龙ID> = { title, chat, creator, entries:[{id,name}], closed}
// 报名就是往 entries 里 toggle（有则删、无则加），名单渲染只读这一条记录。
// ============================================================
async function getChain(env, id) {
  const raw = await env.BOT_KV.get("chain:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function putChain(env, id, c) {
  await env.BOT_KV.put("chain:" + id, JSON.stringify(c));
}
function chainText(id, c) {
  const list = c.entries.length
    ? c.entries
        .slice(0, 50)
        .map((e, i) => `${i + 1}. ${e.name}`)
        .join("\n") +
      (c.entries.length > 50 ? `\n… 共 ${c.entries.length} 人` : "")
    : "（还没有人接龙，点按钮抢第一）";
  return `🐉 接龙：${c.title}\nID：${id}${c.closed ? " · 已截止" : ""}\n\n${list}`;
}
const chainKb = (id, c) =>
  c.closed
    ? { inline_keyboard: [] }
    : {
        inline_keyboard: [
          [
            {
              text: `✋ 我接龙（已 ${c.entries.length} 人，再点取消）`,
              callback_data: `join:${id}`,
            },
          ],
        ],
      };

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "jielong", description: "发起接龙" },
  { command: "closechain", description: "截止接龙" },
  { command: "start", description: "使用说明" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("chain-signup bot is running.", {
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
// 建接龙（/jielong）-> 按钮 toggle 报名（join:）-> 截止定版（/closechain 公布最终名单）。
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
    const [act, id] = String(cq.data || "").split(":");
    if (act !== "join") return;
    const c = await getChain(env, id);
    if (!c || c.closed)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "接龙不存在或已截止",
        show_alert: true,
      });
    const idx = c.entries.findIndex((e) => e.id === cq.from.id);
    let note;
    if (idx >= 0) {
      c.entries.splice(idx, 1);
      note = "已取消你的接龙";
    } else {
      const max = Number(env.MAX_ENTRIES) || 200;
      if (c.entries.length >= max)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `名单已满（${max} 人）`,
          show_alert: true,
        });
      c.entries.push({ id: cq.from.id, name: who(cq.from) });
      note = `✅ 接龙成功，你是第 ${c.entries.length} 位`;
    }
    await putChain(env, id, c);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: note,
    });
    return tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: chainText(id, c),
      reply_markup: chainKb(id, c),
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/jielong" || cmd === "/chain") {
    const title = text.replace(/^\/(jielong|chain)(@\w+)?\s*/, "").trim();
    if (!title)
      return send(
        env,
        msg.chat.id,
        "用法：/jielong 接龙主题（如 /jielong 周六羽毛球局）",
      );
    const id = newId();
    const c = {
      title,
      chat: msg.chat.id,
      creator: msg.from.id,
      entries: [],
      closed: false,
    };
    await putChain(env, id, c);
    return tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: chainText(id, c),
      reply_markup: chainKb(id, c),
    });
  }
  if (cmd === "/closechain") {
    const id = text.split(/\s+/)[1];
    const c = id && (await getChain(env, id));
    if (!c) return send(env, msg.chat.id, "用法：/closechain 接龙ID");
    let allowed =
      c.creator === msg.from.id || admins(env).includes(String(msg.from.id));
    if (!allowed && msg.chat.type !== "private") {
      const me = await tg(env, "getChatMember", {
        chat_id: msg.chat.id,
        user_id: msg.from.id,
      });
      allowed = ["administrator", "creator"].includes(me.result?.status);
    }
    if (!allowed)
      return send(
        env,
        msg.chat.id,
        "只有发起人、群管理员或 Bot 管理员能截止。",
      );
    c.closed = true;
    await putChain(env, id, c);
    return send(
      env,
      msg.chat.id,
      `🏁 接龙截止，最终名单（${c.entries.length} 人）：\n\n${c.entries.length ? c.entries.map((e, i) => `${i + 1}. ${e.name}`).join("\n") : "（无人接龙）"}`,
    );
  }
  if (cmd === "/start")
    return send(
      env,
      msg.chat.id,
      "🐉 接龙报名 Bot：在群里发 /jielong 主题 建接龙，成员点按钮报名（再点取消），/closechain 接龙ID 截止定版。",
    );
}
