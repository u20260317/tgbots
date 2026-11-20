# 旗舰 · 母体 SaaS（mother-saas）

> 一个母体平台 + 一份 82 模板目录。**母体只有 1 个**，82 是它货架上的模板目录，不是 82 个母体。
> v1 真实可入驻的只有 4 个内核（见下），其余模板按三档诚实标注：已可入驻 4 / 可适配 35 / 不适合托管 43，合计 82。不要对外宣称 82 个都能一键克隆。

## 这是什么

一个 Cloudflare Worker 托管 N 个子 Bot：用户在母体里选内核、交子 Bot Token，母体验真（getMe）→ AES-GCM 加密存储 → 代设 Webhook 到 `/w/<随机slug>` → 子 Bot 立刻上线。之后所有子 Bot 共用这一份代码，升级只改母体一处。另带 Web 面板看平台总览、内核目录、82 模板三档目录和脱敏租户列表。

## ⚠️ 安全须知（部署前必读）

- 本项目会**代管别人 Bot 的 Token**，Token = 那个 Bot 的全部权限。只建议自用或熟人小圈子部署，别公开招揽陌生人交 Token。
- 子 Token 一律 AES-GCM 加密后才存 KV，密钥 `TOKEN_ENC_KEY` 只放 Cloudflare Secret。丢了密钥 = 所有密文作废，子 Bot 需重新入驻。
- 面板、`/api/stats`、`/api/tenants`、任何 Bot 回复都**不显示 Token 原文、密文和租户 secret**，租户列表只显示用户名、内核、slug、店主 ID 和状态。
- Webhook 路径用随机 slug + 每租户独立 `secret_token` 验签，Token 绝不进 URL。
- 用户退出托管的安全阀：随时去 @BotFather 用 `/revoke` 换新 Token，旧 Token 立即失效，母体里的密文随之作废；也可以在母体 `/mybots` 里删除托管（母体会删子 Bot Webhook 并销毁密文）。
- 向导进行中，Token 明文会短暂存在 `fsm:` 状态键（1 小时过期、完成即清）。KV 访问权限等同密钥权限，别把 KV 导出或共享给任何人。

## v1 已可入驻内核（4 个）

| 内核键 | 名称 | 源模板 | 说明 |
|---|---|---|---|
| `support` | 客服 Bot | 02 | 用户消息转发店主，店主回复转发即回达 |
| `checkin` | 签到 Bot | 13 | /qd 签到（基础 10 + 连签加成）、/me、/top 排行（抽奖未含） |
| `menu-faq` | 菜单 FAQ Bot | 07 | 按钮问答菜单 + 关键词命中答复，问答可写租户 config.faqs |
| `file-store-lite` | 文件仓库 Lite | 06 | 店主发文件只存 file_id 生成取件码，访客 /get <码> 或深链取件；文件本体在 Telegram 服务器 |

## 手把手部署

### 1. 建 KV
Cloudflare 控制台 → Workers & Pages → KV → Create namespace（名字随意，如 `mother-saas-kv`）。

### 2. 建 Worker 并粘贴代码
新建 Worker，把本目录 `worker.js` 全文粘贴进去（或用 wrangler 部署），保存。

### 3. 绑定 KV
Worker → Settings → Bindings → Add → KV Namespace，**变量名必须叫 `BOT_KV`**，选第 1 步的命名空间。

### 4. 填变量与 Secret
Worker → Settings → Variables and Secrets：

| 变量 | 类型 | 说明 |
|---|---|---|
| `BOT_TOKEN` | Secret | 母体 Bot 的 Token（@BotFather 建母体 Bot 时拿到） |
| `TOKEN_ENC_KEY` | Secret | 32 字节随机数的 base64。生成：`openssl rand -base64 32`（或在线随机生成后妥善保存，丢了要全员重入驻） |
| `WEBHOOK_SECRET` | Secret | 自己编一串随机字符串，挂 Webhook 时用 |
| `ADMIN_ID` | 普通变量 | 你的 Telegram 数字 ID（可问 @dododotest_bot 这类 ID Bot），多个用英文逗号隔开 |
| `WORKER_BASE_URL` | 普通变量（选填） | Worker 公网地址如 `https://mother-saas.xxx.workers.dev`，不填则用每次请求的来源地址 |
| `TZ_OFFSET` | 普通变量（选填） | 签到时区，默认 `8` |

### 5. 挂母体 Webhook
浏览器打开：`https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`
返回 JSON 里 `telegram.ok=true` 即成功。此步同时注册分级命令菜单（普通用户只看到 /new /mybots /cancel /start，管理员私聊多出 /tenants /tstop）。

### 6. 打开面板验收
浏览器打开 `https://你的Worker地址/` 应看到面板：状态、租户统计、4 个已可入驻内核、租户列表（空状态）和 82 模板三档目录。
只读接口：`/api/stats`、`/api/tenants`（均脱敏）、`/healthz`。

