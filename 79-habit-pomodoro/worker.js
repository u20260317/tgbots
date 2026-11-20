// ============================================================
// 79 习惯打卡 / 番茄钟 Bot（单文件 · Cloudflare Workers + KV + Cron）
// 功能：
// /habit <习惯名> 建习惯；/habits 看习惯列表（按钮打卡 + 近 7 天
// 周视图 + 连续天数 streak）；/pomo [分钟] 开一个番茄钟（默认
// 25 分钟），到点 Cron 推送「🍅 番茄完成」；/pomos 看进行中的番茄。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// ADMIN_ID 管理员数字 ID（看 /habitstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：habit:<uid> = {habits:[{name, created, checks:{日期:1},
// streak, best}]}（一人一键整表读写，习惯数量小没问题）；
// pomo:<uid>:<番茄ID> = {end(毫秒), label, chat} 一颗一键，
// Cron 扫 pomo: 前缀逐个判到期，天然支持多人多颗并发。
// ⚠️ 需要 Cron：Triggers 加一条 * * * * *（每分钟）番茄精度才够；
// 只用打卡不用番茄的话可以不配 Cron。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 34（提醒/待办）+ 模块 16（dayKey/streak）+ 09/01/02
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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// ============================================================
// 日期键与 streak 计算（沿用 13 号口径）
// dayKey 按 UTC+8 切日（与 13 签到同一时区口径，跨模板习惯一致）。
// streak：从今天（没打卡则从昨天）往前数连续打卡天数——今天还没
// 打不算断签，昨天断了才归零。打卡时顺手刷新 streak 与 best。
// ============================================================
const dayKey = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
function calcStreak(checks) {
  let streak = 0;
  let start = checks[dayKey(0)] ? 0 : 1; // 今天没打从昨天起数
  for (let i = start; ; i++) {
    if (checks[dayKey(i)]) streak++;
    else break;
  }
  return streak;
}
function weekView(checks) {
  const marks = [];
  for (let i = 6; i >= 0; i--) marks.push(checks[dayKey(i)] ? "✅" : "·");
  return marks.join(" ");
}

async function getHabitDoc(env, uid) {
  const raw = await env.BOT_KV.get("habit:" + uid);
  return raw ? JSON.parse(raw) : { habits: [] };
}
async function saveHabitDoc(env, uid, doc) {
  await env.BOT_KV.put("habit:" + uid, JSON.stringify(doc));
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "habit", description: "新建习惯 /habit 晨跑" },
  { command: "habits", description: "我的习惯：打卡与周视图" },
  { command: "pomo", description: "开番茄钟 /pomo 或 /pomo 50" },
  { command: "pomos", description: "进行中的番茄" },
];
const COMMANDS_ADMIN = [
  { command: "habitstats", description: "使用统计（管理员）" },
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
// 健康检查、/setWebhook、Webhook 密钥校验、更新分发；
// scheduled 是 Cron 入口（每分钟）：扫 pomo: 前缀，到期的推送
// 「番茄完成」并删键。番茄 ID 里带 uid 前缀只是方便扫，归属校验
// 靠键名里的 uid 与操作者比对。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("habit-pomodoro bot is running.", {
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanPomos(env));
  },
};

// ============================================================
// 番茄到期扫描（Cron 每分钟）
// pomo: 键的 end 是毫秒时间戳；到期 → 给本人推送完成提醒并删键。
// 推送失败（拉黑）也删键，不留僵尸番茄反复重试。
// ============================================================
async function scanPomos(env) {
  if (!env.BOT_KV) return;
  const now = Date.now();
  const list = await env.BOT_KV.list({ prefix: "pomo:", limit: 1000 });
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const pomo = JSON.parse(raw);
    if (pomo.end <= now) {
      await send(
        env,
        pomo.chat,
        `🍅 番茄完成！「${pomo.label}」专注结束，起来活动一下。再来一颗：/pomo`,
      );
      await env.BOT_KV.delete(k.name);
    }
  }
}

