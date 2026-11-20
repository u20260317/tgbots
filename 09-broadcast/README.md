# 订阅群发 Bot

用户 /start 订阅、/stop 退订，管理员 /broadcast 群发通知，失效订阅自动清理。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、ADMIN_ID*、WEBHOOK_SECRET、WELCOME_TEXT ＋ 必须绑定 KV 变量名 BOT_KV

## 说明
单次群发逐个顺序发送，适合几百人以内；人数上千请分批（或联系做队列版）。用户拉黑 Bot 会在下次群发时被自动清出名单。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
