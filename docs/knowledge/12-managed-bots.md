# 12 · Managed Bots 全解

## 本篇讲什么

Bot API 9.6 引入的 Managed Bots（受管 Bot）是怎么回事：一个「管理 Bot」如何引导用户创建出归他管的 Bot、怎么拿到并轮换它的 token、和本库自研的母体代管（模块 21）有什么区别、什么时候该用哪条路线。

## 核心概念

### 先分清两个词：母体 vs Managed Bots

- **母体（自研路线）**：用户自己先去 BotFather 建好 Bot，把 token 交给你的平台，平台加密代管、代设 webhook。平台是「保管员」，Bot 的出生与所有权在用户和 BotFather 那边。
- **Managed Bots（官方路线）**：管理 Bot 在 BotFather 的 mini app 里开启 **bot-management 模式**后，用户点一条深链就能在 Telegram 内完成「创建新 Bot 并授权给这个管理 Bot 管」，全程不碰 BotFather 对话、不需要用户复制粘贴 token。平台是「接生 + 管理者」。

### 官方路线的完整流程

1. **开模式**：管理 Bot 的所有者去 BotFather 的 mini app 里给它打开 bot-management 模式（`can_manage_bots`）。没开这个模式，后面一切免谈。
2. **发深链**：管理 Bot 生成链接 `https://t.me/newbot/{管理Bot用户名}/{建议用户名}`，建议用户名就是给新 Bot 预起的 username（要符合命名规则且未被占用）。
3. **用户确认**：用户点开链接，在官方界面里确认创建。新 Bot 当场出生，所有者是用户，但被授权给管理 Bot 管理。
4. **收事件**：管理 Bot 的 webhook 收到 `ManagedBotUpdated` 更新，里面带着新 Bot 的信息——这是「认领」时刻，把「哪个用户、建了哪个 Bot」落库。
5. **取 token**：管理 Bot 调 `getManagedBotToken` 拿到子 Bot 的 token，之后就能像用自己的 token 一样替它 setWebhook、调 API。token 泄露或例行轮换时用 `replaceManagedBotToken` 换新，旧的随即失效。

关键点：**token 的交接发生在 API 层，不经过聊天、不经过人手复制**——这正是它比自研路线安全的地方：没有「用户把 token 贴进聊天框」这个最脆弱的环节。

### 为什么 MTProto 路线在 Worker 里走不通

网上能搜到另一条建 Bot 的路：用普通用户账号走 MTProto 协议调 `bots.createBot` / `bots.checkUsername`。这条路需要一个真实登录的用户账号会话和 MTProto 客户端库，而 Cloudflare Worker 里没有 MTProto 客户端、也不能合规地常驻一个用户账号会话（更别说这与平台对用户账号自动化的规则相冲突）。所以单文件 Worker 的世界里，建 Bot 只有两条路：让用户去 BotFather 建（自研母体），或走官方 Managed Bots 深链。看到任何「在服务器上用账号批量建 Bot」的方案，先想清楚它依赖的是哪套协议。

### 两条路线选型对照

| 维度 | 自研母体（模块 21） | Managed Bots（官方） |
|---|---|---|
| 建 Bot | 用户去 BotFather 自建再交 token | 深链内官方界面创建 |
| token 交接 | 经用户之手，有泄露面 | API 直达，无人工环节 |
| 前置条件 | 无 | 管理 Bot 需在 BotFather 开管理模式 |
| 存量 Bot | 已有 Bot 可直接入驻 | 只能管经此流程新建的 Bot |
| 平台依赖 | 全在自己手里 | 依赖官方流程与界面，用户多一步确认 |
| 适合 | 给已有 Bot 的人提供托管/模板服务 | 从零帮用户「一键开店」式建 Bot |

两条路线不互斥：平台可以同时支持——新用户走深链一键建，老用户拿已有 Bot 入驻。

## 实操要点

1. 收到 ManagedBotUpdated 先落「认领记录」（用户 id、子 Bot id、建议用户名），再异步取 token，别在 webhook 同步流程里串一长串调用（见 03 篇先回 200 的原则）。
2. 取到的 token 与自研路线同等敏感：AES-GCM 加密存、界面只显掩码、绝不进日志（见 09 篇代管义务），存储层直接复用模块 21 的做法。
3. 子 Bot 的 webhook、命令菜单都要由管理 Bot 代设：每个子 Bot 独立 setWebhook 到带 slug 的路径，别共用一个入口再靠 token 区分。
4. 给用户留退出路径：讲清他随时能在官方界面解除托管或让 token 失效，平台侧删除密文记录——安全阀在用户手里是这类产品的信任基础。

## 常见坑

- **没开 bot-management 模式就发深链**：用户点开只会一头雾水。深链生成前先自检模式状态，开不了就引导走 BotFather 自建路线。
- **建议用户名被占/不合规**：深链里的名字是「建议」不是「保留」，生成前用规则本地校验（字符集、bot 结尾），并准备好失败重试换名。
- **把 ManagedBotUpdated 当普通 message 处理**：它是独立的更新字段，allowed_updates 要显式订阅（见 03 篇），漏订就永远收不到认领事件。
- **以为官方路线就不用存 token 了**：token 还是要你保管和使用的，只是交接方式变了；加密存储与掩码展示一样不能省。

## 在本库里看哪里落地

- 官方路线的完整模板：模板 `54-managed-bots`（深链 FSM、认领、取 token、轮换与删除全流程）。
- 自研路线的加密存储与租户隔离：[modules/21 母体 Bot 多租户托管](../../modules/21-mother-bot.md)；对应的成品是模板 32。
- 代管的安全义务：[09 安全](09-security.md) 的代管一节。
