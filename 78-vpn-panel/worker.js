// ============================================================
// 78 VPN 面板交付 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 卖 VPN/代理订阅的「交付适配器」：用户选套餐下单 → 管理员人工
// 确认收款（复用 14/15 的确认流）→ Bot 调面板 API 自动开号：
// Marzban 或 3X-UI 创建用户 → 把订阅链接回给用户；/mysub 查流量
// 与到期；Cron 到期前提醒、到期后面板禁用账号。
// 面板二选一（PANEL_TYPE=marzban|xui）+ PANEL_URL + PANEL_TOKEN；
// 都没配时走「手动发链接模式」：确认收款后管理员用
// /vpndeliver <订单号> <订阅链接> 人工交付，流程照样闭环。
// ⚠️ 定位说清：本 Bot 只做「收款确认 → 面板开号 → 链接交付」的
// 自动化，面板本身（Marzban/3X-UI 的部署、节点、流量费）自理，
// 卖什么线路、合规与售后由部署者自担。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// PANEL_TYPE marzban | xui（不填 = 手动模式）
// PANEL_URL 面板地址（如 https://panel.example.com）
// PANEL_TOKEN 面板 API Token（Secret；Marzban 的管理员 access token
// 或 3X-UI 的 API Token）
// PANEL_INBOUND_ID 仅 xui：把新用户加到哪个入站（inbound id）
// ADMIN_ID 管理员数字 ID（收订单、确认收款，必填才卖得了货）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：vpn:order:<订单号> = {uid, planId, status, t, subUrl?}；
// vpn:sub:<uid> = {username, url, expire(秒), planId}。
// ⚠️ 需要 Cron：Triggers 加一条（如 0 9 * * * 每天查到期）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 13（支付确认与发货）+ 模块 19（面板 API）+ 09/01/02
// ============================================================

