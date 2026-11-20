# 22 · 商店目录与购物车模块

> 完整商店 Bot 的前台：分类目录 → 商品卡 → 购物车 → 结账。与 15 号「卡密直购机」的区别是这里有完整的电商链路；支付环节不在本模块，接模块 24（Stars）或模块 13（人工确认）。

## 数据模型

商品放 CONFIG 或 KV 都行（改价频繁用 KV `prod:<id>`）。购物车存 KV `cart:<用户ID>` = `{ 商品ID: 数量 }`，只存 ID 和数量，价格永远现查商品表——防改价后购物车按旧价结算。

```js
const PRODUCTS = [
  { id: "p1", cat: "课程", name: "剪辑入门课", price: 99, desc: "24 节视频课", stock: 100 },
  { id: "p2", cat: "课程", name: "直播运营课", price: 199, desc: "12 节直播课", stock: 50 },
  { id: "p3", cat: "素材", name: "封面模板包", price: 29, desc: "200 张 PSD", stock: 999 },
];
const prodOf = (id) => PRODUCTS.find((p) => p.id === id);
async function getCart(env, uid) {
  const raw = await env.BOT_KV.get("cart:" + uid);
  return raw ? JSON.parse(raw) : {};
}
async function setCart(env, uid, cart) {
  await env.BOT_KV.put("cart:" + uid, JSON.stringify(cart));
}
function cartTotal(cart) {
  return Object.entries(cart).reduce((s, [id, n]) => s + (prodOf(id)?.price || 0) * n, 0);
}
```

## 商品卡与购物车按钮

回调前缀：`shop:` 逛店导航、`cart:` 购物车操作。商品卡带加购按钮；购物车视图逐项带 +/−/删，底部合计与结账按钮。

```js
function productCard(env, chatId, p) {
  return send(env, chatId, `🛍 ${p.name}\n${p.desc}\n价格：${p.price} 元 · 库存 ${p.stock}`, {
    reply_markup: { inline_keyboard: [[
      { text: "➕ 加入购物车", callback_data: `cart:add:${p.id}` },
      { text: "🛒 看购物车", callback_data: "cart:view" },
    ]] },
  });
}
async function cartView(env, chatId, uid) {
  const cart = await getCart(env, uid);
  const items = Object.entries(cart);
  if (!items.length) return send(env, chatId, "购物车是空的，去逛逛 /shop 吧。");
  const lines = items.map(([id, n]) => { const p = prodOf(id); return `${p.name} ×${n} = ${p.price * n} 元`; });
  const kb = items.map(([id]) => [
    { text: "➖", callback_data: `cart:dec:${id}` },
    { text: prodOf(id).name, callback_data: "cart:noop" },
    { text: "➕", callback_data: `cart:add:${id}` },
    { text: "🗑", callback_data: `cart:rm:${id}` },
  ]);
  kb.push([{ text: `🧾 结账（合计 ${cartTotal(cart)} 元）`, callback_data: "cart:checkout" }]);
  return send(env, chatId, "🛒 你的购物车\n\n" + lines.join("\n"), { reply_markup: { inline_keyboard: kb } });
}
```

## 回调分发（节选）

```js
if (data.startsWith("cart:")) {
  const [, act, pid] = data.split(":");
  const cart = await getCart(env, cq.from.id);
  if (act === "add") cart[pid] = (cart[pid] || 0) + 1;
  if (act === "dec") { cart[pid] = (cart[pid] || 1) - 1; if (cart[pid] <= 0) delete cart[pid]; }
  if (act === "rm") delete cart[pid];
  await setCart(env, cq.from.id, cart);
  // view/checkout 分别走 cartView 与结账向导（模块 20 的 FSM：确认清单→收货信息→支付）
}
```

## 注意点

- 库存校验放在**下单时**而不是加购时：加购只是意向，下单预留、支付超时释放、支付成功实扣，扣减带订单号幂等键，防超卖（KV 无事务，这是商店最容易翻车处）。
- 结账是多步流程，用模块 20 的 FSM 承载；支付成功事件是发货的唯一触发源，重复到达靠 charge/order 幂等去重。
- 订单状态机与店主后台复用模块 10 的审核流按钮形态（推进状态、双向通知）。
- 增值件（促销码、钱包余额、心愿单补货提醒）等主链路跑通后再加，别一上来全塞进 v1。
