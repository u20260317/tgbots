# 消息推送 API Bot

给服务器/脚本一个往 Telegram 发消息的网址接口（Server酱/Bark 的 TG 版）：curl 一下，消息就到。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、PUSH_KEY*（自己编一串长随机字符串，当 Secret 存）、ADMIN_ID 或 DEFAULT_CHAT_ID、WEBHOOK_SECRET。不需要 KV。

## 接口
- GET /push?key=PUSH_KEY&text=内容（可带 &chat_id=目标ID）
- POST /push?key=PUSH_KEY，JSON {"text":"内容","chat_id":可选,"parse_mode":"Markdown"可选}
- 不带 chat_id 默认发给 ADMIN_ID 第一个人。推到群：把 Bot 拉进群、群里发 /id 查群 ID 后当 chat_id 用。

## 安全（重要）
- 带 key 的网址 = 发消息权限：别贴公开仓库、别截图外传；泄露就去 Worker 改 PUSH_KEY 的值，旧网址立即失效。
- Bot 命令 /start 会把你自己的专属推送网址发给你，同样注意保密。
