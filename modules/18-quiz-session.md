# 18 · 竞答游戏会话模块

> 一局游戏 = 一份会话状态存 KV（`quiz:<群ID>`）：当前第几题、谁得多少分、谁被锁出本题。按钮抢答、第一个答对者得分、答错选项对本人锁定——26-quiz-game 的状态机。

## 发题（摘自 26-quiz-game）

题目渲染成文本 + 选项按钮（回调 `quiz:<题号>:<选项>`），会话状态先落 KV 再发消息，保证按钮点回来时状态已就位。

```js
async function sendQuestion(env, chatId, s) {
  const r = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: questionText(s),
    reply_markup: questionKb(s),
  });
  if (r.ok) {
    s.msgId = r.result.message_id;
    await putSession(env, chatId, s);
  }
}
```

## 抢答判定

回调里先查会话：本题已被答对就回执「来晚了」；点错的人记进本题锁定名单，同一选项不能连试；答对者 +10 写回会话并推进下一题。

```js
// ============================================================
// 26 竞答游戏 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：群里 /quiz 开局，Bot 逐题发题+选项按钮，第一个答对的人得分
// 自动出下一题；全部答完（或 /stopquiz 提前结束）公布本场排名。
// 每场得分会累计进赛季总榜，/quiztop 随时看。
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET、ADMIN_ID（管理员可强制结束任何一场）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV
// （键：quiz:<会话ID> 存进行中的场次；quizpts:<用户ID> 存赛季总分）。
// 换题库：改下面 CONFIG 的 QUESTIONS 数组即可（answer 是正确选项下标，从 0 数）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================
```

## 注意点

- 会话按群隔离（一群一局），私聊和群里互不干扰；结束时统一结算：本场排名发群里，分数并入赛季总榜（`quizpts:`，排行榜见 03 号模块的翻页）。
- 并发抢答靠「先落状态再回执」：两个人同时点对，第二个读到的状态已经是下一题了，天然防双得分。
- 题库写在 CONFIG 里（题目/选项/答案索引），换题库不用改逻辑。
