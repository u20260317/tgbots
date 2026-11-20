// ============================================================
// 76 电商比价追踪 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// /track <商品链接> 订阅查价；Cron 定时抓商品页解析价格，降价幅度
// 超过阈值（PRICE_DROP_PCT，默认 5%）时推送；/prices 看追踪列表与
// 近 30 天价格历史。
// 价格解析是「站点适配层」extractPrice(html, url)：
// · 通用口径先吃带 JSON-LD（offers.price）的页面与
// <meta property="product:price:amount"> 的页面（多数中小电商与
// 独立站都带），不用为每个站写代码；
// · 大平台（Amazon 等）反爬严、页面无静态价，解析不到就明确提示
// 「该站点暂未适配」，不编价格。接 Keepa 等授权 API 时改这一个
// 函数即可（见模块 48 的抓取礼仪与 README）。
// 抓取安全沿用 44 号口径：SSRF 私有地址拦截、超时掐断、大小上限。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// PRICE_DROP_PCT 降价提醒阈值百分比，默认 5
// ADMIN_ID 管理员数字 ID（看 /pricestats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：price:item:<ID> = {url, title, last, history:[{d,p}], subs:[uid]}
// price:sub:<用户ID> = [itemID...]（与 item.subs 双向冗余，
// 方便按人列清单与按商品扇出，改动时两边一起维护）。
// ⚠️ 需要 Cron：Triggers 加一条（如 0 */6 * * * 每 6 小时查价）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 48（网页抓取礼仪）+ 模块 19/41 + 模块 01/02
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
const dayKey = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// ============================================================
// URL 安全（SSRF 防护，沿用 44 号口径）
// 只许 http/https，字面拦掉 localhost 与私有/保留地址段——查价
// fetch 是以服务器身份发出的，不能被当成扫内网的跳板。
// ============================================================
function isSafePublicUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (
    /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fe80"))
    return false;
  return true;
}

// ============================================================
// 价格抓取与站点适配层
// fetchPrice(url) → { price:Number, title} 或抛错。
// 解析顺序（extractPrice）：
// 1. JSON-LD：<script type="application/ld+json"> 里的 offers.price
// （含 @graph / 数组形态），电商页最标准的价格标注；
// 2. OpenGraph 价格 meta：product:price:amount；
// 3. 都没有 → 抛「未适配」——不做全文正则瞎猜价格（页面里出现的
// 数字太多，猜错价比不报更坏）。新站点适配 = 在这里加一个分支
// 或改走授权 API（如 Keepa），调用方不用动。
// ============================================================
function extractPrice(html, url) {
  const ldBlocks = html.match(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (ldBlocks) {
    for (const block of ldBlocks) {
      const jsonText = block.replace(/<[^>]+>/g, "");
      try {
        const stack = [JSON.parse(jsonText)];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== "object") continue;
          const offers = node.offers;
          const offer = Array.isArray(offers) ? offers[0] : offers;
          if (offer && offer.price) {
            const p = Number(offer.price);
            if (p > 0) return { price: p, title: node.name || "" };
          }
          for (const v of Object.values(node)) {
            if (v && typeof v === "object") stack.push(v);
          }
        }
      } catch (e) {
        /* 坏 JSON-LD 跳过，看下一个 */
      }
    }
  }
  const meta = html.match(
    /property="product:price:amount"\s+content="([\d.,]+)"/i,
  );
  if (meta) {
    const p = Number(meta[1].replace(/,/g, ""));
    if (p > 0) {
      const t = html.match(/property="og:title"\s+content="([^"]+)"/i);
      return { price: p, title: t ? t[1] : "" };
    }
  }
  throw new Error(
    "该页面没有 JSON-LD / OG 价格标注，暂未适配这个站点（大平台多需授权 API，如 Keepa）",
  );
}
async function fetchPrice(url) {
  if (!isSafePublicUrl(url)) throw new Error("链接不合法或指向内网地址");
  const r = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; PriceTrackerBot/1.0; +https://telegram.org)",
      accept: "text/html",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`商品页 HTTP ${r.status}`);
  const html = (await r.text()).slice(0, 500000);
  return extractPrice(html, url);
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "track", description: "追踪商品 /track <链接>" },
  { command: "prices", description: "我的追踪列表与价格历史" },
];
const COMMANDS_ADMIN = [
  { command: "pricestats", description: "追踪统计（管理员）" },
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
// scheduled 是 Cron 入口：逐商品查价、记历史、超阈值降价才推送。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("price-tracker bot is running.", {
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
    ctx.waitUntil(checkAll(env));
  },
};

