# 全球 TG Bot 类别盘点与缺失清单（2026-11-20 调研）

对照基准：本库 30 模板 + 19 模块。状态：✅已有 / 🟡部分有 / ❌缺失。出处为调研时核实的目录站榜单、开源项目与官方文档。

## 对照总表（摘要）

| 类别 | 全球代表 | 状态 | 差距 |
|---|---|---|---|
| 群管理/审核 | Rose、Group Help、Combot | ✅ | 04 + 模块 11 |
| 入群验证码 | Shieldy（约 20.7 万月活） | ✅ | 04、12 |
| 全局反垃圾/联邦封禁 | Combot CAS、Rose Federations | ❌ | 只有本地过滤，无跨群共享黑名单 |
| 强制订阅门禁 | PuzzleBot 标配 | ✅ | 03 + 模块 06 |
| 客服/双向私聊 | Livegram 类 | ✅ | 02、30 |
| 付费会员 | InviteMemberBot | ✅ | 14（人工确认版） |
| 卡密直售 | shop-tgbot 卡密部分 | ✅ | 15 |
| 完整电商商店（单店） | Lanxre/telegram-sales-bot 等 | ❌ | 无购物车/订单流 → 专项 B |
| 母体/克隆平台 | Manybot、Botmother、BotHost Pro | ❌ | 完全没有 → 专项 A |
| 加盟连锁商城 | TGTools Reseller、sh0p.bot、BotLaunch | ❌ | 完全没有 → 专项 C |
| RSS 推送 | @RSStT_Bot | ✅ | 11 + 模块 15 |
| 投票 | @vote（官方） | 🟡 | 19 自研投票；原生 sendPoll 未用 |
| 竞答 | @QuizBot（官方） | ✅ | 26 + 模块 18 |
| 狼人杀/黑手党 | Werewolf Moderator（约 8.7 万月活） | ❌ | 缺角色/阶段状态机 |
| HTML5 游戏平台 | @gamebot、PlayDeck | ❌ | 无 sendGame |
| 签到/抽奖 | 目录站单列类 | ✅ | 13 + 模块 16 |
| 接龙/RSVP | CountMeIn | ✅ | 24 |
| 群统计 | Combot analytics | ✅ | 22 |
| 邀请统计 | 商店 Bot 标配 | ✅ | 16 + 模块 14 |
| 任务赚钱 | 任务平台类 | ✅ | 17 |
| 记账 | @BudgetLogBot | ✅ | 25 |
| 个人提醒/待办 | Skeddy、@AlertBot | 🟡 | 21 是频道排播，缺个人提醒 |
| 匿名信箱 | @AnonInboxProBot | ✅ | 29 |
| 匿名随机聊天 | @RandTalkBot 等 | ❌ | 需配套举报/封禁/未成年保护，优先级低 |
| 文件分享/网盘 | Ya_Disk 类 | ✅ | 06、10 + 模块 08 |
| URL 上传转存 | @uploadbot | ❌ | 08 只存 TG 内文件 |
| 视频/媒体解析下载 | yt-dlp 系 Bot 一整类 | ❌ | 见优先级 6 的实现约束 |
| 音乐下载/识别 | scdlbot、Shazam 类 | ❌ | 与下载同管线；识曲没有 |
| AI 聊天 | GPT-4 Bot（约 508 万月活） | ❌ | 完全没有 → 优先级 4 |
| 翻译基础 | @YTranslateBot | ✅ | 27 |
| 翻译进阶 | @voice_translator_bot | ❌ | 无文档/语音/图片翻译 |
| 语音转文字 | Voicy（开源 915 star） | ❌ | 完全没有 |
| PDF/文件转换 | PDF Bot（约 1.55 万月活） | ❌ | Workers 需外部 API/纯 JS 库选型 |
| 图片处理/OCR | @imagetotext_bot | ❌ | 28 只有轻工具 |
| 贴纸制作 | @Stickers（官方，66.5 万月活） | ❌ | 无 createNewStickerSet 封装 |
| 天气查询 | @weatherman_bot | 🟡 | 模块 19 模式现成，补数据源即可 |
| 行情提醒 | @btcprices_bot 类 | ✅ | 23 + 模块 19 |
| 推送 API | IFTTT、@GmailBot 模式 | ✅ | 20 |
| GitHub/运维通知 | 官方 GitHub bot | 🟡 | 缺专用事件适配与存活监控 |
| 频道导航 | @Tchannelsbot | ✅ | 18 |
| Inline 模式 | @pic（约 450 万月活）、@gif、@wiki | ❌ | 能力级缺失：无一模板处理 inline_query |
| Mini App | 月活 5 亿+ 生态 | ❌ | 无 web_app/initData 校验 |
| 论坛话题 | Bot API Forum Topics | ❌ | 工单在话题群的标准组织方式 |
| 消息反应 | @like、setMessageReaction | ❌ | 小能力，可并入模块 03 |
| Business 代答 | Bot API Business | ❌ | 新兴，观察级 |
| Stars 付费内容 | 官方 Stars 变现渠道 | ❌ | 与 Stars 支付模块配套 |

