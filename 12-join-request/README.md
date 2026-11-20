# 入群申请审核 Bot

处理私有群/频道的加入申请，三种模式用 MODE 变量切换：review 管理员按钮审核（默认）、auto 秒通过、question 先答题再审核。

## 部署要点
1. 同单体三步部署，变量：BOT_TOKEN*、ADMIN_ID*、MODE、REVIEW_CHAT_ID、TARGET_CHAT_ID、QUESTION_TEXT、WELCOME_TEXT、WEBHOOK_SECRET。question 模式必须绑定 KV 变量名 BOT_KV，其余模式不用。
2. **群/频道侧设置**：邀请链接要勾选「Request Admin Approval（加入需管理员批准）」，或群设置里开启批准新成员；Bot 是该群/频道管理员（邀请权限）。
3. setWebhook 已自动带上 chat_join_request 事件类型，不用额外操作。

## 说明
- review 模式申请卡发到 REVIEW_CHAT_ID 群或管理员私聊，按钮里编码了目标群和申请人 ID，无状态可处理。
- question 模式下申请人若没先私聊过 Bot（没点过 Bot 的开始），Bot 无法主动私聊他——这是 Telegram 的限制：用户没和 Bot 对话过，Bot 不能先开口。遇到这种情况申请人会在申请后收不到问题，建议邀请页注明「申请后请先打开 Bot 发任意消息」。兜底逻辑：没绑 KV 时自动退回 review 模式，不会让申请卡死。
- 申请长期不处理会由 Telegram 自行过期，Bot 点按钮时会提示失败原因。
