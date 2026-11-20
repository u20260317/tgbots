# ID 查询工具 Bot

查自己/群/频道/转发来源的数字 ID 和 file_id，配其它 Bot 时的瑞士军刀。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、WEBHOOK_SECRET

## 说明
查频道 ID：把频道里任意一条消息转发给它。查群 ID：把它拉进群发 /id。对方开了转发隐私时拿不到其 ID，让对方自己来发 /id。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
