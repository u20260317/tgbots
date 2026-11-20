# 域名 / SSL 到期监控 Bot

域名注册到期 + 证书到期双监控，到期前 30/7/1 天分级提醒。是模块 41 存活监控的姊妹篇：41 管「服务活没活」，81 管「域名和证书什么时候过期」。

## 部署要点
单体三步部署，变量：BOT_TOKEN*、DOMAIN_PROBE_URL（证书探针，可空）、ADMIN_ID（看 /domstats）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV ＋ **必须加 Cron Trigger**（`0 10 * * *` 每天一次足够，到期是天级粒度）。

## 两条数据线（一条免 key 直跑，一条要探针）
- **域名到期 = RDAP**：`GET rdap.org/domain/<域名>` 自动跳注册局 RDAP，从 `events[eventAction=expiration].eventDate` 取到期日。免 key、免注册，订阅时先真查一次，查不到（无 RDAP 的小众后缀/域名不存在）不收订阅并说明原因。
- **证书到期 = 外部探针**：Workers 的 fetch **读不到对端证书有效期**（TLS 细节不暴露给 JS，这是平台硬边界，不是没写代码）。探针口径：`GET {DOMAIN_PROBE_URL}?domain=<域名>` 返回 `{certExpiry: ISO}` 或 `{certDaysLeft: n}` 都认。自建探针很简单：任何 Node/Python 小服务里 TLS 连接目标 443 端口读 peerCertificate.valid_to 包成这个 JSON 即可。**没配探针时 Bot 只监控域名到期，并在 /start、订阅回复、列表里都明确标注「证书未监控」**，不假装查过。

## 提醒逻辑
- 状态存 `dom:state:<域名>`：取域名/证书两个到期日里更早的算剩余天数，落到 30/7/1 档才推；`stage` 记住已提醒的最紧档，只有跨入更紧的档才再推（不会天天重复喊）；续期后天数回升，stage 自动回档，下个周期重新生效。
- 订阅存 `dom:sub:<uid>`，Cron 按域名汇总订阅者扇出，一个域名只查一次 RDAP。

## 拼装来源
模块 41（通知适配器/监控形态）+ 模块 19（外部 API 调用）+ 模块 09（Cron）+ 模块 01/02（骨架与分级菜单）。
