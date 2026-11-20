// ============================================================
// 23 行情播报 Bot（单文件 · Cloudflare Workers · 价格提醒需 KV）
// 玩法：/p BTC 查币价（24h 涨跌，数据走 Binance 公共行情，无需 API Key）；
// /alert BTC > 70000 设价格提醒，Cron 每几分钟巡检，触发私聊通知；
// 配了 BROADCAST_CHAT_ID 后每次 Cron 还会把关注列表播报到频道/群。
// 必填变量：BOT_TOKEN（Secret）
// 选填：
// BROADCAST_CHAT_ID 定时播报目标（频道/群 ID）
// BROADCAST_SYMBOLS 播报币种，逗号隔开，默认 BTC,ETH
// WEBHOOK_SECRET
// ⚠️ 价格提醒需要 KV：变量名 BOT_KV（键 alerts 存全部提醒）。不绑 KV 也能查价。
// ⚠️ 播报/提醒需要 Cron：Worker → Triggers 加 */10 * * * *（10 分钟一轮）。
// 命令：/p 币种 · /alert 币种 > 价格 或 < 价格 · /alerts 我的提醒 · /delalert 编号
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 数据说明：data-api.binance.vision 是 Binance 官方公共数据域名，只含
// USDT 交易对现货价；查不到的币会明确报错，不编价格。
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

