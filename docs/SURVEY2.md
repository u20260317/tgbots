# 全球 TG Bot 品类盘点 · 第二轮（2026-11-20 调研）

对照基准：本库 51 模板 + 3 组合 + 45 模块。第一轮 48 类见 docs/SURVEY.md，本轮只查 48 类之外的漏网品类，不重复论证旧表。状态：✅已有 / 🟡部分有 / ❌缺失 / 🚫合规排除。

## 一、本轮方法与来源

- 目录站与榜单：HotBots（hotbots.online，含 Image generation、Wallets & TON、Books & audiobooks、Learning English 等单品类页）、awesome-telegram（TGrpg 版，Bots 分 17 个子类，含 Crypto & Wallets、Trading Bots、Giveaways、Analytics）、telegram-store.com（Job Search 类 149 个 Bot、Religion 类单列）、findmini.app（Astrology 类 254 个应用）、TGStat / Telemetr 官方与 Brand24 的 2026 分析工具评测。
- 垂直评测与产品站：mira.tg（AI 绘图 Bot 对比）、payrequest.io（2026 加密支付指南）、coob.app（Telegram 课程平台）、GuestKeepr / RentABot（预约）、ForestsNet（VPN 售卖）、TGPicker / TgGrow（活动抽奖）、vust.ai（总结与 TTS）、DomainChecked（域名监控）、DealTrackerProBot（比价）、FairDrop / TagTripBot（机票）、PocketAnki（闪卡）、Protean / Squid DAO（治理）、Getgems 帮助中心（NFT）。
- 每个新品类均核到至少一个在运营的全球代表 Bot 与出处；只有设想、无代表的品类不收录。

## 二、新增品类对照总表（30 类）

