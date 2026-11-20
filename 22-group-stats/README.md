# 群活跃统计 Bot

群里默默数数：每日消息量、发言人数、话痨榜、进退群，/stats 看今日、/stats7 看近 7 天。

## 部署要点（多一步关隐私模式）
1. **BotFather 关隐私**：/mybots → 选 Bot → Bot Settings → Group Privacy → Turn off。关完把 Bot 移出群再重新拉回（不重拉不生效）。
2. 同单体三步部署，变量：BOT_TOKEN*、TZ_OFFSET（默认 8）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。

## 说明
- 数据按天分键存 KV，35 天自动过期，不会无限涨。
- 话痨榜只统计文字消息的条数（图片/文件等也计 1 条），口径是「发言条数」不是字数。
- Bot 不需要当群管理员；进退群计数靠 chat_member 事件。
