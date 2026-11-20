# 06 · 强制订阅校验模块

> 「先关注频道才能用」的门禁核心：逐个查用户在必订频道里的成员状态，没齐就发加入引导。03-force-subscribe 和两个组合装都靠它。

## 核心判定（摘自 03-force-subscribe）

```js
async function missingSubs(env, userId) {
  const missing = [];
  for (const [i, chat] of requiredChats(env).entries()) {
    const r = await tg(env, "getChatMember", {
      chat_id: chat,
      user_id: userId,
    });
    const st = r?.result?.status;
    if (
      !r.ok ||
      !["member", "administrator", "creator", "restricted"].includes(st)
    )
      missing.push({ chat, idx: i });
  }
  return missing;
}
```

判定要点：`member/administrator/creator` 算通过，`restricted`（受限成员）也算在群里；接口报错（Bot 不在那个频道、频道 ID 写错）一律按未加入处理，宁可拦错也不能放行假数据。

## 加入引导键盘

按未加入清单生成按钮：有公开链接的给 url 按钮直达，私有频道给不出链接就只提示文字；最后一行固定放「我已加入，点我验证」，点了重新跑一遍判定（回调 data 用 `check`）。

```js
function joinKeyboard(env, missing) {
  const rows = missing.map((m) => {
    const link = linkFor(env, m.chat, m.idx);
    return link
      ? [{ text: `➕ 加入 ${m.chat}`, url: link }]
      : [{ text: `请先加入 ${m.chat}`, callback_data: "noop" }];
  });
  rows.push([{ text: "✅ 我已加入，点我验证", callback_data: "check" }]);
  return { inline_keyboard: rows };
}
```

## 注意点

- Bot 必须在每个必订频道/群里（普通成员即可），否则 getChatMember 查不到。
- 私有频道需要邀请链接才能生成 url 按钮，模板里用 REQUIRED_LINKS 按顺序对应填。
- 群内守卫模式（新成员发言先验订阅）要配合删除消息+私聊引导，且 Bot 在群里需删消息权限；完整实现看 03 和 combos/combo-group-guard。