| 品类 | 全球代表 | 状态 | 差距 / 要点 |
|---|---|---|---|
| AI 绘图 / 修图生成 | Kandinsky（@kandinsky21_bot）、SYNTX AI（@syntxaibot）、@GPT4Telegrambot（HotBots 单列品类页） | ❌ | 31 是纯文本聊天、43 是 OCR/处理，都不生成图。差一个「文生图 + 图生图」模板：可替换绘图 API（OpenAI 兼容 images 接口等）+ 额度控制（复用模块 25 的用量模式） |
| TON / 加密钱包支付接入 | @wallet、@CryptoBot（Crypto Pay API）、@xrocket（HotBots「Wallets & TON」页、payrequest 2026 指南） | 🟡 | 有 Stars（模块 24）与人工确认（模块 13），差加密支付通道：Crypto Pay 发票创建 + webhook 回调验签，让 15/33 的商店多一条收款轨 |
| 课程 / LMS 学习 | coob.app（@coob_app_bot，配套 Studyum 课程 Bot 目录）、Teleteacher | ❌ | 完全没有。课程 = 课时序列（FSM 推进）+ 随堂测验（复用模块 18/20）+ 付费解锁（14/24），Workers 完全可行 |
| 预约 / 订位 | GuestKeepr（餐厅/沙龙）、RentABot（多渠道预约平台） | ❌ | 完全没有。服务/师傅/时段三段 FSM + KV 时段占用表 + 到店前 Cron 提醒，模式与 36/21 相通但无成品 |
| 相亲交友 | Leo Match、Lover（自称 100 万+ 档案）、@matchmaker2_bot、Flirtu（botfortelegram 交友榜） | ❌ | 完全没有。档案卡 + 滑动式互选 + 互相喜欢才开聊；须带 18+ 门槛、举报/拉黑、防诈骗提示，与 52 号共享安全要求，优先级低 |
| VPN / 代理订阅售卖 | ForestsNet（20+ 家 VPN 在用）、3X-UI Shop、Marzban 系 Bot（tt-proxy-bot 等开源项目） | 🟡 | 15/14 已有下单、确认、卡密发货，差「面板交付适配器」：对接 Marzban / 3X-UI / Remnawave 面板 API 自动开号、回订阅链接、到期回收 |
| 活动抽奖（评论/订阅条件） | TgGrow（@tggrowbot）、TGPicker（@comments_picker_bot）、Telegram 原生 Giveaway | 🟡 | 13 的抽奖只限 Bot 内按钮报名；差评论区抽奖（讨论组评论抓取去重）、多频道订阅条件核验、多名额 + 备选中奖、开奖公示 |
| 频道数据分析 | TGStat Bot（@TGStat_Bot）、Telemetr（@telemetrmebot）、@tg_analytics_bot、Telechurn | ❌ | 22 只有群活跃统计，频道侧空白。硬约束：Bot API 几乎不给频道数据（仅成员数），真实产品靠 TGStat/Telemetr 的自有数据库 API，模板形态 = API 客户端 + 自有频道轻量记录 |
| 长文 / 频道总结（TL;DR） | @vustSummaryBot、Summarix（自托管频道日报） | ❌ | 完全没有。链接总结 = 安全抓取（复用 44 的抓取层）+ LLM 摘要（复用 31 的客户端）；频道日报变体靠管理员 Bot 收 channel_post 后 Cron 汇总 |
| TTS 语音合成 | Sir Readsalot（@vustVoiceBot）；有评测一次试呼 121 个 TTS Bot（charliemorrison.dev） | ❌ | 35 是反向的 STT。差 TTS 模板：外部 TTS API（须直接返回 ogg/opus 才能发语音条，否则退化为音频文件），Workers 无本地合成与转码能力 |
| 电台 / 播客 | @RadioBot（40+ 电台）、@podcastly_bot（goq/telegram-list 收录） | ❌ | 完全没有。小品类：电台直播流目录 + 播客 RSS 更新推送（复用模块 15 解析），发流链接/音频 |
| 直播开播提醒 | @twitch2telegram_bot、TwitchSirenBot、Follow Bot | ❌ | 完全没有。Cron 轮询 Twitch Helix API（需开发者凭据）或 YouTube 频道 RSS + 直播检测，复用模块 41 的通知适配器形态 |
| 网站更新监控（无 RSS 快照 diff） | Visualping、changedetection.io（两者都提供 Telegram 告警通道） | ❌ | 11 只认 RSS/Atom。差快照监控：Cron 抓页 → 正文归一化 → 哈希存 KV → 变化时推 diff 摘要；JS 重页面抓不到是已知边界（无浏览器渲染） |
| 包裹快递追踪 | MyTracking.bot、Trackbot、bernalli/parcel-tracker-bot（开源，17track API） | ❌ | 完全没有。单号识别承运商 → 17track API 查询（免费档需 Key）→ Cron 轮询状态变更推送 |
| 机票 / 旅行助手 | @TagTripBot、FairDrop、@WandessaBot | ❌ | 完全没有。主流是「航线价格盯盘 + 跳转出票」的联盟模式，依赖票价 API（如 Travelpayouts 类），Bot 本体只做订阅与提醒 |
| 求职招聘 | Jobaron、getmatch；telegram-store「Job Search」类 149 个 Bot | ❌ | 完全没有。两种形态：聚合推送（需职位源 API/RSS，如 hh.ru API、RemoteOK）或雇主发岗板（复用 18 的提交审核流换皮），后者零外部依赖 |
| 房产租售提醒 | @flat_pl_bot（波兰多门户）、Dorin（以色列）、Bytky | ❌ | 完全没有且高度区域化：各国门户无统一 API。模板形态 = 筛选订阅 + 可插拔房源适配器推送，与 11/18 同构，需逐个市场接源 |
| 习惯打卡 / 番茄钟 | FocusTimerProBot、PomodoRoBot、@pomodoro_timer_bot（生产力榜单常客） | 🟡 | 13 是群积分签到、36 是提醒待办；差个人习惯实体（连续天数/ streak 统计）与番茄钟会话计时（Cron 驱动、群共学模式） |
| 闪卡记忆（间隔重复） | PocketAnki（@PocketAnkiBot）、MemoCard、Flipi（开源） | ❌ | 完全没有。卡片 CRUD 存 KV + SM-2/FSRS-lite 调度 + Cron 到期推送复习，零外部 API，Workers 适配度最高的一类 |
| 星座运势 / 塔罗 | @Zodiac_bot（awesome-telegram 收录）、@iHorosbot、@vustAstroBot；findmini.app 占星类 254 个应用 | ❌ | 完全没有。每日运势 = 内容库（配置文本或 LLM 生成）+ 订阅 Cron 推送；须带「仅供娱乐」声明 |
| 宗教 / 祈祷 | VerseOfTheDay、iMuslimbot、@aisyah_ai_bot、BibleGateway Bot（telegram-store 单列 Religion 类） | ❌ | 完全没有。每日经文推送 + 礼拜时间（Aladhan 等免费 API）+ 经文检索；内容只取权威来源，不自创教义解读 |
| 电子书 / 书库（公版） | Gutenberg（@Gutenberg_Bot，Project Gutenberg 5 万+ 公版书） | ❌ | 完全没有。只做公版书目：Gutendex 免费 API 检索 + 文件回传，与 06 文件分享同构；受版权保护的书库见第五节排除 |
| 匿名提问墙（NGL 式公开问答） | @AskAnonFriendBot、@askthatbot；@AnonInboxProBot 的公开答卡片模式 | 🟡 | 29 是私聊双向匿名信箱；提问墙差「公开作答」工作流：问题队列管理、答卡生成并发布到频道、提问 prompts 包 |
| DAO / 链上治理提醒 | Squid DAO Bot、Decent 的 Telegram Bot、Protean | ❌ | 完全没有。Snapshot 有公开 GraphQL API：订阅 space → 提案新建/即将截止/结果推送，Cron 轮询即可；真投票要钱包签名，只能深链/Mini App 跳出，Bot 内做不了 |
| NFT 动态提醒 | @getgemsnftbot（Getgems）、@nftop_bot、CALCo Bot | ❌ | 完全没有。订阅合集 → mint/上架/成交事件推送，靠 toncenter / 市场 API 轮询，与模块 41 同形态，圈子小 |
| 域名 / SSL 到期监控 | DomainChecked（@domainChecked_bot，自身就跑在 Cloudflare Workers 上）、Uptimia | 🟡 | 模块 41 有存活打卡（dead man's switch），差域名到期（RDAP 查询）与 SSL 到期两项检查；注意 Workers 的 fetch 读不到对端证书有效期，需借外部检测 API 或证书透明日志 |
| 电商比价追踪 | DealTrackerProBot（Amazon / Flipkart） | ❌ | 完全没有。难点在数据源：大平台反爬严，需 Keepa 等授权 API 或只吃带 JSON-LD 的中小店页（PricePulse 路线）；23 的币价提醒模式可复用 |
| AI 头像 / 证件照 | @AiAvatars_Bot、@visumate_ai_bot | 🟡 | 与 AI 绘图同源：43 只有处理没有生成。落地时并入 AI 绘图模板作「照片转头像」模式；证件照只做规格裁剪排版，须注明不得用于证件造假 |
| DEX 交易机器人（狙击/跟单） | Trojan、BONKbot、Banana Gun、Maestro（累计成交额百亿美元级） | 🚫 | 品类真实且巨大，但模板形态必须托管用户私钥：复制即部署的模板无法保证密钥安全（Banana Gun 2024 年曾因消息预言机漏洞被盗约 300 万美元）。本库只做行情/提醒（23），不做代签名交易 |
| 盗版书库分发 | Z-Library 影子系 Bot 群 | 🚫 | 以受版权保护的新书全文分发为核心卖点，属第一轮排除口径中的盗版资源分发；公版书库不在此列（见上行） |

