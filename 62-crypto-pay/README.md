# 加密支付收款 Bot

用 Crypto Pay（@CryptoBot 官方支付系统）收加密货币：建发票 → 用户付款 → Webhook 验签 → 幂等自动发货，Webhook 丢了还有轮询兜底。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、CRYPTO_PAY_API_TOKEN*（Secret）、WEBHOOK_SECRET、ADMIN_ID（/cpall 用）、CRYPTO_PAY_API_BASE（选填）＋ 绑定 KV 变量名 BOT_KV（存发票与发货标记，不绑 KV 不能用）。

还要做两件平台侧配置：
1. **TG 侧**：部署后访问 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`。
2. **Crypto Pay 侧**：打开 @CryptoBot → Crypto Pay → My Apps → 选你的应用 → Webhooks，把 Webhook 地址填成 `https://你的Worker地址/cryptopay`。不填这一步就没有支付回调，只能靠 /invoices 轮询补发货。

## 申请 API Token
@CryptoBot → Crypto Pay → My Apps → Create App，创建后在应用页拿到 API Token，填进 Worker 的 Secret 变量 `CRYPTO_PAY_API_TOKEN`。没配 Token 时，/invoice 会直接回复申请办法，不会假装建票成功。测试网把 `CRYPTO_PAY_API_BASE` 设为 `https://testnet-pay.crypt.bot/api` 并使用测试网应用（@CryptoTestnetBot）的 Token。

## 玩法说明
- /invoice 10 USDT 创建发票（金额 + 币种；币种缺省 USDT）。加密货币：USDT/TON/BTC/ETH/LTC/BNB/TRX/USDC/DOGE；法币计价：USD/EUR/RUB/UAH/BYN/KZT/CNY/GBP/JPY（用户付款时 Crypto Pay 按汇率折算）。
- 发票消息带「💳 去支付」链接按钮（跳 Crypto Pay 付款页）和「🔄 刷新状态」按钮。
- 付款成功 → Crypto Pay 回调 /cryptopay → 验签（HMAC-SHA256，密钥为 Token 的 SHA-256 摘要，按官方算法）→ 发货（演示货品是一段兑换码）→ 用 `cppaid:<发票ID>` 标记防重复发货。
- /invoices 查看我的发票：逐张向官方 getInvoices 刷新状态，发现 paid 未发货立即补发——Webhook 丢失、被拦截都能兜底。
- /cpall（管理员）：全部发票最近 15 张。

## 嵌回商店当支付通道
本 Bot 是 15（数字商品商店）/33（商城）的加密支付通道，两种嵌法：
- **轻嵌**：商店下单后生成订单号，把金额拼成 /invoice 深链或直接在本 Bot 里调 `cpApi(env, "createInvoice", {...})`，`payload` 里塞商店订单号；发货函数 `deliver()` 里把「发兑换码」换成商店的发货逻辑（15 的弹库存/33 的订单置 paid），幂等标记沿用 `cppaid:` 换成订单号即可。
- **整拼**：把本文件的 Crypto Pay 客户端 + 验签 + /cryptopay 路由三块搬进商店 worker.js（回调前缀 `cp:` 已在全库注册表登记，不与商店的 `shop:`/`cart:`/`payok:` 冲突），KV 共用一个 BOT_KV 即可。

## 注意事项
- 金额在 API 里一律传字符串，避免浮点误差；法币发票的实际到账币种与数量以 Crypto Pay 结算为准。
- 验签必须用请求体原文：代码里 Webhook 入口先 `request.text()` 再验签、后解析 JSON，顺序别改。
- Crypto Pay 对发票有最小金额限制（按币种不同），太小会建票失败并把官方错误名回给你。

## 拼装来源
模块 24（Stars 支付幂等发货模式）+ 模块 19（外部 API 调用）+ 模块 01（骨架）。
