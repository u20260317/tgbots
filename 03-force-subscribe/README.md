# 强制订阅 Bot

私聊门禁：未加入指定频道/群只能看到加入按钮，验证通过才放行；群内守卫：群成员未订阅指定频道，发言会被删并提醒。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、REQUIRED_CHATS*（@频道或-100数字ID，逗号隔开）、REQUIRED_LINKS、WEBHOOK_SECRET、UNLOCK_TEXT、GUARD_GROUP_ID

## 说明
Bot 必须是每个 REQUIRED_CHATS 的管理员，否则 Telegram 不让查成员状态；私有频道务必填 REQUIRED_LINKS 邀请链接，否则用户点不到加入。群管理员豁免检查。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