// ============================================================
// 业务主流程
// 习惯打卡按钮回调 habit:do:<下标>（下标指个人习惯数组序号，
// 习惯名可能含冒号/中文，不进 callback_data）；删习惯 habit:del:<下标>。
// /habits 一条消息列全：每个习惯一行信息 + 一行按钮。
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
    const uid = cq.from.id;
    if (data.startsWith("habit:do:") || data.startsWith("habit:del:")) {
      const idx = Number(data.split(":")[2]);
      const doc = await getHabitDoc(env, uid);
      const habit = doc.habits[idx];
      if (!habit)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "习惯不存在了",
          show_alert: true,
        });
      if (data.startsWith("habit:del:")) {
        doc.habits.splice(idx, 1);
        await saveHabitDoc(env, uid, doc);
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `已删除习惯「${habit.name}」`,
        });
      }
      const today = dayKey(0);
      if (habit.checks[today])
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "今天已经打过卡了 ✅",
        });
      habit.checks[today] = 1;
      habit.streak = calcStreak(habit.checks);
      habit.best = Math.max(habit.best || 0, habit.streak);
      await saveHabitDoc(env, uid, doc);
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `✅ 打卡成功！「${habit.name}」连续 ${habit.streak} 天`,
        show_alert: true,
      });
    }
    if (data.startsWith("pomo:x:")) {
      const key = data.slice("pomo:x:".length);
      const raw = await env.BOT_KV.get("pomo:" + key);
      if (raw && JSON.parse(raw).uid === uid) {
        await env.BOT_KV.delete("pomo:" + key);
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已取消这个番茄",
        });
      }
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这不是你的番茄",
        show_alert: true,
      });
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

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🌱 习惯打卡 / 番茄钟 Bot\n\n/habit <习惯名> 新建习惯，如 /habit 晨跑\n/habits 看习惯、点按钮打卡、看连续天数与近 7 天\n/pomo 开 25 分钟番茄钟（/pomo 50 = 50 分钟），到点提醒\n/pomos 看进行中的番茄",
    );

  if (cmd === "/habit") {
    const name = parts.slice(1).join(" ").slice(0, 30);
    if (!name)
      return send(env, chatId, "用法：/habit <习惯名>，如 /habit 晨跑");
    const doc = await getHabitDoc(env, uid);
    if (doc.habits.some((h) => h.name === name))
      return send(env, chatId, `习惯「${name}」已经有了，去 /habits 打卡吧。`);
    if (doc.habits.length >= 20)
      return send(env, chatId, "习惯最多 20 个，先删掉不用的再加。");
    doc.habits.push({
      name,
      created: dayKey(0),
      checks: {},
      streak: 0,
      best: 0,
    });
    await saveHabitDoc(env, uid, doc);
    return send(env, chatId, `🌱 已建习惯「${name}」，/habits 里点按钮打卡。`);
  }

  if (cmd === "/habits") {
    const doc = await getHabitDoc(env, uid);
    if (!doc.habits.length)
      return send(env, chatId, "还没有习惯。/habit <习惯名> 建一个。");
    const lines = doc.habits.map((h, i) => {
      const streak = calcStreak(h.checks);
      return `${i + 1}. ${h.name} · 连续 ${streak} 天（最佳 ${h.best || streak}）\n 近7天 ${weekView(h.checks)} ${h.checks[dayKey(0)] ? "· 今日已打卡✅" : "· 今日未打卡"}`;
    });
    return send(env, chatId, `🌱 我的习惯\n\n${lines.join("\n")}`, {
      reply_markup: {
        inline_keyboard: doc.habits.map((h, i) => [
          { text: `✅ 打卡：${h.name}`, callback_data: `habit:do:${i}` },
          { text: "🗑", callback_data: `habit:del:${i}` },
        ]),
      },
    });
  }

  if (cmd === "/pomo") {
    const mins = Math.min(180, Math.max(1, Number(parts[1]) || 25));
    const label = parts.slice(2).join(" ") || `${mins} 分钟专注`;
    const id = `${uid}:${newId()}`;
    await env.BOT_KV.put(
      "pomo:" + id,
      JSON.stringify({
        uid,
        chat: chatId,
        end: Date.now() + mins * 60000,
        label,
      }),
      { expirationTtl: mins * 60 + 3600 },
    );
    return send(
      env,
      chatId,
      `🍅 番茄开始：「${label}」，${mins} 分钟后提醒你。放下手机，开始专注。`,
    );
  }

  if (cmd === "/pomos") {
    const list = await env.BOT_KV.list({ prefix: `pomo:${uid}:`, limit: 100 });
    if (!list.keys.length)
      return send(env, chatId, "没有进行中的番茄。/pomo 开一颗。");
    const rows = [];
    for (const k of list.keys) {
      const p = JSON.parse((await env.BOT_KV.get(k.name)) || "{}");
      const left = Math.max(0, Math.ceil((p.end - Date.now()) / 60000));
      rows.push({
        text: `🍅 ${p.label} · 剩 ${left} 分钟`,
        cb: k.name.slice("pomo:".length),
      });
    }
    return send(env, chatId, "进行中的番茄：", {
      reply_markup: {
        inline_keyboard: rows.map((r) => [
          { text: r.text, callback_data: "pomo:noop" },
          { text: "❌ 取消", callback_data: `pomo:x:${r.cb}` },
        ]),
      },
    });
  }

  if (cmd === "/habitstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "habit:", limit: 1000 });
    return send(env, chatId, `📊 使用习惯功能的用户：${list.keys.length} 人`);
  }
}
