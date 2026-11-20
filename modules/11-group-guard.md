# 11 · 群管理模块

> 群里的三件套：入群验证（防机器人）、内容过滤（违禁词/链接）、管理命令（ban/mute/warn）。全部依赖一个前提：Bot 是群管理员，且 BotFather 里关掉隐私模式（否则收不到普通消息，过滤无从谈起）。

## 先决判定：谁是群管理员

管理命令和验证豁免都要先认人。查 getChatMember，creator/administrator 才算数；注意这是「群管理员」，和 Bot 自己的 ADMIN_ID 白名单是两套名单，别混。

```js
async function isGroupAdmin(env, chatId, userId) {
  const r = await tg(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return ["administrator", "creator"].includes(r?.result?.status);
}
```

## 入群验证

新成员进群先禁言，发生成验证按钮（回调 `verify:<用户ID>`），本人在限定时间内点对才解禁，超时踢出。本人校验很关键：回调里比对 cq.from.id，不是谁都能替点。

```js

  // 新人入群：欢迎 + 验证
  if (msg.new_chat_members?.length) {
    for (const u of msg.new_chat_members) {
      if (u.is_bot) continue;
      const welcome = (
        env.WELCOME_TEXT || "👋 欢迎 {name} 加入！先看群规 /rules，文明发言。"
      ).replace("{name}", u.first_name || "新朋友");
      if (env.CAPTCHA !== "0") {
        await tg(env, "restrictChatMember", {
          chat_id: chatId,
          user_id: u.id,
          permissions: NO_PERMS,
        });
        await send(
          env,
          chatId,
          `${welcome}\n\n🔐 请在 5 分钟内点下方按钮完成验证，否则将一直禁言（超时可退群重进，或联系管理员 /unmute）。`,
          {
            reply_markup: {
              inline_keyboard: [
                [
```

## 内容过滤

普通消息逐条过：命中违禁词或外链就删消息并警告，警告累计到阈值自动禁言。过滤前先豁免群管理员。

```js
//   WEBHOOK_SECRET  Webhook 密钥
//   WELCOME_TEXT    欢迎语，{name} 会替换成新人名字
//   RULES_TEXT      /rules 展示的群规
//   BAD_WORDS       违禁词，英文逗号隔开，如 赌博,代充,加微信
//   ANTI_LINK       填 1 开启：非管理员发的 http / t.me 链接自动删除
//   CAPTCHA         填 0 关闭新人按钮验证（默认开启）
// 前提：Bot 在群里设为管理员（删除消息、封禁、禁言、置顶权限都要勾）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

// ============================================================
// 【核心模块】Telegram Bot API 通信层
// 统一封装 tg()：所有给 Telegram 发的请求都走这里，改 API 地址/加重试只改这一处。
```

## 注意点

- 隐私模式不关，Bot 只能收到命令和回复，违禁词过滤等于摆设——部署清单里这是最常见的「不生效」原因。
- 删消息、禁言、踢人分别需要对应的管理员权限，缺哪个哪个动作静默失败，上线前逐项验。
- 和强制订阅拼装时顺序很重要：先验订阅、再验证、最后过滤（见 combos/combo-group-guard 的实现）。
