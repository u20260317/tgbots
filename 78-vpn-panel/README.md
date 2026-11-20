# VPN 面板交付 Bot

给自营 VPN/代理卖家的交付适配器：下单 → 人工确认收款 → 调面板 API 自动开号 → 订阅链接直达用户 → 到期提醒与禁用。Bot 只管交付这一段，面板与线路自理。

## 部署要点
单体三步部署，变量：BOT_TOKEN*、ADMIN_ID*（收订单确认收款，没填卖不了货）、PANEL_TYPE / PANEL_URL / PANEL_TOKEN（面板三件套）、PANEL_INBOUND_ID（仅 3X-UI）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV ＋ **必须加 Cron Trigger**（如 `0 9 * * *`）做到期处理。

## 面板对接（适配层 `createPanelUser` 等三个函数）
- **Marzban（推荐，口径最稳）**：`PANEL_TYPE=marzban`，PANEL_TOKEN 填管理员 access token。建号走 `POST /api/user`（vless 代理、data_limit 字节、expire 秒戳），响应 `subscription_url` 直接交付；查量 `GET /api/user/<名>`；到期禁用 `PUT status=disabled`。面板用户名统一 `tg<用户ID>`，一人一号好对账。
- **3X-UI（best-effort）**：`PANEL_TYPE=xui` + PANEL_INBOUND_ID。走 `addClient` 把用户加到指定入站，订阅链接按 `/sub/<subId>` 拼。3X-UI 版本间 API 差异不小，查量/禁用没有稳定统一口径：本模板查量退化为本地记录、到期禁用需管理员在面板侧手动操作（Bot 会发到期通知提醒你）。**开号失败不会假装成功**：订单留在 pending，管理员可重试或转手动交付。
- **手动模式**：面板三件套任一没配即自动启用——确认收款后 Bot 提醒管理员用 `/vpndeliver <订单号> <订阅链接>` 补链交付，订单状态照样闭环。
- 换 Remnawave 等其他面板：照着适配层再写一组 create/disable/get 三个函数，业务流不动。

## 玩法与状态机
- 订单存 `vpn:order:<订单号>`：pending →（确认）done / manual /（拒）rejected；面板开号抛错时订单**不落状态**、保持 pending 可重试。
- 订阅存 `vpn:sub:<uid>`：{username, url, expire, planId}。/mysub 展示链接与到期，Marzban 时实时查量。
- Cron 到期处理：剩 ≤3 天提醒一次（reminded 标记防重复），过期禁用面板账号并通知双方（expiredFlag 防重复）。
- 续费说明：同一用户再下单确认后会**新建/覆盖**订阅记录并按新套餐重新计期；Marzban 同名用户重复 POST 会报错走管理员处理——长期运营建议续费时先在面板给老用户续期，再用 /vpndeliver 把原链接补单交付。

## 责任边界
本 Bot 是交付工具：线路来源、节点成本、当地法规与售后纠纷由部署者自担；Bot 不经手钱款（收款走部署者渠道 + 人工确认），不存用户任何面板密码（只有面板 API Token 在部署者自己的 Secret 里）。

## 拼装来源
模块 13（支付确认与自动发货）+ 模块 19（外部 API 调用）+ 模块 09（Cron）+ 模块 01/02（骨架与分级菜单）。