## 子 Bot 怎么入驻（给用户看的说明）

1. 去 @BotFather `/newbot` 建一个空 Bot，复制它的 Token。
2. 在母体 Bot 私聊发 `/new` → 点选内核（客服/签到/菜单FAQ/文件仓库Lite）。
3. 把子 Bot Token 发给母体 → 母体验真后显示核对页（只显示掩码）→ 点「确认开通」。
4. 母体自动加密存储并代设 Webhook，子 Bot 立刻可用。发 `/mybots` 可停用/恢复/删除托管。
5. 想退出：@BotFather `/revoke` 选该 Bot，或在母体 `/mybots` 删除托管。

## 管理员命令

- `/tenants` 全部租户列表（slug、店主、状态，不含任何 Token）。
- `/tstop <slug>` 熔断/恢复任意租户。熔断后该子 Bot 不再执行内核，只回一条停用提示。
- 子 Bot 违规（垃圾/诈骗）可能连带平台，熔断要舍得用。

## 键设计（排障用）

- `bot:<slug>` 租户记录（含 Token 密文与租户 secret，只应由 Worker 访问）
- `fsm:<chatId>:<userId>` 入驻向导状态，1 小时过期
- `t:<子BotID>:...` 租户业务数据前缀（scopedKV 自动加），如 `t:123456:pts:789`、`t:123456:file:abc123`

## 82 模板目录 · 三档清单

母体是平台，82 个模板是目录。档位定义：一档 = v1 已实现内核、现在就能入驻；二档 = 数据主要在 KV、改 scopedKV 与租户 config 就能变成内核，但 v1 还没做，不能入驻；三档 = 需要独立 Cron / 独立密钥 / 群或频道管理员权限 / 支付，或本身就是母体/商城母体，不适合塞进托管。

### 一档：已可入驻（4）

| 编号 | 模板 | 说明 |
|---|---|---|
| 02 | 双向客服 | 已实现 support 内核（简化版） |
| 06 | 文件存储分享 | 已实现 file-store-lite 内核（只存 file_id） |
| 07 | 菜单导航/关键词回复 | 已实现 menu-faq 内核（租户可配问答） |
| 13 | 签到积分/抽奖 | 已实现 checkin 内核（签到/积分/排行，抽奖未含） |

### 二档：可适配（35）

| 编号 | 模板 | 说明 |
|---|---|---|
| 01 | 频道发帖面板 | 状态在 KV、配置可改租户 config，可适配 |
| 05 | 投稿审核 | 审核流状态在 KV、配置可改租户 config，可适配 |
| 08 | ID 查询工具 | 无状态查询、改租户配置即可，可适配 |
| 09 | 订阅群发 | 订阅名单改 scopedKV、由店主手动触发可适配（不做定时群发版） |
| 10 | 网盘（私有频道存储） | 需租户自备私有频道 ID 作 config，可适配 |
| 16 | 邀请引流统计 | 归因数据改 scopedKV 即可，可适配 |
| 18 | 频道导航/互推 | 目录数据改租户 config/KV 即可，可适配 |
| 19 | 投票问卷 | 票数改 scopedKV 即可，可适配 |
| 22 | 群活跃统计 | 群消息计数改 scopedKV 可适配（需子 Bot 进群） |
| 23 | 行情播报 | 按需查询版可适配（定时播报版需 Cron，不含） |
| 24 | 接龙报名 | 名单改 scopedKV 即可，可适配 |
| 25 | 记账 | 账本改 scopedKV 即可，可适配 |
| 26 | 竞答游戏 | 会话改 scopedKV/FSM 即可，可适配 |
| 28 | 工具箱 | 无状态工具、改租户配置即可，可适配 |
| 29 | 匿名信箱 | 转发映射改 scopedKV 即可，可适配 |
| 30 | 客服工单 | 工单状态改 scopedKV 即可，可适配 |
| 37 | 贴纸制作 | 无外部密钥、处理逻辑可直接搬，可适配 |
| 38 | 天气 | 免 key 天气源、改租户默认城市即可，可适配 |
| 40 | Inline 工具 | Inline 查询改租户配置即可，可适配 |
| 41 | 狼人杀主持人 | 对局状态改 scopedKV/FSM 即可，可适配 |
| 44 | URL 上传转存 | 转存映射改 scopedKV 即可，可适配 |
| 46 | 原生 Poll/Quiz 与反应 | 票数/反应改 scopedKV 即可，可适配 |
| 49 | PDF 工具 | 文件 file_id 流转、无外部密钥，可适配 |
| 52 | 匿名随机聊天 | 匹配队列改平台级/租户级 KV 需专门设计，可适配但要改匹配域 |
| 56 | 课程/LMS | 课时状态改 scopedKV 可适配（付费解锁部分不含） |
| 57 | 预约/订位 | 时段占用改 scopedKV 即可，可适配 |
| 58 | 闪卡记忆 | 卡组与复习状态改 scopedKV 即可，可适配 |
| 61 | 活动抽奖 | 参与名单改 scopedKV、手动开奖可适配 |
| 68 | 机票/旅行助手 | 查询改租户配置即可，可适配 |
| 69 | 求职招聘 | 职位数据改 scopedKV/config 即可，可适配 |
| 70 | 房产租售提醒 | 按需查询版可适配（定时提醒版需 Cron，不含） |
| 71 | 星座运势/塔罗 | 内容生成无外部密钥，可适配 |
| 73 | 公版书库 | 免 key 书库源、书签改 scopedKV，可适配 |
| 77 | 相亲交友 | 资料卡改 scopedKV 可适配（需另加安全/举报设计） |
| 80 | 匿名提问墙 | 提问墙数据改 scopedKV 即可，可适配 |

