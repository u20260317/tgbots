// ============================================================
// 74 DAO 治理提醒 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// /watch <Snapshot 空间 id>（如 uniswap、aave.eth）订阅该 DAO 的
// 治理动态；Cron 轮询 Snapshot 公开 GraphQL API（免 key），发现
// 新提案、提案开始/结束状态变化时推送给订阅者；/daos 管理订阅。
// 说明：Bot 内只能「看与提醒」——真投票需要钱包签名，Snapshot 的
// 投票动作只能跳到 snapshot.org 页面完成，本 Bot 每条提醒都带链接。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// ADMIN_ID 管理员数字 ID（看 /daostats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：dao:sub:<用户ID> = [空间id...] 个人订阅；
// dao:state:<空间id> = {seen:{提案id:state}} 全局轮询状态。
// ⚠️ 需要 Cron：Triggers 加一条（如 */30 * * * * 每半小时轮询）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 41（通知适配器/轮询形态）+ 模块 09（Cron）+ 模块 01/02
// ============================================================

const SNAPSHOT_GRAPHQL = "https://hub.snapshot.org/graphql";

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
// Snapshot 轮询层
// GraphQL 公开端点免 key：按空间拉最近 20 条提案
// （id/title/state/start/end/link）。状态机就三个值：
// pending（未开始）→ active（投票中）→ closed（已结束）。
// diff 口径：本地 dao:state 存 {提案id: 上次state}；
// · 没见过的提案且 state 不是 closed → 「🆕 新提案」
// · 见过但 state 变了 → 「状态变化」（重点是 active→closed 出结果）
// 首次见到某空间时只播种不推送，避免订阅瞬间被历史提案刷屏。
// ============================================================
async function fetchProposals(space) {
  const query = `query { proposals(first: 20, skip: 0, where: { space_in: ["${space}"]}, orderBy: "created", orderDirection: desc) { id title state start end link choices}}`;
  const r = await fetch(SNAPSHOT_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`Snapshot HTTP ${r.status}`);
  const data = await r.json().catch(() => ({}));
  return data?.data?.proposals || [];
}
async function spaceExists(space) {
  const query = `query { space(id: "${space}") { id name}}`;
  const r = await fetch(SNAPSHOT_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await r.json().catch(() => ({}));
  return data?.data?.space || null;
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "watch", description: "订阅 DAO /watch uniswap" },
  { command: "unwatch", description: "退订 /unwatch uniswap" },
  { command: "daos", description: "我订阅的 DAO" },
];
const COMMANDS_ADMIN = [
  { command: "daostats", description: "轮询统计（管理员）" },
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
// scheduled 是 Cron 入口：轮询全部被订阅空间并 diff 推送。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("dao-alerts bot is running.", {
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
    ctx.waitUntil(pollAll(env));
  },
};