## 三、缺失优先级汇总

本轮无 P0（第一轮的 P0 已在前三批清完）。新增 30 类中：❌缺失 21 类、🟡部分有 7 类、🚫排除 2 类。

- **P1（建议下一批优先）**
  - AI 绘图/修图生成 ❌：目录站单品类、用户量最大的一块空白，与 31 同为 AI 双子星，只差绘图 API 适配层。
  - 课程/LMS ❌：coob 类平台已成势，课时 FSM + 测验 + 付费解锁全是现成模块的拼装，零新外部依赖。
  - 预约/订位 ❌：中小商家刚需，FSM + 时段表 + 提醒 Cron 全在 Workers 能力圈内。
  - 闪卡记忆 ❌：零外部 API、纯 KV + Cron 就能跑满，性价比最高。
  - 长文/频道总结 ❌：抓取层（44）与 LLM 客户端（31）都已就位，只差组装。
  - 网站更新监控 ❌：RSS 之外的长尾站点全靠它；抓取 + 哈希 diff + KV 快照，与 11 互补（此项亦为早期已向用户提过、一直未立项的提案）。
  - 活动抽奖补全 🟡：13 只差评论抓取与订阅条件核验两步，补完即覆盖频道运营最高频活动。
  - TON/加密支付接入 🟡：给 15/33 商店补 Crypto Pay 通道，与 Stars 并行，模块级改动。
