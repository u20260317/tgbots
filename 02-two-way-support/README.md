# 双向 Bot（客服/联系管理员）

用户私聊留言→转发给管理员；管理员回复那条转发消息→自动回给用户。支持客服群多人接待。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、ADMIN_ID*、WEBHOOK_SECRET、WELCOME_TEXT、SUPPORT_GROUP_ID（客服群 ID，填了转发到群）

## 说明
对方隐藏转发来源时，回复认不出原用户：看转发前的说明条里的 ID，用 /reply <用户ID> <内容>。管理员自己的私聊消息不会被转发，放心自言自语测试。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
