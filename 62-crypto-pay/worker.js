// ============================================================
// 62 加密支付收款 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 用 Crypto Pay（@CryptoBot 官方支付系统）的发票给数字商品/服务收款：
// /invoice 10 USDT 创建发票 → Bot 发带「去支付」链接按钮的消息 →
// 用户在 Crypto Pay 里付款 → Webhook 回调验签 → 幂等发货（演示发兑换码）。
// Webhook 丢了也不怕：/invoices 主动查发票状态做轮询兜底，到账照样发货。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// CRYPTO_PAY_API_TOKEN Crypto Pay 应用的 API Token（Secret，
//   在 @CryptoBot → Crypto Pay → My Apps 里创建应用后拿到）
// 选填：
// WEBHOOK_SECRET Webhook 密钥（管 /setWebhook 与 TG 侧 webhook 验签）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（/cpall 看全部发票）
// CRYPTO_PAY_API_BASE 默认 https://pay.crypt.bot/api（测试网填
//   https://testnet-pay.crypt.bot/api）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：cpinv:<发票ID> = 发票记录；cppaid:<发票ID> = 已发货标记（幂等）。
// ⚠️ Webhook 地址要在 Crypto Pay 应用设置里填：
//   https://你的Worker地址/cryptopay （@CryptoBot → Crypto Pay →
//   My Apps → 选应用 → Webhooks），TG 侧部署后访问
//   https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 24（Stars 支付的幂等发货模式）+ 模块 19（外部 API）+ 模块 01（骨架）
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
// Crypto Pay API 客户端
// 官方接口：POST /createInvoice 建发票、GET /getInvoices 查状态，
// 请求头带 Crypto-Pay-API-Token。金额一律字符串（官方要求，避免浮点误差）。
// 币种分两类：加密货币（asset：USDT/TON/BTC…）与法币（fiat：USD/EUR…，
// 用户付款时由 Crypto Pay 按汇率折算成加密货币到账）。
// ============================================================
const CRYPTO_ASSETS = [
  "USDT",
  "TON",
  "BTC",
  "ETH",
  "LTC",
  "BNB",
  "TRX",
  "USDC",
  "DOGE",
];
const FIATS = ["USD", "EUR", "RUB", "UAH", "BYN", "KZT", "CNY", "GBP", "JPY"];
const cpBase = (env) => env.CRYPTO_PAY_API_BASE || "https://pay.crypt.bot/api";
async function cpApi(env, method, params, isGet = false) {
  let url = `${cpBase(env)}/${method}`;
  const opt = { headers: { "Crypto-Pay-API-Token": env.CRYPTO_PAY_API_TOKEN } };
  if (isGet) {
    const qs = new URLSearchParams(params || {}).toString();
    if (qs) url += "?" + qs;
  } else {
    opt.method = "POST";
    opt.headers["content-type"] = "application/json";
    opt.body = JSON.stringify(params || {});
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!data.ok)
    throw new Error(data.error?.name || `Crypto Pay 接口异常 HTTP ${r.status}`);
  return data.result;
}

