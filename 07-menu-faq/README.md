# 菜单导航 / 关键词自动回复 Bot

多级 inline 菜单 + 关键词自动回复。改 worker.js 顶部 CONFIG 区即可改全部文案、菜单和关键词，不用动逻辑代码。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、WEBHOOK_SECRET

## 说明
适合做项目介绍、价格表、FAQ 门面 Bot。与双向 Bot 的区别：这个只自动回复、不转真人；要真人接待用 02。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
