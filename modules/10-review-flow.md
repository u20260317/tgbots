# 10 · 审核流模块

> 「用户提交 → 管理员按钮审核 → 通过后执行动作」的通用流：投稿审核、任务领取审核、频道收录审核、兑换审核，全是同一个骨架。

## 骨架

1. 用户提交的内容先转发/复制到审核群（或管理员私聊），消息上挂「✅ 通过 / ❌ 拒绝」按钮，按钮 data 里编进回溯所需的信息（如原消息 ID、提交者 ID）。
2. 管理员点按钮 → 回调里解析 data → 通过就执行动作（发频道/发分/发货），拒绝就通知用户；同时把审核消息的按钮换成「已处理」状态防重复点。

## 提交侧（摘自 05-submission-review）

```js
// ============================================================
// 05 投稿审核 Bot（单文件 · Cloudflare Workers）
// 流程（无状态）：用户私聊投稿（文字/图片/视频/文件）-> 转到审核群/管理员处，
//   带「✅ 通过并发布」「❌ 拒绝」按钮 -> 通过即复制发布到目标频道，
//   并通知投稿人；拒绝同样通知投稿人。定位靠按钮里编码的消息坐标，不用数据库。
// 必填变量：
//   BOT_TOKEN       BotFather Token（Secret）
//   REVIEW_CHAT_ID  审核群 ID（推荐，-100 开头）或管理员个人 ID
//   TARGET_CHANNEL  发布频道 @username 或 -100 数字 ID
// 选填：WEBHOOK_SECRET
// 前提：Bot 是目标频道的管理员；审核群里请把 Bot 也拉进去。
```

## 审核侧

回调 data 用冒号分段 `动作:审核消息ID:提交者ID`，解析后按动作分发；通过时用 copyMessage 把原稿复制到目标频道，再回头把审核消息的按钮改掉、通知投稿人。

```js
// 投稿审核业务主流程（投稿转发、审核按钮、发布/拒绝通知）。这是本 Bot 真正干活的地方，其余都是它的地基。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    // data 格式：ok|no : 审核chat的消息id : 投稿人id
    const [act, reviewMsgId, submitterId] = String(cq.data || "").split(":");
    if (act !== "ok" && act !== "no") return;
    const reviewChatId = cq.message.chat.id;
    if (act === "ok") {
      const r = await tg(env, "copyMessage", {
        chat_id: env.TARGET_CHANNEL,
        from_chat_id: reviewChatId,
        message_id: Number(reviewMsgId),
      });
      if (!r.ok)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "发布失败：" + (r.description || "检查 Bot 是否为频道管理员"),
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 已发布",
      });
      await tg(env, "editMessageReplyMarkup", {
        chat_id: reviewChatId,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ 已发布到频道", callback_data: "done" }],
          ],
        },
      });
      if (submitterId)
        await send(
```

## 注意点

- 审核按钮必须验管理员身份：回调里先 isAdmin，不是管理员点的直接回执拒绝——按钮谁都能看见（在审核群里还好，私聊转发出去就危险）。
- data 只有 64 字节，编不下就存 KV 映射（30 工单的 `tmap:` 就是这么干的）。
- 「已处理」状态一定要落到消息上（editMessageReplyMarkup），否则两个管理员可能重复通过。
- 同类实现：17 的任务领取审核（`claimok:`）、18 的频道收录审核（`dirok:`）、30 的工单关闭（`tclose:`）。
