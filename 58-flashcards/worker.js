// ============================================================
// 58 闪卡记忆 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：Anki 式间隔重复背卡（PocketAnki 类）：
// /add 正面|背面 建卡；/review 复习到期卡——先看正面，点按钮翻面，
// 再按「忘了/模糊/记得」三档自评，SM-2 简化算法安排下次复习时间；
// Cron 每天推一次「今天有 N 张卡到期」；/stats 看掌握情况。
// 零外部 API：调度算法是纯计算，状态全在 KV。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ 每日提醒需要 Cron Trigger，如 0 1 * * *（UTC 01:00 = 北京 09:00）。
// 键设计：card:<uid>:<卡ID> 卡片（含 SM-2 字段与 due）；
// card:users 建过卡的用户名单（Cron 推送用）；fc:sess:<uid> 本轮复习计数。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 04（KV）+ 模块 09（Cron）+ 模块 03（按钮）+ 模块 01（骨架）
// ============================================================

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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const DAY = 86400 * 1000;

// ============================================================
// SM-2 简化调度
// 每张卡带 { ease 难度系数(默认2.5,下限1.3), interval 间隔天数, reps 连对次数}。
// 三档自评映射：
// · 忘了(0)：reps 清零，10 分钟后再来，ease -0.2；
// · 模糊(1)：间隔小步增长（首轮 1 天，之后 ×1.2），ease -0.15；
// · 记得(2)：间隔 1 天 → 3 天 → 之后 ×ease 放大，ease +0.05。
// 比原版 SM-2（五档）粗，但对自用背单词/背概念足够，且每档都可解释。
// ============================================================
function gradeCard(card, g) {
  const now = Date.now();
  if (g === 0) {
    card.reps = 0;
    card.interval = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.lapses = (card.lapses || 0) + 1;
    card.due = now + 10 * 60 * 1000;
  } else if (g === 1) {
    card.interval =
      card.reps === 0 ? 1 : Math.max(1, Math.round(card.interval * 1.2));
    card.ease = Math.max(1.3, card.ease - 0.15);
    card.reps += 1;
    card.due = now + card.interval * DAY;
  } else {
    card.reps += 1;
    if (card.reps === 1) card.interval = 1;
    else if (card.reps === 2) card.interval = 3;
    else card.interval = Math.round(card.interval * card.ease);
    card.ease = Math.min(2.8, card.ease + 0.05);
    card.due = now + card.interval * DAY;
  }
  return card;
}

