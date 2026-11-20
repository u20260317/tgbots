# 邀请引流统计 Bot

只统计你自己的邀请成果的合规引流工具：Bot 深链拉新 + 群专属邀请链接双归因，带邀请榜和实时到账通知。不群发私信、不采集成员、不自动拉人——那些是封号玩法，本仓库不做。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、BOT_USERNAME*、TARGET_CHAT_ID（启用群邀请统计时填）、REWARD_TEXT、ADMIN_ID、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。Bot 需为目标群管理员（生成邀请链接 + 收 chat_member 事件都要）。

## 玩法说明
- 每个用户 /invite 拿到两条链接：Bot 深链（新人首次启动即归因）和专属进群链接（Bot 现场生成、链接名带用户 ID，进群事件自动归因）。
- 防刷：同一新人只归因一次（refdone 记录），不能邀请自己。
- 奖励发放靠你线下/手动执行，Bot 只负责把数算准：/topinv 榜单、/refstats 总量（管理员）。
