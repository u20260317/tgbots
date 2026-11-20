# 24 · Telegram Stars 官方支付模块

> 平台内原生收银：sendInvoice（币种 XTR）→ 用户在 Telegram 里付 Stars → pre_checkout 复核 → successful_payment 到账 → 发货。官方文档明确：**数字商品和服务必须用 Stars**，这是合规的唯一通道；和模块 13 的人工确认流是两条路线（人工流适合线下转账场景，Stars 适合规模化自动交付）。

## 发账单

Stars 不需要 provider_token，金额单位就是 Stars 个数（整数）。

```js
// ============================================================
// 【核心模块】Stars 收银：开票 → 复核 → 到账发货 → 退款
// ============================================================
async function sendStarsInvoice(env, chatId, { orderId, title, desc, stars }) {
  return tg(env, "sendInvoice", {
    chat_id: chatId,
    title,
    description: desc,
    payload: orderId, // 自定义载荷，原样带回后续每一步，用订单号
    currency: "XTR",
    prices: [{ label: title, amount: stars }],
  });
}
```

## 付款前复核（10 秒内必须答复）

用户点付款后 Telegram 先发 pre_checkout_query：最后一次验单（订单存在、价格对、还有库存）的机会，超时或答 ok=false 都会取消付款。

```js
// update.pre_checkout_query 分支
const pcq = update.pre_checkout_query;
if (pcq) {
  const order = await getOrder(env, pcq.invoice_payload);
  const okOrder = !!order && order.status === "pending" && order.stars === pcq.total_amount && pcq.currency === "XTR";
  return tg(env, "answerPreCheckoutQuery", {
    pre_checkout_query_id: pcq.id,
    ok: okOrder,
    ...(okOrder ? {} : { error_message: "订单已失效或金额不符，请重新下单。" }),
  });
}
```

## 到账发货（幂等是关键）

successful_payment 可能因网络重试重复到达，发货必须按 telegram_payment_charge_id 幂等：先占坑再发货。

```js
// message.successful_payment 分支
const sp = msg.successful_payment;
if (sp) {
  const seen = await env.BOT_KV.get("paid:" + sp.telegram_payment_charge_id);
  if (!seen) {
    await env.BOT_KV.put("paid:" + sp.telegram_payment_charge_id, sp.invoice_payload);
    await deliverOrder(env, sp.invoice_payload, msg.from); // 订单→paid 并交付（模块 13/22 的交付动作）
  }
  return send(env, chatId, "✅ 付款成功，已发货。如未收到请联系客服并提供订单号。");
}
// 退款：tg(env, "refundStarPayment", { user_id, telegram_payment_charge_id })；Stars 退款后余额回用户，交付物需自行回收
```

## 注意点

- allowed_updates 不用额外加：pre_checkout_query 和 successful_payment 都走常规消息/更新通道，但 webhook 响应要快，复核逻辑别放重活。
- Stars 有平台抽成与提现规则（经 Fragment 换出），定价时把这部分成本算进去；费率以官方文档为准，别按传闻定价。
- 数字内容付费解锁（paid media）是 Stars 的另一形态：sendPaidMedia 直接卖图/视频，和本模块共用到账逻辑。
- 与模块 13 的取舍：金额小、量少、用户习惯转账 → 人工确认够用；要自动交付、卖数字商品 → 必须 Stars。
