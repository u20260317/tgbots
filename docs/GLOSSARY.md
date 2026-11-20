# 术语表（GLOSSARY）

约 40 条，按主题分组。每条 = 一句话解释 + 在本库的对应物（模板/模块编号）。更系统的原理讲解在 [知识库](knowledge/README.md)，本页只管查词。

## 平台与通信

| 术语 | 一句话解释 | 在本库 |
|---|---|---|
| Webhook（回调地址） | Telegram 把新消息 POST 到你登记的网址，而不是你去轮询拉取 | 每个模板的 `/webhook` 路由；知识库 03 |
| Update（更新） | Telegram 推来的一包事件：消息、按钮回调、入群申请等都是不同类型的 Update | 入口路由按类型分发；知识库 02/03 |
| 长轮询（getUpdates） | 客户端反复调用 getUpdates 拉更新，Webhook 的替代方案；Workers 是请求驱动的，用不了它 | 本库全系 Webhook；知识库 03 有对比 |
| secret_token | setWebhook 时登记的密钥，之后每个请求带在请求头里，Worker 验它防伪造更新 | 入口路由校验，不符 403 |
| 子请求（Subrequest） | Worker 处理一次请求时向外发出的 fetch 次数，免费版有上限 | 抓取/轮询类模板的省流设计都为它；知识库 08 |
| 边缘缓存（Edge Cache） | Cloudflare 把数据放在离用户近的节点；KV 的最终一致与读回延迟来自于此 | FAQ「KV 读不回来」一条；模块 04 |
| Secret（密钥变量） | Worker 的加密环境变量，值不进代码、不进仓库 | BOT_TOKEN、WEBHOOK_SECRET 的存放方式；DEPLOY 第 3 步 |
| Cron Trigger（定时触发） | Cloudflare 按表达式定时唤醒 Worker 的 scheduled() 入口 | 模块 09；11/14/21/36 等靠它 |

## 消息与交互

| 术语 | 一句话解释 | 在本库 |
|---|---|---|
| Inline Keyboard（内联键盘） | 贴在消息下方的按钮，点了发回调不发新消息 | 全库按钮的主形态；模块 03 |
| Reply Keyboard（回复键盘） | 替换输入框位置的按钮，点了等于发一条文本消息 | 07 菜单的备选形态；知识库 05 |
| Callback Query（回调查询） | 用户点内联按钮时产生的 Update，带 callback_data | handle() 的回调分发分支 |
| callback_data | 按钮里藏的字符串（上限 64 字节），本库用「前缀:参数」编码并注册防冲突 | 模块 03 文末前缀注册表 |
| 深链（Deep Link） | `t.me/<bot>?start=<参数>` 形式的链接，参数会随 /start 递给 Bot | 06 取件码、16 邀请归因、29 信箱、54 建 Bot；模块 14 |
| file_id | Telegram 给每个文件的永久标识，存下它就能反复发送该文件而不重传 | 06/10 的存储地基；模块 08 |
| 群隐私模式（Group Privacy） | BotFather 的开关：开着时 Bot 在群里只能收到命令类消息 | 关掉（Disable）才能过滤/统计；FAQ 群相关 |
| 论坛话题（Forum Topic） | 开了 Topics 的超级群里的子对话，每条消息带 thread id | 45 一单一话题；模块 39 |
| 原生 Poll / Quiz | Telegram 官方投票：sendPoll 发起、poll_answer 回报选择，Quiz 模式带正确答案 | 46；模块 38（与 19 自研投票的区别在 FAQ） |
| sendGame（游戏卡片） | 发送 HTML5 游戏入口卡片，分数用 setGameScore 回报 | 51；模块 45 |
| Paid Media（付费媒体） | 用 Stars 标价的图片/视频，看前先付费 | 模块 42 |

## 状态与架构

| 术语 | 一句话解释 | 在本库 |
|---|---|---|
| KV（键值存储） | Cloudflare 的全球键值数据库，本库的状态层：一个键一个 JSON 值 | 变量名统一 `BOT_KV`；模块 04（含键注册表） |
| FSM（有限状态机） | 把多步流程拆成「当前在哪一步 + 这一步收什么」，每步落盘可恢复 | 模块 20；56/57/69/77 的向导都靠它 |
| 幂等（Idempotency） | 同一操作重复执行多次，结果和执行一次相同 | 支付发货的命门：靠 `paid:` 标记；模块 13/24/49 |
| 播种（Seeding） | 监控/抓取类首次运行时只记录现状、不推送，避免把历史存量当新增刷屏 | 11 的 rss_state、65/74 的首轮只播种 |
| 熔断（Circuit Breaker） | 出事时一键停掉某 Bot/某租户/某功能的开关 | 32/33/54 的子 Bot 停用；模块 21/23 |
| 租户（Tenant） | 母体平台里每个独立的使用者（一个子 Bot = 一个租户），数据按前缀隔离 | 32/33/54；KV 前缀 `t:<botId>:` |
| 母体（Mother Bot） | 代管多个子 Bot 的 Bot：收 Token、代挂 Webhook、按租户分发更新 | 32、54；模块 21 |
| 适配器 / 解析层（Adapter / Resolver） | 把外部服务包一层统一接口，换供应商只改这一层 | 34/50 的解析层、63 的 TGStat 适配位；模块 19/41 |
| 归因（Attribution） | 判断「这个新用户是谁带来的」，靠深链参数或专属邀请链接 | 16；模块 14 |

## 支付与官方能力

| 术语 | 一句话解释 | 在本库 |
|---|---|---|
| Stars / XTR | Telegram 官方虚拟货币，XTR 是它的货币代码；数字商品的合规收款通道 | 模块 24；知识库 06 |
| Managed Bot（托管 Bot） | Bot API 9.6 的能力：管理 Bot 发深链，用户确认后它拿到子 Bot 的 Token | 54；路线是深链 + getManagedBotToken |
| Business 连接 | Telegram Business 账号把账号消息委托给 Bot 代答的授权关系（business_connection） | 53；模块形态见其 README |
| HMAC 验签 | 用共享密钥对原始请求体算签名并比对，证明请求真来自对方且没被改 | 39 GitHub、62 Crypto Pay；红线：必须用原始请求体 |
| SSRF | 伪造请求让服务器去访问内网地址的攻击；抓取类功能必须先拦私网地址 | 44/59/60 的抓取层；模块 48 |

## 运营与治理

| 术语 | 一句话解释 | 在本库 |
|---|---|---|
| 订阅门禁（强制订阅） | 没加入指定频道/群就不让用 Bot 或发言 | 03；模块 06 |
| 联邦（Federation） | 多个群共享一份封禁名单，一处封禁处处生效 | 48；模块 33 |
| CAS | Combot 的公共反垃圾数据库，被标记的账号进群即可识别 | 48 的查询项；模块 33 |
| 工单（Ticket） | 带编号、有状态（开/关）的客服请求，比裸转发多一层可追踪性 | 30、45；模块 10/39 |
| 429 / retry_after | Telegram 限流响应：要求你等 retry_after 秒再发，硬顶会被封更久 | 模块 27 的节流与退避；知识库 08 |
