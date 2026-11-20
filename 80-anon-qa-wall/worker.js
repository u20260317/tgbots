// ============================================================
// 80 匿名提问墙 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 粉丝私聊 Bot 提问 → 以「❓ 匿名提问 #号」卡片发到博主的频道 →
// 博主用 /answer <号> <回答> 公开作答（答案卡也发频道）→ 可选
// 私信通知提问者「你的问题有回答了」。
// 与 29 匿名信箱的区别：29 是私聊双向信箱（内容只有双方可见）；
// 80 是公开问答墙——问题与回答都公开展示在频道，卖点是围观与
// 互动。提问者身份只存 ask: 映射键，频道侧从头到尾不出现。
// 先审后发可选：WALL_REVIEW=1 时问题先发管理员审核（复用模块 10
// 审核流：ask:ok / ask:no 按钮），通过才上墙；=0 直接上墙。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// WALL_CHANNEL_ID 目标频道（如 @yourchannel 或 -100 开头的数字 id），
// Bot 必须是该频道管理员（只需发帖权限）
// 选填：
// WALL_REVIEW =1 先审后发（默认 0 直接发）
// WALL_NOTIFY =0 关掉「回答后私信通知提问者」（默认开）
// ADMIN_ID 管理员数字 ID（审核人 + /answer 作答人）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：ask:<提问号> = {uid, q, status, t, qMsg?, aMsg?}；
// ask:seq 计数器（提问号自增）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 10（审核流）+ 模块 05（频道发帖）+ 模块 01/02
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
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 本 Bot 的作答权 = 管理员权（博主本人），/answer 只认 ADMIN_ID。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "ask", description: "匿名提问 /ask 你的问题" },
  { command: "myasks", description: "我提过的问题" },
];
const COMMANDS_ADMIN = [
  { command: "answer", description: "公开作答 /answer <号> <回答>（管理员）" },
  { command: "askstats", description: "提问墙统计（管理员）" },
];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    for (const id of admins(env)) {
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
    }
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("anon-qa-wall bot is running.", {
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
// 上墙发布
// 问题卡文案只有「❓ 匿名提问 #号 + 问题正文」——不带提问者任何
// 信息（名字/用户名/ID 都不进频道）。发失败（Bot 不是频道管理员
// 等）抛错，调用方如实告诉用户，不假装已发布。
// ============================================================
async function publishQuestion(env, id, q) {
  const r = await send(
    env,
    env.WALL_CHANNEL_ID,
    `❓ 匿名提问 #${id}\n\n${q}\n\n—— 来自一位匿名读者`,
  );
  if (!r.ok) throw new Error("往频道发帖失败（Bot 是频道管理员吗？）");
  return r.result.message_id;
}
async function getAsk(env, id) {
  const raw = await env.BOT_KV.get("ask:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveAsk(env, id, ask) {
  await env.BOT_KV.put("ask:" + id, JSON.stringify(ask));
}

// ============================================================
// 业务主流程
// /ask 落 ask: 记录（号从 ask:seq 自增）：
// · WALL_REVIEW=1 → status=review，把审核卡（问题全文 + 提问号，
// 不带提问者身份给频道、但管理员审核卡上也不显示身份——审核只
// 看内容）推给全部管理员，按钮 ask:ok:<号> / ask:no:<号>；
// · 否则直接 publishQuestion 上墙，status=published。
// /answer（管理员）：答案卡发频道 + 可选私信通知提问者。
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
    const data = String(cq.data || "");
    if (!data.startsWith("ask:")) return;
    if (!isAdmin(env, cq.from.id))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "只有管理员能审核",
        show_alert: true,
      });
    const [, act, id] = data.split(":");
    const ask = await getAsk(env, id);
    if (!ask || ask.status !== "review")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这条已处理过了",
        show_alert: true,
      });
    if (act === "no") {
      ask.status = "rejected";
      await saveAsk(env, id, ask);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已拒绝",
      });
      await send(env, ask.uid, `你的匿名提问 #${id} 未通过审核，没有上墙。`);
      return;
    }
    if (act === "ok") {
      try {
        ask.qMsg = await publishQuestion(env, id, ask.q);
        ask.status = "published";
        await saveAsk(env, id, ask);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已上墙 ✅",
        });
        await send(env, ask.uid, `✅ 你的匿名提问 #${id} 已发布到频道。`);
      } catch (e) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: String(e.message || e).slice(0, 100),
          show_alert: true,
        });
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (msg.chat.type !== "private") return; // 只在私聊收提问，群里发命令不理

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      `❓ 匿名提问墙\n\n/ask <你的问题> 匿名提问，问题会以「匿名提问」卡片发到频道 ${env.WALL_CHANNEL_ID || "(未配置)"}，博主公开作答。\n/myasks 看我提过的问题与状态。\n\n🕶️ 匿名承诺：频道里只会出现问题本身，永远不会出现你的名字与 ID。${env.WALL_REVIEW === "1" ? "\n📝 本墙先审后发：问题先经管理员审核才上墙。" : ""}`,
    );

  if (cmd === "/ask") {
    const q = text.slice(cmd.length).trim().slice(0, 1000);
    if (!q)
      return send(
        env,
        chatId,
        "用法：/ask <你的问题>（问题跟在命令后面，一次发完）",
      );
    if (!env.WALL_CHANNEL_ID)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置 WALL_CHANNEL_ID，提问墙暂时没开。",
      );
    const seq = Number(await env.BOT_KV.get("ask:seq")) || 0;
    const id = seq + 1;
    await env.BOT_KV.put("ask:seq", String(id));
    const ask = { uid, q, status: "new", t: Date.now() };
    if (env.WALL_REVIEW === "1") {
      ask.status = "review";
      await saveAsk(env, id, ask);
      for (const a of admins(env))
        await send(env, a, `📝 待审匿名提问 #${id}\n\n${q}`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ 通过上墙", callback_data: `ask:ok:${id}` },
                { text: "❌ 拒绝", callback_data: `ask:no:${id}` },
              ],
            ],
          },
        });
      return send(
        env,
        chatId,
        `📝 收到！你的问题编号 #${id}，先审后发，通过后会出现在频道里。`,
      );
    }
    try {
      ask.qMsg = await publishQuestion(env, id, q);
      ask.status = "published";
      await saveAsk(env, id, ask);
      return send(
        env,
        chatId,
        `✅ 已匿名发布到频道，编号 #${id}。博主回答后${env.WALL_NOTIFY === "0" ? "请去频道看" : "我会私信通知你"}。`,
      );
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 发布失败：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (cmd === "/answer") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有博主（管理员）能公开作答。");
    const id = parts[1];
    const answer = text.split(/\s+/).slice(2).join(" ");
    if (!id || !answer)
      return send(env, chatId, "用法：/answer <提问号> <回答内容>");
    const ask = await getAsk(env, id);
    if (!ask) return send(env, chatId, `没有 #${id} 这个提问。`);
    if (ask.status === "answered")
      return send(env, chatId, `#${id} 已经回答过了。`);
    const r = await send(
      env,
      env.WALL_CHANNEL_ID,
      `💬 回答 #${id}\n\nQ：${ask.q}\n\nA：${answer}`,
    );
    if (!r.ok)
      return send(env, chatId, "往频道发答案失败（Bot 是频道管理员吗？）。");
    ask.status = "answered";
    ask.aMsg = r.result.message_id;
    await saveAsk(env, id, ask);
    if (env.WALL_NOTIFY !== "0")
      await send(
        env,
        ask.uid,
        `💬 你的匿名提问 #${id} 有回答了！\n\nQ：${ask.q}\nA：${answer}`,
      );
    return send(env, chatId, `✅ #${id} 的回答已发到频道。`);
  }

  if (cmd === "/myasks") {
    const list = await env.BOT_KV.list({ prefix: "ask:", limit: 1000 });
    const mine = [];
    for (const k of list.keys) {
      if (k.name === "ask:seq") continue;
      const a = JSON.parse((await env.BOT_KV.get(k.name)) || "null");
      if (a && a.uid === uid)
        mine.push(`#${k.name.slice(4)} · ${a.status} · ${a.q.slice(0, 40)}`);
    }
    return send(
      env,
      chatId,
      mine.length
        ? `❓ 我提过的问题：\n${mine.join("\n")}`
        : "还没提过问题。/ask <问题> 来一条。",
    );
  }

  if (cmd === "/askstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const total = (await env.BOT_KV.get("ask:seq")) || "0";
    return send(env, chatId, `📊 提问墙累计提问：${total} 条`);
  }
}