async function getItem(env, id) {
  const raw = await env.BOT_KV.get("price:item:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveItem(env, id, item) {
  await env.BOT_KV.put("price:item:" + id, JSON.stringify(item));
}
async function getUserItems(env, uid) {
  const raw = await env.BOT_KV.get("price:sub:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveUserItems(env, uid, ids) {
  await env.BOT_KV.put("price:sub:" + uid, JSON.stringify(ids));
}

// ============================================================
// 定时查价（Cron）
// 逐商品抓价：与上次价比，降幅 ≥ PRICE_DROP_PCT（默认 5%）才推
// 送（涨价与小波动只记历史不打扰）；历史按天记一个点（同天覆盖），
// 只保留近 30 天。抓价失败（下架/反爬）跳过本轮，不删订阅。
// ============================================================
async function checkAll(env) {
  if (!env.BOT_KV) return;
  const pct = Number(env.PRICE_DROP_PCT) || 5;
  const list = await env.BOT_KV.list({ prefix: "price:item:", limit: 1000 });
  for (const k of list.keys) {
    const id = k.name.slice("price:item:".length);
    const item = await getItem(env, id);
    if (!item || !item.subs.length) continue;
    let now;
    try {
      now = await fetchPrice(item.url);
    } catch (e) {
      continue;
    }
    const today = dayKey();
    item.history = (item.history || []).filter((h) => h.d >= dayKeyMinus30());
    const todayPoint = item.history.find((h) => h.d === today);
    if (todayPoint) todayPoint.p = now.price;
    else item.history.push({ d: today, p: now.price });
    const prev = item.last;
    item.last = now.price;
    if (now.title && !item.title) item.title = now.title;
    await saveItem(env, id, item);
    if (prev && now.price < prev && ((prev - now.price) / prev) * 100 >= pct) {
      const drop = (((prev - now.price) / prev) * 100).toFixed(1);
      const text = `📉 降价提醒（-${drop}%）\n${item.title || item.url}\n${prev} → ${now.price}\n${item.url}`;
      for (const uid of item.subs) await send(env, uid, text);
    }
  }
}
function dayKeyMinus30() {
  return new Date(Date.now() + 8 * 3600 * 1000 - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
}

// ============================================================
// 业务主流程
// /track 先真抓一次价：抓不到价（未适配/反爬）当场说明白，不收
// 订阅；抓到才落 item（同 URL 复用同一 item，subs 合并）。
// /prices 逐个展示现价与近 30 天历史点列，带删除按钮
// （回调 price:del:<itemID>，ID 是 4 位短码，回调长度安全）。
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
  if (cq && String(cq.data || "").startsWith("price:del:")) {
    const id = cq.data.split(":")[2];
    const uid = cq.from.id;
    const item = await getItem(env, id);
    if (item) {
      item.subs = item.subs.filter((u) => String(u) !== String(uid));
      if (item.subs.length) await saveItem(env, id, item);
      else await env.BOT_KV.delete("price:item:" + id);
    }
    await saveUserItems(
      env,
      uid,
      (await getUserItems(env, uid)).filter((x) => x !== id),
    );
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "已停止追踪",
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
      "🏷️ 电商比价追踪 Bot\n\n/track <商品链接> 开始追踪，降价超过阈值（默认 5%）时提醒你。\n/prices 看追踪列表与近 30 天价格历史。\n\n支持带 JSON-LD / OG 价格标注的商品页（多数独立站与中小电商）；Amazon 等大平台反爬严、需授权 API，未适配时会明确告诉你。",
    );

  if (cmd === "/track") {
    const url = parts[1] || "";
    if (!/^https?:\/\//i.test(url))
      return send(env, chatId, "用法：/track <商品链接>");
    if (!isSafePublicUrl(url))
      return send(env, chatId, "⛔ 这个链接不合法或指向内网地址，已拒绝。");
    await send(env, chatId, "⏳ 先帮你抓一次当前价…");
    let now;
    try {
      now = await fetchPrice(url);
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 没抓到价格：${String(e.message || e).slice(0, 200)}\n没有收下这个追踪——抓不到价的订阅只会永远静默。`,
      );
    }
    // 同 URL 复用同一 item
    const list = await env.BOT_KV.list({ prefix: "price:item:", limit: 1000 });
    let id = null;
    let item = null;
    for (const k of list.keys) {
      const it = await getItem(env, k.name.slice("price:item:".length));
      if (it && it.url === url) {
        id = k.name.slice("price:item:".length);
        item = it;
        break;
      }
    }
    if (!item) {
      id = newId();
      item = {
        url,
        title: now.title || "",
        last: now.price,
        history: [{ d: dayKey(), p: now.price }],
        subs: [],
      };
    }
    if (!item.subs.includes(uid)) item.subs.push(uid);
    await saveItem(env, id, item);
    const mine = await getUserItems(env, uid);
    if (!mine.includes(id)) {
      mine.push(id);
      await saveUserItems(env, uid, mine);
    }
    return send(
      env,
      chatId,
      `✅ 已追踪\n${item.title || url}\n当前价：${now.price}\n降价超 ${Number(env.PRICE_DROP_PCT) || 5}% 时会提醒你。`,
    );
  }

  if (cmd === "/prices") {
    const ids = await getUserItems(env, uid);
    if (!ids.length)
      return send(env, chatId, "还没追踪任何商品。/track <商品链接> 开始。");
    for (const id of ids) {
      const item = await getItem(env, id);
      if (!item) continue;
      const hist = (item.history || [])
        .map((h) => `${h.d.slice(5)}:${h.p}`)
        .join(" · ");
      await send(
        env,
        chatId,
        `🏷️ ${item.title || item.url}\n现价：${item.last}\n近 30 天：${hist || "暂无"}\n${item.url}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🗑 停止追踪", callback_data: `price:del:${id}` }],
            ],
          },
        },
      );
    }
    return;
  }

  if (cmd === "/pricestats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "price:item:", limit: 1000 });
    return send(env, chatId, `📊 正在追踪的商品：${list.keys.length} 个`);
  }
}
