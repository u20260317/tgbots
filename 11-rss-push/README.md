# RSS / 定时推送 Bot

定时抓 RSS/Atom 源的新文章，自动推到你的频道。靠 Cloudflare Cron 触发 + KV 去重，不需要服务器。

## 部署要点（比普通 Bot 多两步）
1. 同单体三步部署（见仓库 docs/DEPLOY.md），变量：BOT_TOKEN*、CHANNEL_ID*、RSS_FEEDS*（逗号隔开多个源）、ADMIN_ID、WEBHOOK_SECRET、KEYWORDS（只推标题含词的）、MAX_PER_RUN（默认 3）＋ 必须绑定 KV 变量名 BOT_KV。
2. **设定时**：Worker → Settings → Triggers → Cron Triggers → Add，填 `*/30 * * * *`（每 30 分钟）之类的表达式。不设 Cron 也能用：访问 `/push?key=WEBHOOK_SECRET` 手动触发，或管理员发 /pushnow。
3. Bot 必须是目标频道管理员。

## 说明
- **首轮只播种不推送**：第一次运行把现有文章记为已读，之后只推新增，避免开局刷屏。
- 解析器是零依赖正则实现，主流 RSS/Atom 都能吃；个别怪异 Feed 解析不到会自动跳过并计入失败数（/pushnow 会回报）。
- 免费版 Worker 每天 10 万请求很宽裕；Cron 别设太密，30 分钟一轮足够，省额度。
