# 群管理 Bot

新人按钮验证（防广告号）+欢迎语、违禁词删帖、防链接、管理员命令 /ban /mute /unmute /warn /pin /rules。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、WEBHOOK_SECRET、WELCOME_TEXT、RULES_TEXT、BAD_WORDS、ANTI_LINK=1、CAPTCHA=0 可关验证

## 说明
Bot 在群里必须是管理员且勾选删除/封禁/禁言/置顶权限。命令要「回复对方消息」再发才生效。验证超时的人可用 /unmute 手动解除（回复其消息）。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
