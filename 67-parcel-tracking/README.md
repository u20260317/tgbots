# 包裹追踪 Bot

订阅快递单号，物流状态变化自动推送，签收自动停追。数据源 17track。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、TRACK17_API_KEY（选填但强烈建议，见下）＋ 绑定 KV 变量名 BOT_KV（不绑 KV 不能用）。
自动追踪需给 Worker 加 Cron Trigger，推荐 `*/30 * * * *`。

## 申请 Key（各快递 API 都要自备，先说清）
**没有免 Key 的官方物流查询接口**——17track、快递100、TrackingMore 全都要注册拿 Key。本模板用 17track：
- 去 17track.net 注册开发者账号（后台「API」页），创建应用拿 API Key，免费档有每月查询额度，个人用够。
- 把 Key 填进 Worker 的 Secret 变量 `TRACK17_API_KEY`。
- **未配 Key 时的实际行为**：/track 照样记录单号，但明确回复「自动追踪未启用」并给 17track / 快递100 的手动查询链接；Cron 轮询直接跳过。不会假装在追踪。换其他聚合商时改 track17()/queryParcel() 两个函数即可。

## 玩法说明
- /track <单号>：登记订阅。有 Key 时顺手向 17track 登记并回当前状态；新包裹查不到轨迹很常见，回复会说明，之后轮询到再推。
- 状态推送：Cron 按单号去重查询（多人追同一单只查一次），轨迹签名（状态+最新事件）变了才推；签收后推送一条并自动移出追踪列表。
- /parcels 看在追包裹及最近状态；/untrack <单号> 取消。

## 注意事项
- 17track 状态码已映射中文（InTransit 运输中 / OutForDelivery 派送中 / Delivered 已签收 / Exception 异常等），映射表在 worker.js 的 STATUS_CN。
- 单号格式只做宽松校验（字母数字 6-40 位）；承运商由 17track 自动识别，识别不准是聚合数据源的固有问题。
- 查询额度按单号消耗，去重逻辑就是为省额度：同单号多人订阅只查一次。

## 拼装来源
模块 19（外部 API 调用）+ 模块 09（Cron 定时任务）+ 模块 01（骨架）。与 23（行情提醒）同构：都是「订阅目标 → Cron 轮询 → 变化才推」。
