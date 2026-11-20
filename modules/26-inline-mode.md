# 26 · Inline 模式模块

> 在任何聊天里输入 `@你的Bot 关键词`，Bot 直接在输入框上方弹出结果卡片，点一张就发到当前聊天——不用先打开 Bot，也不用加进群。

## 原理

Inline 模式是 Bot API 的一种特殊更新类型：用户在任意对话的输入框里 @ 出 Bot 并打字，Telegram 把每个字都以 `inline_query` 更新发给 Bot；Bot 用 `answerInlineQuery` 回一列结果卡片（文章、图片、视频等），用户点中哪张，Telegram 就代他把那张的内容发进当前聊天。Bot 全程不在那个聊天里，所以拿不到 chat_id，只有发起查询的用户信息。

结果卡片最常用的是 `article` 型：标题 + 描述 + 一段点击后要发出的文本（`input_message_content`）。搜索、查价、查词、发固定话术，都是这一张卡的变体。

## 代码

```js
// ============================================================
// 【核心模块】Inline 查询处理
// update.inline_query = { id, from, query, offset }
// 必须在几秒内 answerInlineQuery，慢了输入框就一直转圈最后空白。
// 结果 id 要在一次返回内唯一（≤64 字节）；offset 是分页游标，
// 本页给不满就把 next_offset 回传，Telegram 会带着它再查一次。
// ============================================================
async function handleInlineQuery(env, iq) {
  const q = (iq.query || "").trim();
  // 空查询时给默认推荐卡，别让用户对着空白框发呆
  const items = q
    ? await searchItems(env, q)
    : [{ title: "试试输入关键词搜索", text: "在任意聊天 @我 并输入关键词即可搜索。" }];
  const results = items.slice(0, 20).map((it, i) => ({
    type: "article",
    id: "r" + i + "_" + (it.id || i),
    title: it.title,
    description: it.desc || "",
    input_message_content: { message_text: it.text },
  }));
  return tg(env, "answerInlineQuery", {
    inline_query_id: iq.id,
    results,
    cache_time: 60, // 同一关键词 60 秒内走缓存，省接口调用
    is_personal: false, // 结果对所有人一样时设 false，缓存才有效
  });
}

// 业务搜索函数自己实现：查 KV、调外部 API 都行，返回 [{id, title, desc, text}]
async function searchItems(env, q) {
  const out = [];
  out.push({ title: "关于「" + q + "」", text: "🔍 " + q + "\n（示例结果，换成你的数据源）" });
  return out;
}
```

## chosen_inline_result：知道用户点了哪张

用户点选某张卡后，如果在 BotFather 里开了反馈（/setinlinefeedback），Bot 会再收到一条 `chosen_inline_result` 更新，带 `result_id` 和原始 `query`——这是 Inline 模式唯一的「点击统计」来源，想知道哪张卡最受欢迎就靠它计数。分发方式和普通更新一样，在 handle() 里加一个 `update.chosen_inline_result` 分支即可。

## 接入步骤

1. BotFather：`/setinline` 给 Bot 开 Inline 模式（会让你填占位提示文字），需要统计点击再开 `/setinlinefeedback`。
2. webhook 的 `allowed_updates` 加上 `"inline_query"`（开反馈再加 `"chosen_inline_result"`），漏了永远收不到。
3. handle() 里加分支：`if (update.inline_query) return handleInlineQuery(env, update.inline_query);`

## 注意点

- Inline 里没有「当前聊天」的概念：不能主动给那个聊天发消息、不能查成员，只能回卡片。
- 结果文本就是普通消息，可以带按钮（reply_markup 挂在卡片定义里），按钮回调会回到 Bot 私聊逻辑里处理。
- cache_time 设太长，数据源更新了用户还看到旧结果；带个人数据（比如「我的收藏」）时必须 `is_personal: true`，否则会串号给别人看。
- 图片型卡片（type: "photo"）要给公网可达的 photo_url，Telegram 会去抓，内网地址和过期签名链接都会失败。
