# 06 · 支付与变现

## 本篇讲什么

在 Telegram 里收钱的两条正规路线——Stars（平台内货币）与传统支付通道——各自的流程、适用边界、幂等与退款，以及数字商品为什么必须走 Stars 这条合规线。

## 核心概念

### 路线一：Telegram Stars（XTR）

Stars 是 Telegram 的平台内货币：用户用真实货币买 Stars，在 Bot 里花 Stars 买数字商品/服务。特点：

- **数字商品与服务必须用 Stars** 支付，这是官方政策（以官方文档为准），不要试图用其他通道绕。
- 开票用 `sendInvoice`，币种填 `XTR`，**不需要 provider_token**，金额就是 Stars 个数（整数）。
- 平台会抽成，Stars 需经官方渠道（如 Fragment）兑换变现，费率与规则以官方文档为准。
- 变现形态不止发票：`sendPaidMedia` 付费解锁图/视频、Stars 订阅（周期性扣费的会员）都是同一货币体系。

### Stars 全流程（状态机视角）

1. **sendInvoice**：带上你自定义的 `payload`（放订单号），这是后续每一步对单的凭据。
2. **pre_checkout_query**：用户点付款后、真正扣款前，平台来问你「这单还能付吗」。**必须在约 10 秒内**用 answerPreCheckoutQuery 回答（以官方文档为准），这里做最后校验：订单存在、金额一致、还有库存。不过或超时，付款自动取消。
3. **successful_payment**：扣款成功，信息随 message 到达，含 `telegram_payment_charge_id`（平台交易号）和你原样的 payload。**发货只认这个事件**，且必须按 charge_id 幂等——网络重试会让它重复到达。
4. **退款**：`refundStarPayment` 按 user_id + charge_id 退，Stars 回用户账户；已交付的数字权益要你自己回收。

### 路线二：传统支付通道

卖**实物**或需要法币结算时走传统通道：接 Stripe、YooKassa 等 provider，在 BotFather 里换取 `provider_token` 填进 sendInvoice，币种用法币（USD、CNY 等），金额以最小货币单位计（分）。流程骨架与 Stars 相同（同样有 pre_checkout 与 successful_payment），多出 shipping_query（运费选项）等实物环节。注意各 provider 的可用地区与结算规则，以官方与 provider 文档为准。

### 人工确认：第三条「非正式」路线

用户线下转账、管理员肉眼确认到账后点按钮发货（本库模块 13）。它不在 Bot API 支付体系内，没有平台担保与自动对账，胜在零接入成本。适合小额、低频、熟人场景；要规模化、自动交付，就迁到 Stars。

## 实操要点

1. 订单先落库再开票：payload 里的订单号是全流程的锚，任何一步都凭它对单。
2. 发货动作与「标记已发货」做成一个幂等单元：先占坑（记录 charge_id）再交付，重复事件直接跳过。
3. 金额校验放在 pre_checkout 做最后一道：比对订单金额与 pcq.total_amount，不一致就拒绝并给出 error_message。
4. 退款政策提前写进商品说明：数字商品退 Stars 不退权益之外的东西，避免纠纷时无据可依。

## 常见坑

- **pre_checkout 超时**：在复核里做了慢查询或等了别的 API。复核只读本地订单状态，毫秒级返回。
- **重复发货**：没做 charge_id 幂等，重试一到就发第二份。先查 `paid:<charge_id>` 再发货。
- **拿线下转账卖数字商品还挂在 Bot 里收款引导**：与 Stars 政策冲突的风险自担，平台规则以官方文档为准。
- **金额单位搞错**：传统通道是最小单位（100 = 1 元），Stars 是整数个。混了就是 100 倍事故。

## 在本库里看哪里落地

- Stars 完整实现：[modules/24 Stars 官方支付](../../modules/24-stars-payment.md)。
- 人工确认流：[modules/13 支付确认与自动发货](../../modules/13-payment-delivery.md)、模板 14（会员）/15（售货）。
- 支付前的购物车与结账：[modules/22 商店目录与购物车](../../modules/22-shop.md)。
- Stars 之外的加密支付（Crypto Pay 发票/Webhook 验签、TON 概念、四条路线选型）：[15 加密支付](15-crypto-payments.md)，实现看 [modules/49 Crypto Pay](../../modules/49-crypto-pay.md) 与模板 62。