// ============================================================
// Webhook 验签（Crypto Pay 官方算法）
// 签名头 crypto-pay-api-signature = HMAC-SHA256(请求体原文)，
// 其中 HMAC 的密钥不是 Token 本身，而是 Token 的 SHA-256 摘要。
// 必须用原始字节验签（先解析 JSON 再拼回去空格一变就对不上），
// 比较用恒定时间防时序攻击。
// ============================================================
async function sha256Bytes(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}
async function verifyCryptoPay(env, rawBody, headerHex) {
  if (!headerHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    await sha256Bytes(env.CRYPTO_PAY_API_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex.length !== headerHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++)
    diff |= hex.charCodeAt(i) ^ headerHex.charCodeAt(i);
  return diff === 0;
}

// ============================================================
// 发票存储与幂等发货（模块 24 的 paid: 模式）
// 发货只认「已支付」事实，且用 cppaid:<发票ID> 做幂等标记：
// Webhook 和 /invoices 轮询两条路都可能触发发货，先抢到标记的才发，
// 另一条路看到标记直接跳过——同一张发票永远只发一次货。
// 演示货品 = 一段兑换码；嵌回商店时把 deliver() 换成真发货逻辑即可。
// ============================================================
async function saveInvoice(env, inv, uid, chat) {
  await env.BOT_KV.put(
    "cpinv:" + inv.invoice_id,
    JSON.stringify({
      id: inv.invoice_id,
      uid,
      chat,
      amount: inv.amount,
      cur: inv.asset || inv.fiat || "",
      status: inv.status || "active",
      url:
        inv.bot_invoice_url ||
        inv.mini_app_invoice_url ||
        inv.web_app_invoice_url ||
        "",
      at: Date.now(),
      delivered: false,
    }),
  );
}
async function getInvoiceRec(env, id) {
  const raw = await env.BOT_KV.get("cpinv:" + id);
  return raw ? JSON.parse(raw) : null;
}
function makeCode(id) {
  let h = 0;
  const s = "cp" + id;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `CP-${id}-${h.toString(36).toUpperCase().padStart(6, "0")}`;
}
async function deliver(env, rec) {
  if (await env.BOT_KV.get("cppaid:" + rec.id)) return false; // 已发货，幂等跳过
  await env.BOT_KV.put("cppaid:" + rec.id, String(Date.now()));
  rec.delivered = true;
  rec.status = "paid";
  await env.BOT_KV.put("cpinv:" + rec.id, JSON.stringify(rec));
  await send(
    env,
    rec.chat,
    `🎉 支付成功！发票 #${rec.id}（${rec.amount} ${rec.cur}）已到账。\n\n你的兑换码：\n${makeCode(rec.id)}\n\n（演示货品：在 15/33 商店里把这段换成真实发货即可，见 README。）`,
  );
  return true;
}
// 查一次官方状态；发现 paid 且未发货就补发。Webhook 与轮询共用。
async function refreshInvoice(env, rec) {
  const list = await cpApi(
    env,
    "getInvoices",
    { invoice_ids: String(rec.id) },
    true,
  );
  const inv = Array.isArray(list) ? list[0] : null;
  if (!inv) return rec;
  if (inv.status && inv.status !== rec.status) {
    rec.status = inv.status;
    await env.BOT_KV.put("cpinv:" + rec.id, JSON.stringify(rec));
  }
  if (inv.status === "paid") await deliver(env, rec);
  return rec;
}

// Crypto Pay Webhook 入口：POST /cryptopay，验签后只处理 invoice_paid。
async function handleCryptoPayWebhook(request, env) {
  const body = await request.text();
  const ok = await verifyCryptoPay(
    env,
    body,
    request.headers.get("crypto-pay-api-signature"),
  );
  if (!ok) return new Response("bad signature", { status: 401 });
  let upd = {};
  try {
    upd = JSON.parse(body);
  } catch (e) {
    return new Response("bad json", { status: 400 });
  }
  if (upd.update_type === "invoice_paid" && upd.payload?.invoice_id) {
    const rec = await getInvoiceRec(env, upd.payload.invoice_id);
    if (rec) {
      rec.status = "paid";
      await deliver(env, rec);
    }
  }
  return new Response("ok");
}

// ============================================================
// 管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
// · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
// · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
// 于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
// 的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "invoice", description: "创建支付发票，如 /invoice 10 USDT" },
  { command: "invoices", description: "我的发票（查状态/补发货）" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "cpall", description: "全部发票（管理员）" },
];
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
// 三条路：/setWebhook 挂 TG、/webhook 收 TG 更新、/cryptopay 收 Crypto Pay 回调。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("crypto-pay bot is running.", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname === "/cryptopay" && request.method === "POST") {
      if (!env.CRYPTO_PAY_API_TOKEN)
        return new Response("CRYPTO_PAY_API_TOKEN 未配置", { status: 500 });
      if (!env.BOT_KV) return new Response("KV 未绑定", { status: 500 });
      return handleCryptoPayWebhook(request, env);
    }
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
// /invoice 建发票、/invoices 查我的、/cpall 管理员看全部；
// 回调 cp:check:<id> 是发票消息上的「刷新状态」按钮。
// ============================================================
const noConfig = (env, chatId) =>
  send(
    env,
    chatId,
    "⚠️ 还没配置 CRYPTO_PAY_API_TOKEN，无法创建发票。\n申请办法：打开 @CryptoBot → Crypto Pay → My Apps → Create App，把 Token 填进 Worker 的 Secret 变量 CRYPTO_PAY_API_TOKEN（见 README）。",
  );

