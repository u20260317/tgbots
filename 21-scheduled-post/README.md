# 定时播报 Bot

每天/每周固定时间自动往频道/群发播报：每日公告、打卡提醒、活动预告这类循环内容。

## 部署要点（多一步 Cron）
1. 同单体三步部署，变量：BOT_TOKEN*、ADMIN_ID*、TARGET_CHAT_ID、TZ_OFFSET（默认 8）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。
2. **加 Cron**：Worker → Triggers → Cron Triggers → `*/5 * * * *`（每 5 分钟检查到点任务；任务按 nextRun 时间戳判断，5 分钟粒度够用，别设每分钟，省免费额度）。

## 管理员命令
- /add 09:30 daily 内容 —— 每天 9:30 发
- /add 20:00 weekly:1 内容 —— 每周一 20:00（0=周日…6=周六）
- 在群里建任务默认发本群；私聊建任务发 TARGET_CHAT_ID。
- /jobs 列表（带下一次时间）、/deljob ID 删除。

## 说明
发送失败也会顺延到下一周期（防止故障时每 5 分钟重试刷屏），失败会记在 Worker 日志里。
