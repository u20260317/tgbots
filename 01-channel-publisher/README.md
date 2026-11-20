# 频道发帖面板 Bot

管理员私聊发内容→预览→一键发频道；另带网页面板（/panel）和 /post 带按钮发帖。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、ADMIN_ID*、CHANNEL_ID*、WEBHOOK_SECRET、PANEL_KEY（网页面板口令，不填面板关闭）

## 说明
把 Bot 拉进目标频道并设为管理员（发帖权限必勾）。发到频道的消息是「复制」过去的，不带转发标记。网页面板正文支持 HTML。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