async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (
      data.startsWith("cp:check:") &&
      env.BOT_KV &&
      env.CRYPTO_PAY_API_TOKEN
    ) {
      const rec = await getInvoiceRec(env, data.slice(9));
      if (!rec || String(rec.uid) !== String(cq.from.id)) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "发票不存在或不是你的",
        });
        return;
      }
      try {
        const fresh = await refreshInvoice(env, rec);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: fresh.delivered
            ? "✅ 已支付并发货"
            : `当前状态：${fresh.status}`,
        });
      } catch (e) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "查询失败，稍后再试",
        });
      }
      return;
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "💎 加密支付收款 Bot（Crypto Pay）\n\n/invoice 10 USDT 创建一张发票，点按钮去 @CryptoBot 付款，到账自动发货。\n/invoices 查看我的发票并刷新状态。\n\n支持币种：USDT / TON / BTC / ETH 等加密货币，或 USD / EUR 等法币计价。",
    );
  if (!env.BOT_KV)
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");

  if (cmd === "/invoice") {
    if (!env.CRYPTO_PAY_API_TOKEN) return noConfig(env, chatId);
    const parts = text.split(/\s+/).slice(1);
    const amount = parts[0];
    const cur = (parts[1] || "USDT").toUpperCase();
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
      return send(
        env,
        chatId,
        "用法：/invoice 金额 [币种]，如 /invoice 10 USDT 或 /invoice 9.9 USD",
      );
    const params = {
      amount: String(amount),
      description: `Bot 发票（用户 ${uid}）`,
      payload: JSON.stringify({ uid, chat: chatId }),
      allow_comments: false,
      allow_anonymous: false,
    };
    if (CRYPTO_ASSETS.includes(cur)) params.asset = cur;
    else if (FIATS.includes(cur)) {
      params.currency_type = "fiat";
      params.fiat = cur;
    } else
      return send(
        env,
        chatId,
        `不支持的币种 ${cur}。加密货币：${CRYPTO_ASSETS.join("/")}；法币：${FIATS.join("/")}。`,
      );
    try {
      const inv = await cpApi(env, "createInvoice", params);
      await saveInvoice(env, inv, uid, chatId);
      return send(
        env,
        chatId,
        `🧾 发票 #${inv.invoice_id}：${inv.amount} ${cur}\n点下面按钮完成支付，支付成功后自动发货。`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💳 去支付",
                  url:
                    inv.bot_invoice_url ||
                    inv.mini_app_invoice_url ||
                    inv.web_app_invoice_url,
                },
              ],
              [
                {
                  text: "🔄 刷新状态",
                  callback_data: `cp:check:${inv.invoice_id}`,
                },
              ],
            ],
          },
        },
      );
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 创建发票失败：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (cmd === "/invoices") {
    if (!env.CRYPTO_PAY_API_TOKEN) return noConfig(env, chatId);
    const list = await env.BOT_KV.list({ prefix: "cpinv:", limit: 1000 });
    const mine = [];
    for (const k of list.keys) {
      const rec = await getInvoiceRec(env, k.name.slice(6));
      if (rec && String(rec.uid) === String(uid)) mine.push(rec);
    }
    if (!mine.length)
      return send(env, chatId, "你还没有发票。/invoice 10 USDT 创建一张。");
    mine.sort((a, b) => b.at - a.at);
    const lines = [];
    for (const rec of mine.slice(0, 10)) {
      try {
        await refreshInvoice(env, rec);
      } catch (e) {
        // 单张刷新失败不中断列表
      }
      lines.push(
        `#${rec.id} · ${rec.amount} ${rec.cur} · ${rec.delivered ? "✅ 已发货" : rec.status}`,
      );
    }
    return send(
      env,
      chatId,
      "🧾 我的发票（已自动刷新状态）：\n" + lines.join("\n"),
    );
  }

  if (cmd === "/cpall") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 管理员命令。");
    const list = await env.BOT_KV.list({ prefix: "cpinv:", limit: 1000 });
    const all = [];
    for (const k of list.keys) {
      const rec = await getInvoiceRec(env, k.name.slice(6));
      if (rec) all.push(rec);
    }
    all.sort((a, b) => b.at - a.at);
    if (!all.length) return send(env, chatId, "暂无发票。");
    return send(
      env,
      chatId,
      "🧾 全部发票（最近 15 张）：\n" +
        all
          .slice(0, 15)
          .map(
            (r) =>
              `#${r.id} · ${r.amount} ${r.cur} · ${r.status}${r.delivered ? " · 已发货" : ""} · 用户 ${r.uid}`,
          )
          .join("\n"),
    );
  }
}
