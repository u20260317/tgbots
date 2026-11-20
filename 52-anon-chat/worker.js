// ============================================================
// 52 匿名随机聊天 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：陌生人一对一随机配对聊天（RandTalk 类）：
// /match 进匹配队列，配对成功后双方消息互转（copyMessage，对方看不到你的 ID）；
// /next 跳过当前对象重新匹配，/stop 断开。
// ⚠️ 安全配套是本体的一部分，不是可选项：
// · 首次进入必须先看规则并点「我已成年并同意规则」才能入队（含未成年提示）；
// · 每条转发消息都带控制条：举报 / 下一位 / 断开；
// · 举报累计达阈值（默认 3 次）自动封禁，被封者不能再匹配；
// · 敏感词过滤（CONFIG.BAD_WORDS）；管理员可开「禁媒体模式」只许文字。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 管理员数字 ID（逗号分隔），收举报通知、用管理命令
// BAN_LIMIT 举报几次自动封禁，默认 3
// NO_MEDIA 填 1 默认开启禁媒体模式（管理员可用 /media 临时开关）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：ach:queue 匹配队列；ach:pair:<uid> 当前配对；ach:ok:<uid> 已确认规则；
// ach:rep:<uid> 被举报次数；ban:<uid> 封禁记录；ach:cfg 管理员开关。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 07（转发与回复路由）+ 模块 03（按钮与回调）+ 模块 04（KV）
// ============================================================

// ============================================================
// 敏感词与规则文案（改这里定制你的聊天室）
// 敏感词命中即拦截不转发，并提醒发送者；词表按需增删。
// ============================================================
const CONFIG = {
  BAD_WORDS: ["加微信", "加我微信", "博彩", "代充返利"],
  RULES:
    "🎭 匿名聊天规则\n\n" +
    "1. 双方全程匿名，不要索取或透露手机号、微信、住址等个人信息；\n" +
    "2. 禁止骚扰、辱骂、诈骗、广告与违法内容，消息可能被举报；\n" +
    "3. 被举报累计达标会被自动封禁，管理员会收到举报通知；\n" +
    "4. 聊得不舒服随时点「✖️ 断开」或发 /stop，没人知道你是谁。\n\n" +
    "⚠️ 未满 18 周岁请勿使用本 Bot。点下方按钮即表示你已成年并同意以上规则。",
};

// ============================================================
// Telegram Bot API 通信层
// 统一封装 tg()：所有给 Telegram 发的请求都走这里。
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
const isAdmin = (env, uid) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(uid));
const banLimit = (env) => Number(env.BAN_LIMIT) || 3;

// ============================================================
// 配对状态（KV）
// ach:pair:<uid> = { with: 对方uid, since}，双向各存一份，任一方断开两边都清。
// ach:queue 是等待者 uid 数组：KV 无事务，快速并发下偶发重复配对的概率低、
// 后果轻（多收到一条提示），v1 接受；量大时改 Durable Objects 做队列。
// ============================================================
async function getPair(env, uid) {
  const raw = await env.BOT_KV.get("ach:pair:" + uid);
  return raw ? JSON.parse(raw) : null;
}
async function setPair(env, a, b) {
  const rec = { since: Date.now() };
  await env.BOT_KV.put("ach:pair:" + a, JSON.stringify({ ...rec, with: b }));
  await env.BOT_KV.put("ach:pair:" + b, JSON.stringify({ ...rec, with: a }));
}
async function clearPair(env, uid) {
  const p = await getPair(env, uid);
  if (!p) return null;
  await env.BOT_KV.delete("ach:pair:" + uid);
  await env.BOT_KV.delete("ach:pair:" + p.with);
  return p.with;
}
async function getQueue(env) {
  const raw = await env.BOT_KV.get("ach:queue");
  return raw ? JSON.parse(raw) : [];
}
async function saveQueue(env, q) {
  await env.BOT_KV.put("ach:queue", JSON.stringify(q));
}
const isBanned = async (env, uid) => !!(await env.BOT_KV.get("ban:" + uid));

// ============================================================
// 匹配引擎
// 先看队列里有没有可配的人（跳过自己、已封禁、已在聊的），有就立即配对；
// 没有就把自己挂进队列等下一个人来。
// ============================================================
async function tryMatch(env, uid) {
  let q = await getQueue(env);
  q = q.filter((x) => x !== uid);
  while (q.length) {
    const cand = q.shift();
    if (await isBanned(env, cand)) continue;
    if (await getPair(env, cand)) continue;
    await saveQueue(env, q);
    await setPair(env, uid, cand);
    await send(
      env,
      uid,
      "🎉 配对成功！直接发消息就能聊，消息下方的按钮可以举报/换人/断开。",
    );
    await send(
      env,
      cand,
      "🎉 配对成功！直接发消息就能聊，消息下方的按钮可以举报/换人/断开。",
    );
    return true;
  }
  q.push(uid);
  await saveQueue(env, q);
  await send(
    env,
    uid,
    "⏳ 已进入匹配队列，有人来就会自动配对。等待时发 /stop 可退出队列。",
  );
  return false;
}
async function endChat(env, uid, reason) {
  const partner = await clearPair(env, uid);
  if (partner) {
    await send(env, partner, reason || "对方已断开连接。发 /match 重新匹配。");
    return partner;
  }
  // 不在配对中也可能还在队列里，一并摘掉
  const q = (await getQueue(env)).filter((x) => x !== uid);
  await saveQueue(env, q);
  return null;
}

