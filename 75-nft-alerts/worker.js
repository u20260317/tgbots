// ============================================================
// 75 NFT 动态提醒 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// /watch <链> <合约地址> 订阅某个 NFT 合集的动态；Cron 轮询事件源，
// 新 mint / 新成交时推送给订阅者；/nfts 管理订阅。
// 数据源是「事件轮询适配层」fetchNftEvents()，两种接法二选一：
// A. OpenSea 官方 API v2 events（需 OPENSEA_API_KEY，官网申请）；
// B. 自建/第三方适配端点 NFT_API_URL：GET {NFT_API_URL}?chain=&contract=
// 返回 JSON 数组 [{id, type:"mint"|"sale", tokenId, price, url, time}]。
// 两者都没配时，/watch 会明确提示未配置数据源，不假装在监控。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// OPENSEA_API_KEY OpenSea API Key（Secret）
// NFT_API_URL 通用事件适配端点（与上二选一）
// ADMIN_ID 管理员数字 ID（看 /nftstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：nft:sub:<用户ID> = [{chain, contract}]；
// nft:state:<链>:<合约> = {seen:[事件id...]}。
// ⚠️ 需要 Cron：Triggers 加一条（如 */15 * * * *）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 41（通知适配器）+ 模块 19（外部 API）+ 模块 01/02
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
// NFT 事件轮询适配层（可替换）
// fetchNftEvents(chain, contract) → 统一事件数组（新→旧）：
// { id, type:"mint"|"sale"|"list", tokenId, price?, url}
// OpenSea v2 events 口径：GET /api/v2/events/chain/{chain}/contract/
// {address}?event_type=mint,sale&limit=20，响应 nft_events[]，
// 每条有 event_type、nft.identifier、payment.quantity、event_url，
// 去重 id 用 transaction.hash + identifier 拼。
// 各链命名以 OpenSea 为准：ethereum / polygon / arbitrum / base /
// solana 等；TON 系合集 OpenSea 不收，要走 NFT_API_URL 接 toncenter
// 或 Getgems 的适配端点（见 README）。
// ============================================================
async function fetchNftEvents(env, chain, contract) {
  if (env.OPENSEA_API_KEY) {
    const u = `https://api.opensea.io/api/v2/events/chain/${encodeURIComponent(chain)}/contract/${encodeURIComponent(contract)}?event_type=mint,sale&limit=20`;
    const r = await fetch(u, {
      headers: { accept: "application/json", "x-api-key": env.OPENSEA_API_KEY },
    });
    if (!r.ok) throw new Error(`OpenSea HTTP ${r.status}`);
    const data = await r.json().catch(() => ({}));
    return (data.nft_events || []).map((e) => ({
      id: `${e.transaction?.hash || ""}:${e.nft?.identifier || ""}:${e.event_type}`,
      type: e.event_type === "mint" ? "mint" : "sale",
      tokenId: e.nft?.identifier || "?",
      price: e.payment?.quantity
        ? `${Number(e.payment.quantity) / 1e18} ${e.payment?.symbol || ""}`.trim()
        : "",
      url: e.event_url || "",
    }));
  }
  if (env.NFT_API_URL) {
    const u = `${env.NFT_API_URL.replace(/\/$/, "")}?chain=${encodeURIComponent(chain)}&contract=${encodeURIComponent(contract)}`;
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`NFT_API HTTP ${r.status}`);
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  }
  throw new Error("未配置数据源");
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "watch", description: "订阅合集 /watch ethereum 0x…" },
  { command: "unwatch", description: "退订 /unwatch ethereum 0x…" },
  { command: "nfts", description: "我订阅的合集" },
];
const COMMANDS_ADMIN = [
  { command: "nftstats", description: "轮询统计（管理员）" },
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
// scheduled 是 Cron 入口：轮询全部被订阅合集，diff 新事件后扇出。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("nft-alerts bot is running.", {
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

const subKey = (w) => `${w.chain}:${w.contract.toLowerCase()}`;
async function getSubs(env, uid) {
  const raw = await env.BOT_KV.get("nft:sub:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, uid, subs) {
  await env.BOT_KV.put("nft:sub:" + uid, JSON.stringify(subs));
}

// ============================================================
// 轮询与分发（Cron）
// 按合集汇总订阅者（一个合集只查一次），拉事件后与 nft:state 里
// 的 seen 集合 diff：新 id 才是新事件。首次轮询只播种不推送。
// 每轮最多推 5 条防刷屏，seen 只留最近 200 个 id。
// ============================================================
async function pollAll(env) {
  if (!env.BOT_KV) return;
  const list = await env.BOT_KV.list({ prefix: "nft:sub:", limit: 1000 });
  const byWatch = new Map();
  for (const k of list.keys) {
    const uid = k.name.slice("nft:sub:".length);
    for (const w of JSON.parse((await env.BOT_KV.get(k.name)) || "[]")) {
      const key = subKey(w);
      if (!byWatch.has(key)) byWatch.set(key, { w, uids: [] });
      byWatch.get(key).uids.push(uid);
    }
  }
  for (const [key, { w, uids }] of byWatch) {
    let events;
    try {
      events = await fetchNftEvents(env, w.chain, w.contract);
    } catch (e) {
      continue;
    }
    const stateKey = "nft:state:" + key;
    const rawState = await env.BOT_KV.get(stateKey);
    const seen = rawState ? JSON.parse(rawState).seen || [] : [];
    const seenSet = new Set(seen);
    const fresh = events.filter((e) => e.id && !seenSet.has(e.id));
    const merged = [...events.map((e) => e.id), ...seen].slice(0, 200);
    await env.BOT_KV.put(stateKey, JSON.stringify({ seen: merged }));
    if (!rawState) continue; // 首次只播种
    for (const e of fresh.slice(0, 5)) {
      const label = e.type === "mint" ? "🌱 新 Mint" : "💰 新成交";
      const text = `${label} · ${w.chain}\n合集 ${w.contract}\nToken #${e.tokenId}${e.price ? `\n价格：${e.price}` : ""}${e.url ? `\n${e.url}` : ""}`;
      for (const uid of uids) {
        const r = await send(env, uid, text);
        if (!r.ok) {
          const rest = (await getSubs(env, uid)).filter(
            (x) => subKey(x) !== key,
          );
          await saveSubs(env, uid, rest);
        }
      }
    }
  }
}

// ============================================================
// 业务主流程
// /watch 先检查数据源是否已配置：没配 OPENSEA_API_KEY 也没配
// NFT_API_URL 时直接说明白，不收下订阅装作在监控。
// 退订按钮回调 nft:un:<下标>（下标指个人订阅数组序号，避开把长
// 合约地址塞进 callback_data 超 64 字节上限）。
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
  if (cq && String(cq.data || "").startsWith("nft:un:")) {
    const idx = Number(cq.data.split(":")[2]);
    const subs = await getSubs(env, cq.from.id);
    const removed = subs[idx];
    if (removed) {
      subs.splice(idx, 1);
      await saveSubs(env, cq.from.id, subs);
    }
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: removed ? `已退订 ${removed.contract}` : "已退订",
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
      "🖼️ NFT 动态提醒 Bot\n\n/watch <链> <合约地址> 订阅合集，如\n/watch ethereum 0xBC4C…\n有新 mint / 新成交时推送。\n/nfts 看订阅，/unwatch 退订。\n\n数据源：OpenSea API（需管理员配置 OPENSEA_API_KEY）或自建适配端点 NFT_API_URL，二选一。",
    );

  if (cmd === "/watch") {
    const [, chain, contract] = parts;
    if (!chain || !contract)
      return send(
        env,
        chatId,
        "用法：/watch <链> <合约地址>，如 /watch ethereum 0xBC4C...",
      );
    if (!env.OPENSEA_API_KEY && !env.NFT_API_URL)
      return send(
        env,
        chatId,
        "⚠️ 管理员还没配置 NFT 数据源（OPENSEA_API_KEY 或 NFT_API_URL 都没填），现在订阅了也不会有任何推送。等管理员配好后再来 /watch。",
      );
    const subs = await getSubs(env, uid);
    const w = { chain: chain.toLowerCase(), contract };
    if (!subs.some((x) => subKey(x) === subKey(w))) {
      subs.push(w);
      await saveSubs(env, uid, subs);
    }
    return send(
      env,
      chatId,
      `✅ 已订阅 ${w.chain} 上的合集 ${contract}，有新 mint/成交会推送。`,
    );
  }

  if (cmd === "/unwatch") {
    const [, chain, contract] = parts;
    const subs = (await getSubs(env, uid)).filter(
      (x) =>
        !(x.chain === (chain || "").toLowerCase() && x.contract === contract),
    );
    await saveSubs(env, uid, subs);
    return send(env, chatId, "已退订。");
  }

  if (cmd === "/nfts") {
    const subs = await getSubs(env, uid);
    if (!subs.length)
      return send(
        env,
        chatId,
        "还没订阅任何合集。/watch <链> <合约地址> 开始。",
      );
    return send(env, chatId, "🖼️ 我订阅的合集：", {
      reply_markup: {
        inline_keyboard: subs.map((w, i) => [
          {
            text: `${w.chain} · ${w.contract.slice(0, 10)}…`,
            callback_data: "nft:noop",
          },
          { text: "退订", callback_data: `nft:un:${i}` },
        ]),
      },
    });
  }

  if (cmd === "/nftstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const subs = await env.BOT_KV.list({ prefix: "nft:sub:", limit: 1000 });
    const states = await env.BOT_KV.list({ prefix: "nft:state:", limit: 1000 });
    return send(
      env,
      chatId,
      `📊 订阅用户 ${subs.keys.length} 人 · 监控中的合集 ${states.keys.length} 个 · 数据源：${env.OPENSEA_API_KEY ? "OpenSea" : env.NFT_API_URL ? "NFT_API_URL" : "未配置"}`,
    );
  }
}
