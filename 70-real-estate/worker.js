// ============================================================
// 70 房产租售提醒 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// /watch 城市 户型 预算 订阅房源（如 /watch 上海 2室 8000），
// Cron 拉取匹配的新房源、去重后推送；/estates 管理订阅。
// ⚠️ 数据源是这行最难的部分：房产门户高度区域化（各国各城不同
// 门户、基本没有统一 API），模板只给「房源适配位」ESTATE_API_URL
// ——把你所在市场的房源接口（自建聚合/授权 API）按约定口径接上。
// 未配置时走内置演示数据（明确标注），只用来演示订阅→
// 去重→推送的完整流程，不会假装是真实房源。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ESTATE_API_URL / ESTATE_API_KEY 房源 API 适配位（通用 GET 口径）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：estate:<用户ID> = 订阅列表；estate:seen:<用户ID>:<订阅ID> = 已推房源ID（去重）。
// ⚠️ 推送要给 Worker 加 Cron Trigger（如 */30 * * * *）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 19（外部 API）+ 模块 09（Cron）+ 模块 01（骨架）
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

// ============================================================
// 房源数据层（适配位 + 演示数据）
// 真实口径：GET {ESTATE_API_URL}?city=<城市>&rooms=<户型>&max=<预算>，
// 期望 JSON 数组（或 {listings}/{data} 包一层），元素含
// id/title/price/rooms/url。换任何市场的数据源都只改 fetchListings。
// 未配置时返回 DEMO_LISTINGS 并标注 demo=true，调用方必须把
// 字样带进用户可见文案——这是诚实红线，别删。
// ============================================================
const DEMO_LISTINGS = [
  {
    id: "demo-1",
    title: "阳光花园 两室一厅 近地铁",
    price: 6500,
    rooms: "2室",
    url: "",
  },
  {
    id: "demo-2",
    title: "河畔公寓 三室两厅 江景",
    price: 9800,
    rooms: "3室",
    url: "",
  },
  {
    id: "demo-3",
    title: "老城小户型 一室一厅 拎包入住",
    price: 3800,
    rooms: "1室",
    url: "",
  },
];
async function fetchListings(env, sub) {
  if (!env.ESTATE_API_URL) return { listings: DEMO_LISTINGS, demo: true };
  const u =
    `${env.ESTATE_API_URL}${env.ESTATE_API_URL.includes("?") ? "&" : "?"}` +
    `city=${encodeURIComponent(sub.city)}&rooms=${encodeURIComponent(sub.rooms)}&max=${encodeURIComponent(sub.max)}`;
  const r = await fetch(u, {
    headers: env.ESTATE_API_KEY
      ? { Authorization: `Bearer ${env.ESTATE_API_KEY}` }
      : {},
  });
  if (!r.ok) throw new Error(`房源接口 HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  const arr = Array.isArray(d) ? d : d.listings || d.data || [];
  return {
    demo: false,
    listings: arr.map((x) => ({
      id: String(x.id ?? x.url ?? x.title),
      title: String(x.title || "房源"),
      price: Number(x.price) || 0,
      rooms: String(x.rooms || ""),
      url: x.url || "",
    })),
  };
}
function matchListing(sub, l) {
  if (
    sub.rooms &&
    l.rooms &&
    !String(l.rooms).includes(sub.rooms.replace("室", ""))
  )
    return false;
  if (sub.max && l.price && l.price > sub.max) return false;
  return true;
}

// ============================================================
// 订阅与去重推送（KV + Cron）
// estate:<uid> = [{id, city, rooms, max}]；每条订阅一份已推清单
// estate:seen:<uid>:<订阅ID>（上限 300 条滚动），新房源 = 拉取结果
// 里没见过且匹配筛选的。每轮每条订阅最多推 5 条防刷屏。
// ============================================================
async function getSubs(env, uid) {
  const raw = await env.BOT_KV.get("estate:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, uid, subs) {
  await env.BOT_KV.put("estate:" + uid, JSON.stringify(subs));
}
async function checkSub(env, uid, sub, { silent = false } = {}) {
  const { listings, demo } = await fetchListings(env, sub);
  const seenKey = `estate:seen:${uid}:${sub.id}`;
  const seen = JSON.parse((await env.BOT_KV.get(seenKey)) || "[]");
  const seenSet = new Set(seen);
  const fresh = listings
    .filter((l) => matchListing(sub, l) && !seenSet.has(l.id))
    .slice(0, 5);
  for (const l of fresh) {
    seenSet.add(l.id);
    if (!silent)
      await send(
        env,
        Number(uid),
        `🏠 新房源（${sub.city} ${sub.rooms} ≤ ${sub.max}）${demo ? "\n⚠️ 演示数据，非真实房源" : ""}\n${l.title}\n💰 ${l.price}/月${l.rooms ? " · " + l.rooms : ""}`,
        l.url
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "🔗 看房源", url: l.url }]],
              },
            }
          : {},
      );
  }
  await env.BOT_KV.put(seenKey, JSON.stringify([...seenSet].slice(-300)));
  return fresh.length;
}
async function pollEstates(env) {
  const list = await env.BOT_KV.list({ prefix: "estate:", limit: 1000 });
  for (const k of list.keys) {
    if (!/^estate:\d+$/.test(k.name)) continue;
    const uid = k.name.slice(7);
    for (const sub of await getSubs(env, uid)) {
      try {
        await checkSub(env, uid, sub);
      } catch (e) {
        // 单条订阅拉取失败不中断整轮
      }
    }
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "watch", description: "订阅房源，如 /watch 上海 2室 8000" },
  { command: "estates", description: "我的订阅" },
  { command: "unwatch", description: "取消订阅，如 /unwatch 1" },
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
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("real-estate bot is running.", {
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
        allowed_updates: ["message"],
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
    if (env.BOT_KV) ctx.waitUntil(pollEstates(env));
  },
};

// ============================================================
// 业务主流程
// /watch 城市 户型 预算；订阅后立即试拉一次（真实源给即时反馈，
// 演示源让用户看到完整流程长什么样）。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const parts = text.split(/\s+/);
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🏠 房产租售提醒 Bot\n\n/watch 上海 2室 8000 订阅（城市 户型 预算/月），有匹配的新房源就推你。\n/estates 看订阅 · /unwatch 序号 取消。\n\n数据源说明：房源靠管理员接入的市场 API（ESTATE_API_URL）；没接之前推送的是明确标注的演示数据，只演示流程。",
    );
  if (!env.BOT_KV && ["/watch", "/estates", "/unwatch"].includes(cmd))
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");

  if (cmd === "/watch") {
    const city = parts[1];
    const rooms = parts[2] || "";
    const max = Number(parts[3]);
    if (!city || !max)
      return send(
        env,
        chatId,
        "用法：/watch 城市 户型 预算，如 /watch 上海 2室 8000（预算是月租上限，买房场景填总价即可，口径在数据源侧统一）",
      );
    const subs = await getSubs(env, uid);
    const sub = { id: Date.now().toString(36), city, rooms, max };
    subs.push(sub);
    await saveSubs(env, uid, subs);
    await send(
      env,
      chatId,
      `✅ 已订阅：${city} ${rooms} ≤ ${max}。` +
        (env.ESTATE_API_URL
          ? "正在帮你拉第一批…"
          : "\n⚠️ 管理员还没接入房源 API（ESTATE_API_URL），接下来推给你的将是，只用于演示流程，不是真实房源。"),
    );
    try {
      const n = await checkSub(env, uid, sub);
      if (!n)
        await send(
          env,
          chatId,
          "暂时没有符合条件的新房源，有新的会第一时间推你。",
        );
    } catch (e) {
      await send(
        env,
        chatId,
        `😵 房源接口出错：${String(e.message || e).slice(0, 120)}。订阅已保存，后续轮询会重试。`,
      );
    }
    return;
  }

  if (cmd === "/estates") {
    const subs = await getSubs(env, uid);
    if (!subs.length)
      return send(
        env,
        chatId,
        "你还没有房源订阅。/watch 上海 2室 8000 订一个。",
      );
    return send(
      env,
      chatId,
      "🏠 我的订阅：\n" +
        subs
          .map((s, i) => `${i + 1}. ${s.city} ${s.rooms} ≤ ${s.max}`)
          .join("\n") +
        "\n\n取消：/unwatch 序号",
    );
  }

  if (cmd === "/unwatch") {
    const n = Number(parts[1]);
    const subs = await getSubs(env, uid);
    if (!n || n < 1 || n > subs.length)
      return send(env, chatId, "用法：/unwatch 序号（序号见 /estates）");
    const [gone] = subs.splice(n - 1, 1);
    await saveSubs(env, uid, subs);
    await env.BOT_KV.delete(`estate:seen:${uid}:${gone.id}`);
    return send(
      env,
      chatId,
      `🔕 已取消订阅：${gone.city} ${gone.rooms} ≤ ${gone.max}。`,
    );
  }
}