// 转发消息下方的控制条：举报走 report: 两步确认，换人/断开走 ach:
const controlKb = {
  inline_keyboard: [
    [
      { text: "⏭ 下一位", callback_data: "ach:next" },
      { text: "✖️ 断开", callback_data: "ach:stop" },
    ],
    [{ text: "🚨 举报对方", callback_data: "report:ask" }],
  ],
};

// ============================================================
// 内容安全：敏感词 + 媒体开关
// 命中敏感词直接拦截；禁媒体模式下非文字消息一律拒收。
// 管理员开关存 ach:cfg，env NO_MEDIA=1 是部署默认值。
// ============================================================
const MEDIA_KEYS = [
  "photo",
  "video",
  "document",
  "sticker",
  "voice",
  "video_note",
  "animation",
  "audio",
];
async function noMediaOn(env) {
  const raw = await env.BOT_KV.get("ach:cfg");
  if (raw) return !!JSON.parse(raw).noMedia;
  return env.NO_MEDIA === "1";
}
function hitBadWord(msg) {
  const t = (msg.text || msg.caption || "").toLowerCase();
  if (!t) return null;
  return CONFIG.BAD_WORDS.find((w) => t.includes(w.toLowerCase())) || null;
}

// ============================================================
// 管理员白名单与分级命令菜单
// 普通用户只看匹配相关命令；管理员（ADMIN_ID）额外看到管理命令。
// 菜单只是展示层，真正的门禁在业务代码里的 isAdmin 校验。
// ============================================================
const COMMANDS_USER = [
  { command: "match", description: "开始匹配" },
  { command: "next", description: "跳过当前对象" },
  { command: "stop", description: "断开/退出队列" },
  { command: "start", description: "规则与说明" },
];
const COMMANDS_ADMIN = [
  { command: "achstats", description: "队列与封禁概况" },
  { command: "unban", description: "解封用户 /unban <ID>" },
  { command: "media", description: "禁媒体开关 /media on|off" },
];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  const ids = String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids) {
    await tg(env, "setMyCommands", {
      commands: [...COMMANDS_USER, ...COMMANDS_ADMIN],
      scope: { type: "chat", chat_id: Number(id) },
    });
  }
  return r;
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
      return new Response("anon-chat bot is running.", {
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
// 业务主流程
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
    const uid = cq.from.id;
    const data = String(cq.data || "");
    const chatId = cq.message?.chat?.id || uid;
    if (data === "ach:agree") {
      await env.BOT_KV.put("ach:ok:" + uid, "1");
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 已确认，开始匹配吧",
      });
      return send(
        env,
        chatId,
        "发 /match 开始匹配。聊天中发 /next 换人、/stop 断开。",
      );
    }
    if (data === "ach:next" || data === "ach:stop") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (data === "ach:stop") {
        await endChat(env, uid);
        return send(env, chatId, "已断开。发 /match 重新匹配。");
      }
      const partner = await endChat(
        env,
        uid,
        "对方已跳过你，去找下一位了。发 /match 重新匹配。",
      );
      if (partner) return tryMatch(env, uid);
      return send(env, chatId, "你现在没有在聊天，发 /match 开始匹配。");
    }
    if (data === "report:ask") {
      const p = await getPair(env, uid);
      if (!p)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "你现在没有在聊天",
          show_alert: true,
        });
      return send(env, chatId, "确认举报当前聊天对象？恶意举报同样会被处理。", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "确认举报", callback_data: "report:yes" },
              { text: "取消", callback_data: "report:no" },
            ],
          ],
        },
      });
    }
    if (data === "report:no")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已取消",
      });
    if (data === "report:yes") {
      const p = await getPair(env, uid);
      if (!p)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "对方已经不在了",
          show_alert: true,
        });
      const target = p.with;
      const cnt = Number((await env.BOT_KV.get("ach:rep:" + target)) || 0) + 1;
      await env.BOT_KV.put("ach:rep:" + target, String(cnt));
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🚨 举报已记录",
      });
      await clearPair(env, uid);
      await send(env, uid, "已举报并断开连接。发 /match 重新匹配。");
      await send(env, target, "对方已断开连接。发 /match 重新匹配。");
      const admins = String(env.ADMIN_ID || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      for (const a of admins)
        await send(
          env,
          a,
          `🚨 匿名聊天举报：用户 ${target} 被举报（累计 ${cnt}/${banLimit(env)} 次）。`,
        ).catch(() => {});
      if (cnt >= banLimit(env)) {
        await env.BOT_KV.put(
          "ban:" + target,
          JSON.stringify({ at: Date.now(), reports: cnt }),
        );
        await send(
          env,
          target,
          "⛔ 你被举报次数已达上限，已被封禁，无法再使用匿名聊天。",
        ).catch(() => {});
        for (const a of admins)
          await send(
            env,
            a,
            `⛔ 用户 ${target} 举报达 ${cnt} 次，已自动封禁。/unban ${target} 可解封。`,
          ).catch(() => {});
      }
      return;
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  if (msg.chat.type !== "private") return; // 匿名聊天只做私聊
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/ +/)[0].split("@")[0];

  if (cmd === "/start") {
    if (await env.BOT_KV.get("ach:ok:" + uid))
      return send(
        env,
        chatId,
        "🎭 匿名聊天\n\n/match 开始匹配 · /next 换人 · /stop 断开",
      );
    return send(env, chatId, CONFIG.RULES, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ 我已成年并同意规则", callback_data: "ach:agree" }],
        ],
      },
    });
  }

  // 管理员命令（菜单之外再验一次身份）
  if (isAdmin(env, uid)) {
    if (cmd === "/achstats") {
      const q = await getQueue(env);
      const bans = await env.BOT_KV.list({ prefix: "ban:", limit: 1000 });
      return send(
        env,
        chatId,
        `📊 队列中 ${q.length} 人；已封禁 ${bans.keys.length} 人。`,
      );
    }
    if (cmd === "/unban") {
      const target = text.split(/ +/)[1];
      if (!target) return send(env, chatId, "用法：/unban <用户ID>");
      await env.BOT_KV.delete("ban:" + target);
      await env.BOT_KV.delete("ach:rep:" + target);
      return send(env, chatId, `✅ 已解封 ${target} 并清零举报计数。`);
    }
    if (cmd === "/media") {
      const arg = text.split(/ +/)[1];
      if (arg !== "on" && arg !== "off")
        return send(
          env,
          chatId,
          `当前禁媒体：${(await noMediaOn(env)) ? "开" : "关"}。用法：/media on|off`,
        );
      await env.BOT_KV.put(
        "ach:cfg",
        JSON.stringify({ noMedia: arg === "on" }),
      );
      return send(
        env,
        chatId,
        `✅ 禁媒体模式已${arg === "on" ? "开启（只许文字）" : "关闭"}。`,
      );
    }
  }

  if (await isBanned(env, uid)) {
    if (cmd === "/match")
      return send(env, chatId, "⛔ 你已被封禁，无法使用匿名聊天。");
    return;
  }
  if (!(await env.BOT_KV.get("ach:ok:" + uid))) {
    // 没确认规则前，任何操作都先弹规则
    return send(env, chatId, CONFIG.RULES, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ 我已成年并同意规则", callback_data: "ach:agree" }],
        ],
      },
    });
  }

  if (cmd === "/match") {
    if (await getPair(env, uid))
      return send(env, chatId, "你已经在聊天中了。/next 换人，/stop 断开。");
    return tryMatch(env, uid);
  }
  if (cmd === "/next") {
    const partner = await endChat(
      env,
      uid,
      "对方已跳过你，去找下一位了。发 /match 重新匹配。",
    );
    if (!partner)
      return send(env, chatId, "你现在没有在聊天，发 /match 开始匹配。");
    return tryMatch(env, uid);
  }
  if (cmd === "/stop") {
    await endChat(env, uid);
    return send(env, chatId, "已断开并退出队列。发 /match 重新匹配。");
  }
  if (cmd.startsWith("/")) return; // 其他命令不转发给对方

  // 普通消息：在配对中就转发给对方
  const pair = await getPair(env, uid);
  if (!pair)
    return send(env, chatId, "你现在没有聊天对象，发 /match 开始匹配。");
  const bad = hitBadWord(msg);
  if (bad)
    return send(env, chatId, `⚠️ 消息包含敏感词「${bad}」，已拦截不转发。`);
  if ((await noMediaOn(env)) && MEDIA_KEYS.some((k) => msg[k]))
    return send(env, chatId, "⚠️ 当前是禁媒体模式，只能发文字消息。");
  const r = await tg(env, "copyMessage", {
    chat_id: pair.with,
    from_chat_id: chatId,
    message_id: msg.message_id,
    reply_markup: controlKb,
  });
  if (!r.ok) {
    // 对方可能已拉黑 Bot 或连接已失效：清掉配对，别让用户对着空气说话
    await clearPair(env, uid);
    return send(
      env,
      chatId,
      "对方连接已失效，已为你断开。发 /match 重新匹配。",
    );
  }
}
