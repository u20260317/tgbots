# 组合 · 强订网盘（03+10）

资源分发涨粉二合一：主人存文件进私有频道网盘，粉丝凭分享链接领取，但必须先订阅指定频道/群。

## 分流规则
- **主人（ADMIN_ID）**：免订阅检查，网盘全功能（存文件、/list、/search、/tag、/del、/stats），存好自动生成分享链接。
- **粉丝**：点分享链接（/start d_短码）→ Bot 先查 REQUIRED_CHATS 订阅状态，没订只给加入按钮，点「验证领文件」复查通过才把文件发过去；已订阅的直接发。
- 分享链接本身不设防，谁拿到都能走到验证这一步，但没订阅领不到文件。

## 部署
同单体三步（见仓库 docs/DEPLOY.md），外加绑 KV。变量清单（并集）：
BOT_TOKEN*、ADMIN_ID*、STORAGE_CHANNEL_ID*、BOT_USERNAME*、REQUIRED_CHATS*、REQUIRED_LINKS、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。
前提：Bot 是存储频道管理员，也是 REQUIRED_CHATS 各频道的管理员。单文件大小与备份提醒同 10 网盘（50MB 内稳妥、重要文件另行备份）。