async function getSubs(env, uid) {
  const raw = await env.BOT_KV.get("dao:sub:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, uid, subs) {
  await env.BOT_KV.put("dao:sub:" + uid, JSON.stringify(subs));
}

// ============================================================
// 轮询与分发（Cron）
// 先从全部个人订阅汇总出空间集合（一个空间只查一次），逐空间
// diff 出事件，再按订阅关系扇出推送。推送失败（拉黑）顺手清订阅。
// ============================================================
async function pollAll(env) {
  if (!env.BOT_KV) return;
  const list = await env.BOT_KV.list({ prefix: "dao:sub:", limit: 1000 });
  const bySpace = new Map(); // space -> [uid...]
  for (const k of list.keys) {
    const uid = k.name.slice("dao:sub:".length);
    const subs = JSON.parse((await env.BOT_KV.get(k.name)) || "[]");
    for (const sp of subs) {
      if (!bySpace.has(sp)) bySpace.set(sp, []);
      bySpace.get(sp).push(uid);
    }
  }
  for (const [space, uids] of bySpace) {
    let proposals;
    try {
      proposals = await fetchProposals(space);
    } catch (e) {
      continue; // 单个空间查询失败不拖垮整轮
    }
    const stateKey = "dao:state:" + space;
    const rawState = await env.BOT_KV.get(stateKey);
    const seen = rawState ? JSON.parse(rawState).seen || {} : {};
    const firstRun = !rawState;
    const events = [];
    for (const p of proposals) {
      const prev = seen[p.id];
      if (prev === undefined) {
        if (!firstRun && p.state !== "closed")
          events.push(`🆕 新提案\n《${p.title}》\n状态：${p.state}\n${p.link}`);
      } else if (prev !== p.state) {
        events.push(
          p.state === "closed"
            ? `🏁 提案已结束\n《${p.title}》\n去看结果：${p.link}`
            : `🔔 提案状态变化：${prev} → ${p.state}\n《${p.title}》\n${p.link}`,
        );
      }
      seen[p.id] = p.state;
    }
    // 只保留最近 100 个提案的状态，防止键无限膨胀
    const ids = Object.keys(seen);
    if (ids.length > 100)
      for (const id of ids.slice(0, ids.length - 100)) delete seen[id];
    await env.BOT_KV.put(stateKey, JSON.stringify({ seen }));
    for (const text of events) {
      for (const uid of uids) {
        const r = await send(env, uid, `🏛️ ${space}\n\n${text}`);
        if (!r.ok) {
          const rest = (await getSubs(env, uid)).filter((s) => s !== space);
          await saveSubs(env, uid, rest);
        }
      }
    }
  }
}

// ============================================================
// 业务主流程
// /watch 先验空间存在（spaceExists）再落订阅，避免订了个不存在
// 的空间永远静默；/daos 列表带退订按钮（回调 dao:un:<空间>，
// 空间 id 可能含点号但不含冒号，回调解析安全）。
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
  if (cq && String(cq.data || "").startsWith("dao:un:")) {
    const space = cq.data.slice("dao:un:".length);
    const subs = (await getSubs(env, cq.from.id)).filter((s) => s !== space);
    await saveSubs(env, cq.from.id, subs);
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `已退订 ${space}`,
    });
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
      "🏛️ DAO 治理提醒 Bot\n\n订阅 Snapshot 上的 DAO 空间，有新提案、提案开始/结束时第一时间提醒你。\n\n/watch <空间id> 订阅，如 /watch uniswap、/watch aave.eth\n/daos 看我的订阅\n/unwatch <空间id> 退订\n\n⚠️ Bot 内只能看与提醒：投票需要钱包签名，请点提醒里的链接去 Snapshot 页面完成。",
    );

  if (cmd === "/watch") {
    const space = (parts[1] || "").trim();
    if (!space)
      return send(
        env,
        chatId,
        "用法：/watch <Snapshot 空间 id>，如 /watch uniswap",
      );
    try {
      const sp = await spaceExists(space);
      if (!sp)
        return send(
          env,
          chatId,
          `没找到空间「${space}」，检查一下 id（就是 snapshot.org/#/ 后面那段）。`,
        );
      const subs = await getSubs(env, uid);
      if (!subs.includes(space)) {
        subs.push(space);
        await saveSubs(env, uid, subs);
      }
      return send(
        env,
        chatId,
        `✅ 已订阅 ${sp.name || space}（${space}）。有新提案或状态变化会推送给你。`,
      );
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 查询 Snapshot 失败：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (cmd === "/unwatch") {
    const space = (parts[1] || "").trim();
    const subs = (await getSubs(env, uid)).filter((s) => s !== space);
    await saveSubs(env, uid, subs);
    return send(env, chatId, `已退订 ${space || ""}。`);
  }

  if (cmd === "/daos") {
    const subs = await getSubs(env, uid);
    if (!subs.length)
      return send(env, chatId, "还没订阅任何 DAO。/watch <空间id> 开始。");
    return send(env, chatId, "🏛️ 我订阅的 DAO：", {
      reply_markup: {
        inline_keyboard: subs.map((s) => [
          { text: `🏛️ ${s}`, callback_data: `dao:noop` },
          { text: "退订", callback_data: `dao:un:${s}` },
        ]),
      },
    });
  }

  if (cmd === "/daostats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const subs = await env.BOT_KV.list({ prefix: "dao:sub:", limit: 1000 });
    const spaces = await env.BOT_KV.list({ prefix: "dao:state:", limit: 1000 });
    return send(
      env,
      chatId,
      `📊 订阅用户 ${subs.keys.length} 人 · 轮询中的空间 ${spaces.keys.length} 个`,
    );
  }
}
