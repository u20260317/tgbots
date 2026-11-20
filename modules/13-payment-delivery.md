# 13 · 支付确认与自动发货模块

> 不接支付网关的人工确认流：用户下单 → 自行转账 → 点「我已付款」→ 管理员核对到账后点确认 → Bot 自动交付（发邀请链接开通会员 / 从库存弹一件卡密私聊发货）。14 会员和 15 售货共用这个骨架。

## 为什么是人工确认

个人 Bot 接不了合规的自动收款通道；人工确认把「钱」的环节留在人手里，Bot 只管订单状态机和交付动作，反而最稳。订单状态都存 KV：`order:` 记录从 pending → waitconfirm → done 的流转。

## 会员开通（摘自 14-paid-membership）

管理员确认后：生成一次性邀请链接、写会员到期时间（续费自动顺延）、通知用户。到期清理由 Cron 每天扫一遍（见 09 号模块）。

```js
async function grantMembership(env, orderId, order) {
  const link = await tg(env, "createChatInviteLink", {
    chat_id: env.TARGET_CHAT_ID,
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 48 * 3600,
    name: "vip" + order.user,
  });
  if (!link.ok)
    return { ok: false, error: link.description || "邀请链接创建失败" };
  const prev = await getKV(env, "sub:" + order.user);
  const base = prev && prev.expires > Date.now() ? prev.expires : Date.now(); // 续费顺延
  const expires = base + order.days * 86400 * 1000;
  await putKV(env, "sub:" + order.user, {
    plan: order.plan,
    name: order.name,
    expires,
    chat: env.TARGET_CHAT_ID,
  });
  order.status = "done";
  await putKV(env, "order:" + orderId, order);
  await send(
    env,
    order.user,
    `🎉 收款确认，会员已开通！\n套餐：${order.planName}，有效期至 ${fmtDay(expires)}\n\n👇 你的专属一次性邀请链接（48 小时内点开加入，限你本人）：\n${link.result.invite_link}`,
  );
  return { ok: true };
}
```

## 卡密发货（摘自 15-digital-shop）

库存是 KV 里的数组，确认时弹出一件交付并落订单状态；库存为空直接拦截确认，先补货再发。

```js
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
```

## 注意点

- 确认按钮只认管理员（回调里 isAdmin），且订单状态不是 waitconfirm 时重复点无效——防手滑连点两次发两件货。
- 先落 KV 状态、再执行交付动作：动作失败（比如用户拉黑了 Bot 私聊发不出）时订单状态可查、可人工补发。
- 邀请链接设 `creates_join_request=false` + 单次有效，防转发扩散。
