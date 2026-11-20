# 游戏平台 Bot

Worker 自托管 HTML5 小游戏 + Telegram Game API 记分：sendGame 发卡、点 Play 进场、setGameScore 把分数写回卡片排行榜。模块 45 的成品落地版。

## ⚠️ 先注册游戏（不做这步必报错）
去 @BotFather 发 /newgame，按提示选 Bot、填游戏名/描述/封面图，注册两个游戏，short_name 分别是 `snake` 和 `g2048`——**必须与 worker.js 里 GAMES 注册表一字不差**，sendGame 填错名字会直接失败（Bot 会把 Telegram 的报错原文回给你）。改名只能删了重注册。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET ＋ 建议绑定 KV 变量名 BOT_KV（跨聊天总榜 `gscore:<游戏>:<用户ID>`，新前缀，已查模块 04 注册表避冲突；不绑 KV 也能玩，卡片自带榜照常，只是没有 /top 总榜）。游戏页面由同一个 Worker 托管（/game/snake、/game/g2048），不用另部署网站。

## 玩法说明
- /game 发出两张游戏卡片，点 Play 开始；分数在游戏结束时自动提交，写回卡片下方的好友排行榜。
- /top snake 或 /top g2048 看跨聊天总榜（KV 里存的每人最高分）。
- 在任意聊天 @ 本 Bot 也能发出游戏卡（Inline 模式，需 BotFather /setinline 开启），inline 卡的记分走 inline_message_id 分支，已接好。

## 身份与分数是怎么回事（重要设计）
游戏页在 webview 里打开，但 Game API **不给页面 initData**。本模板的做法：用户点 Play 时，Bot 在回调里把 {用户、聊天、消息、游戏、名字} 打包成 HMAC 签名令牌拼进游戏 URL，页面结束时把令牌+分数 POST 回 /api/score，Worker 验签通过才调 setGameScore。伪造令牌会被 403（已实测）。
诚实边界：分数终究是客户端报的，签名只能证明「是谁这局报的」，证明不了分数真实——休闲榜够用，要防刷分得把游戏逻辑搬到服务端，不在本模板范围。

## 注意事项
- 游戏页只有普通浏览器 API，没有 Telegram.WebApp SDK，别在页面里调它。
- setGameScore 默认只认更高分（最高分语义）；同一卡片重复提交低分不会覆盖。
- 换自己的游戏：把页面 HTML 换掉、GAMES 里加一行、BotFather 注册同名 short_name，三步即可；记分提交的 fetch 片段照抄现有页面。

## 拼装来源
模块 45（HTML5 游戏平台）+ 模块 28（HMAC 验签思路）+ 模块 01（骨架）。
