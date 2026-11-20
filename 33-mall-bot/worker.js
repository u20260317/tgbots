// ============================================================
// 33 商城 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// ⚠️⚠️⚠️ 风险提示（部署前必读）⚠️⚠️⚠️
// 本 Bot 是「母体 × 商店」的连锁商城：别人把自己 Bot 的 Token 交进来，
// 克隆出一家独立门面的连锁店。代管 Token 的风险与母体完全相同：
// · 店主 Token 一律 AES-GCM 加密后才存 KV，密钥 TOKEN_ENC_KEY 只放 Secret；
// · 任何界面/日志都不回显 Token 原文；店主随时可去 @BotFather /revoke 退出托管；
// · 🔴 红线：平台绝不代收代付——买家付款直达店主（本模板用人工确认流，
// 钱本来就不经平台手）；连锁店卖违禁品会牵连母体，总部保留一键熔断权，
// 入驻协议里要写明「经营责任归店主、平台有权停店」。
// 功能：
// 总部（平台管理员）：维护总部货源池（/hqadd），连锁店可一键上架（加价卖）；
// 店主：开店向导（选模式→交 Token→起店名→开通），门面是店主自己的 Bot；
// 买家在子 Bot 里逛店：目录（总部货源+店主自营）→购物车→下单→店主确认→发货。
// 必填变量：
// BOT_TOKEN 商城母体 Bot Token（Secret）
// TOKEN_ENC_KEY 加密密钥：32 字节随机数的 base64（Secret）
// ADMIN_ID 总部管理员数字 ID，多个英文逗号隔开
// 选填：
// WEBHOOK_SECRET 母体 Webhook 密钥
// MALL_MARKUP 总部货源默认加价百分比，默认 20
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：bot:<slug> 租户（店）记录；mall:prod:<ID> 总部货源池；
// fsm: 开店向导状态；t:<子BotID>: 店内数据前缀（prod:/cart:/order: 在其内）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 21（母体）+ 模块 22（商店）+ 模块 23（商城连锁）+ 模块 13（支付确认）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
// 统一封装 tg()：母体与子 Bot 共用，靠 env.BOT_TOKEN 区分身份。
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
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;
const randHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// ============================================================
// 租户 Token 加解密（AES-GCM）
// 与模块 21 同款：密钥只放 Secret，KV 只存密文。绝不回显/记录明文 Token。
// ============================================================
async function importKey(env) {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encToken(env, token) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  const pack = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return pack(iv.buffer) + "." + pack(ct);
}
async function decToken(env, enc) {
  const [ivB, ctB] = enc.split(".");
  const un = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await importKey(env);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: un(ivB) },
    key,
    un(ctB),
  );
  return new TextDecoder().decode(pt);
}
const maskToken = (t) => (t ? t.slice(0, 4) + "…" + t.slice(-4) : "");

// ============================================================
// 租户 KV 隔离（scopedKV）
// 店内数据（prod:/cart:/order:）经前缀包一层落到 t:<子BotID>: 下，
// 总部货源池 mall:prod: 在根 KV，两边互不污染（模块 21）。
// ============================================================
function scopedKV(kv, prefix) {
  return {
    get: (k, t) => kv.get(prefix + k, t),
    put: (k, v, o) => kv.put(prefix + k, v, o),
    delete: (k) => kv.delete(prefix + k),
    list: async (o = {}) => {
      const r = await kv.list({ ...o, prefix: prefix + (o.prefix || "") });
      return {
        keys: r.keys.map((k) => ({ ...k, name: k.name.slice(prefix.length) })),
        list_complete: r.list_complete,
        cursor: r.cursor,
      };
    },
  };
}

