# 14 · 富交互能力谱

## 本篇讲什么

除了「文本 + 按钮」，Bot API 还攒了一整套富交互原语：游戏卡、付费媒体、原生投票、消息反应、Inline 结果。这一篇把它们摆在一张谱上，讲清每个的能力边界和适用场景，选型时不再靠试错。

## 核心概念

### sendGame：游戏卡与平台记分

- Bot 通过 BotFather 注册游戏（short name），用 `sendGame` 发出一张游戏卡片；用户点 Play，Bot 收到带 `game_short_name` 的 callback_query，要在回执里给出游戏页 URL（`answerCallbackQuery` 的 url 参数）。
- 游戏本体是一个 HTTPS 网页（自托管在任何静态/Worker 服务上都行），在 Telegram WebView 里运行。**游戏页没有 initData**——它不是 Mini App，没有官方的身份注入通道；要认人，靠回调时由 Bot 在 URL 里拼一个**签名令牌**（用户 id + 时间戳 + HMAC），页面拿令牌向你的后端报分，后端验签后才信。
- 记分走 `setGameScore`：按 user + 承载消息（chat+message，或 inline_message_id）记分，平台维护每个游戏的排行榜展示。`force` 参数决定低分是否覆盖高分（一般不覆盖）。
- 边界：防作弊只能靠「令牌验签 + 分数合理性校验」，客户端报上来的分数本质不可全信——竞技性强的游戏要么弱化奖励，要么关键判定放服务端。

### sendPaidMedia：付费媒体

Stars 体系的另一种变现形态（见 06 篇）：一条消息里挂图/视频，用 `sendPaidMedia` 定价（Stars 数），用户付费前只看到模糊预览与价格，付费后解锁原图。购买事件以 `purchased_paid_media` 服务消息到达，payload 对单。适合「内容即商品」：付费图集、付费视频课的单集、资料包。已购关系自己存 KV，用户复看时用普通发送免费重发，别让人付两次钱。

### 原生 Poll / Quiz：平台的投票

`sendPoll` 发起的原生投票由平台托管状态：选项、票数、匿名与否、截止时间都是平台的事，你不用存票。两种模式：

- **普通投票（regular）**：可多选、可匿名，适合意见收集；结果通过 `poll` 更新回传汇总，单个用户投了谁（非匿名时）走 `poll_answer`。
- **Quiz 模式**：单选 + `correct_option_id` 定正确答案 + explanation 解析 + open_period 限时，天生为答题设计，记分自己按 poll_answer 累加。

与自研按钮投票（模块 03/模板 19）相比：原生省存储、UI 原生流畅，但流程控制（改票规则、阶段推进、与业务状态机联动）不如自研灵活。纯收集用原生，深度嵌入业务用自研。

### 消息反应：最轻的互动

`setMessageReaction` 让 Bot 对某条消息贴一个表情反应（reaction 是官方给定的 ReactionType 列表，以文档为准）。用途是「已读/收到/赞」的轻反馈——客服确认收到、打卡盖章、内容点赞计数（配合 `message_reaction` 更新统计某条消息被点了多少反应）。边界：Bot 能贴的反应类型受限、不能凭空自定义表情；它是点缀不是流程，别拿它承载需要确认的业务动作。

### Inline 结果类型全谱

Inline 模式（见 05 篇入口、模块 26 实现）回答查询时能返回的结果远不止文章：

- **内容类**：article（文本卡）、photo、gif、mpeg4_gif、video、audio、voice、document、sticker——选中后直接把该媒体发进当前聊天。
- **复用类**：cached_* 系列，用已在 Telegram 里的 file_id 构造结果，零上传、最快，是图库/贴纸类 Inline Bot 的主力。
- **位置类**：location、venue、contact——选中即发定位/名片。
- 结果要带 id（结果集内唯一）、可挂 inline 键盘；`cache_time` 与 `is_personal` 决定结果缓存策略，个性化结果务必标 personal 防串人。

## 实操要点

1. 选型先问「状态谁托管」：平台托管（原生投票、游戏记分）省事但受限，自托管（自研投票、KV 记分）灵活但要自己扛一致性（见 17 篇）。
2. 游戏链接令牌要有时效（分钟级）且一次性更佳，报分接口验签 + 限频，分数异常值直接丢弃并记录。
3. 付费媒体的「已购复看」是体验红线：购买关系落 KV，复看走免费通道，退款时同步删关系。
4. Inline 结果优先 cached_* + file_id：先把素材用普通发送在 Telegram 里「存档」，Inline 只做检索与分发。

## 常见坑

- **游戏页想读 initData**：没有这个东西。身份靠回调 URL 的签名令牌注入，这是设计不是 bug。
- **setGameScore 找不到目标**：记分要精确定位到那张游戏卡消息（chat_id+message_id 或 inline_message_id），创建卡时就把定位信息存好。
- **原生 Quiz 的 correct_option_id 数错**：它是选项下标（从 0 起），且选项要用官方的对象结构传，字符串数组在 quiz 模式下会被拒（46 号模板实测踩过）。
- **付费媒体重复收费**：用户点已购内容又弹付款，多半是没查购买关系就直接 sendPaidMedia。先查 KV 再决定走付费还是免费发送。

## 在本库里看哪里落地

- 游戏平台成品：模板 `51-game-platform`（自托管小游戏 + 签名令牌记分 + 总榜）；游戏记分与令牌模式看 [modules/45 游戏平台](../../modules/45-games.md)。
- 付费媒体：[modules/42 付费媒体](../../modules/42-paid-media.md)（与模块 24 的 paid: 幂等到账共用）。
- 原生投票/反应：[modules/38 原生 Poll 与反应](../../modules/38-native-poll-reaction.md)、模板 46。
- Inline 全谱实战：模板 40（inline 工具箱）与 [modules/26 Inline 模式](../../modules/26-inline-mode.md)。