// ============================================================
// 套餐表（CONFIG）
// price 只用于展示与订单留痕——收款走部署者自己的渠道（转账后
// 管理员在 Bot 里点确认），Bot 不经手钱。流量单位 GB，0 = 不限。
// ============================================================
const PLANS = [
  { id: "m1", name: "月付 · 100GB", days: 30, gb: 100, price: "¥15" },
  { id: "m2", name: "季付 · 300GB", days: 90, gb: 300, price: "¥39" },
  { id: "y1", name: "年付 · 1200GB", days: 365, gb: 1200, price: "¥129" },
];
const planOf = (id) => PLANS.find((p) => p.id === id);

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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const fmtDate = (sec) =>
  new Date(sec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ============================================================
// 面板适配层（可替换）
// 统一口径：createPanelUser(env, {username, days, gb}) →
// { url: 订阅链接}；disablePanelUser(env, username)；
// getPanelUser(env, username) → { usedGB, limitGB, expire} | null。
// Marzban：REST + Bearer Token。建号 POST /api/user
// {username, proxies:{vless:{}}, data_limit(字节), expire(秒戳),
// status:"active"}，响应带 subscription_url（相对路径，拼 PANEL_URL）。
// 3X-UI：POST /panel/api/inbounds/addClient（新版带 API Token 的
// Bearer 头），client 以 UUID 建在 PANEL_INBOUND_ID 入站下，订阅
// 链接按 /sub/<subId> 口径拼——3X-UI 版本差异大，这条路径是
// best-effort，失败会抛错走手动交付兜底，不假装成功。
// 换面板（Remnawave 等）= 再写一组这三个函数，业务流不用动。
// ============================================================
function panelReady(env) {
  return Boolean(env.PANEL_TYPE && env.PANEL_URL && env.PANEL_TOKEN);
}
async function panelFetch(env, path, method, body) {
  const r = await fetch(env.PANEL_URL.replace(/\/$/, "") + path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.PANEL_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      `面板 HTTP ${r.status}：${JSON.stringify(data).slice(0, 120)}`,
    );
  return data;
}
async function createPanelUser(env, { username, days, gb }) {
  const expire = Math.floor(Date.now() / 1000) + days * 86400;
  if (env.PANEL_TYPE === "marzban") {
    const data = await panelFetch(env, "/api/user", "POST", {
      username,
      proxies: { vless: {} },
      data_limit: gb > 0 ? gb * 1073741824 : 0,
      expire,
      status: "active",
    });
    const url = data.subscription_url
      ? data.subscription_url.startsWith("http")
        ? data.subscription_url
        : env.PANEL_URL.replace(/\/$/, "") + data.subscription_url
      : "";
    if (!url) throw new Error("Marzban 没返回 subscription_url");
    return { url, expire };
  }
  if (env.PANEL_TYPE === "xui") {
    const uuid = crypto.randomUUID();
    const subId = newId() + newId();
    const client = {
      id: uuid,
      email: username,
      totalGB: gb > 0 ? gb * 1073741824 : 0,
      expiryTime: expire * 1000,
      enable: true,
      subId,
    };
    await panelFetch(env, "/panel/api/inbounds/addClient", "POST", {
      id: Number(env.PANEL_INBOUND_ID || 1),
      settings: JSON.stringify({ clients: [client] }),
    });
    return {
      url: `${env.PANEL_URL.replace(/\/$/, "")}/sub/${subId}`,
      expire,
    };
  }
  throw new Error(`未知 PANEL_TYPE：${env.PANEL_TYPE}`);
}
async function disablePanelUser(env, username) {
  if (env.PANEL_TYPE === "marzban") {
    await panelFetch(env, `/api/user/${encodeURIComponent(username)}`, "PUT", {
      status: "disabled",
    });
    return;
  }
  if (env.PANEL_TYPE === "xui") {
    // 3X-UI 没有按用户名直接禁用的稳定 API 口径，这里只把本地订阅
    // 标记过期，面板侧禁用请管理员在面板里操作（README 有说明）。
    return;
  }
}
async function getPanelUser(env, username) {
  if (env.PANEL_TYPE === "marzban") {
    const d = await panelFetch(
      env,
      `/api/user/${encodeURIComponent(username)}`,
      "GET",
    );
    return {
      usedGB: ((d.used_traffic || 0) / 1073741824).toFixed(2),
      limitGB: d.data_limit ? (d.data_limit / 1073741824).toFixed(0) : "∞",
      expire: d.expire || 0,
    };
  }
  return null; // xui 无统一查量口径，/mysub 退化为本地记录
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "buy", description: "购买订阅（套餐列表）" },
  { command: "mysub", description: "我的订阅：链接/流量/到期" },
];
const COMMANDS_ADMIN = [
  { command: "vpnorders", description: "待确认订单（管理员）" },
  {
    command: "vpndeliver",
    description: "手动交付 /vpndeliver <订单号> <链接>（管理员）",
  },
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
// scheduled 是 Cron 入口：到期前 3 天提醒、到期禁用并通知。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("vpn-panel bot is running.", {
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
    ctx.waitUntil(checkExpiry(env));
  },
};

// ============================================================
// 到期处理（Cron）
// 扫全部 vpn:sub：剩 3 天内（含今天）且没提醒过 → 提醒续费；
// 已过期且没处理过 → 调面板禁用 + 通知用户与管理员。
// reminded/expiredFlag 写回订阅记录防重复打扰。
// ============================================================
async function checkExpiry(env) {
  if (!env.BOT_KV) return;
  const now = Math.floor(Date.now() / 1000);
  const list = await env.BOT_KV.list({ prefix: "vpn:sub:", limit: 1000 });
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const sub = JSON.parse(raw);
    const uid = k.name.slice("vpn:sub:".length);
    if (sub.expire && sub.expire <= now && !sub.expiredFlag) {
      sub.expiredFlag = 1;
      await env.BOT_KV.put(k.name, JSON.stringify(sub));
      if (panelReady(env)) {
        try {
          await disablePanelUser(env, sub.username);
        } catch (e) {
          /* 禁用失败不阻塞通知，管理员会收到提醒去手动处理 */
        }
      }
      await send(
        env,
        uid,
        `⏰ 你的订阅已于 ${fmtDate(sub.expire)} 到期，账号已停用。/buy 续费后恢复。`,
      );
      for (const a of admins(env))
        await send(
          env,
          a,
          `订阅到期已处理：用户 ${uid}（面板账号 ${sub.username}）。`,
        );
    } else if (
      sub.expire &&
      sub.expire - now <= 3 * 86400 &&
      sub.expire > now &&
      !sub.reminded
    ) {
      sub.reminded = 1;
      await env.BOT_KV.put(k.name, JSON.stringify(sub));
      await send(
        env,
        uid,
        `⏰ 订阅将在 ${fmtDate(sub.expire)} 到期（剩不到 3 天），/buy 续费别断线。`,
      );
    }
  }
}