// ============================================================
// 【核心模块】行情数据源（Binance 公共 API）
// 免 Key 的 24hr ticker：现价、24h 涨跌幅、高低点；符号统一拼 USDT 交易对。
// ============================================================
async function ticker(symbol) {
  const pair = symbol.toUpperCase().replace(/USDT$/, "") + "USDT";
  const r = await fetch(
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${pair}`,
  );
  if (!r.ok) return null;
  const d = await r.json();
  return {
    pair,
    price: Number(d.lastPrice),
    change: Number(d.priceChangePercent),
    high: Number(d.highPrice),
    low: Number(d.lowPrice),
  };
}
const fmtPrice = (n) =>
  n >= 1000
    ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : n >= 1
      ? n.toFixed(4)
      : n.toFixed(6);
function priceText(t) {
  const arrow = t.change >= 0 ? "📈" : "📉";
  return `${arrow} ${t.pair}\n现价：$${fmtPrice(t.price)}\n24h 涨跌：${t.change >= 0 ? "+" : ""}${t.change.toFixed(2)}%\n24h 高/低：$${fmtPrice(t.high)} / $${fmtPrice(t.low)}`;
}

// ============================================================
// 【核心模块】价格提醒存储与巡检（KV + Cron）
// alerts = [{ user, name, symbol, cond:">"|"<", target}] 一条 KV 存全部（量小）；
// 巡检按币种去重抓价，触发即通知并删除该提醒（一次性）。
// ============================================================
async function loadAlerts(env) {
  const raw = await env.BOT_KV.get("alerts");
  return raw ? JSON.parse(raw) : [];
}
async function saveAlerts(env, a) {
  await env.BOT_KV.put("alerts", JSON.stringify(a));
}
async function checkAlerts(env) {
  let alerts = await loadAlerts(env);
  if (!alerts.length) return 0;
  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  const prices = {};
  for (const s of symbols) {
    const t = await ticker(s);
    if (t) prices[s] = t.price;
  }
  const keep = [];
  let fired = 0;
  for (const a of alerts) {
    const p = prices[a.symbol];
    const hit =
      p !== undefined &&
      ((a.cond === ">" && p > a.target) || (a.cond === "<" && p < a.target));
    if (hit) {
      fired++;
      await send(
        env,
        a.user,
        `🔔 价格提醒触发！\n${a.symbol}USDT 现价 $${fmtPrice(p)}，已${a.cond === ">" ? "突破" : "跌破"}你设的 $${fmtPrice(a.target)}。`,
      ).catch(() => {});
    } else keep.push(a);
  }
  if (fired) await saveAlerts(env, keep);
  return fired;
}
async function broadcast(env) {
  if (!env.BROADCAST_CHAT_ID) return;
  const symbols = String(env.BROADCAST_SYMBOLS || "BTC,ETH")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lines = [];
  for (const s of symbols) {
    const t = await ticker(s);
    if (t) lines.push(priceText(t));
  }
  if (lines.length)
    await send(
      env,
      env.BROADCAST_CHAT_ID,
      "📰 行情播报\n\n" + lines.join("\n\n"),
    );
}

// ============================================================
// 【核心模块】Worker 入口与路由
// fetch 管查价/提醒命令，scheduled 管提醒巡检与定时播报。
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
  { command: "p", description: "查币价，如 /p BTC" },
  { command: "alert", description: "设价格提醒" },
  { command: "alerts", description: "我的提醒" },
  { command: "delalert", description: "删除提醒" },
  { command: "start", description: "使用说明" },
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
      return new Response("crypto-price bot is running.", {
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
    ctx.waitUntil(
      (async () => {
        await broadcast(env);
        if (env.BOT_KV) await checkAlerts(env);
      })(),
    );
  },
};

// ============================================================
// 【核心模块】业务主流程
// 查价直连行情模块；提醒的增删查都落在 alerts 一条 KV 记录上（私聊使用）。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  if (cmd === "/p" || cmd === "/price") {
    const sym = text.split(/\s+/)[1];
    if (!sym) return send(env, chatId, "用法：/p BTC（查 BTC/USDT）");
    const t = await ticker(sym);
    return send(
      env,
      chatId,
      t
        ? priceText(t)
        : `查不到 ${sym.toUpperCase()} 的 USDT 行情，确认币种拼写（只支持 Binance 现货 USDT 对）。`,
    );
  }
  if (cmd === "/alert") {
    if (!env.BOT_KV)
      return send(
        env,
        chatId,
        "⚠️ 价格提醒需要先绑定 KV（变量名 BOT_KV）。查价不受影响。",
      );
    if (msg.chat.type !== "private")
      return send(env, chatId, "提醒是私聊通知的，请私聊我设置。");
    const m = text.match(/^\/alert\s+(\w+)\s*(>|<)\s*([\d.]+)/);
    if (!m)
      return send(env, chatId, "用法：/alert BTC > 70000 或 /alert ETH < 3000");
    const alerts = await loadAlerts(env);
    alerts.push({
      user: msg.from.id,
      symbol: m[1].toUpperCase(),
      cond: m[2],
      target: Number(m[3]),
    });
    await saveAlerts(env, alerts);
    return send(
      env,
      chatId,
      `🔔 已设提醒：${m[1].toUpperCase()}USDT ${m[2]} $${m[3]} 时私聊通知你（Cron 巡检触发，一次性）。`,
    );
  }
  if (cmd === "/alerts") {
    if (!env.BOT_KV) return send(env, chatId, "未绑定 KV，没有提醒数据。");
    const mine = (await loadAlerts(env))
      .map((a, i) => ({ ...a, i }))
      .filter((a) => a.user === msg.from.id);
    return send(
      env,
      chatId,
      mine.length
        ? "🔔 我的提醒（编号用于删除）：\n" +
            mine
              .map((a) => `${a.i} · ${a.symbol}USDT ${a.cond} $${a.target}`)
              .join("\n")
        : "你还没有价格提醒。/alert 币种 > 价格 设置。",
    );
  }
  if (cmd === "/delalert") {
    if (!env.BOT_KV) return send(env, chatId, "未绑定 KV。");
    const idx = Number(text.split(/\s+/)[1]);
    const alerts = await loadAlerts(env);
    if (alerts[idx]?.user !== msg.from.id)
      return send(env, chatId, "编号不对或不是你的提醒，发 /alerts 看编号。");
    alerts.splice(idx, 1);
    await saveAlerts(env, alerts);
    return send(env, chatId, "已删除该提醒。");
  }
  if (cmd === "/start")
    return send(
      env,
      chatId,
      "💹 行情 Bot\n/p BTC 查价\n/alert BTC > 70000 设提醒（私聊）\n/alerts 我的提醒 · /delalert 编号 删除\n数据：Binance 公共行情（USDT 现货）。",
    );
}
