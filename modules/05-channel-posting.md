# 05 · 频道发帖模块

> 管理员在私聊里攒稿，一键发到频道。核心技巧：不重新上传媒体，直接 `copyMessage` 把原消息复制到频道——图片、视频、文件、图注全部原样带过去。

## 发布动作（摘自 01-channel-publisher）

```js
async function handle(env, update) {
  // 按钮回调：发布 / 发布并置顶
  const cq = update.callback_query;
  if (cq) {
    if (!isAdmin(env, cq.from.id))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "你不是管理员",
        show_alert: true,
      });
    const [act, msgId] = String(cq.data || "").split(":");
    if (act === "pub" || act === "pubp") {
      const r = await tg(env, "copyMessage", {
        chat_id: env.CHANNEL_ID,
        from_chat_id: cq.message.chat.id,
        message_id: Number(msgId),
      });
      if (!r.ok)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "发布失败：" + (r.description || ""),
          show_alert: true,
        });
      if (act === "pubp")
        await tg(env, "pinChatMessage", {
          chat_id: env.CHANNEL_ID,
```

## 带链接按钮的帖子

发帖时在正文末尾按「按钮文字 - 链接」逐行写，解析成 url 型按钮行挂到帖子上：

```js
// 解析「文字 | https://链接」每行一个，返回 inline keyboard
// ============================================================
// 【核心模块】链接按钮解析
// 把「文字 | https://链接」文本块解析成 inline 键盘，网页面板和 /post 共用。
// ============================================================
function parseButtons(block) {
  const rows = [];
  for (const line of String(block || "").split("\n")) {
    const m = line.trim().match(/^(.+?)\s*[|｜]\s*(https?:\/\/\S+)$/);
    if (m) rows.push([{ text: m[1].trim(), url: m[2].trim() }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
```

## 流程设计（01 的完整玩法）

1. 管理员私聊发任意内容 → Bot 存为草稿并回预览。
2. 点「发布」按钮 → copyMessage 到目标频道 → 回执带频道帖子链接。
3. 另有网页版面板 `/panel`（PANEL_KEY 把关），适合长文排版。

## 注意点

- Bot 必须是频道管理员且有发帖权限，否则 copyMessage 会被 Telegram 拒绝。
- copyMessage 复制的是「无转发标记」的副本，频道读者看不到来源，正适合官方发稿；想保留出处就用 forwardMessage。
- 频道 ID 用 `-100` 开头的数字 ID（08-id-tools 可以查），不要用 @用户名 以外的猜测值。
