# 38 · 原生 Poll/Quiz 与消息反应模块

> 这一篇是「官方原生件」：投票用 Telegram 自带的 sendPoll（含 quiz 竞答模式），点赞用 setMessageReaction。定位写在前面——它们是模块 19（自研按钮投票）和模块 03（按钮回调）的**替代与增补**，不是升级：原生件零状态、规则固定；自研件能改票、能匿名、能自定义计票。按需求二选一，别混着用。

## 原理

**原生 Poll**：Bot 发一条 poll 消息，选项、计时、计票全由 Telegram 客户端和服务器完成，Bot 不存票。两种形态：

- 普通 poll：`type` 不填或 `"regular"`，可多选（allows_multiple_answers）、可匿名（is_anonymous）。
- Quiz 模式：`type: "quiz"` + `correct_option_id` 指明正确项，用户答完立刻知道对错，可附 `explanation` 解析——官方 @QuizBot 就是这么做的。

Bot 能拿到的回流有两路：`update.poll`（poll 状态变化，含各选项票数；非匿名且 Bot 是发起方时推送）和 `update.poll_answer`（某个用户具体选了什么，quiz 复盘和排行榜靠它）。两路都要在 setWebhook 的 allowed_updates 里显式加 `poll` / `poll_answer`，默认收不到。

**消息反应**：`setMessageReaction` 让 Bot 以自己身份给某条消息挂一个 emoji 反应（点赞的心意表达）。另有 `message_reaction` 更新：群里某条消息的反应发生变化时推送给 Bot（含新旧反应列表），Bot 是群管理员时才收得到，适合做「统计某条消息被点了多少赞」的被动计数。

## 代码

```js
// ============================================================
// 原生投票：普通票与 Quiz 竞答
// options 在新版 API 里是 InputPollOption 对象数组（{text}），
// 不是字符串数组，写错直接被 API 拒。question 上限 300 字，
// 选项 2–10 个、每个 ≤100 字。
// ============================================================
async function sendVotePoll(env, chatId, question, options, { anonymous = true} = {}) {
return tg(env, "sendPoll", {
chat_id: chatId,
question,
options: options.map((text) => ({ text})),
is_anonymous: anonymous,
allows_multiple_answers: false,
});
}

async function sendQuizPoll(env, chatId, { question, options, correct, explanation, seconds = 30}) {
return tg(env, "sendPoll", {
chat_id: chatId,
question,
options: options.map((text) => ({ text})),
type: "quiz",
correct_option_id: correct, // 从 0 数
explanation: explanation || undefined, // 答后展示的解析，可带 entities
open_period: seconds, // 到点自动关闭；或用 close_date（二选一）
is_anonymous: false, // 要靠 poll_answer 记名排行就不能匿名
});
}

// 到点没关或想提前结算：stopPoll 拿最终票数（result.total_voter_count
// 与 options[].voter_count），再自行播报结果。
async function closePoll(env, chatId, messageId) {
return tg(env, "stopPoll", { chat_id: chatId, message_id: messageId});
}

// ============================================================
// poll_answer 回流：记 Quiz 成绩
// update.poll_answer = { poll_id, user, option_ids: [选了第几项]}
// quiz 是单选，option_ids 只有一个元素。对错要 Bot 自己比对
// correct_option_id（开局时存一份 KV：poll:<poll_id> 已被 19 号占用，
// 这里用原生件专用键 npoll:<poll_id> = { correct, chatId}）。
// ============================================================
async function onPollAnswer(env, pa) {
const raw = await env.BOT_KV.get("npoll:" + pa.poll_id);
if (!raw) return; // 不是本 Bot 记的题
const { correct} = JSON.parse(raw);
const right = pa.option_ids[0] === correct;
// 成绩落 pts: 会和 13 号签到积分串味，独立记一份 qpts:<uid> 更干净
const key = "qpts:" + pa.user.id;
const score = Number((await env.BOT_KV.get(key)) || 0) + (right? 1: 0);
await env.BOT_KV.put(key, String(score));
}

// ============================================================
// 消息反应：Bot 点赞 + 被动计数
// setMessageReaction 是「设置」语义：传数组替换 Bot 当前的反应，
// 传空数组 = 收回。reaction 元素 { type: "emoji", emoji: "👍"}，
// 只能用 Telegram 允许的反应 emoji 集合里的，别自创。
// is_big=true 是大号动画效果，慎用，容易显得吵。
// ============================================================
async function botLike(env, chatId, messageId, emoji = "❤️") {
return tg(env, "setMessageReaction", {
chat_id: chatId,
message_id: messageId,
reaction: [{ type: "emoji", emoji}],
});
}

// update.message_reaction = { chat, message_id, user?, new_reaction, old_reaction}
// 统计净增减：new 比 old 多出的 emoji 记 +1，少的记 -1，按消息聚合存
// KV react:<chatId>:<messageId> = { "👍": 12, "❤️": 3}。
async function onMessageReaction(env, mr) {
const key = `react:${mr.chat.id}:${mr.message_id}`;
const counts = JSON.parse((await env.BOT_KV.get(key)) || "{}");
const tally = (list, delta) => {
for (const r of list || [])
if (r.type === "emoji") counts[r.emoji] = (counts[r.emoji] || 0) + delta;
};
tally(mr.new_reaction, +1);
tally(mr.old_reaction, -1);
await env.BOT_KV.put(key, JSON.stringify(counts));
}
```

## 和自研方案怎么选

| 需求 | 用原生 | 用自研（模块 19 / 03） |
|---|---|---|
| 快速发起、规则标准 | ✅ 零代码状态 | 杀鸡用牛刀 |
| Quiz 竞答带解析、限时 | ✅ open_period 现成 | 要自己写计时 |
| 可改票 / 匿名但防重复投 | ❌ 原生不支持改票 | ✅ |
| 自定义计票（加权、淘汰赛） | ❌ | ✅ |
| 点赞计数展示在消息上 | ✅ 反应原生渲染在消息下 | 按钮要占键盘位 |

## 接入步骤

1. setWebhook 的 allowed_updates 加上 `"poll"`、`"poll_answer"`，要收反应计数再加 `"message_reaction"`（且 Bot 需为群管理员）。
2. 发 quiz 前先把 `{ correct, chatId}` 存进 `npoll:<poll_id>`——poll_id 在 sendPoll 的返回 `result.poll.id` 里，发完立刻落库。
3. handle() 里加三个更新分支：`update.poll_answer` → onPollAnswer；`update.message_reaction` → onMessageReaction；`update.poll` 只用来播报最终结果（可选）。
4. 不需要 KV 也能发原生票（纯发不记分时）；记分和反应计数才需要绑定 `BOT_KV`。

## 注意点

- 原生 poll 的票数统计在 Telegram 侧，Bot **删不掉、改不了**已投的票；发起前把选项和 correct 想清楚，发错只能 stopPoll 重来。
- `poll_answer` 只在非匿名时带用户信息，匿名 poll 你只知道总票数，不知道谁答对——要排行就必须非匿名。
- 反应的可用 emoji 集合由聊天设置决定（频道/群可限制），setMessageReaction 报 REACTION_INVALID 多半是这个 emoji 在该聊天被禁了，换 👍/❤️ 这类常用款更稳。
- message_reaction 里的 user 字段在匿名反应时为空（给的是 actor_chat），计数逻辑别强依赖用户身份。
