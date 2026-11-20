// ============================================================
// 15 数字商品自动售货 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：管理员上架商品并导入库存（卡密/下载链接/账号，一行一条），
// 用户逛店下单 -> 按收款说明付款 -> 点「我已付款」-> 管理员按钮确认
// -> Bot 自动从库存弹出一条私聊发货。库存卖完自动显示售罄。
// 收款模式同 14：人工确认、Bot 不碰资金，只管订单与发货。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开
// PAYMENT_INFO 收款说明原文
// 选填：WEBHOOK_SECRET、SHOP_NAME（店名，默认「小店」）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（键：prod:<商品ID>、order:<订单号>）。
// 管理员命令（私聊 Bot）：
// /addproduct 商品名|价格文案 新建商品，返回商品 ID
// /addstock 商品ID 卡密内容 加一条库存（一行一条地发，可多发几次）
// /stock 商品ID 看某商品库存数
// /delproduct 商品ID 下架删除商品
// /orders 近期订单状态在 KV 的 order: 键里，本命令回订单数
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
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
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const adminChat = (env) => admins(env)[0];
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;

// ============================================================
// 【核心模块】商品与库存存储（KV）
// prod:<商品ID> = { name, price, stock:[库存条目...]}，发货就是从 stock 尾部 pop 一条。
// order:<订单号> = { user, name, pid, pname, price, status}，状态流同支付确认模块。
// ============================================================
async function getKV(env, key) {
  const raw = await env.BOT_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function putKV(env, key, val) {
  await env.BOT_KV.put(key, JSON.stringify(val));
}
async function listProducts(env) {
  const list = await env.BOT_KV.list({ prefix: "prod:", limit: 100 });
  const out = [];
  for (const k of list.keys) {
    const p = await getKV(env, k.name);
    if (p) out.push({ id: k.name.slice(5), ...p });
  }
  return out;
}

// ============================================================
// 【核心模块】支付确认与自动发货
// 管理员确认收款 -> 校验库存 -> pop 一条私聊发给买家；库存不足则拦截确认并提醒双方走退款。
// ============================================================
async function confirmAndDeliver(env, orderId, order) {
  const prod = await getKV(env, "prod:" + order.pid);
  if (!prod || !prod.stock.length)
    return {
      ok: false,
      error: "库存不足，无法发货（请勿确认，先补库存或拒绝订单走退款）",
    };
  const item = prod.stock.pop();
  await putKV(env, "prod:" + order.pid, prod);
  order.status = "done";
  order.delivered = item;
  await putKV(env, "order:" + orderId, order);
  await send(
    env,
    order.user,
    `🎉 收款确认，你的商品来了！\n\n📦 ${order.pname}\n🔑 内容：\n${item}\n\n请及时保存，售出内容一般不支持退换，有问题联系管理员。`,
  );
  return { ok: true };
}

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
  { command: "shop", description: "逛商店" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "addproduct", description: "上架商品（管理员）" },
  { command: "addstock", description: "补库存（管理员）" },
  { command: "stock", description: "查库存（管理员）" },
  { command: "orders", description: "订单数（管理员）" },
];
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
      return new Response("digital-shop bot is running.", {
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
// 买家流：逛店（shop:）-> 下单（buy:）-> 已付款（paid:）-> 管理员确认发货（payok:/payno:）；卖家流：上架/补库存命令。
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
  const shopName = env.SHOP_NAME || "小店";
  const cq = update.callback_query;
  if (cq) {
    const [act, arg] = String(cq.data || "").split(":");
    if (act === "buy") {
      const prod = await getKV(env, "prod:" + arg);
      if (!prod)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "商品不存在或已下架",
          show_alert: true,
        });
      if (!prod.stock.length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已售罄，等补货吧",
          show_alert: true,
        });
      const orderId = newId();
      await putKV(env, "order:" + orderId, {
        user: cq.from.id,
        name: who(cq.from),
        pid: arg,
        pname: prod.name,
        price: prod.price,
        status: "waitpay",
        t: Date.now(),
      });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(
        env,
        cq.message.chat.id,
        `🧾 订单 ${orderId}：${prod.name}（${prod.price}）\n\n💳 请按说明付款，付完点「✅ 我已付款」，管理员确认后自动发货到本对话：\n\n${env.PAYMENT_INFO || "（管理员未设置 PAYMENT_INFO）"}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ 我已付款", callback_data: `paid:${orderId}` }],
            ],
          },
        },
      );
    }
    if (act === "paid") {
      const order = await getKV(env, "order:" + arg);
      if (!order || order.user !== cq.from.id || order.status !== "waitpay")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单不存在或已提交过",
          show_alert: true,
        });
      order.status = "waitconfirm";
      await putKV(env, "order:" + arg, order);
      await tg(env, "sendMessage", {
        chat_id: adminChat(env),
        text: `💰 售货订单待确认\n订单号：${arg}\n买家：${order.name}\n商品：${order.pname}（${order.price}）\n核对收款后点确认，Bot 会自动发货：`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ 已收款，发货", callback_data: `payok:${arg}` },
              { text: "❌ 未收到，拒绝", callback_data: `payno:${arg}` },
            ],
          ],
        },
      });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已通知管理员",
      });
      return send(
        env,
        cq.message.chat.id,
        "⏳ 已提交，确认后商品会自动发到这里。",
      );
    }
    if (act === "payok" || act === "payno") {
      if (!isAdmin(env, cq.from.id))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能确认",
          show_alert: true,
        });
      const order = await getKV(env, "order:" + arg);
      if (!order || order.status !== "waitconfirm")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单状态不对或已处理",
          show_alert: true,
        });
      if (act === "payno") {
        order.status = "reject";
        await putKV(env, "order:" + arg, order);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已拒绝",
        });
        await send(
          env,
          order.user,
          `❌ 订单 ${arg} 未核对到收款，已取消。如已付款请把凭证发给管理员。`,
        );
      } else {
        const r = await confirmAndDeliver(env, arg, order);
        if (!r.ok)
          return tg(env, "answerCallbackQuery", {
            callback_query_id: cq.id,
            text: r.error,
            show_alert: true,
          });
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "✅ 已自动发货",
        });
      }
      return tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: act === "payok" ? "✅ 已发货" : "❌ 已拒绝",
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
  if (!msg || msg.chat.type !== "private") return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const userIsAdmin = isAdmin(env, msg.from.id);

  // ---------- 管理员卖家命令 ----------
  if (userIsAdmin && cmd === "/addproduct") {
    const m = text
      .replace(/^\/addproduct(@\w+)?\s*/, "")
      .split("|")
      .map((s) => s.trim());
    if (m.length < 2 || !m[0] || !m[1])
      return send(
        env,
        msg.chat.id,
        "用法：/addproduct 商品名|价格文案（如 /addproduct Netflix月卡|25 USDT）",
      );
    const pid = newId();
    await putKV(env, "prod:" + pid, { name: m[0], price: m[1], stock: [] });
    return send(
      env,
      msg.chat.id,
      `✅ 已上架「${m[0]}」，商品 ID：${pid}\n接着用 /addstock ${pid} 卡密内容 一条一条补库存。`,
    );
  }
  if (userIsAdmin && cmd === "/addstock") {
    const m = text.match(/^\/addstock\s+(\w+)\s+([\s\S]+)/);
    if (!m)
      return send(
        env,
        msg.chat.id,
        "用法：/addstock 商品ID 卡密内容（一次一条）",
      );
    const prod = await getKV(env, "prod:" + m[1]);
    if (!prod) return send(env, msg.chat.id, "商品 ID 不存在。");
    prod.stock.push(m[2].trim());
    await putKV(env, "prod:" + m[1], prod);
    return send(
      env,
      msg.chat.id,
      `✅ 「${prod.name}」库存 +1，现有 ${prod.stock.length} 条。`,
    );
  }
  if (userIsAdmin && cmd === "/stock") {
    const pid = text.split(/\s+/)[1];
    const prod = pid && (await getKV(env, "prod:" + pid));
    return send(
      env,
      msg.chat.id,
      prod
        ? `「${prod.name}」库存 ${prod.stock.length} 条。`
        : "用法：/stock 商品ID",
    );
  }
  if (userIsAdmin && cmd === "/delproduct") {
    const pid = text.split(/\s+/)[1];
    if (!pid) return send(env, msg.chat.id, "用法：/delproduct 商品ID");
    await env.BOT_KV.delete("prod:" + pid);
    return send(env, msg.chat.id, `已下架删除商品 ${pid}。`);
  }
  if (userIsAdmin && cmd === "/orders") {
    const list = await env.BOT_KV.list({ prefix: "order:", limit: 1000 });
    return send(
      env,
      msg.chat.id,
      `🧾 历史订单共 ${list.keys.length} 笔（明细在 KV 的 order: 键里）。`,
    );
  }

  // ---------- 买家逛店 ----------
  if (cmd === "/start" || cmd === "/shop") {
    const prods = await listProducts(env);
    if (!prods.length)
      return send(env, msg.chat.id, `🛍 ${shopName} 还没上架商品，稍后再来。`);
    const rows = prods.map((p) => [
      {
        text: `${p.name} · ${p.price} · ${p.stock.length ? "库存 " + p.stock.length : "售罄"}`,
        callback_data: `buy:${p.id}`,
      },
    ]);
    return send(
      env,
      msg.chat.id,
      `🛍 欢迎来到${shopName}，点商品即可下单（付款后管理员确认即自动发货）：`,
      { reply_markup: { inline_keyboard: rows } },
    );
  }
  if (text.startsWith("/"))
    return send(env, msg.chat.id, "发 /shop 看商品列表。");
}
