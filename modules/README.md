# 模块库（modules/）

把 30 个模板 + 3 个组合装里反复出现的核心能力拆出来，逐个模块一篇文档：**讲清原理 + 附真实代码（直接摘自模板，可复制）+ 接入步骤 + 注意点**。写新 Bot 或拼装组合时，先来这里挑积木。

| # | 模块 | 内容 | 主要出处 |
|---|---|---|---|
| 01 | [基础骨架](01-foundation.md) | tg() 请求封装、send、webhook 入口与验签 | 全部模板 |
| 02 | [管理员白名单与分级命令菜单](02-admin-menu.md) | scope 分级注册、isAdmin 校验 | 全部模板标配 |
| 03 | [按钮与回调](03-buttons-callback.md) | inline 键盘、回调分发、原地编辑、排行榜翻页 | 13 / 19 / 26 等 |
| 04 | [KV 状态存储](04-kv-store.md) | JSON 读写、全量扫描、键命名注册表 | 全部带 KV 的模板 |
| 05 | [频道发帖](05-channel-posting.md) | copyMessage 发稿、链接按钮帖子 | 01 |
| 06 | [强制订阅校验](06-force-subscribe.md) | getChatMember 判定、加入引导键盘 | 03 / 组合装 |
| 07 | [转发与回复路由](07-forward-routing.md) | forwardMessage 双向客服与兜底路由 | 02（30 为工单版） |
| 08 | [文件存储](08-file-store.md) | file_id 直存 vs 私有频道转存 | 06 / 10 |
| 09 | [定时任务 Cron](09-cron.md) | scheduled 入口、节奏表、去重状态 | 11 / 14 / 21 / 23 |
| 10 | [审核流](10-review-flow.md) | 提交→按钮审核→执行动作的状态流 | 05 / 17 / 18 / 30 |
| 11 | [群管理](11-group-guard.md) | 入群验证、内容过滤、群管理员判定 | 04 |
| 12 | [入群申请审核](12-join-request.md) | chat_join_request 三种审核模式 | 12 |
| 13 | [支付确认与自动发货](13-payment-delivery.md) | 人工确认订单状态机、邀请开通、卡密发货 | 14 / 15 |
| 14 | [邀请归因](14-referral.md) | 深链+群邀请链接双通道归因与防刷 | 16 |
| 15 | [RSS 抓取与解析](15-rss.md) | 无依赖 RSS/Atom 解析、去重播种 | 11 |
| 16 | [签到积分与抽奖](16-checkin-lottery.md) | 时区日期键、连签加成、加密随机开奖 | 13 |
| 17 | [配置驱动菜单与关键词回复](17-config-menu.md) | CONFIG 菜单树、关键词匹配 | 07 |
| 18 | [竞答游戏会话](18-quiz-session.md) | KV 会话状态机、按钮抢答与锁定 | 26 |
| 19 | [外部 API 调用与提醒](19-external-api.md) | 公开接口拉数、条件命中推送 | 23 / 27 / 28 |
| 25 | [AI 对话](25-ai-chat.md) | OpenAI 兼容接口、per-user 上下文存 KV、人设与用量控制 | 新增扩展 |
| 26 | [Inline 模式](26-inline-mode.md) | inline_query 结果卡片、chosen_inline_result 点击反馈 | 新增扩展 |
| 27 | [限流与 429 重试](27-rate-limit-retry.md) | tg() 增强版：出站节流桶、retry_after 退避、广播分片队列 | 01 改造 |
| 28 | [Mini App 接入](28-mini-app.md) | web_app 按钮、initData 的 HMAC-SHA-256 验签、web_app_data 回传 | 新增扩展 |
| 29 | [多语言 i18n](29-i18n.md) | 按 language_code 选包、文案外置、多语言命令菜单 | 新增扩展 |
| 30 | [语音转文字](30-speech-to-text.md) | getFile 下载语音 + Whisper 类接口、群自动转写开关 | 19 外部 API |
| 31 | [翻译进阶](31-translate-plus.md) | 文档/语音/图片 OCR 翻译管线、群自动翻译模式 | 27 升级 |
| 32 | [视频下载](32-video-download.md) | 链接识别、可替换解析层、50MB 发货上限与中转 | 新增扩展 |
| 33 | [群管进阶](33-group-guard-plus.md) | 联邦封禁名单、CAS 垃圾库查询、群笔记 #tag、过滤器回复 | 04 / 11 进阶 |
| 34 | [个人提醒/待办](34-personal-reminder.md) | 自然语言时间解析、周期提醒扫描、待办按钮清单 | 09 / 21 姊妹篇 |
| 20 | [通用状态机 FSM](20-fsm.md) | 分步向导的通用骨架（状态+数据存 KV） | 新模式（框架标配） |
| 21 | [母体 Bot 多租户托管](21-mother-bot.md) | 交 token 克隆子 Bot：加密存储、slug 路由、租户隔离 | 新模式（专项 A） |
| 22 | [商店目录与购物车](22-shop.md) | 分类目录、商品卡、购物车、结账衔接 | 新模式（专项 B） |
| 23 | [商城连锁](23-franchise-mall.md) | 母体×商店的加盟模式：总部/连锁店划分与熔断 | 新模式（专项 C） |
| 24 | [Stars 官方支付](24-stars-payment.md) | sendInvoice→复核→到账发货→退款，数字商品合规通道 | 新模式（官方支付） |
| 35 | [狼人杀主持人](35-werewolf.md) | 角色私发、夜晚行动收集、白天公投的阶段状态机 | 18 进阶（多角色版） |
| 36 | [贴纸制作](36-stickers.md) | 贴纸规格、建包/加贴纸 API、QuotLy 式引用贴纸 | 新增扩展 |
| 37 | [图片处理/OCR](37-image-tools.md) | 外部 OCR 提字、代理改尺寸/转格式、渲染引用图 | 新增扩展 |
| 38 | [原生 Poll/Quiz 与消息反应](38-native-poll-reaction.md) | sendPoll quiz 模式、poll_answer 记分、setMessageReaction 点赞 | 03 / 19 原生替代 |
| 39 | [论坛话题管理](39-forum-topics.md) | createForumTopic 等方法组、工单按话题组织 | 30 组织升级 |
| 40 | [URL 上传转存](40-url-upload.md) | 外网链接拉取转存 TG：双路线分流、SSRF 与大小护栏 | 08 外部版 |
| 41 | [通知适配器](41-notify-adapters.md) | GitHub webhook 验签格式化、存活监控 dead man's switch | 20 专用适配 |
| 42 | [付费媒体](42-paid-media.md) | sendPaidMedia 卖图/视频、与 Stars 到账联动、已购复看 | 24 媒体形态 |
| 43 | [PDF 工具](43-pdf-tools.md) | 纯 JS JPEG 拼 PDF、PDF 提文字走 OCR、转图/合并/拆分走外部 API | 新增扩展（模板 49） |
| 44 | [音乐下载与识曲](44-music.md) | 可替换解析层下音频、AudD 指纹识曲、版权边界 | 32 姊妹篇（模板 50） |
| 45 | [HTML5 游戏平台](45-games.md) | sendGame 发卡、签名令牌身份注入、setGameScore 记分与总榜 | 新增扩展（模板 51） |
| 46 | [AI 绘图 API 适配](46-ai-image-gen.md) | OpenAI 兼容 images 口径文生图/图生图、b64/url 双回图、换源点 | 新增扩展（模板 55 / 82） |
| 47 | [间隔重复算法](47-spaced-repetition.md) | SM-2 简化版：ease/interval/due 计算与 KV 存法、到期扫描 | 新增扩展（模板 58） |
| 48 | [网页快照与 diff](48-web-snapshot-diff.md) | 正文提取、SHA-256 哈希哨兵、行级 diff 摘要、抓取礼仪 | 新增扩展（模板 60 / 76） |
| 49 | [Crypto Pay 加密支付](49-crypto-pay.md) | Crypto Pay 发票创建、Webhook HMAC 验签、paid: 幂等到账 | 新增扩展（商店加挂） |
| 50 | [匹配队列](50-matching-queue.md) | 一人一键队列、防重复配对、镜像会话键、举报封禁骨架 | 新增扩展（模板 52 / 77） |

## 怎么用

1. 在表里找到要的能力，打开对应文档。
2. 复制代码块到你的 worker.js，按文档的「接入步骤」补上环境变量/命令表/handler 分支。
3. 拼多个模块时查两张注册表防冲突：回调前缀表（03 号文末）与 KV 键注册表（04 号文末）；更完整的拼装流程见 [docs/ASSEMBLY.md](../docs/ASSEMBLY.md)。

每个模板文件头部也有同样的【核心模块】注释横幅，模块边界与这里一一对应——仓库里读代码和在这里读文档，看到的是同一套积木。
