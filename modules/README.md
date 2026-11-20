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

## 怎么用

1. 在表里找到要的能力，打开对应文档。
2. 复制代码块到你的 worker.js，按文档的「接入步骤」补上环境变量/命令表/handler 分支。
3. 拼多个模块时查两张注册表防冲突：回调前缀表（03 号文末）与 KV 键注册表（04 号文末）；更完整的拼装流程见 [docs/ASSEMBLY.md](../docs/ASSEMBLY.md)。

每个模板文件头部也有同样的【核心模块】注释横幅，模块边界与这里一一对应——仓库里读代码和在这里读文档，看到的是同一套积木。