// ============================================================
// 通用状态机（FSM，开店向导用）
// fsm:<chatId>:<userId> = { step, data}，1 小时过期。
// ⚠️ 向导中 data 会短暂存店主刚发的 Token 明文，验真加密落库后即清。
// ============================================================
async function fsmGet(env, chatId, userId) {
  const raw = await env.BOT_KV.get(`fsm:${chatId}:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function fsmSet(env, chatId, userId, step, data = {}) {
  await env.BOT_KV.put(
    `fsm:${chatId}:${userId}`,
    JSON.stringify({ step, data, updatedAt: Date.now() }),
    { expirationTtl: 3600 },
  );
}
async function fsmClear(env, chatId, userId) {
  await env.BOT_KV.delete(`fsm:${chatId}:${userId}`);
}

// ============================================================
// 总部货源池（根 KV）
// mall:prod:<ID> = { name, price}：总部维护、连锁店一键上架，
// 店面价 = 批发价 ×(1+加价%) 向上取整。履约由总部负责（店主只管卖）。
// ============================================================
async function hqProducts(env) {
  const list = await env.BOT_KV.list({ prefix: "mall:prod:", limit: 500 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (raw)
      out.push({ id: k.name.slice("mall:prod:".length), ...JSON.parse(raw) });
  }
  return out;
}

// ============================================================
// 开店装配
// 验真 → slug/密钥 → 加密存租户（type=shop，config 带店名/模式/加价）→
// 代设子 Webhook → 给子 Bot 注册买家命令菜单。
// ============================================================
const SHOP_COMMANDS = [
  { command: "shop", description: "逛店" },
  { command: "cart", description: "购物车" },
  { command: "orders", description: "我的订单" },
  { command: "start", description: "店铺说明" },
];
async function onboardShop(env, origin, { token, owner, config }) {
  const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meResp.json().catch(() => ({}));
  if (!me.ok) return { error: "Token 无效（getMe 验真没过），检查后重发。" };
  const slug = randHex(8);
  const secret = randHex(12);
  const rec = {
    tokenEnc: await encToken(env, token),
    botId: me.result.id,
    username: me.result.username,
    type: "shop",
    owner,
    secret,
    config,
    stopped: false,
    at: Date.now(),
  };
  await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
  const hookResp = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${origin}/w/${slug}`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      }),
    },
  );
  const hook = await hookResp.json().catch(() => ({}));
  if (!hook.ok)
    return { error: "代设 Webhook 失败：" + (hook.description || "未知错误") };
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: SHOP_COMMANDS }),
  }).catch(() => {});
  return { slug, username: me.result.username };
}
async function getTenant(env, slug) {
  const raw = await env.BOT_KV.get("bot:" + slug);
  return raw ? JSON.parse(raw) : null;
}
async function listTenants(env, ownerId) {
  const list = await env.BOT_KV.list({ prefix: "bot:", limit: 1000 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    if (rec.type !== "shop") continue;
    if (ownerId && rec.owner !== ownerId) continue;
    out.push({ slug: k.name.slice(4), ...rec });
  }
  return out;
}

// ============================================================
// 子店内核（买家购物 + 店主管理）
// 租户视角：env.BOT_KV 已是租户前缀 KV；env.MALL_KV 是根 KV（读总部货源）。
// 目录 = 总部货源（mode 含 hq 时，店面价带加价）+ 自营商品（prod:）。
// 购物车 cart:<用户ID> 的键是 <src>:<商品ID>（src=hq/own）防两边 ID 撞车。
// 下单走人工确认：买家结账 → 订单 order:<ID> 待确认 → 店主在订单卡点
// payok/payno → 有卡密库存的自营商品自动弹一件私聊发货，其余提示人工发货。
// ============================================================
async function shopCatalog(env, rec) {
  const items = [];
  if (rec.config.mode !== "self") {
    const markup = Number(rec.config.markupPct) || 20;
    for (const p of await hqProducts(
      env.MALL_KV ? { BOT_KV: env.MALL_KV } : env,
    )) {
      items.push({
        key: "hq:" + p.id,
        name: p.name + "（总部货源）",
        price: Math.ceil(p.price * (1 + markup / 100)),
        src: "hq",
      });
    }
  }
  if (rec.config.mode !== "hq") {
    const list = await env.BOT_KV.list({ prefix: "prod:", limit: 500 });
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (raw) {
        const p = JSON.parse(raw);
        items.push({
          key: "own:" + k.name.slice(5),
          name: p.name,
          price: p.price,
          src: "own",
          stock: Array.isArray(p.stock) ? p.stock.length : p.stock,
        });
      }
    }
  }
  return items;
}
async function getCart(env, uid) {
  const raw = await env.BOT_KV.get("cart:" + uid);
  return raw ? JSON.parse(raw) : {};
}
async function cartView(env, rec, uid) {
  const cart = await getCart(env, uid);
  const catalog = await shopCatalog(env, rec);
  const byKey = Object.fromEntries(catalog.map((i) => [i.key, i]));
  const entries = Object.entries(cart).filter(([k]) => byKey[k]);
  if (!entries.length) return { text: "🛒 购物车是空的。发 /shop 逛逛。" };
  let total = 0;
  const lines = entries.map(([k, n]) => {
    const it = byKey[k];
    total += it.price * n;
    return `${it.name} ×${n} = ${it.price * n}`;
  });
  const kb = entries.map(([k]) => [
    { text: "➖", callback_data: `cart:dec:${k}` },
    { text: byKey[k].name.slice(0, 14), callback_data: "cart:noop" },
    { text: "➕", callback_data: `cart:add:${k}` },
    { text: "🗑", callback_data: `cart:rm:${k}` },
  ]);
  kb.push([
    { text: `🧾 结账（合计 ${total}）`, callback_data: "cart:checkout" },
  ]);
  return {
    text: "🛒 购物车\n\n" + lines.join("\n") + `\n\n合计：${total}`,
    reply_markup: { inline_keyboard: kb },
  };
}