- **P2（可做，排队）**
  - ❌：频道数据分析（受制于第三方 API）、TTS、电台/播客、直播开播提醒、包裹追踪、机票旅行、求职招聘、房产提醒、星座运势/塔罗、宗教/祈祷、电子书公版书库、DAO 治理提醒、NFT 动态提醒、电商比价追踪、相亲交友（须与 52 同级安全配套）。
  - 🟡：VPN 面板交付适配器、习惯打卡/番茄钟、匿名提问墙公开作答、域名/SSL 到期监控、AI 头像/证件照（并入 AI 绘图）。

## 四、已确认可行待立项（非本轮新发现，等用户定范围）

- **52 匿名随机聊天**：可做，前提是安全配套做进模板本体——举报按钮、被举报达阈值自动封禁、敏感词过滤、可关媒体消息、入场未成年提示。
- **53 Business 代答**：business_connection 是正式 API；营业时间自动回复、关键词答疑、非营业时间留言转人工。第一轮列为观察级，现升为可立项。
- **54 Managed Bots**：Bot API 9.6（2026-04-03）已上线。走 Bot API 路线：管理 Bot 在 BotFather mini app 开 bot-management 模式 → 深链 `t.me/newbot/{管理Bot}/{建议用户名}` → 用户确认 → ManagedBotUpdated → `getManagedBotToken` 取子 Bot token（轮换用 `replaceManagedBotToken`）；子 Bot token 存储复用模块 21（AES-GCM 加密 + 租户前缀隔离）。MTProto 的 bots.createBot 路线在单文件 Worker 走不通，不采用。

## 五、合规排除新增项

沿用第一轮口径（批量私信、采集群成员/全网索引他人群组、自动拉人、MTProto 绕限、绕验证码/风控、账号农场、真钱赌博、盗版分发、绕 DRM/付费墙），本轮新增两项：

- **DEX 交易机器人（代签名形态）**：必须托管用户私钥才能代下单，模板复制分发场景下密钥安全不可控，且有真实被盗先例；行情查询与价格提醒不在排除内（已有 23）。
- **盗版书库分发**：以受版权保护作品全文分发为卖点的书库 Bot；仅检索书目信息或分发公版书不在此列。

另注：相亲交友与 52 匿名随机聊天同属陌生人社交，立项时必须同带举报/封禁/未成年保护配套，不裸奔上线；房产、比价两类只接授权 API 或允许抓取的源，不做绕反爬的数据获取。
