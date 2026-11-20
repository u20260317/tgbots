// ============================================================
// 18 频道导航 / 互推 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：频道主提交自己的公开频道 -> 管理员审核 -> 收录进分类导航，
// 用户按分类逛、搜索、随机发现频道。互推涨粉的合规玩法：目录曝光，
// 不刷量、不互赞。成员数在提交/审核时用 getChatMemberCount 抓一次快照。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开
// 选填：WEBHOOK_SECRET
// 分类在下面 CONFIG 里改。
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（键：dir:<用户名> 频道条目）。
// ⚠️ 只收录有公开用户名的频道/群（私有链接无法校验与跳转，不收）。
// 用户命令：/submit @频道 | 分类 | 一句简介 —— 提交待审
// 浏览：/start 打开分类菜单 · /search 关键词 · /random 随机一个
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

// ==================== 在这里改分类 ====================
const CATEGORIES = [
  "羊毛优惠",
  "AI科技",
  "搞钱理财",
  "影视娱乐",
  "学习资源",
  "游戏",
  "其它",
];
// ==================== 分类区结束 ====================

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
const adminChat = (env) => admins(env)[0];
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;

// ============================================================
// 【核心模块】目录存储（KV）
// dir:<用户名小写> = { user, title, cat, desc, members, status:pending|ok, by}
// 浏览/搜索只读 status=ok 的条目；成员数是审核时的快照，条目里会标注。
// ============================================================
async function getKV(env, key) {
  const raw = await env.BOT_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function putKV(env, key, val) {
  await env.BOT_KV.put(key, JSON.stringify(val));
}
async function listEntries(env, onlyOk = true) {
  const list = await env.BOT_KV.list({ prefix: "dir:", limit: 500 });
  const out = [];
  for (const k of list.keys) {
    const e = await getKV(env, k.name);
    if (e && (!onlyOk || e.status === "ok")) out.push(e);
  }
  return out.sort((a, b) => (b.members || 0) - (a.members || 0));
}
const entryText = (e) =>
  `📣 ${e.title} (@${e.user})\n分类：${e.cat} · 成员约 ${e.members ?? "未知"}（收录时快照）\n${e.desc || ""}`;
const entryKb = (e) => ({
  inline_keyboard: [[{ text: "➡️ 打开频道", url: "https://t.me/" + e.user }]],
});

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
  { command: "start", description: "分类导航" },
  { command: "search", description: "搜索频道" },
  { command: "random", description: "随机发现频道" },
  { command: "submit", description: "收录我的频道" },
];
const COMMANDS_ADMIN = [];
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
      return new Response("channel-directory bot is running.", {
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
// 浏览侧：分类菜单（cat:）/搜索/随机；收录侧：/submit 校验真频道 -> 管理员审核卡（dirok:/dirno:）。
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
    const [act, arg] = String(cq.data || "").split(":");
    if (act === "cat") {
      const entries = (await listEntries(env)).filter((e) => e.cat === arg);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (!entries.length)
        return send(
          env,
          cq.message.chat.id,
          `「${arg}」分类下还没有收录频道。`,
        );
      await send(env, cq.message.chat.id, `📂 ${arg}（按成员数排，前 10）：`);
      for (const e of entries.slice(0, 10))
        await send(env, cq.message.chat.id, entryText(e), {
          reply_markup: entryKb(e),
        });
      return;
    }
    if (act === "dirok" || act === "dirno") {
      if (!isAdmin(env, cq.from.id))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能审核",
          show_alert: true,
        });
      const e = await getKV(env, "dir:" + arg);
      if (!e || e.status !== "pending")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "条目不存在或已处理",
          show_alert: true,
        });
      if (act === "dirok") {
        e.status = "ok";
        await putKV(env, "dir:" + arg, e);
        await send(
          env,
          e.by,
          `🎉 你的频道 @${e.user} 已收录进导航（分类：${e.cat}）。`,
        );
      } else {
        await env.BOT_KV.delete("dir:" + arg);
        await send(
          env,
          e.by,
          `😢 你的频道 @${e.user} 这次未被收录，可完善简介后重新提交。`,
        );
      }
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已处理",
      });
      return tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: act === "dirok" ? "✅ 已收录" : "❌ 已拒绝",
                callback_data: "done",
              },
            ],
          ],
        },
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private" || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start") {
    const rows = [];
    for (let i = 0; i < CATEGORIES.length; i += 2)
      rows.push(
        CATEGORIES.slice(i, i + 2).map((c) => ({
          text: "📂 " + c,
          callback_data: "cat:" + c,
        })),
      );
    return send(
      env,
      msg.chat.id,
      "🧭 频道导航：选分类逛逛，或发 /search 关键词、/random 随机发现。\n频道主收录自己的频道发：/submit @频道 | 分类 | 简介",
      { reply_markup: { inline_keyboard: rows } },
    );
  }
  if (cmd === "/search") {
    const kw = text
      .replace(/^\/search(@\w+)?\s*/, "")
      .trim()
      .toLowerCase();
    if (!kw) return send(env, msg.chat.id, "用法：/search 关键词");
    const hits = (await listEntries(env)).filter((e) =>
      (e.title + "@" + e.user + e.desc + e.cat).toLowerCase().includes(kw),
    );
    if (!hits.length) return send(env, msg.chat.id, "没搜到相关频道。");
    await send(env, msg.chat.id, `🔍 找到 ${hits.length} 个：`);
    for (const e of hits.slice(0, 10))
      await send(env, msg.chat.id, entryText(e), { reply_markup: entryKb(e) });
    return;
  }
  if (cmd === "/random") {
    const entries = await listEntries(env);
    if (!entries.length) return send(env, msg.chat.id, "导航还是空的。");
    const e =
      entries[crypto.getRandomValues(new Uint32Array(1))[0] % entries.length];
    return send(env, msg.chat.id, "🎲 随机发现：\n\n" + entryText(e), {
      reply_markup: entryKb(e),
    });
  }
  if (cmd === "/submit") {
    const parts = text
      .replace(/^\/submit(@\w+)?\s*/, "")
      .split("|")
      .map((s) => s.trim());
    if (parts.length < 2)
      return send(
        env,
        msg.chat.id,
        `用法：/submit @频道用户名 | 分类 | 一句简介\n分类可选：${CATEGORIES.join(" / ")}`,
      );
    const username = parts[0].replace(/^@/, "").toLowerCase();
    const cat = parts[1];
    const desc = parts[2] || "";
    if (!CATEGORIES.includes(cat))
      return send(
        env,
        msg.chat.id,
        `分类不对，可选：${CATEGORIES.join(" / ")}`,
      );
    if (await getKV(env, "dir:" + username))
      return send(env, msg.chat.id, "这个频道已在导航里或审核中，别重复提交。");
    const chat = await tg(env, "getChat", { chat_id: "@" + username });
    if (!chat.ok || !["channel", "supergroup"].includes(chat.result.type))
      return send(
        env,
        msg.chat.id,
        "没找到这个公开频道/群，确认用户名写对了（只收有公开用户名的）。",
      );
    const cnt = await tg(env, "getChatMemberCount", {
      chat_id: "@" + username,
    });
    const entry = {
      user: username,
      title: chat.result.title || username,
      cat,
      desc,
      members: cnt.ok ? cnt.result : null,
      status: "pending",
      by: msg.from.id,
    };
    await putKV(env, "dir:" + username, entry);
    await tg(env, "sendMessage", {
      chat_id: adminChat(env),
      text: `🧭 新频道收录申请\n${entryText(entry)}\n提交人：${who(msg.from)}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 收录", callback_data: `dirok:${username}` },
            { text: "❌ 拒绝", callback_data: `dirno:${username}` },
          ],
        ],
      },
    });
    return send(
      env,
      msg.chat.id,
      "⏳ 已提交管理员审核，通过后会出现在导航里并通知你。",
    );
  }
  if (text.startsWith("/"))
    return send(
      env,
      msg.chat.id,
      "命令：/start 分类导航 · /search 关键词 · /random 随机 · /submit 收录我的频道",
    );
}