async function shopKernel(env, update, rec) {
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    const chatId = cq.message.chat.id;
    if (data.startsWith("cart:")) {
      const [, act, src, pid] = data.split(":");
      const key = src && pid ? `${src}:${pid}` : null;
      const cart = await getCart(env, cq.from.id);
      if (act === "checkout") {
        const catalog = await shopCatalog(env, rec);
        const byKey = Object.fromEntries(catalog.map((i) => [i.key, i]));
        const entries = Object.entries(cart).filter(([k]) => byKey[k]);
        if (!entries.length)
          return tg(env, "answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "购物车是空的",
            show_alert: true,
          });
        const items = entries.map(([k, n]) => ({
          key: k,
          name: byKey[k].name,
          price: byKey[k].price,
          qty: n,
        }));
        const total = items.reduce((s, i) => s + i.price * i.qty, 0);
        const oid = newId();
        const order = {
          id: oid,
          buyer: cq.from.id,
          buyerName: who(cq.from),
          items,
          total,
          status: "waitconfirm",
          t: Date.now(),
        };
        await env.BOT_KV.put("order:" + oid, JSON.stringify(order));
        await env.BOT_KV.delete("cart:" + cq.from.id);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "🧾 订单已生成，等店主确认",
        });
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `🧾 订单 ${oid} 已提交（合计 ${total}）。\n付款方式请按店主说明转账，转账后等店主确认即发货。`,
        });
        await send(
          env,
          rec.owner,
          `🔔 新订单 ${oid}（${rec.config.shopName}）\n买家：${order.buyerName}\n${items.map((i) => `· ${i.name} ×${i.qty} = ${i.price * i.qty}`).join("\n")}\n合计：${total}\n\n确认收到款后点「确认收款并发货」。`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 确认收款并发货", callback_data: `payok:${oid}` },
                  { text: "❌ 取消订单", callback_data: `payno:${oid}` },
                ],
              ],
            },
          },
        ).catch(() => {});
        return;
      }
      if (act === "view") {
        const v = await cartView(env, rec, cq.from.id);
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
        return send(
          env,
          chatId,
          v.text,
          v.reply_markup ? { reply_markup: v.reply_markup } : {},
        );
      }
      if (!key)
        return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (act === "add") cart[key] = (cart[key] || 0) + 1;
      if (act === "dec") {
        cart[key] = (cart[key] || 1) - 1;
        if (cart[key] <= 0) delete cart[key];
      }
      if (act === "rm") delete cart[key];
      await env.BOT_KV.put("cart:" + cq.from.id, JSON.stringify(cart));
      const v = await cartView(env, rec, cq.from.id);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: v.text,
        ...(v.reply_markup ? { reply_markup: v.reply_markup } : {}),
      });
    }
    if (data.startsWith("shop:")) {
      const key = data.slice(5);
      const catalog = await shopCatalog(env, rec);
      const it = catalog.find((i) => i.key === key);
      if (!it)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "商品已下架",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(
        env,
        chatId,
        `🛍 ${it.name}\n价格：${it.price}${it.src === "own" && it.stock != null ? `\n库存：${it.stock}` : ""}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "➕ 加入购物车", callback_data: `cart:add:${it.key}` },
                { text: "🛒 看购物车", callback_data: "cart:view" },
              ],
            ],
          },
        },
      );
    }
    if (data.startsWith("payok:") || data.startsWith("payno:")) {
      if (cq.from.id !== rec.owner)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有店主能确认订单",
          show_alert: true,
        });
      const oid = data.split(":")[1];
      const raw = await env.BOT_KV.get("order:" + oid);
      if (!raw)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单不存在",
          show_alert: true,
        });
      const order = JSON.parse(raw);
      if (order.status !== "waitconfirm")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "订单已处理过了",
        });
      if (data.startsWith("payno:")) {
        order.status = "cancelled";
        await env.BOT_KV.put("order:" + oid, JSON.stringify(order));
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
        await send(
          env,
          order.buyer,
          `❌ 订单 ${oid} 已被店主取消，如已付款请联系店主处理。`,
        ).catch(() => {});
        return tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `订单 ${oid} 已取消。`,
        });
      }
      // 确认：自营商品有卡密库存的逐件弹出私聊发货
      order.status = "done";
      const delivered = [];
      for (const it of order.items) {
        if (!it.key.startsWith("own:")) continue;
        const pid = it.key.slice(4);
        const praw = await env.BOT_KV.get("prod:" + pid);
        if (!praw) continue;
        const p = JSON.parse(praw);
        if (Array.isArray(p.stock)) {
          for (let n = 0; n < it.qty && p.stock.length; n++)
            delivered.push(`${it.name}：${p.stock.shift()}`);
          await env.BOT_KV.put("prod:" + pid, JSON.stringify(p));
        }
      }
      await env.BOT_KV.put("order:" + oid, JSON.stringify(order));
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      await send(
        env,
        order.buyer,
        delivered.length
          ? `🎉 订单 ${oid} 已确认收款，自动发货：\n${delivered.join("\n")}\n（如含总部货源/实物商品，店主会另行发货。）`
          : `🎉 订单 ${oid} 已确认收款！店主会尽快为你发货，请留意私聊。`,
      ).catch(() => {});
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `订单 ${oid} 已确认并发货（自动发货 ${delivered.length} 件）。`,
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const isOwner = msg.from.id === rec.owner;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      `🏪 欢迎来到「${rec.config.shopName}」\n\n/shop 逛店 · /cart 购物车 · /orders 我的订单\n下单后按店主说明付款，店主确认即发货。${isOwner ? "\n\n— 店主命令 —\n/addprod 名称|价格 添加自营商品\n/addstock 商品ID 卡密 给商品补卡密库存\n/delprod 商品ID 下架\n/orders 查看待确认订单" : ""}`,
    );

  if (cmd === "/shop") {
    const catalog = await shopCatalog(env, rec);
    if (!catalog.length)
      return send(env, chatId, "店里还没上架商品，过会儿再来。");
    const kb = catalog
      .slice(0, 30)
      .map((i) => [
        { text: `${i.name} · ${i.price}`, callback_data: `shop:${i.key}` },
      ]);
    return send(env, chatId, `🏪 ${rec.config.shopName} · 商品目录`, {
      reply_markup: { inline_keyboard: kb },
    });
  }
  if (cmd === "/cart") {
    const v = await cartView(env, rec, msg.from.id);
    return send(
      env,
      chatId,
      v.text,
      v.reply_markup ? { reply_markup: v.reply_markup } : {},
    );
  }
  if (cmd === "/orders") {
    if (isOwner) {
      const list = await env.BOT_KV.list({ prefix: "order:", limit: 200 });
      const pending = [];
      for (const k of list.keys) {
        const raw = await env.BOT_KV.get(k.name);
        if (!raw) continue;
        const o = JSON.parse(raw);
        if (o.status === "waitconfirm") pending.push(o);
      }
      if (!pending.length) return send(env, chatId, "没有待确认订单。");
      return send(
        env,
        chatId,
        "🧾 待确认订单\n\n" +
          pending
            .map(
              (o) =>
                `· ${o.id} ${o.buyerName} 合计 ${o.total}（确认卡在下单时的通知消息上）`,
            )
            .join("\n"),
      );
    }
    const list = await env.BOT_KV.list({ prefix: "order:", limit: 200 });
    const mine = [];
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (!raw) continue;
      const o = JSON.parse(raw);
      if (o.buyer === msg.from.id) mine.push(o);
    }
    if (!mine.length) return send(env, chatId, "你还没有订单。/shop 去逛逛。");
    return send(
      env,
      chatId,
      "🧾 我的订单\n\n" +
        mine
          .slice(-10)
          .map(
            (o) =>
              `· ${o.id} 合计 ${o.total} 状态：${o.status === "done" ? "✅ 已完成" : o.status === "cancelled" ? "❌ 已取消" : "⏳ 待店主确认"}`,
          )
          .join("\n"),
    );
  }

  // ---------- 店主管理 ----------
  if (cmd === "/addprod") {
    if (!isOwner) return send(env, chatId, "⛔ 只有店主能加商品。");
    const body = text.replace(/^\/addprod(@\w+)?\s*/, "");
    const [name, priceStr] = body.split("|").map((s) => (s || "").trim());
    const price = Number(priceStr);
    if (!name || !price)
      return send(
        env,
        chatId,
        "用法：/addprod 名称|价格（如 /addprod 剪辑课|99）",
      );
    const pid = newId();
    await env.BOT_KV.put(
      "prod:" + pid,
      JSON.stringify({ name, price, stock: [] }),
    );
    return send(
      env,
      chatId,
      `✅ 已上架「${name}」（ID ${pid}，价格 ${price}）。\n数字商品用 /addstock ${pid} 卡密内容 逐件补卡密库存；实物/服务类不用补。`,
    );
  }
  if (cmd === "/addstock") {
    if (!isOwner) return send(env, chatId, "⛔ 只有店主能补库存。");
    const parts = text.split(/\s+/);
    const pid = parts[1];
    const item = text.slice(text.indexOf(pid) + pid.length).trim();
    const raw = pid && (await env.BOT_KV.get("prod:" + pid));
    if (!raw || !item)
      return send(env, chatId, "用法：/addstock 商品ID 卡密内容");
    const p = JSON.parse(raw);
    if (!Array.isArray(p.stock)) p.stock = [];
    p.stock.push(item);
    await env.BOT_KV.put("prod:" + pid, JSON.stringify(p));
    return send(env, chatId, `✅ 已补 1 件库存，当前共 ${p.stock.length} 件。`);
  }
  if (cmd === "/delprod") {
    if (!isOwner) return send(env, chatId, "⛔ 只有店主能下架。");
    const pid = text.split(/\s+/)[1];
    if (!pid) return send(env, chatId, "用法：/delprod 商品ID");
    await env.BOT_KV.delete("prod:" + pid);
    return send(env, chatId, "🗑 已下架。");
  }
}

// 子 Bot 分发：解密 Token → 租户 env（换 Token + 前缀 KV + 根 KV 引用）→ 跑子店内核。
async function dispatchTenant(env, rec, update) {
  let token;
  try {
    token = await decToken(env, rec.tokenEnc);
  } catch (e) {
    return;
  }
  const tenantEnv = {
    ...env,
    BOT_TOKEN: token,
    BOT_KV: scopedKV(env.BOT_KV, `t:${rec.botId}:`),
    MALL_KV: env.BOT_KV,
    TENANT: rec,
  };
  await shopKernel(tenantEnv, update, rec);
}

// ============================================================
// 管理员白名单与分级命令菜单
// 总部管理员（ADMIN_ID）的命令只出现在其私聊菜单里；原理同全库模块 02。
// ============================================================
const COMMANDS_USER = [
  { command: "open", description: "开一家连锁店" },
  { command: "mystores", description: "我的店铺" },
  { command: "cancel", description: "取消当前向导" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "hqadd", description: "总部货源上架（管理员）" },
  { command: "hq", description: "总部货源池（管理员）" },
  { command: "stores", description: "全部店铺（管理员）" },
  { command: "mstop", description: "熔断/恢复店铺（管理员）" },
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
// /setWebhook 挂载母体、/webhook 母体更新、/w/<slug> 子店更新分发。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("mall-bot is running.", {
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
    if (url.pathname.startsWith("/w/") && request.method === "POST") {
      if (!env.BOT_KV) return new Response("KV 未绑定", { status: 500 });
      const slug = url.pathname.slice(3);
      const rec = await getTenant(env, slug);
      if (!rec) return new Response("ok");
      if (request.headers.get("x-telegram-bot-api-secret-token") !== rec.secret)
        return new Response("forbidden", { status: 403 });
      if (rec.stopped) return new Response("ok");
      const update = await request.json().catch(() => ({}));
      ctx.waitUntil(dispatchTenant(env, rec, update));
      return new Response("ok");
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
    update.__origin = url.origin;
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};

// ============================================================
// 业务主流程（总部/母体侧）
// 开店向导 FSM：mode（按钮 mall:mode:*）→ token → name（店名）→
// confirm（mall:go）→ onboardShop。回调前缀 mall: 只管母体侧向导与店铺管理。
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
  const origin = update.__origin || "";

  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (!data.startsWith("mall:")) return;
    const chatId = cq.message.chat.id;
    const uid = cq.from.id;
    const parts = data.split(":");
    const act = parts[1];
    if (act === "mode") {
      const mode = parts[2];
      await fsmSet(env, chatId, uid, "token", { mode });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `已选模式：${mode === "hq" ? "总部货源" : mode === "self" ? "完全自营" : "混合（总部货源+自营）"}\n\n第 2 步：把你店铺 Bot 的 Token 发给我（@BotFather 拿）。\n\n⚠️ Token = 你店铺 Bot 的全部权限：会加密存储、绝不回显；你随时可去 @BotFather /revoke 退出托管。经营责任归你本人，卖违禁品总部会直接停店。\n不想继续发 /cancel。`,
      });
    }
    if (act === "go") {
      const st = await fsmGet(env, chatId, uid);
      if (!st || st.step !== "confirm")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "向导已过期，重新 /open",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⏳ 正在开店…",
      });
      const res = await onboardShop(env, origin, {
        token: st.data.token,
        owner: uid,
        config: {
          shopName: st.data.shopName,
          mode: st.data.mode,
          markupPct: Number(env.MALL_MARKUP) || 20,
        },
      });
      await fsmClear(env, chatId, uid);
      if (res.error)
        return tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `😵 开店失败：${res.error}`,
        });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `🎉 开店成功！「${st.data.shopName}」门面 Bot：@${res.username}\n去子 Bot 里发 /start 看店主命令（上架自营商品等）。\n管理：/mystores`,
      });
    }
    if (act === "stop" || act === "start" || act === "del") {
      const slug = parts[2];
      const rec = await getTenant(env, slug);
      if (!rec || (rec.owner !== uid && !isAdmin(env, uid)))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "不是你的店",
          show_alert: true,
        });
      if (act === "del") {
        const token = await decToken(env, rec.tokenEnc).catch(() => null);
        if (token)
          await fetch(
            `https://api.telegram.org/bot${token}/deleteWebhook`,
          ).catch(() => {});
        await env.BOT_KV.delete("bot:" + slug);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "🗑 已关店（Token 密文销毁）",
        });
      } else {
        rec.stopped = act === "stop";
        await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: rec.stopped ? "⏸️ 已停店" : "▶️ 已恢复",
        });
      }
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: "已更新。发 /mystores 看最新列表。",
      });
    }
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  if (msg.chat.type !== "private") return; // 开店/管理只在私聊（Token 不能进群）

  const st = await fsmGet(env, chatId, uid);
  if (st && cmd !== "/cancel" && cmd !== "/start") {
    if (st.step === "token") {
      const token = text;
      if (!/^\d{6,}:[\w-]{30,}$/.test(token))
        return send(
          env,
          chatId,
          "这不像 Token（格式应是 数字:一串字符）。从 @BotFather 复制完整的发我，或 /cancel 退出。",
        );
      const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const me = await meResp.json().catch(() => ({}));
      if (!me.ok)
        return send(
          env,
          chatId,
          "这个 Token 验真没过（getMe 失败），检查一下重发，或 /cancel 退出。",
        );
      st.data.token = token;
      st.data.username = me.result.username;
      await fsmSet(env, chatId, uid, "name", st.data);
      return send(
        env,
        chatId,
        `Token 验真通过：@${me.result.username}\n第 3 步：给你的店起个名字（直接发文字，如：小明的数码店）`,
      );
    }
    if (st.step === "name") {
      st.data.shopName = text.slice(0, 40);
      await fsmSet(env, chatId, uid, "confirm", st.data);
      return send(
        env,
        chatId,
        `核对一下：\n· 店名：${st.data.shopName}\n· 门面 Bot：@${st.data.username}\n· 模式：${st.data.mode}\n· Token：${maskToken(st.data.token)}（加密存储）\n· 总部货源加价：${Number(env.MALL_MARKUP) || 20}%\n\n确认开店？`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ 确认开店", callback_data: "mall:go" }],
            ],
          },
        },
      );
    }
    return send(env, chatId, "向导进行中，按提示操作，或 /cancel 退出。");
  }

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🏬 连锁商城 Bot\n\n交出你自己的 Bot Token，1 分钟克隆出一家独立门面的连锁店：总部提供系统、托管与货源池，你管经营和收款（钱直达你，不经平台手）。\n\n/open 开店 · /mystores 我的店铺\n总部货源在你的子 Bot 目录里自动上架（带加价），你也可以上架自营商品。",
    );

  if (cmd === "/open") {
    await fsmSet(env, chatId, uid, "mode", {});
    return send(env, chatId, "第 1 步：选经营模式", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏭 总部货源（选品加价卖，总部发货）",
              callback_data: "mall:mode:hq",
            },
          ],
          [
            {
              text: "🧺 混合（总部货源 + 自营）",
              callback_data: "mall:mode:mixed",
            },
          ],
          [
            {
              text: "🏠 完全自营（只卖自己的）",
              callback_data: "mall:mode:self",
            },
          ],
        ],
      },
    });
  }
  if (cmd === "/cancel") {
    await fsmClear(env, chatId, uid);
    return send(env, chatId, "已取消向导。");
  }
  if (cmd === "/mystores") {
    const mine = await listTenants(env, uid);
    if (!mine.length) return send(env, chatId, "你还没有店。/open 开一家。");
    for (const rec of mine) {
      await send(
        env,
        chatId,
        `🏪 「${rec.config.shopName}」 @${rec.username}\n模式：${rec.config.mode} · 状态：${rec.stopped ? "⏸️ 已停店" : "✅ 营业中"}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                rec.stopped
                  ? { text: "▶️ 恢复", callback_data: `mall:start:${rec.slug}` }
                  : { text: "⏸️ 停店", callback_data: `mall:stop:${rec.slug}` },
                { text: "🗑 关店", callback_data: `mall:del:${rec.slug}` },
              ],
            ],
          },
        },
      );
    }
    return;
  }

  // ---------- 总部管理（管理员） ----------
  if (cmd === "/hqadd") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有总部管理员能上架货源。");
    const body = text.replace(/^\/hqadd(@\w+)?\s*/, "");
    const [name, priceStr] = body.split("|").map((s) => (s || "").trim());
    const price = Number(priceStr);
    if (!name || !price)
      return send(
        env,
        chatId,
        "用法：/hqadd 名称|批发价（如 /hqadd 剪辑课批发|50）",
      );
    const pid = newId();
    await env.BOT_KV.put("mall:prod:" + pid, JSON.stringify({ name, price }));
    return send(
      env,
      chatId,
      `✅ 总部货源已上架「${name}」（ID ${pid}，批发价 ${price}）。各连锁店会自动带加价展示。`,
    );
  }
  if (cmd === "/hqdel") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有总部管理员能下架货源。");
    const pid = text.split(/\s+/)[1];
    if (!pid) return send(env, chatId, "用法：/hqdel 商品ID");
    await env.BOT_KV.delete("mall:prod:" + pid);
    return send(env, chatId, "🗑 已下架。");
  }
  if (cmd === "/hq") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有总部管理员能看货源池。");
    const pool = await hqProducts(env);
    if (!pool.length) return send(env, chatId, "货源池是空的。/hqadd 上架。");
    return send(
      env,
      chatId,
      "🏭 总部货源池\n\n" +
        pool.map((p) => `· ${p.name} 批发 ${p.price}（ID ${p.id}）`).join("\n"),
    );
  }
  if (cmd === "/stores") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有总部管理员能看。");
    const all = await listTenants(env, null);
    if (!all.length) return send(env, chatId, "还没有任何店铺。");
    return send(
      env,
      chatId,
      `🏬 全部店铺（${all.length}）\n\n` +
        all
          .slice(0, 30)
          .map(
            (r) =>
              `· 「${r.config.shopName}」@${r.username} 店主 ${r.owner} ${r.stopped ? "⏸️" : "✅"} slug=${r.slug}`,
          )
          .join("\n"),
    );
  }
  if (cmd === "/mstop") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有总部管理员能熔断。");
    const slug = text.split(/\s+/)[1];
    const rec = slug && (await getTenant(env, slug));
    if (!rec)
      return send(env, chatId, "用法：/mstop <slug>（slug 见 /stores）");
    rec.stopped = !rec.stopped;
    await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
    return send(
      env,
      chatId,
      `已${rec.stopped ? "熔断停店" : "恢复"}「${rec.config.shopName}」。`,
    );
  }
}
