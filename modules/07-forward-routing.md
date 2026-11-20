# 07 · 转发与回复路由模块

> 双向客服的命脉：用户消息转发给管理员，管理员「回复」那条转发，Bot 把回复送回用户。靠的是转发消息里携带的原发送者信息。

## 用户 → 管理员（摘自 02-two-way-support）

```js
  // 先发说明条（带 ID，兜底回复用），再转发原消息（保留原样、方便回复定位）
  await send(
    env,
    target,
    `💬 新消息 · 来自 ${describeUser(msg.from)}\n回复下面那条转发消息即可回他；认不出时用 /reply ${msg.from.id} 内容`,
  );
  const r = await tg(env, "forwardMessage", {
    chat_id: target,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
  });
  if (r.ok)
    await send(env, msg.chat.id, "✅ 已转达，管理员回复后会直接出现在这里。");
  else await send(env, msg.chat.id, "⚠️ 转达失败，请稍后再试。");
}

```

## 管理员 → 用户

管理员不需要记任何 ID：直接在 Telegram 里回复那条转发消息即可，Bot 从 `reply_to_message` 里认出原用户并投递。识别不到（比如对方隐藏了转发来源）时有兜底命令 `/reply <用户ID> <内容>`。

```js

  // ---------- 管理员侧 ----------
  if (fromAdmin) {
    // 1) 回复某条转发消息 -> 回给原用户
    if (msg.reply_to_message) {
      const uid = originUserId(msg.reply_to_message);
      // 回复的是 Bot 的说明条时，从说明文本里抠 ID
      const m2 =
        !uid && (msg.reply_to_message.text || "").match(/ID:\s*(\d{5,})/);
      const userId = uid || (m2 && m2[1]);
      if (userId) {
        const r = await tg(env, "copyMessage", {
          chat_id: userId,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        });
        return send(
          env,
          msg.chat.id,
          r.ok
```

## 注意点

- 用户在隐私设置里关了「转发链接到我的账号」时，转发消息不带原发送者，路由会失效——兜底方案是像 30-support-ticket 那样不用转发、改用自建工单卡片+映射表（KV 存 `tmap:` 消息对应关系），代价是多一层存储，好处是永远可路由。
- forwardMessage 会带「转发自」标记，想隐藏就用 copyMessage 代替（02 里管理员回复走的就是 copyMessage）。
- 管理员侧建议用一个专门的客服号或客服群，别用私人主号对所有人可见。
