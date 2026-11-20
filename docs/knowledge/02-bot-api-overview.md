# 02 · Bot API 全景

## 本篇讲什么

Bot API 这套接口是怎么组织的：方法、对象、更新三大件的关系；官方文档该怎么查；API 版本演进怎么跟（包括近期的 Managed Bots、sendMessageDraft 这类新能力该怎么评估要不要用）。

## 核心概念

### 一切调用长一个样

所有方法都是同一个 URL 形状：`https://api.telegram.org/bot<token>/<方法名>`，POST JSON 进、JSON 出。返回永远是 `{ ok: true, result: ... }` 或 `{ ok: false, error_code, description }`——先判 `ok` 再读 `result`，是所有 Bot 代码的第一课。本库的 `tg()` 封装就是把这一层抹平。

### 三大件

- **方法（Methods）**：动词，驼峰命名：`sendMessage`、`editMessageText`、`getChatMember`、`setWebhook`……按域分组：消息类、聊天管理类、成员类、支付类、贴纸类、游戏类、Mini App 类等。方法名基本能望文生义。
- **对象（Types）**：名词，API 的数据结构：`Update`、`Message`、`Chat`、`User`、`CallbackQuery`、`InlineQuery`……对象之间互相嵌套（Message 里有 from（User）、chat（Chat）、reply_to_message（Message））。
- **更新（Update）**：服务端推给你的事件总包，每种事件占一个字段（见 03 篇）。你的代码本质上就是一个巨大的「按更新类型分发」的开关。

### 没有 SDK 也没关系

官方不提供任何语言的 SDK；生态里的框架（python-telegram-bot、aiogram、grammY、Telegraf 等）都是社区封装。本库走的是「裸 API + 一个 tg() 小封装」的路线：好处是没有任何一层黑盒，官方文档怎么写你就能怎么调，新方法上线当天就能用——代价是会话管理、限流这些要自己补（模块库就是在补这些）。

### 版本与演进

Bot API 用「大版本.小版本」编号（如 9.x），更新日志在官方文档的 changelog 页。近年值得知道的方向（**具体版本与可用性以官方更新日志为准**）：

- **Managed Bots**（Bot API 9.6 引入）：管理型 Bot 可以引导用户创建「受管 Bot」并通过 `getManagedBotToken` 等方法取得其 token——官方版的母体机制，是模块 21（母体托管）自研路线的平台级替代，值得持续跟踪。
- **sendMessageDraft**：先发一条会不断更新的草稿消息，给 AI 对话做流式输出用（模块 25 提及），普通 Bot 用 editMessageText 也能达到类似效果。
- **Business 连接、付费媒体、Stars** 等：都是围绕「Bot 做生意」长出来的能力，见 06、07 篇。

## 实操要点

1. 查文档的正确姿势：先在 [core.telegram.org/bots/api](https://core.telegram.org/bots/api) 搜方法名，看它的参数表——哪些必填、哪些可选、类型是什么；再看它返回什么对象。参数表就是合同，别靠猜。
2. 新方法上线不等于所有客户端都支持展示（比如某些新消息效果），但 API 调用本身与客户端版本无关。
3. 跟进演进订两个源就够：官方 changelog 页 + @BotNews 频道。
4. 评估新能力先问三件事：我的用户场景用得上吗？它有没有前置条件（如付费、BotFather 开关）？不用它我现在的实现差多少？

## 常见坑

- **按第三方博客的参数表写代码**：博客会过时，官方参数表才是准的；尤其注意某些参数是「二选一必填」（如发图用 file_id、URL、上传文件三选一）。
- **忽略 error_code 的细分**：同样是失败，400（参数错）、403（被拉黑/没权限）、429（限流）、5xx（平台抖动）处理方式完全不同（见 08 篇）。
- **以为 result 一定是对象**：有些方法返回布尔（如 deleteMessage）或数组（如 getUpdates），照文档读。

## 在本库里看哪里落地

- 裸 API 封装的取舍：[modules/01 基础骨架](../../modules/01-foundation.md)。
- 全库如何按更新类型分发：每个模板的 `handle()` 就是活教材，从 02-two-way-support 开始看最简单。
- 官方新能力的落地评估实例：Managed Bots 已从「二期路线」落地为模板 54，专文见 [12 Managed Bots 全解](12-managed-bots.md)；Business 代答见 [13](13-business-api.md) 与模板 53；流式草稿看模块 25 的说明。
- 跟踪演进的方法论：[20 跟踪 Bot API 演进](20-api-evolution.md)（评估五问与升级流程）。