框架生态（aiogram / python-telegram-bot / grammY / Telegraf）反复出现的能力模式缺失：FSM 多步状态机（四框架全有，头牌功能）、限流/节流中间件、429 按 retry_after 自动重试、i18n 多语言、会话存储抽象（KV 模块 04 是简易版）。

## 缺失优先级

- **P0（用户点名）**：母体/克隆多租户架构（专项 A）、完整商店单店（专项 B）、加盟连锁商城（专项 C）——同一条演进线：A 是地基，B 是业务，C = A × B。
- **P0/P1**：AI 对话（双向多轮状态、上下文截断、人设、流式草稿 sendMessageDraft）；Stars 官方支付（数字商品合规唯一通道，B/C 的收银层）；视频解析下载（Workers 约束：必须走第三方解析 API 或外置服务，Bot API 上传上限 50MB，不绕 DRM）；Inline 模式；FSM 通用状态机（A/B 的向导骨架）。
- **P1**：Mini App 接入（initData HMAC 校验）、语音转文字、翻译进阶、群管进阶（联邦封禁+CAS+群笔记）、限流与重试中间件、PDF/文件处理、i18n。
- **P2**：狼人杀主持人、贴纸制作、图片/OCR、个人提醒、通知适配器包（GitHub webhook/存活监控）、论坛话题、原生 Poll/反应、天气模板、Business 代答（观察）。

## 专项要点（浓缩）

**A 母体/克隆**：入驻向导（FSM）→ getMe 验 token → slug 路由 `/w/<slug>`（不要把 token 放 URL，会进日志）+ 每租户 secret_token → 模板注册表按租户配置装配 → KV 键加租户前缀 `t:<bot_id>:` → 每租户独立 setMyCommands 与限流。风险：代管 token 必须 AES-GCM 加密存储、只显示掩码、绝不落日志；一个 token 只能挂一个 webhook，入驻要提示冲突；子 Bot 违规需熔断开关。官方 Bot API 9.6 的 Managed Bots 是二期路线。

**B 完整商店**：分类目录（分页）→ 商品卡（多图/SKU/库存）→ 购物车 `cart:<uid>` → FSM 结账 → 支付（Stars 或人工确认，发货只认支付成功事件、charge_id 幂等）→ 订单状态机 pending→paid→shipped→done（双向通知）。库存用「下单预留、超时释放、成功实扣 + 幂等键」防超卖——KV 无事务，这是最容易翻车处。

**C 加盟商城**：总部与连锁店的划分有两种通行模式——统供型（总部批发目录+店主加价，TGTools 型）与自营型（店主自建商品、钱直达店主钱包、平台收订阅费，sh0p.bot/BotLaunch 型）；建议自营为主、总部货源池为可选。红线：绝不代收代付形成资金池；连锁店违规牵连母体，必须入驻审核+禁售清单+举报直达+一键停店熔断；token 集中代管是最高价值攻击目标，沿用 A 的加密与审计要求。

## 合规排除（不拆不做）

批量私信群发（未订阅用户）、采集群成员/全网索引他人群组（极搜类数据层）、自动拉人/邀请农场、Userbot/MTProto 绕 Bot API 限制、绕验证码/风控/账号农场、真钱赌博、盗版资源分发、绕 DRM/付费墙。
