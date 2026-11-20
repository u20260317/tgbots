# 投稿审核 Bot

用户投稿→审核群带通过/拒绝按钮→通过即发布到目标频道并通知投稿人，全程无数据库。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、REVIEW_CHAT_ID*、TARGET_CHANNEL*、WEBHOOK_SECRET

## 说明
Bot 必须是目标频道管理员，审核群也要拉 Bot 进去。一次投稿=一条消息；长稿请让用户分条或发文件。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
