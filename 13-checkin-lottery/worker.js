// ============================================================
// 13 签到积分 / 抽奖 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 每日签到：/qd 或 /checkin，每天一次，基础 10 分 + 连签加成（每天 +1，上限 +10）
// 积分查询：/me 我的积分、连签天数；/top 积分榜 Top 10
// 抽奖：管理员 /lottery 奖品名 在当前聊天发起（群里发就群里抽），
// 成员点消息上的「🎁 参与抽奖」按钮报名（可设参与门票积分 LOTTERY_COST），
// 管理员 /draw 抽奖ID [中奖人数] 开奖，Bot 公布并私聊通知中奖者
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（只有管理员能发起/开奖）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// LOTTERY_COST 参与一次抽奖扣多少积分，默认 0（免费参与）
// TZ_OFFSET 签到按哪个时区算「一天」，默认 8（北京时间）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：pts:<用户ID> 存积分档案；lot:<抽奖ID> 存一场抽奖（奖品/名单/状态）。
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
const dayKey = (env) =>
  new Date(Date.now() + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
const yesterdayKey = (env) =>
  new Date(
    Date.now() + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000 - 86400 * 1000,
  )
    .toISOString()
    .slice(0, 10);
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】积分存储（KV）
// pts:<用户ID> = { p:积分, last:上次签到日期, streak:连签天数, name:显示名}，签到/扣费/排行都走这里。
// ============================================================
async function getProfile(env, userId) {
  const raw = await env.BOT_KV.get("pts:" + userId);
  return raw ? JSON.parse(raw) : { p: 0, last: "", streak: 0, name: "" };
}
async function saveProfile(env, userId, prof) {
  await env.BOT_KV.put("pts:" + userId, JSON.stringify(prof));
}
async function addPoints(env, user, delta) {
  const prof = await getProfile(env, user.id);
  prof.p += delta;
  prof.name = who(user);
  await saveProfile(env, user.id, prof);
  return prof;
}

// ============================================================
// 【核心模块】抽奖存储（KV）
// lot:<抽奖ID> = { prize, chat, entries:[{id,name}], drawn:bool, cost}，一场一条记录，开奖后保留可查。
// ============================================================
async function getLottery(env, id) {
  const raw = await env.BOT_KV.get("lot:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveLottery(env, id, lot) {
  await env.BOT_KV.put("lot:" + id, JSON.stringify(lot));
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "qd", description: "每日签到领积分" },
  { command: "me", description: "我的积分与连签" },
  { command: "top", description: "积分排行榜" },
  { command: "lottery", description: "发起抽奖（管理员）" },
  { command: "draw", description: "开奖（管理员）" },
  { command: "start", description: "使用说明" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("checkin-lottery bot is running.", {
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
// 签到积分主流程（签到/查询/排行）+ 抽奖主流程（发起/按钮报名/开奖），回调前缀 lj: 只管抽奖报名。
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

  // ---------- 抽奖报名按钮 ----------
  const cq = update.callback_query;
  if (cq) {
    if (!String(cq.data || "").startsWith("lj:")) return;
    const lotId = cq.data.slice(3);
    const lot = await getLottery(env, lotId);
    if (!lot || lot.drawn)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这场抽奖已结束或不存在",
        show_alert: true,
      });
    if (lot.entries.some((e) => e.id === cq.from.id))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "你已经参与啦，等开奖吧 🍀",
      });
    const cost = lot.cost || 0;
    if (cost > 0) {
      const prof = await getProfile(env, cq.from.id);
      if (prof.p < cost)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `积分不足：参与需 ${cost} 分，你有 ${prof.p} 分，先去签到 /qd 攒分`,
          show_alert: true,
        });
      await addPoints(env, cq.from, -cost);
    }
    lot.entries.push({ id: cq.from.id, name: who(cq.from) });
    await saveLottery(env, lotId, lot);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `✅ 报名成功！当前 ${lot.entries.length} 人参与`,
    });
    return tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: lotteryText(lotId, lot),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `🎁 参与抽奖（已 ${lot.entries.length} 人）`,
              callback_data: `lj:${lotId}`,
            },
          ],
        ],
      },
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  // ---------- 签到 ----------
  if (cmd === "/qd" || cmd === "/checkin" || text === "签到") {
    const prof = await getProfile(env, msg.from.id);
    const today = dayKey(env);
    if (prof.last === today)
      return send(
        env,
        chatId,
        `📅 今天已经签过啦。当前积分 ${prof.p}，连签 ${prof.streak} 天，明天再来。`,
      );
    prof.streak = prof.last === yesterdayKey(env) ? prof.streak + 1 : 1;
    const gain = 10 + Math.min(prof.streak - 1, 10);
    prof.p += gain;
    prof.last = today;
    prof.name = who(msg.from);
    await saveProfile(env, msg.from.id, prof);
    return send(
      env,
      chatId,
      `✅ 签到成功 +${gain} 分（连签 ${prof.streak} 天）\n当前积分：${prof.p}`,
    );
  }

  // ---------- 我的积分 ----------
  if (cmd === "/me" || cmd === "/points") {
    const prof = await getProfile(env, msg.from.id);
    return send(
      env,
      chatId,
      `🧾 ${who(msg.from)}\n积分：${prof.p}\n连签：${prof.streak} 天\n签到发 /qd，排行发 /top`,
    );
  }

  // ---------- 排行榜 ----------
  if (cmd === "/top") {
    const list = await env.BOT_KV.list({ prefix: "pts:", limit: 1000 });
    const rows = [];
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (raw) {
        const p = JSON.parse(raw);
        rows.push({ name: p.name || k.name.slice(4), p: p.p });
      }
    }
    rows.sort((a, b) => b.p - a.p);
    if (!rows.length)
      return send(env, chatId, "还没有人签到，快发 /qd 抢榜一。");
    return send(
      env,
      chatId,
      "🏆 积分榜 Top 10\n\n" +
        rows
          .slice(0, 10)
          .map((r, i) => `${i + 1}. ${r.name} — ${r.p} 分`)
          .join("\n"),
    );
  }

  // ---------- 发起抽奖（管理员） ----------
  if (cmd === "/lottery") {
    if (!isAdmin(env, msg.from.id))
      return send(env, chatId, "⛔ 只有管理员能发起抽奖。");
    const prize = text.replace(/^\/lottery(@\w+)?\s*/, "").trim();
    if (!prize)
      return send(
        env,
        chatId,
        "用法：/lottery 奖品名称（如 /lottery 50 USDT）",
      );
    const lotId = newId();
    const lot = {
      prize,
      chat: chatId,
      entries: [],
      drawn: false,
      cost: Number(env.LOTTERY_COST) || 0,
      t: Date.now(),
    };
    await saveLottery(env, lotId, lot);
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: lotteryText(lotId, lot),
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎁 参与抽奖（已 0 人）", callback_data: `lj:${lotId}` }],
        ],
      },
    });
  }

  // ---------- 开奖（管理员） ----------
  if (cmd === "/draw") {
    if (!isAdmin(env, msg.from.id))
      return send(env, chatId, "⛔ 只有管理员能开奖。");
    const [, lotId, nStr] = text.split(/\s+/);
    const lot = lotId && (await getLottery(env, lotId));
    if (!lot)
      return send(
        env,
        chatId,
        "用法：/draw 抽奖ID [中奖人数]（抽奖ID 见发起消息）",
      );
    if (lot.drawn) return send(env, chatId, "这场已经开过奖了。");
    if (!lot.entries.length)
      return send(env, chatId, "还没有人参与，无法开奖。");
    const n = Math.min(Number(nStr) || 1, lot.entries.length);
    const pool = [...lot.entries];
    const winners = [];
    for (let i = 0; i < n; i++) {
      const idx = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
      winners.push(pool.splice(idx, 1)[0]);
    }
    lot.drawn = true;
    lot.winners = winners;
    await saveLottery(env, lotId, lot);
    for (const w of winners)
      await send(
        env,
        w.id,
        `🎉 恭喜！你在抽奖「${lot.prize}」中中奖啦，请联系管理员领奖。`,
      ).catch(() => {});
    return send(
      env,
      chatId,
      `🎉 开奖啦！奖品：${lot.prize}\n参与人数：${lot.entries.length}\n\n🏆 中奖者：\n${winners.map((w) => "· " + w.name).join("\n")}\n\n恭喜！Bot 已私聊通知中奖者。`,
    );
  }

  if (text.startsWith("/start") || text.startsWith("/help"))
    return send(
      env,
      chatId,
      "🎲 签到积分/抽奖 Bot\n\n/qd 每日签到领积分（连签有加成）\n/me 我的积分\n/top 积分榜\n管理员发起抽奖后，点消息上的「🎁 参与抽奖」按钮报名，等 /draw 开奖。",
    );
}

function lotteryText(lotId, lot) {
  return `🎁 抽奖进行中！\n奖品：${lot.prize}\n参与门票：${lot.cost > 0 ? lot.cost + " 积分" : "免费"}\n抽奖 ID：${lotId}\n\n点下方按钮参与，管理员开奖后 Bot 会公布并私聊通知中奖者。`;
}