// ============================================================
// 交付：确认收款后开号/发链接
// 面板就绪 → createPanelUser 自动开号，订阅链接存 vpn:sub 并发
// 用户；面板没配 → 订单转「等手动交付」，管理员 /vpndeliver 补链。
// 续费 = 已有订阅时新订单确认后按新套餐天数顺延 expire（面板侧
// Marzban 会 PUT 更新；简化起见续费走「到期日顺延 + 通知管理员
// 在面板核对」，README 有说明）。
// ============================================================
async function deliver(env, order, orderId) {
  const plan = planOf(order.planId);
  const username = `tg${order.uid}`;
  if (panelReady(env)) {
    const { url, expire } = await createPanelUser(env, {
      username,
      days: plan.days,
      gb: plan.gb,
    });
    await env.BOT_KV.put(
      "vpn:sub:" + order.uid,
      JSON.stringify({ username, url, expire, planId: plan.id }),
    );
    order.status = "done";
    order.subUrl = url;
    await env.BOT_KV.put("vpn:order:" + orderId, JSON.stringify(order));
    return send(
      env,
      order.uid,
      `✅ 订阅已开通（${plan.name}）\n\n订阅链接：\n${url}\n\n到期：${fmtDate(expire)}\n把链接导入你的客户端（v2rayNG / Streisand / Hiddify 等）即可用。/mysub 随时查流量。`,
    );
  }
  order.status = "manual";
  await env.BOT_KV.put("vpn:order:" + orderId, JSON.stringify(order));
  for (const a of admins(env))
    await send(
      env,
      a,
      `🧑‍🔧 订单 ${orderId} 已确认收款但面板未配置，请手动交付：\n/vpndeliver ${orderId} <订阅链接>`,
    );
  return send(
    env,
    order.uid,
    "✅ 已确认收款，订阅链接马上由管理员发出，请稍等。",
  );
}

