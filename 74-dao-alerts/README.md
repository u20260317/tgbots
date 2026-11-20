# DAO 治理提醒 Bot

订阅 Snapshot 上的 DAO 空间，新提案、提案开始/结束自动推送。Snapshot GraphQL 公开 API 免 key，Cron 轮询即可。

## 部署要点
单体三步部署，变量：BOT_TOKEN*、ADMIN_ID（看 /daostats）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV ＋ **必须加 Cron Trigger**（建议 `*/30 * * * *` 每半小时；提案节奏慢，没必要更密）。

## 玩法说明
- /watch <空间id>：先调 Snapshot 的 `space(id)` 验空间真实存在再落订阅 `dao:sub:<uid>`，订错 id 不会静默无消息。
- 轮询：Cron 先把全部个人订阅汇总成空间集合（一个空间只查一次 API），逐空间拉最近 20 条提案与 `dao:state:<空间>` 里存的上次状态做 diff：
  - 新提案（且未结束）→ 🆕 推送；状态变化 → 🔔 推送，其中 active→closed 单独用 🏁「提案已结束」文案带结果链接。
  - 某空间**首次**被轮询时只播种状态不推送，避免历史提案刷屏（与 11 号 RSS 模板同口径）。
- /daos 列表带退订按钮（回调 `dao:un:<空间>`）；推送失败（用户拉黑）自动清掉对应订阅。

## 能力边界（先说清）
- **Bot 内不能投票**：Snapshot 投票要钱包签名（EIP-712），Telegram Bot 没有用户的钱包，任何「Bot 内一键投票」都是假的。本 Bot 只做订阅与提醒，每条提醒带提案链接，点过去签名投票。
- Snapshot 空间 id 就是 snapshot.org/#/ 后面那段（如 `uniswap`、`aave.eth`），不是合约地址。
- GraphQL 端点是 Snapshot 官方公开 hub，免 key 但有频率礼仪：模板已做「按空间去重查询」，订阅量大时请把 Cron 间隔拉长而不是加频。

## 拼装来源
模块 41（通知适配器/轮询形态）+ 模块 09（Cron）+ 模块 01/02（骨架与分级菜单）。
