# NFT 动态提醒 Bot

订阅 NFT 合集，新 mint / 新成交自动推送。事件源做成可替换的轮询适配层：OpenSea 官方 API 或自建适配端点，二选一。

## 部署要点
单体三步部署，变量：BOT_TOKEN*、OPENSEA_API_KEY（OpenSea 数据源）或 NFT_API_URL（通用适配端点）、ADMIN_ID（看 /nftstats）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV ＋ **必须加 Cron Trigger**（建议 `*/15 * * * *`）。
**两个数据源都没配时 Bot 不装样子**：/watch 会直接告诉用户「管理员还没配置数据源」，不收订阅、不假装监控。

## 数据源说明（各链差异，先看这段）
- **OpenSea API v2 events**：`GET api.opensea.io/api/v2/events/chain/{chain}/contract/{address}`，需 Key——去 opensea.io 账号设置里申请（免费档有频率上限，轮询间隔别太密）。链名用 OpenSea 口径：`ethereum` / `polygon` / `arbitrum` / `base` / `solana` 等。成交价按 payment 原始量 ÷1e18 展示（主流 EVM 链代币多为 18 位精度，个别代币不是，属已知近似）。
- **TON 系合集 OpenSea 不收录**：Getgems 上的 TON NFT 要走 `NFT_API_URL` 适配端点——自己写个小服务把 toncenter / Getgems 的事件转成统一 JSON 数组 `[{id, type:"mint"|"sale", tokenId, price, url}]` 即可，Bot 侧只认这个形状。
- 换任何其他数据源（Reservoir、Blur、自建索引器）同理：改 `fetchNftEvents()` 一个函数，输出形状不变，其余代码不用动。

## 玩法说明
- /watch <链> <合约地址> 落订阅 `nft:sub:<uid>`；Cron 按合集汇总订阅者（一个合集只查一次），事件与 `nft:state:<链>:<合约>` 的 seen 集合 diff，新事件才推；首次轮询只播种不推；每轮每合集最多推 5 条防刷屏。
- /nfts 列表带退订按钮（回调 `nft:un:<下标>`——用个人订阅数组下标而不是把 42 字符合约地址塞进 callback_data，避开 64 字节上限）。

## 拼装来源
模块 41（通知适配器）+ 模块 19（外部 API）+ 模块 01/02（骨架与分级菜单）。
