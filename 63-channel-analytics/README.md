# 频道数据分析 Bot

给频道主看自己频道的基础数据：成员数实时查、新帖浏览/转发/反应采样、每日汇总日报。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、ADMIN_ID（可代绑任意频道）、TGSTAT_API_URL / TGSTAT_API_KEY（选填，深度数据）＋ 绑定 KV 变量名 BOT_KV（不绑 KV 不能用）。
日报需给 Worker 加 Cron Trigger，推荐 `0 1 * * *`（UTC 1:00 = 北京 9:00）：每次触发给每个绑定推一份近 24 小时汇总。不配 Cron 也能用 /stats 手动看。
⚠️ /setWebhook 的 allowed_updates 已包含 channel_post 与 message_reaction_count，采样靠这两路更新——自己改部署时别删。

## 玩法说明
- 绑定：先把 Bot 加为频道管理员，再把频道里任意一篇帖子**转发**给 Bot（最稳），或 /bind @频道名 / /bind -100xxxxxxxxxx。绑定会校验操作者是频道管理员，防乱绑。
- /stats [@频道名]：成员数（getChatMemberCount 实时）+ 采样汇总（帖子数、总/平均浏览、总转发、总反应、浏览 Top 3）。
- /channels 看我的绑定；/unbind 解绑第一个绑定频道（多频道时逐个解）。
- 日报：每天 Cron 推送近 24 小时汇总到绑定人私聊；被用户拉黑（403）自动关日报，绑定保留。

## 数据边界（重要，别误读）
- Bot API **拿不到**频道完整历史统计：没有订户增减曲线、没有老帖浏览回溯、没有竞品数据。本 Bot 的浏览/反应是「Bot 成为管理员之后」新帖的采样快照（channel_post 到达时的 views/forwards + message_reaction_count 的反应总数），发帖瞬间的初始值为主，老帖后续增长不会回推。
- 想要 TGStat / Telemetr 那种深度数据，必须接第三方数据库 API：把地址填进 `TGSTAT_API_URL`（鉴权用 `TGSTAT_API_KEY`，Bearer 头），/deep 会带频道参数去拉并原样摘要返回。**未配置时 /deep 只给说明，不编造数据。** TGStat 官方 API 在 tgstat.ru 的 API 页面申请（付费），Telemetr 等同理，接口字段各家不同，/deep 的返回处理是通用文本摘要，深度对接时按对方文档改 handle 里的 /deep 分支。

## 注意事项
- 采样数据存 KV `stat:post:<频道ID>:<消息ID>`，大频道高频发帖会吃 KV 写额度；解绑不清采样，需要时手动删前缀。
- 成员数是唯一实时准确的数；Bot 被移出管理员后成员数也会查不到，/stats 会提示未知。

## 拼装来源
模块 19（外部 API 调用）+ 模块 09（Cron 定时任务）+ 模块 01（骨架）。与 22（群活跃统计）分工：22 看群里谁说话，63 看频道帖子表现。
