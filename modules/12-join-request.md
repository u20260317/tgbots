# 12 · 入群申请审核模块

> 群开「申请制」后，新人加入要先过审。Bot 收到的是 `chat_join_request` 更新（allowed_updates 要显式加），三种模式：管理员按钮审核、自动通过、答题审核。

## 审核卡片（摘自 12-join-request）

把申请人的资料拼成一张卡片发给管理员，按钮带 `jr:ok:<用户ID>` / `jr:no:<用户ID>`：

```js
function reviewCard(env, chat, user, extraText) {
  return {
    chat_id: reviewChat(env),
    text: `🆕 入群申请\n群/频道：${chat.title || chat.id}（${chat.id}）\n申请人：${who(user)}${extraText ? "\n\n💬 他的回答：\n" + extraText : ""}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ 通过", callback_data: `jr:ok:${chat.id}:${user.id}` },
          { text: "❌ 拒绝", callback_data: `jr:no:${chat.id}:${user.id}` },
        ],
      ],
    },
  };
}
```

## 通过动作

调 approveChatJoinRequest 放行；静默模式下不打扰申请人，非静默会私聊告知（前提是对方先启动过 Bot，否则私聊发不出去——这是 Telegram 的硬限制，不是 bug）。

```js
async function approve(env, chatId, userId, silent) {
  const r = await tg(env, "approveChatJoinRequest", {
    chat_id: chatId,
    user_id: userId,
  });
  if (r.ok && !silent)
    await send(
      env,
      userId,
      env.WELCOME_TEXT ||
        "🎉 你的加入申请已通过，欢迎加入！回到群/频道即可开始使用。",
    );
  return r;
}
```

## 注意点

- Bot 必须是目标群管理员且有「邀请用户」权限，不然 approve/decline 都会被拒。
- 答题模式要把待审问题存 KV（`pending:`），申请人私聊答对了再放行；同样受「没启动过 Bot 就私聊不到」的限制，README 里要跟用户讲清。
- 自动模式适合熟人小群；公开群建议按钮审核，防广告号批量涌入。