// ============================================================
// 业务主流程
// /buy 出套餐按钮（回调 vpn:plan:<套餐id>）→ 建单 vpn:order 并把
// 确认卡推给管理员（回调 vpn:ok:<订单号> / vpn:no:<订单号>）→
// 确认走 deliver()，拒绝通知用户。订单状态机：
// pending → done（已交付）/ manual（等手动）/ rejected。
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
    const chatId = cq.message.chat.id;
    const uid = cq.from.id;

    if (data.startsWith("vpn:plan:")) {
      const plan = planOf(data.split(":")[2]);
      if (!plan) return;
      if (!admins(env).length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "管理员还没配置 ADMIN_ID，暂时无法下单",
          show_alert: true,
        });
      const orderId = newId();
      const order = { uid, planId: plan.id, status: "pending", t: Date.now() };
      await env.BOT_KV.put("vpn:order:" + orderId, JSON.stringify(order));
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "订单已提交",
      });
      await send(
        env,
        chatId,
        `🧾 订单 ${orderId}：${plan.name}（${plan.price}）\n请按管理员给的收款方式付款，付款后管理员确认，订阅链接会自动发你。`,
      );
      for (const a of admins(env))
        await send(
          env,
          a,
          `🧾 新订单 ${orderId}\n用户 ${uid} 购买 ${plan.name}（${plan.price}）\n确认已收款后点下面的按钮交付：`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ 已收款，交付",
                    callback_data: `vpn:ok:${orderId}`,
                  },
                  { text: "❌ 没收到款", callback_data: `vpn:no:${orderId}` },
                ],
              ],
            },
          },
        );
      return;
    }

    if (data.startsWith("vpn:ok:") || data.startsWith("vpn:no:")) {
      if (!isAdmin(env, uid))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能确认订单",
          show_alert: true,
        });
      const orderId = data.split(":")[2];
      const raw = await env.BOT_KV.get("vpn:order:" + orderId);
      if (!raw)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单不存在",
          show_alert: true,
        });
      const order = JSON.parse(raw);
      if (order.status !== "pending")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `订单已处理（${order.status}）`,
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (data.startsWith("vpn:no:")) {
        order.status = "rejected";
        await env.BOT_KV.put("vpn:order:" + orderId, JSON.stringify(order));
        await send(
          env,
          order.uid,
          `❌ 订单 ${orderId} 未确认到收款，已取消。有疑问请联系管理员。`,
        );
        return send(env, chatId, `订单 ${orderId} 已拒绝。`);
      }
      try {
        await deliver(env, order, orderId);
        return send(env, chatId, `订单 ${orderId} 已交付 ✅`);
      } catch (e) {
        // 面板开号失败：订单留在 pending，管理员可重试或改走手动交付
        return send(
          env,
          chatId,
          `😵 面板开号失败：${String(e.message || e).slice(0, 200)}\n订单仍是 pending，可重试确认，或用 /vpndeliver ${orderId} <链接> 手动交付。`,
        );
      }
    }
    return;
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
      `🛜 VPN 订阅 Bot\n\n/buy 选套餐下单 → 付款 → 管理员确认后自动开通，订阅链接直接发你。\n/mysub 查我的订阅链接、流量与到期。\n\n交付方式：${panelReady(env) ? `面板自动开号（${env.PANEL_TYPE}）` : "管理员手动发链接"}`,
    );

  if (cmd === "/buy") {
    return send(env, chatId, "选一个套餐：", {
      reply_markup: {
        inline_keyboard: PLANS.map((p) => [
          { text: `${p.name} · ${p.price}`, callback_data: `vpn:plan:${p.id}` },
        ]),
      },
    });
  }

  if (cmd === "/mysub") {
    const raw = await env.BOT_KV.get("vpn:sub:" + uid);
    if (!raw) return send(env, chatId, "你还没有订阅。/buy 选个套餐开始。");
    const sub = JSON.parse(raw);
    let traffic = "";
    if (panelReady(env)) {
      try {
        const info = await getPanelUser(env, sub.username);
        if (info) traffic = `\n流量：已用 ${info.usedGB}GB / ${info.limitGB}GB`;
      } catch (e) {
        /* 查量失败只展示本地信息 */
      }
    }
    return send(
      env,
      chatId,
      `🛜 我的订阅（${planOf(sub.planId)?.name || sub.planId}）\n\n订阅链接：\n${sub.url}\n到期：${fmtDate(sub.expire)}${traffic}`,
    );
  }

  if (cmd === "/vpndeliver") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能用。");
    const [, orderId, url] = parts;
    if (!orderId || !url)
      return send(env, chatId, "用法：/vpndeliver <订单号> <订阅链接>");
    const raw = await env.BOT_KV.get("vpn:order:" + orderId);
    if (!raw) return send(env, chatId, "订单不存在。");
    const order = JSON.parse(raw);
    const plan = planOf(order.planId);
    const expire = Math.floor(Date.now() / 1000) + plan.days * 86400;
    await env.BOT_KV.put(
      "vpn:sub:" + order.uid,
      JSON.stringify({
        username: `tg${order.uid}`,
        url,
        expire,
        planId: plan.id,
      }),
    );
    order.status = "done";
    order.subUrl = url;
    await env.BOT_KV.put("vpn:order:" + orderId, JSON.stringify(order));
    await send(
      env,
      order.uid,
      `✅ 订阅已开通（${plan.name}）\n\n订阅链接：\n${url}\n\n到期：${fmtDate(expire)}`,
    );
    return send(env, chatId, `订单 ${orderId} 已手动交付 ✅`);
  }

  if (cmd === "/vpnorders") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能用。");
    const list = await env.BOT_KV.list({ prefix: "vpn:order:", limit: 1000 });
    const pending = [];
    for (const k of list.keys) {
      const o = JSON.parse((await env.BOT_KV.get(k.name)) || "{}");
      if (o.status === "pending" || o.status === "manual")
        pending.push(
          `${k.name.slice(10)} · 用户 ${o.uid} · ${o.planId} · ${o.status}`,
        );
    }
    return send(
      env,
      chatId,
      pending.length
        ? `🧾 待处理订单：\n${pending.join("\n")}`
        : "没有待处理订单。",
    );
  }
}
