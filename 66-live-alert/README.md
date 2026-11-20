# 直播开播提醒 Bot

订阅 Twitch / YouTube 主播，开播第一时间推送；状态机防重复报，同一场只报一次。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET（选填，见下）＋ 绑定 KV 变量名 BOT_KV（不绑 KV 不能用）。
**必须**给 Worker 加 Cron Trigger，推荐 `*/5 * * * *`：轮询全靠它，不配 Cron 就永远不会推送。

## 两个平台的口径（差别很大，先说清）
- **YouTube：免 Key 可真跑。** Bot 轮询频道 `/live` 页的开播标记判断状态，订阅时给 UC 开头的频道 ID、@handle 或频道链接都能解析。代价：靠页面标记识别，YouTube 改版可能影响识别，解析不到按未开播处理（宁漏不误报）。
- **Twitch：必须有开发者凭据。** Helix API 要求 Client ID + Secret：去 dev.twitch.tv 注册应用（免费）拿到后填 `TWITCH_CLIENT_ID`、`TWITCH_CLIENT_SECRET`（Secret 变量）。**未配置时**：订阅照常保存，但轮询跳过 Twitch 目标，/follow 和 /live 都会明确显示「未在监控」，不会假装在跑。

## 玩法说明
- /follow twitch <主播名>、/follow youtube <频道ID/@handle/链接>；/live 看订阅和上次轮询状态；/unfollow 平台 目标 退订（目标写订阅时用的名字即可）。
- 轮询把所有人的订阅按目标去重，每个目标只查一次；状态从未开播→直播中、或主播重开新一场（场次 ID 变了）才推送，附标题/分区/观看数（Twitch）和直播链接。

## 注意事项
- 推送时效 = Cron 间隔，5 分钟一轮就是最迟 5 分钟；别把 Cron 设太密，目标多时注意 Workers 免费版请求额度（去重已按目标合并查询）。
- Twitch 应用令牌缓存在 KV（`live:twtoken`），快过期自动换新，不用管。
- 状态存 `live:state:<平台>:<目标>`；想重置某个目标的推送状态，删这个键即可。

## 拼装来源
模块 41（通知适配器形态）+ 模块 09（Cron 定时任务）+ 模块 01（骨架）。与 39（GitHub 通知）区别：39 是事件推过来（Webhook），66 是 Bot 主动轮询拉状态。
