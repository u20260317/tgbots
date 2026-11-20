# tgbots · Telegram Bot 单文件合集（Cloudflare Workers）

24 个常用 TG Bot，**每个都是一个独立的 `worker.js` 单文件**：复制粘贴（或拖拽）到 Cloudflare Worker 即可部署，零依赖、零服务器、跑在 Workers 免费额度里。一个 Bot 用一个 Worker、一个 Bot Token，互不干扰，各从其类。

## 目录

| # | 类型 | 目录 | 一句话 | 需要 KV |
|---|------|------|--------|:---:|
| 01 | 频道发帖面板 | [01-channel-publisher](01-channel-publisher/) | 私聊发稿→预览→发布到频道，带网页面板和链接按钮 | 否 |
| 02 | 双向 Bot | [02-two-way-support](02-two-way-support/) | 用户留言转管理员，管理员回复即回达用户（客服） | 否 |
| 03 | 强制订阅 | [03-force-subscribe](03-force-subscribe/) | 未加入指定频道/群不能用 Bot、不能在群发言 | 否 |
| 04 | 群管理 | [04-group-manager](04-group-manager/) | 新人验证、欢迎、违禁词、防链接、ban/mute 命令 | 否 |
| 05 | 投稿审核 | [05-submission-review](05-submission-review/) | 用户投稿→审核群一键通过→发布到频道 | 否 |
| 06 | 文件分享 | [06-file-store](06-file-store/) | 发文件得专属链接，点链接找 Bot 领文件 | ✅ |
| 07 | 菜单/自动回复 | [07-menu-faq](07-menu-faq/) | 多级菜单 + 关键词自动回复，改配置区即改内容 | 否 |
| 08 | ID 查询工具 | [08-id-tools](08-id-tools/) | 查用户/群/频道 ID 和 file_id，配其它 Bot 用 | 否 |
| 09 | 订阅群发 | [09-broadcast](09-broadcast/) | /start 订阅、管理员 /broadcast 群发通知 | ✅ |
| 10 | 网盘（私有频道存储） | [10-cloud-drive](10-cloud-drive/) | 文件转存私有频道当硬盘，列表/搜索/标签/分享链接 | ✅ |
| 11 | RSS/定时推送 | [11-rss-push](11-rss-push/) | Cron 定时抓 RSS 新文章自动推频道，KV 去重 | ✅ |
| 12 | 入群申请审核 | [12-join-request](12-join-request/) | 加入申请三模式：按钮审核/秒通过/答题审核 | 答题模式需 |
| 13 | 签到积分/抽奖 | [13-checkin-lottery](13-checkin-lottery/) | 每日签到连签加成、积分榜、按钮报名抽奖 | ✅ |
| 14 | 付费会员 | [14-paid-membership](14-paid-membership/) | 卖会员：确认收款自动发邀请链接，到期自动踢 | ✅ |
| 15 | 数字商品售货 | [15-digital-shop](15-digital-shop/) | 卡密/链接自动发货，库存管理，确认后出货 | ✅ |
| 16 | 邀请引流统计 | [16-referral](16-referral/) | 深链+专属进群链接双归因，邀请榜（合规统计） | ✅ |
| 17 | 任务赚钱 | [17-task-earn](17-task-earn/) | 发任务攒积分：加入类自动验证，兑换走审核 | ✅ |
| 18 | 频道导航/互推 | [18-channel-directory](18-channel-directory/) | 频道自助提交审核收录，分类导航/搜索/随机 | ✅ |
| 19 | 投票问卷 | [19-poll-vote](19-poll-vote/) | 按钮投票可改票/可匿名，截止公布结果 | ✅ |
| 20 | 消息推送 API | [20-push-api](20-push-api/) | 给脚本/服务器一个发 TG 消息的网址接口（Server酱式） | 不用 |
| 21 | 定时播报 | [21-scheduled-post](21-scheduled-post/) | 每天/每周固定时间自动发公告到频道/群 | ✅ |
| 22 | 群活跃统计 | [22-group-stats](22-group-stats/) | 每日消息量/话痨榜/进退群，今日与近 7 天报表 | ✅ |
| 23 | 行情播报 | [23-crypto-price](23-crypto-price/) | 币价查询+价格提醒+定时播报（Binance 公共行情） | 提醒需 |
| 24 | 接龙报名 | [24-chain-signup](24-chain-signup/) | 群活动接龙：按钮报名排队名单，截止定版 | ✅ |

每个目录里都有自己的 `README.md`（变量清单 + 注意事项）。

## 快速开始

1. @BotFather 建 Bot 拿 Token → 2. Cloudflare 新建 Worker，把某个 `worker.js` 粘贴部署 → 3. 在 Worker 变量里填 `BOT_TOKEN` 等（Token 设为 Secret）→ 4. 打开 `https://Worker地址/setWebhook?key=你设的WEBHOOK_SECRET` → 5. Telegram 里测试。

手把手图文步骤、怎么查各种 ID、KV 怎么绑、常见报错：见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 代码规范（积木式模块）

- 每个 `worker.js` 的核心模块都用 `【核心模块】` 横幅注释标注（通信层、入口路由、业务主流程，以及各自的关键子模块如订阅校验、目录索引等），照着横幅就能整段拆出来复用。
- 想把几个 Bot 拼成一个：看 [docs/ASSEMBLY.md](docs/ASSEMBLY.md)（组装五步 + 已知冲突清单 + 现成组合推荐）。

## 拼装组合（combos/）

单体拼成的成品组合，各占一个子目录、依然单文件部署：

| 组合 | 子目录 | 拼装 |
|------|--------|------|
| 频道运营全家桶 | [combos/combo-channel-ops](combos/combo-channel-ops/) | 01 发帖 + 05 投稿 + 02 双向 |
| 社群守卫 | [combos/combo-group-guard](combos/combo-group-guard/) | 03 强订 + 04 群管理 |
| 强订网盘 | [combos/combo-drive-gate](combos/combo-drive-gate/) | 03 强订 + 10 网盘 |

索引见 [combos/README.md](combos/README.md)。

## 安全须知

- **Bot Token 只填进 Cloudflare 的 Secret 变量里，不要写进代码、不要发到聊天/群里。** 泄露后去 @BotFather 用 /revoke 重置。
- `WEBHOOK_SECRET` 随便编一串长随机字符即可，它同时是 `/setWebhook` 的访问口令。
- 无状态设计：01–05、07、08 不用任何数据库（靠消息转发/按钮里编码的坐标工作）；06、09、10、11、13、14、15、16、17、18、19、21、22、24 需要绑定一个 KV（12 仅答题模式、23 仅价格提醒需要，20 不用）；KV 只存小数据（映射/名单/索引/账本），文件本体都在 Telegram 服务器上。

## 组合玩法

- 频道运营套装：01 发帖 + 05 投稿 + 03 强制订阅（涨粉）+ 02 双向（读者联系）
- 社群套装：04 群管理 + 03 强制订阅守卫（进群先订频道）
- 配置任何一个之前，先部署 08 查好要用的 ID，能少踩很多坑。