### 三档：不适合托管（43）

| 编号 | 模板 | 说明 |
|---|---|---|
| 03 | 强制订阅 | 需子 Bot 在目标频道/群任管理员才能验订阅 |
| 04 | 群管理 | 需群管理员权限与群事件处理 |
| 11 | RSS/定时推送 | 需独立 Cron 定时抓取 |
| 12 | 入群申请审核 | 需群管理员审批权限 |
| 14 | 付费会员 | 涉及支付与到期 Cron 续期 |
| 15 | 数字商品自动售货 | 涉及支付确认与自动发货 |
| 17 | 任务赚钱 | 涉及奖励结算与防刷/支付风控 |
| 20 | 消息推送 API | 需独立外部推送密钥与 HTTP 鉴权入口 |
| 21 | 定时播报 | 需独立 Cron 定时触发 |
| 27 | 翻译 | 需外部翻译 API 密钥 |
| 31 | AI 聊天 | 需外部 AI API 密钥 |
| 32 | 母体 Bot | 母体本身，不能被母体递归托管 |
| 33 | 商城连锁母体 | 商城母体本身，含总部货源体系 |
| 34 | 视频解析下载 | 需外部解析服务配置/密钥 |
| 35 | 语音转文字 | 需外部语音识别 API 密钥 |
| 36 | 个人提醒/待办 | 需 Cron 定时提醒 |
| 39 | GitHub 通知 | 需独立 Webhook 密钥对接各自仓库 |
| 42 | Mini App 三件套 | 需独立托管 Web App 页面 |
| 43 | 图片处理/OCR | 需外部 OCR API 密钥 |
| 45 | 论坛话题工单 | 需论坛群管理员与话题权限 |
| 47 | 翻译进阶 | 需外部翻译 API 密钥 |
| 48 | 联邦群管 | 需多群管理员与联邦封禁权限 |
| 50 | 音乐下载/识曲 | 需外部识曲/下载服务 |
| 51 | 游戏平台 | 需独立托管 HTML5 游戏页面 |
| 53 | Business 代答 | 需 Telegram Business 连接授权 |
| 54 | Managed Bots 母体 | Managed Bots 母体本身，不能递归托管 |
| 55 | AI 绘图 | 需外部绘图 API 密钥 |
| 59 | 长文/频道总结 | 需外部 AI API 密钥 |
| 60 | 网站更新监控 | 需 Cron 定时巡检 |
| 62 | 加密支付收款 | 需 Crypto Pay 支付密钥 |
| 63 | 频道数据分析 | 需频道管理员权限读取统计 |
| 64 | TTS 语音合成 | 需外部 TTS 服务 |
| 65 | 电台/播客 | 需 Cron 抓取播客更新 |
| 66 | 直播开播提醒 | 需 Cron 轮询开播状态 |
| 67 | 包裹追踪 | 需外部快递查询 API 密钥 |
| 72 | 每日经文 | 需 Cron 每日推送 |
| 74 | DAO 治理提醒 | 需 Cron 与外部链上数据源 |
| 75 | NFT 动态提醒 | 需外部数据源密钥与 Cron 轮询 |
| 76 | 电商比价追踪 | 需 Cron 定时比价 |
| 78 | VPN 面板交付 | 需独立服务器面板密钥与支付 |
| 79 | 习惯打卡/番茄钟 | 需 Cron 计时提醒 |
| 81 | 域名/SSL 监控 | 需 Cron 定时巡检 |
| 82 | AI 头像/证件照 | 需外部 AI 绘图 API 密钥 |

## 本地测试

`node --check worker.js` 语法检查；本地 harness 在仓库外 `~/workspace/tgbots-deploy/harness-mother-saas.mjs`（Mock KV + Mock Telegram，不用真 Token）：覆盖面板、/api/stats、完整入驻、签到分发、租户隔离、菜单FAQ、文件仓库Lite、熔断、错密钥 403，共 20 项。

## 拼装来源

32-mother-bot 本体 + 模块 20 FSM + 模块 21 多租户托管 + 模块 07 转发路由 + 模块 16 签到 + 07-menu-faq 内核化 + 06-file-store 内核化（Lite）。
