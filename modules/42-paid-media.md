# 42 · 付费媒体模块

> 用 Stars 直接卖图卖视频：Bot 发一条「付费媒体」消息，用户在 Telegram 里付星星解锁，没付钱看到的是打码预览，付了当场变高清。这是模块 24（Stars 支付）的媒体专用形态——官方为数字内容准备的正规卖法。

## 原理

`sendPaidMedia` 和普通 sendPhoto 的区别在参数：多一个 `star_count`（价格，单位 Stars）和 `payload`（自定义载荷）。用户点开媒体 → 客户端弹出 Stars 付款 → 付成功后 Bot 收到一条带 `successful_payment` 的消息，其中 `paid_media_payload` 就是你埋的 payload，`telegram_payment_charge_id` 是这笔交易的唯一号。

和模块 24 的分工：24 是通用收银（开票、复核、到账、退款），本模块只管媒体这一头：

- **到账确认共用 24 的幂等逻辑**：先查 `paid:<charge_id>` 占坑再交付，重复到达不重复发货。
- **付费媒体没有 pre_checkout_query**：sendPaidMedia 的购买不走 sendInvoice 流程，没有付款前复核那一步，到账消息就是唯一凭证——所以 payload 里必须埋得下「谁买了什么」。
- **已购复看靠自己记账**：用户付费解锁的那条消息会永久留在他的聊天里可看；但要在「商品页」里给已购用户一个随时重看的入口，就得 Bot 自己存购买关系（KV `own:`），重看时直接用普通 sendPhoto/sendVideo 把原文件再发一份，不再收费。

商品目录存 KV `media:<商品ID>` = `{ title, price, kind: "photo"|"video", fileId, desc}`，上架就是管理员发图/视频给 Bot 时落一条记录。

## 代码

```js
// ============================================================
// 付费媒体商品存储（KV）
// media:<商品ID> = { title, price(Stars), kind, fileId, desc}
// fileId 是源文件的 Telegram file_id（管理员上架时从消息里取），
// 付费发送和已购复看都用它，源文件不用在 Bot 侧存第二份。
// ============================================================
async function getMediaItem(env, id) {
const raw = await env.BOT_KV.get("media:" + id);
return raw? JSON.parse(raw): null;
}
async function putMediaItem(env, id, item) {
await env.BOT_KV.put("media:" + id, JSON.stringify(item));
}

// ============================================================
// 购买关系存储（KV）
// own:<用户ID>:<商品ID> = { chargeId, ts}
// 查得到 = 已购：商品页按钮变「再次查看」，购买回调直接拒。
// ============================================================
async function ownsMedia(env, userId, id) {
return!!(await env.BOT_KV.get(`own:${userId}:${id}`));
}
async function grantMedia(env, userId, id, chargeId) {
await env.BOT_KV.put(`own:${userId}:${id}`, JSON.stringify({ chargeId, ts: Date.now()}));
}

// ============================================================
// 发送付费媒体
// media 数组可混排多张图/多个视频（相册式付费包），每项
// { type, media: file_id}。payload 埋 "<商品ID>" 即可，
// 买家身份从到账消息的 from 里取，不用埋用户 ID。
// caption 会显示在打码预览下方，是唯一的推销位，认真写。
// ============================================================
async function sendPaidItem(env, chatId, id) {
const item = await getMediaItem(env, id);
if (!item) return send(env, chatId, "这个商品已下架。");
return tg(env, "sendPaidMedia", {
chat_id: chatId,
star_count: item.price,
media: [{ type: item.kind, media: item.fileId}],
payload: id,
caption: `🔒 ${item.title}\n${item.desc || ""}\n解锁价格：${item.price} ⭐`,
});
}

// ============================================================
// 到账交付（successful_payment 分支）
// sp.paid_media_payload 有值 = 这是付费媒体的到账（普通 Stars
// 订单走 24 号的 invoice_payload，两条线在一个分支里分流）。
// 幂等：先查 paid:<chargeId>（24 号注册的键），占坑后再发权益。
// ============================================================
async function onPaidMediaPayment(env, msg) {
const sp = msg.successful_payment;
const id = sp.paid_media_payload;
if (!id) return; // 不是付费媒体，交给 24 号通用逻辑
const seen = await env.BOT_KV.get("paid:" + sp.telegram_payment_charge_id);
if (seen) return; // 重复到达，已交付过
await env.BOT_KV.put("paid:" + sp.telegram_payment_charge_id, "media:" + id);
await grantMedia(env, msg.from.id, id, sp.telegram_payment_charge_id);
const item = await getMediaItem(env, id);
return send(env, msg.chat.id, `✅ 已解锁「${item?.title || id}」，在商品页点「再次查看」随时能重看。`);
}

// ============================================================
// 已购复看（回调 pmedia:view:<商品ID>）
// 先验购买关系，再用普通发送把原文件直发一份——不再走
// sendPaidMedia，所以不会再弹付款。未购用户点到只回执提示。
// ============================================================
async function onViewOwned(env, cq, id) {
if (!(await ownsMedia(env, cq.from.id, id)))
return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "还没购买，先解锁才能看", show_alert: true});
const item = await getMediaItem(env, id);
await tg(env, "answerCallbackQuery", { callback_query_id: cq.id});
const method = item.kind === "video"? "sendVideo": "sendPhoto";
return tg(env, method, { chat_id: cq.message.chat.id, [item.kind]: item.fileId, caption: item.title});
}
```

商品页的按钮按购买状态分叉：未购 → 「⭐ 购买」回调 `pmedia:buy:<id>`（处理就是调 sendPaidItem 在当前聊天发付费消息）；已购 → 「👀 再次查看」回调 `pmedia:view:<id>` 走上面的复看逻辑。

## 接入步骤

1. KV 绑定 `BOT_KV`，与模块 24 共用同一命名空间（`paid:` 幂等键两边共用，别拆开）。
2. 上架入口（管理员）：私聊给 Bot 发图/视频并带标题和价格（或走 FSM 向导，见 20 号），取消息里的 file_id 落 `media:` 记录；商品 ID 用短随机串。
3. 商品页/目录里每个商品挂按钮，未购/已购按 `ownsMedia` 分叉渲染（见代码后说明）。
4. handle() 的 `successful_payment` 分支里，先判 `paid_media_payload` 走本模块，否则走 24 号通用订单逻辑。

## 注意点

- 付费媒体的预览图是 Telegram 自动打码生成的，源文件别用「预览即正片」的构图（比如文字全在中间），打码挡不住多少，该防的是这种误判。
- 退款走 24 号的 `refundStarPayment`（user_id + charge_id）；退完记得删 `own:` 购买关系，不然退了钱还能复看。
- Stars 价格是整数星星，没有小数；定价前按 24 号的提醒把平台抽成和提现成本算进去。
- file_id 与 Bot 绑定（模块 08 的老规矩）：上架用的源消息别删、Bot 别换，否则已售商品发不出复看件——重要的源文件建议先转存一份到自己的存储频道（模块 10）再上架。
- 卖的内容必须是自己有权售卖的数字内容，盗版影视/课程不在本库的合规范围内（见 docs/SURVEY.md 排除清单）。
