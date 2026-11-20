# 原生 Poll/Quiz 与反应 Bot

投票和点赞全用 Telegram 原生件：sendPoll（含 quiz 模式）、poll_answer 记分、setMessageReaction。与 19 号自研按钮投票是替代关系：原生件零状态、规则固定；要改票/匿名防刷/自定义计票才用 19。模块 38 的成品落地版。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET ＋ 绑定 KV 变量名 BOT_KV（记分与反应计数用）。/setWebhook 时 allowed_updates 已自动带上 poll、poll_answer、message_reaction——**这三类更新默认收不到，是原生件最常见的「没反应」原因**。要收反应计数，Bot 还必须是群管理员。

## 玩法说明
- /poll 问题 | 选项1 | 选项2：匿名原生投票（选项 2–10 个），结束时自动播报各选项票数。
- /quiz 问题 | 答案序号 | 选项1 | 选项2 …：原生竞答，60 秒限时、答完即知对错；末尾可再加一格「解析:说明」作为答后解析。非匿名（要记名排行），答对 +1 分记 qpts:。
- /qrank：竞答排行榜（成绩只存用户 ID 与分数，榜单按 ID 展示）。
- 回复一条消息 /like：Bot 给它挂 ❤️；/likecount：查这条消息被记录到的反应统计（react: 键）。

## 注意事项
- 原生 poll 的票 Bot 删不掉改不了，发错只能 stopPoll 重来；选项和正确答案发起前想清楚。
- quiz 的 correct_option_id 从 0 数，命令里给用户看的序号从 1 数，代码里已做 -1 换算。
- 反应可用 emoji 由聊天设置决定，被禁的 emoji 会报 REACTION_INVALID，换 👍/❤️ 更稳。
- 匿名投票只知道总票数、不知道谁答对，所以 /poll 不记分，只有 /quiz 记分。

## 拼装来源
模块 38（原生 Poll/Quiz 与消息反应）+ 模块 01（骨架）+ 模块 02（分级菜单）。
