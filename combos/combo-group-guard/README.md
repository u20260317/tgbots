# 组合 · 社群守卫（03+04）

群防广告 + 强制订阅涨粉二合一。

## 群内处理顺序
1. 新人入群 → 欢迎 + 按钮真人验证（验证前禁言，CAPTCHA=0 可关）
2. 普通成员发言 → 先查强制订阅：没加入 REQUIRED_CHATS 任一频道/群 → 删帖 + @提醒（提醒带加入按钮和复查按钮，订好点复查自动撤警告）
3. 过了订阅关 → 再过违禁词（BAD_WORDS）和防链接（ANTI_LINK=1）
4. 群管理员全程豁免，且可用 /ban /mute /unmute /warn /pin /rules（回复对方消息使用）
私聊 Bot 则走订阅门禁，通过后展示 UNLOCK_TEXT。

## 部署
同单体三步（见仓库 docs/DEPLOY.md）。变量清单（并集）：
BOT_TOKEN*、REQUIRED_CHATS*、REQUIRED_LINKS、GUARD_GROUP_ID、WEBHOOK_SECRET、WELCOME_TEXT、RULES_TEXT、BAD_WORDS、ANTI_LINK、CAPTCHA、UNLOCK_TEXT ＋ 无需 KV。
前提：Bot 是群管理员（删/封/禁/置顶权限全勾），也是 REQUIRED_CHATS 各频道的管理员；BotFather 给本 Bot /setprivacy 选 Disable。