// ============================================================
// 卡片存储与到期队列（KV）
// card:<uid>:<卡ID> 一卡一键；复习时按前缀列全组、过滤 due<=now、
// 按 due 升序取第一张——个人牌组千张内毫无压力。
// ============================================================
async function listCards(env, uid) {
  const list = await env.BOT_KV.list({ prefix: `card:${uid}:`, limit: 1000 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}
async function nextDue(env, uid) {
  const cards = await listCards(env, uid);
  const due = cards
    .filter((c) => c.due <= Date.now())
    .sort((a, b) => a.due - b.due);
  return {
    total: cards.length,
    dueCount: due.length,
    card: due[0] || null,
    all: cards,
  };
}
async function saveCard(env, card) {
  await env.BOT_KV.put(`card:${card.uid}:${card.id}`, JSON.stringify(card));
}
async function markUser(env, uid) {
  const raw = await env.BOT_KV.get("card:users");
  const users = raw ? JSON.parse(raw) : [];
  if (!users.includes(uid)) {
    users.push(uid);
    await env.BOT_KV.put("card:users", JSON.stringify(users));
  }
}

// ============================================================
// 每日到期提醒（Cron）
// 按 card:users 名单逐个点数，只给「有卡到期」的人发一条，不骚扰空组。
// 名单靠 /add 时登记，所以 Cron 不用全库扫前缀。
// ============================================================
async function runDailyPush(env) {
  const raw = await env.BOT_KV.get("card:users");
  if (!raw) return;
  for (const uid of JSON.parse(raw)) {
    const { dueCount } = await nextDue(env, uid);
    if (dueCount > 0)
      await send(
        env,
        uid,
        `🗂 今天有 ${dueCount} 张闪卡到期，/review 复习一下吧（几分钟就好）。`,
      ).catch(() => {});
  }
}

// 管理员白名单与分级命令菜单（本 Bot 无管理员命令，菜单模块照常保留）
const COMMANDS_USER = [
  { command: "add", description: "建卡 /add 正面|背面" },
  { command: "review", description: "复习到期卡" },
  { command: "cards", description: "我的牌组" },
  { command: "stats", description: "掌握统计" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  return tg(env, "setMyCommands", { commands: COMMANDS_USER });
}

// ============================================================
// Worker 入口与路由
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("flashcards bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(runDailyPush(env));
  },
};

// 复习出卡：一屏一卡，先正面后背面，全在同一条消息上编辑。
async function showFront(env, chatId, card, dueCount) {
  return send(
    env,
    chatId,
    `🗂 复习（剩余到期 ${dueCount} 张）\n\n正面：${card.front}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "👀 看背面", callback_data: `fc:flip:${card.id}` }],
        ],
      },
    },
  );
}

// ============================================================
// 业务主流程
// 回调 fc:：flip 翻面、g 三档评分、del 删卡。
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
    if (!data.startsWith("fc:")) return;
    const uid = cq.from.id;
    const chatId = cq.message?.chat?.id || uid;
    const parts = data.split(":");
    const raw = await env.BOT_KV.get(`card:${uid}:${parts[2]}`);
    if (!raw)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这张卡不存在了",
        show_alert: true,
      });
    const card = JSON.parse(raw);
    if (parts[1] === "flip") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `正面：${card.front}\n\n背面：${card.back}\n\n诚实自评：刚才想起来了吗？`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "😵 忘了", callback_data: `fc:g:${card.id}:0` },
              { text: "🤔 模糊", callback_data: `fc:g:${card.id}:1` },
              { text: "😎 记得", callback_data: `fc:g:${card.id}:2` },
            ],
          ],
        },
      });
    }
    if (parts[1] === "g") {
      gradeCard(card, Number(parts[3]));
      await saveCard(env, card);
      const sessKey = `fc:sess:${uid}`;
      const n = Number((await env.BOT_KV.get(sessKey)) || 0) + 1;
      await env.BOT_KV.put(sessKey, String(n), { expirationTtl: 3600 });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text:
          card.interval > 0
            ? `下次复习：${card.interval} 天后`
            : "10 分钟后再复习这张",
      });
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `✔ 已记录（本轮第 ${n} 张）\n正面：${card.front}`,
      });
      const { card: next, dueCount } = await nextDue(env, uid);
      if (next) return showFront(env, chatId, next, dueCount);
      await env.BOT_KV.delete(sessKey);
      return send(env, chatId, `🎉 本轮复习完成，共复习 ${n} 张。明天见！`);
    }
    if (parts[1] === "del") {
      await env.BOT_KV.delete(`card:${uid}:${card.id}`);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🗑 已删除",
      });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `已删除卡片：${card.front}`,
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/ +/)[0].split("@")[0];

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "🗂 闪卡记忆 Bot（间隔重复）\n\n/add 正面|背面 建卡，如 /add apple|苹果\n/review 复习到期卡：看正面→翻面→自评忘了/模糊/记得，算法安排下次时间\n/cards 看牌组 · /stats 看统计\n每天还会推送一次到期提醒。",
    );
  if (cmd === "/add") {
    const body = text.replace(/^\/add(@\w+)?\s*/, "");
    const sep = body.search(/[|｜]/);
    if (sep < 1)
      return send(
        env,
        chatId,
        "用法：/add 正面|背面（中间是竖线），如 /add apple|苹果",
      );
    const card = {
      id: newId(),
      uid,
      front: body.slice(0, sep).trim().slice(0, 500),
      back: body
        .slice(sep + 1)
        .trim()
        .slice(0, 1000),
      ease: 2.5,
      interval: 0,
      reps: 0,
      lapses: 0,
      due: Date.now(),
      at: Date.now(),
    };
    if (!card.front || !card.back)
      return send(env, chatId, "正面和背面都不能为空。");
    await saveCard(env, card);
    await markUser(env, uid);
    const { total } = await nextDue(env, uid);
    return send(
      env,
      chatId,
      `✅ 已建卡（牌组共 ${total} 张）：${card.front} → ${card.back}\n现在就能 /review 复习它。`,
    );
  }
  if (cmd === "/review") {
    const { card, dueCount, total } = await nextDue(env, uid);
    if (!total) return send(env, chatId, "牌组是空的，先 /add 建几张卡。");
    if (!card) return send(env, chatId, "🎉 没有到期的卡，全部复习完了。");
    return showFront(env, chatId, card, dueCount);
  }
  if (cmd === "/cards") {
    const cards = await listCards(env, uid);
    if (!cards.length) return send(env, chatId, "牌组是空的。/add 建卡。");
    cards.sort((a, b) => a.due - b.due);
    const shown = cards.slice(0, 20);
    const kb = shown.map((c) => [
      { text: `🗑 ${c.front.slice(0, 20)}`, callback_data: `fc:del:${c.id}` },
    ]);
    return send(
      env,
      chatId,
      `🗂 我的牌组（共 ${cards.length} 张，按到期排序，前 20）\n\n` +
        shown
          .map(
            (c, i) =>
              `${i + 1}. ${c.front} → ${c.back}（间隔 ${c.interval} 天）`,
          )
          .join("\n"),
      { reply_markup: { inline_keyboard: kb } },
    );
  }
  if (cmd === "/stats") {
    const cards = await listCards(env, uid);
    if (!cards.length) return send(env, chatId, "还没有卡。/add 建第一张吧。");
    const due = cards.filter((c) => c.due <= Date.now()).length;
    const mastered = cards.filter((c) => c.interval >= 21).length;
    const learning = cards.length - mastered;
    const lapses = cards.reduce((s, c) => s + (c.lapses || 0), 0);
    return send(
      env,
      chatId,
      `📊 掌握统计\n总卡数：${cards.length}\n已掌握（间隔≥21天）：${mastered}\n学习中：${learning}\n当前到期：${due}\n累计遗忘次数：${lapses}`,
    );
  }
}
