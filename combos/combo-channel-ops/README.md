# 组合 · 频道运营全家桶（01+05+02）

一个 Bot 管一个频道：管理员发稿（私聊草稿/网页面板//post）、粉丝投稿（审核后发频道）、读者留言（双向客服）。

## 分流规则（重点）
- **管理员私聊**：普通消息=发帖草稿预览；回复被转发的留言=回给该用户；/reply <ID> <内容> 兜底回复。
- **普通用户私聊**：发来任何内容，Bot 弹按钮问「📮 投稿还是 💬 留言」，点选才分流；也可用 /tougao、/liuyan 命令直达（文字稿/留言）。
- **投稿审核**：投稿转到 REVIEW_CHAT_ID（不填=管理员私聊），按钮通过即复制发布到 CHANNEL_ID 并通知投稿人。

## 部署
同单体三步（见仓库 docs/DEPLOY.md）。变量清单（并集）：
BOT_TOKEN*、ADMIN_ID*、CHANNEL_ID*、REVIEW_CHAT_ID、WEBHOOK_SECRET、PANEL_KEY、WELCOME_TEXT ＋ 无需 KV。
前提：Bot 是 CHANNEL_ID 频道管理员；REVIEW_CHAT_ID 是群时 Bot 也要在群里。
