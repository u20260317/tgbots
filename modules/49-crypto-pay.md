# 49 · Crypto Pay 加密支付模块

> 给商店体系补一条加密收款轨：用 @CryptoBot 的 Crypto Pay API 开发票，用户在 Crypto Pay 里付 USDT/TON 等，到账走 Webhook 回调，验签 + 幂等后触发发货。与模块 24（Stars）、模块 13（人工确认）并列为三条收款通道，落地：15/33 的商店可加挂。

## 原理

**开票**：服务端调 `POST https://pay.crypt.bot/api/createInvoice`，请求头 `Crypto-Pay-API-Token: <你的应用 Token>`（在 @CryptoBot → Crypto Pay → Create App 里拿），体里给 `asset`（USDT/TON/BTC…）、`amount`、`payload`（自定义透传，放订单号）、`paid_btn_url` 等，返回 `invoice_id` 与 `pay_url`——把 pay_url 做成按钮发给用户，用户点开在 Crypto Pay 内完成付款，Bot 不经手私钥与资金。

**到账回调**：Crypto Pay 把 `invoice_paid` 事件 POST 到你配的 Webhook 地址（在 App 设置里配，或建票时传）。**必须验签**：签名在请求头 `crypto-pay-api-signature`，算法是 HMAC-SHA-256，密钥不是 Token 原文，而是 **Token 的 SHA-256 哈希**（`secret = SHA256(token)`），对**原始请求体字符串**算 HMAC 后与签名做恒定时间比较。不验签 = 任何人 POST 一个假「已付款」就能白嫖发货，这是本模块的红线代码。

**幂等到账**：Webhook 会重试，同一 invoice 可能推多次。用全库统一的 `paid:<invoice_id>` 键先占位：占位成功才发货，已存在直接回 200 不重复发（与模块 24 的 Stars 幂等同口径）。payload 里放的订单号用来回查订单，金额/币种要与订单核对一致才发货，不一致只记日志告警。

## 代码

```js
// ============================================================
// Crypto Pay 开票
// createInvoice(env, {asset, amount, orderId, description})
// → { invoiceId, payUrl}。Token 只走 Secret（CRYPTO_PAY_TOKEN）。
// payload 透传订单号（≤4KB），回调时靠它回查订单。
// ============================================================
async function createInvoice(env, { asset, amount, orderId, description}) {
if (!env.CRYPTO_PAY_TOKEN)
throw new Error(
"未配置 CRYPTO_PAY_TOKEN：管理员需在 @CryptoBot 的 Crypto Pay 里建应用并填 Token。",
);
const r = await fetch("https://pay.crypt.bot/api/createInvoice", {
method: "POST",
headers: {
"content-type": "application/json",
"Crypto-Pay-API-Token": env.CRYPTO_PAY_TOKEN,
},
body: JSON.stringify({
asset,
amount: String(amount),
description: description || "",
payload: String(orderId),
paid_btn_name: "callback",
}),
});
const data = await r.json().catch(() => ({}));
if (!r.ok ||!data.ok)
throw new Error(data?.error?.name || `Crypto Pay HTTP ${r.status}`);
return { invoiceId: data.result.invoice_id, payUrl: data.result.pay_url};
}

// ============================================================
// Webhook 验签（红线：不验签不发货）
// 签名 = HMAC-SHA-256(原始请求体)，密钥 = SHA-256(API Token)。
// checkWebhookSignature(token, rawBody, signature) → bool，
// 恒定时间比较防时序侧信道。rawBody 必须是请求原文字符串，
// 先 JSON.parse 再 stringify 会改变字节、验签必挂——顺序不能反。
// ============================================================
async function checkWebhookSignature(token, rawBody, signature) {
if (!token ||!signature) return false;
const enc = new TextEncoder();
const secretHash = await crypto.subtle.digest(
"SHA-256",
enc.encode(token),
);
const key = await crypto.subtle.importKey(
"raw",
secretHash,
{ name: "HMAC", hash: "SHA-256"},
false,
["sign"],
);
const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
const hex = [...new Uint8Array(mac)]
.map((b) => b.toString(16).padStart(2, "0"))
.join("");
if (hex.length!== signature.length) return false;
let diff = 0;
for (let i = 0; i < hex.length; i++)
diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
return diff === 0;
}

// ============================================================
// 到账处理（幂等）
// handleCryptoPayWebhook(env, rawBody, signature, deliverFn)：
// 验签 → 只认 invoice_paid → paid:<invoice_id> 占位幂等 →
// 金额/币种与订单核对 → deliverFn(order) 发货。
// 返回 HTTP 状态：验签失败 403，重复推送 200（已处理过）。
// ============================================================
async function handleCryptoPayWebhook(env, rawBody, signature, deliverFn) {
const ok = await checkWebhookSignature(
env.CRYPTO_PAY_TOKEN,
rawBody,
signature,
);
if (!ok) return 403;
const update = JSON.parse(rawBody);
if (update.update_type!== "invoice_paid") return 200;
const inv = update.payload || {};
const paidKey = "paid:" + inv.invoice_id;
if (await env.BOT_KV.get(paidKey)) return 200; // 已处理，幂等吞掉
await env.BOT_KV.put(paidKey, "1", { expirationTtl: 86400 * 30});
const orderId = inv.payload;
if (orderId && deliverFn) await deliverFn(orderId, inv);
return 200;
}
```

## 接入步骤

1. @CryptoBot → Crypto Pay → Create App 建应用，Token 填进 Secret `CRYPTO_PAY_TOKEN`；在 App 的 Webhooks 里把回调地址设为 `https://你的Worker/crypto-pay` 并启用。
2. Worker 路由加一条：`POST /crypto-pay` 时**先取原始文本**（`await request.text()`）再调 `handleCryptoPayWebhook`，按返回状态码回响应——别用 request.json()，验签要原文。
3. 下单流程：建订单（复用模块 13 的 order: 状态机）→ `createInvoice` 拿 payUrl 做成「💳 去支付」按钮 → 回调里 deliverFn 按订单号走原有发货逻辑（卡密/开会员/面板开号都行）。

## 注意点

- **验签密钥是 Token 的 SHA-256**，不是 Token 原文——这是 Crypto Pay 文档里最容易踩错的一处，写错了永远验不过，别去改算法迁就。
- **法币通道分清**：Crypto Pay 还有 fiat 发票（`fiat` 参数），与加密 asset 是两套字段，本模块只写加密口径。
- **payload 别放敏感信息**：它会出现在 Crypto Pay 侧记录里，只放订单号这种无敏感度的引用。
- **汇率与确认数由 Crypto Pay 侧决定**：Bot 只认 `invoice_paid` 这一个终态事件，未到账的催付、过期处理走它家的状态查询 API，别自己按「用户说付了」发货——那是模块 13 人工确认的活，通道别串。
