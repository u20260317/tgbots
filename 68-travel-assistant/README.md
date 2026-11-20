# 机票 / 旅行助手 Bot

航班状态查询 + 航线低价提醒 + 手动行程单起飞提醒，三件旅行小事。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、FLIGHT_API_URL / FLIGHT_API_KEY、PRICE_API_URL / PRICE_API_KEY（都选填，见下）＋ 绑定 KV 变量名 BOT_KV（订阅与行程；不绑 KV 只有 /fly 链接兜底可用）。
提醒与盯价需给 Worker 加 Cron Trigger，推荐 `*/15 * * * *`。

## 诚实边界（先说清）
- **比价数据依赖第三方联盟 API**：全球机票价格/库存是 Travelpayouts、Skyscanner 联盟这类 API 生意，没有免费全量源。本 Bot 只做订阅、提醒和跳转出票链接，**不卖票、不假装有票价**。
- **航班状态**同理：接了 API 才有真数据，没接只给权威查询链接。

## 两个适配位怎么接
- **航班状态**：`FLIGHT_API_URL` 填你的航班 API 地址（通用口径：Bot 会 GET `{FLIGHT_API_URL}?flight=CA1837`，带可选 Bearer `FLIGHT_API_KEY`，期望 JSON 含 status/dep/arr/depTime/arrTime 字段）。候选源：FlightAware AeroAPI（aeroapi.flightaware.com，官方、按量付费）、AviationStack 等。字段对不上就改 worker.js 的 queryFlight() 一个函数。**未配置时** /fly 直接回 FlightAware + 飞常准的查询按钮。
- **票价**：`PRICE_API_URL` 填联盟票价 API 地址（通用口径：GET `?from=PEK&to=SHA`，期望 JSON 含 price 与 url）。候选源：Travelpayouts API（联盟注册免费拿 token，价格是联盟缓存价，出票跳联盟链接）。**未配置时** /watch 订阅照存，但回复与 README 都写明「只存不查」，Cron 也跳过。

## 玩法说明
- /fly CA1837 查航班；/watch PEK SHA 800 订阅低价（低于阈值且价格变了才推，防重复）；/watches、/unwatch 管理订阅。
- /trip add 2026-12-01 08:30 CA1837 北京→上海 录行程（**时间按北京时间**解析）；Cron 在起飞前 3 小时内提醒一次；过期 24 小时的行程自动清理；/trip 看列表、/trip del 序号 删除。

## 注意事项
- 三字码用 IATA 机场/城市码（PEK 北京、SHA 上海、CAN 广州…），写错码查不到价别怪 Bot。
- 行程时间一律北京时间：人在海外录当地时间行程请先换算，Bot 里 fmtBJ/parseBeijingTime 是唯一的时区口径，改时区改这两处。

## 拼装来源
模块 19（外部 API 调用与提醒）+ 模块 09（Cron 定时任务）+ 模块 01（骨架）。
