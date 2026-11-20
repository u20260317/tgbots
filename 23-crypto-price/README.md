# 行情播报 Bot

查币价 + 价格提醒 + 定时播报。数据走 Binance 官方公共行情域名，免 API Key。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、BROADCAST_CHAT_ID+BROADCAST_SYMBOLS（定时播报，可选）。价格提醒必须绑定 KV 变量名 BOT_KV；播报/提醒要加 Cron `*/10 * * * *`。不绑 KV、不加 Cron 时就是个纯查价 Bot。

## 命令
- /p BTC 查价（24h 涨跌/高低，现价 USDT 对）
- /alert BTC > 70000 设一次性提醒（私聊设置，触发后自动删除）
- /alerts 我的提醒、/delalert 编号 删除

## 说明
- 只支持 Binance 现货 USDT 交易对；查不到的币明确报错，不编价。
- 提醒巡检按币种去重抓价，同一轮多个提醒共用一次行情请求，省额度。
