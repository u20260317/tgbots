// ============================================================
// 36 个人提醒 / 待办 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 每个用户自己的提醒与待办（不是 21 那种管理员对频道排播）：
// /remind 10分钟后 交房租 · /remind 明天 9:30 开会 · /remind 每天 8:00 吃药
// /remind 每周一 9:00 周报；到点由 Cron 每分钟扫描推送。
// /todo 加待办、/todos 看清单，按钮勾选完成/删除。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// TZ_OFFSET 提醒按哪个时区算，默认 8（北京时间）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ 需要 Cron：给 Worker 加 Cron Trigger */1 * * * *（每分钟），
// 否则提醒永远不会响。免费版 Cron 够用，但每分钟跑要注意额度（见 README）。
// 键设计：rem:<用户ID>:<提醒ID> 存提醒；todo:<用户ID> 存待办数组。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 34（个人提醒/待办）+ 模块 09（Cron）+ 模块 01（骨架）
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
const tzOffset = (env) => (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;
// 「当地时间」的 Date：把 UTC 毫秒 + 时区偏移后按 UTC 读字段，就是当地墙上时间。
const localDate = (env, ts = Date.now()) => new Date(ts + tzOffset(env));
function fmtTs(env, ts) {
  const d = localDate(env, ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ============================================================
// 自然语言时间解析（启发式）
// 支持：N分钟后 / N小时后 / N天后 · 今天/明天/后天 HH:MM · 每天 HH:MM ·
// 每周一…周日 HH:MM。认不出的返回 null，让用户按格式重发，绝不瞎猜。
// 返回 { at:下次触发毫秒, repeat:""|"daily"|"weekly", wday:0-6}
// ============================================================
function parseWhen(env, s) {
  const now = Date.now();
  let m;
  if ((m = s.match(/^(\d+)\s*分钟后/)))
    return {
      at: now + Number(m[1]) * 60 * 1000,
      repeat: "",
      rest: s.slice(m[0].length),
    };
  if ((m = s.match(/^(\d+)\s*小时后/)))
    return {
      at: now + Number(m[1]) * 3600 * 1000,
      repeat: "",
      rest: s.slice(m[0].length),
    };
  if ((m = s.match(/^(\d+)\s*天后/))) {
    const d = localDate(env, now + Number(m[1]) * 86400 * 1000);
    d.setUTCHours(9, 0, 0, 0);
    return {
      at: d.getTime() - tzOffset(env),
      repeat: "",
      rest: s.slice(m[0].length),
    };
  }
  const timeM = s.match(/(\d{1,2})[:：](\d{2})/);
  if (!timeM) return null;
  const hh = Number(timeM[1]),
    mm = Number(timeM[2]);
  if (hh > 23 || mm > 59) return null;
  const atLocal = (baseTs, addDays = 0) => {
    const d = localDate(env, baseTs);
    d.setUTCDate(d.getUTCDate() + addDays);
    d.setUTCHours(hh, mm, 0, 0);
    return d.getTime() - tzOffset(env);
  };
  const rest = s.replace(timeM[0], "").trim();
  if (/每天/.test(s)) {
    let at = atLocal(now);
    if (at <= now) at = atLocal(now, 1);
    return { at, repeat: "daily", rest: rest.replace(/每天/, "").trim() };
  }
  const wM = s.match(/每周([一二三四五六日天])/);
  if (wM) {
    const target = "一二三四五六日".indexOf(wM[1] === "天" ? "日" : wM[1]) + 1; // 1=周一 … 7=周日
    const cur = localDate(env, now).getUTCDay() || 7; // 同样折成 1-7
    let add = (target - cur + 7) % 7;
    let at = atLocal(now, add);
    if (at <= now) at = atLocal(now, add + 7);
    return {
      at,
      repeat: "weekly",
      wday: target % 7,
      rest: rest.replace(/每周[一二三四五六日天]/, "").trim(),
    };
  }
  let addDays = 0;
  if (/明天/.test(s)) addDays = 1;
  else if (/后天/.test(s)) addDays = 2;
  let at = atLocal(now, addDays);
  if (!addDays && at <= now) at = atLocal(now, 1); // 今天这个点已过 → 顺延明天
  return {
    at,
    repeat: "",
    rest: rest.replace(/今天|明天|后天/, "").trim(),
  };
}

// ============================================================
// 提醒存储与到期扫描（KV + Cron）
// rem:<用户ID>:<提醒ID> = { uid, chat, text, at, repeat, wday}
// Cron 每分钟扫一遍 rem: 前缀：到点就发；周期提醒顺延下一次，一次性删除。
// ============================================================
async function saveReminder(env, r) {
  await env.BOT_KV.put(`rem:${r.uid}:${r.id}`, JSON.stringify(r));
}
async function listReminders(env, uid) {
  const list = await env.BOT_KV.list({ prefix: `rem:${uid}:`, limit: 200 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  return out.sort((a, b) => a.at - b.at);
}
async function runDue(env) {
  const list = await env.BOT_KV.list({ prefix: "rem:", limit: 1000 });
  const now = Date.now();
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const r = JSON.parse(raw);
    if (r.at > now) continue;
    await send(
      env,
      r.chat,
      `⏰ 提醒：${r.text}\n（原定 ${fmtTs(env, r.at)}）`,
    ).catch(() => {});
    if (r.repeat === "daily") {
      r.at += 86400 * 1000;
      await saveReminder(env, r);
    } else if (r.repeat === "weekly") {
      r.at += 7 * 86400 * 1000;
      await saveReminder(env, r);
    } else {
      await env.BOT_KV.delete(k.name);
    }
  }
}

// 待办：todo:<用户ID> = [{ id, text, done}]
async function getTodos(env, uid) {
  const raw = await env.BOT_KV.get("todo:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveTodos(env, uid, todos) {
  await env.BOT_KV.put("todo:" + uid, JSON.stringify(todos));
}
function todosView(todos) {
  if (!todos.length)
    return { text: "📋 待办清单是空的。/todo <内容> 加一条。" };
  const text =
    "📋 你的待办\n\n" +
    todos
      .map((t, i) => `${t.done ? "✅" : "⬜"} ${i + 1}. ${t.text}`)
      .join("\n");
  const kb = todos.map((t) => [
    {
      text: `${t.done ? "↩️ 取消完成" : "✅ 完成"} ${t.text.slice(0, 12)}`,
      callback_data: `rem:done:${t.id}`,
    },
    { text: "🗑", callback_data: `rem:del:${t.id}` },
  ]);
  return { text, reply_markup: { inline_keyboard: kb } };
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "remind", description: "新建提醒" },
  { command: "remlist", description: "我的提醒列表" },
  { command: "todo", description: "加一条待办" },
  { command: "todos", description: "待办清单" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
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

// ============================================================
// Worker 入口与路由
// fetch 管命令/按钮，scheduled 管到点提醒，两条路共用 KV 里的提醒表。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("personal-reminder bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(runDue(env));
  },
};

// ============================================================
// 业务主流程
// 回调前缀 rem: 管待办勾选/删除（与模块 34 注册一致）。
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
    if (!data.startsWith("rem:")) return;
    const [, act, id] = data.split(":");
    if (act === "delrem") {
      await env.BOT_KV.delete(`rem:${cq.from.id}:${id}`);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🗑 提醒已删除",
      });
      return tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: "⏰ 提醒已删除。发 /remlist 看剩下的。",
      });
    }
    const todos = await getTodos(env, cq.from.id);
    const t = todos.find((x) => x.id === id);
    if (!t)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这条待办不存在了",
      });
    if (act === "done") t.done = !t.done;
    if (act === "del") todos.splice(todos.indexOf(t), 1);
    await saveTodos(env, cq.from.id, todos);
    const v = todosView(todos);
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: v.text,
      ...(v.reply_markup ? { reply_markup: v.reply_markup } : {}),
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "⏰ 个人提醒/待办 Bot\n\n提醒：/remind <时间> <内容>\n例：\n/remind 10分钟后 交房租\n/remind 明天 9:30 开会\n/remind 每天 8:00 吃药\n/remind 每周一 9:00 写周报\n\n/remlist 看全部提醒（带删除按钮）\n/todo <内容> 加待办 · /todos 看待办清单",
    );

  if (cmd === "/remind") {
    const body = text.replace(/^\/remind(@\w+)?\s*/, "").trim();
    const parsed = body && parseWhen(env, body);
    if (!parsed || !parsed.rest)
      return send(
        env,
        chatId,
        "没看懂时间 🤔 按这个格式：\n/remind 10分钟后 交房租\n/remind 明天 9:30 开会\n/remind 每天 8:00 吃药\n/remind 每周一 9:00 写周报\n（时间在前、内容在后）",
      );
    const r = {
      id: newId(),
      uid,
      chat: chatId,
      text: parsed.rest,
      at: parsed.at,
      repeat: parsed.repeat,
      wday: parsed.wday,
    };
    await saveReminder(env, r);
    return send(
      env,
      chatId,
      `✅ 记下了：${fmtTs(env, r.at)}${r.repeat ? `（${r.repeat === "daily" ? "每天" : "每周"}重复）` : ""} 提醒你「${r.text}」`,
    );
  }

  if (cmd === "/remlist") {
    const list = await listReminders(env, uid);
    if (!list.length)
      return send(env, chatId, "你还没有提醒。/remind 新建一个。");
    const kb = list.map((r) => [
      {
        text: `🗑 ${fmtTs(env, r.at).slice(5)} ${r.text.slice(0, 14)}`,
        callback_data: `rem:delrem:${r.id}`,
      },
    ]);
    return send(
      env,
      chatId,
      "⏰ 你的提醒\n\n" +
        list
          .map(
            (r) =>
              `· ${fmtTs(env, r.at)}${r.repeat ? "（重复）" : ""} ${r.text}`,
          )
          .join("\n"),
      { reply_markup: { inline_keyboard: kb } },
    );
  }
  if (cmd === "/todo") {
    const body = text.replace(/^\/todo(@\w+)?\s*/, "").trim();
    if (!body) return send(env, chatId, "用法：/todo 要做的事");
    const todos = await getTodos(env, uid);
    todos.push({ id: newId(), text: body.slice(0, 200), done: false });
    await saveTodos(env, uid, todos);
    const v = todosView(todos);
    return send(
      env,
      chatId,
      v.text,
      v.reply_markup ? { reply_markup: v.reply_markup } : {},
    );
  }

  if (cmd === "/todos") {
    const v = todosView(await getTodos(env, uid));
    return send(
      env,
      chatId,
      v.text,
      v.reply_markup ? { reply_markup: v.reply_markup } : {},
    );
  }
}
