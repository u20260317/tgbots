# 04 · 消息与媒体

## 本篇讲什么

消息能装什么（文本、媒体、服务消息……）、file_id 这个「Telegram 特产」怎么复用、排版格式化的坑、编辑/删除/置顶的规则边界。发消息是 Bot 最高频的动作，这一篇决定你的消息稳不稳。

## 核心概念

### 消息全谱

一条 Message 里可能出现的字段大致分四类：

- **内容类**：text、photo、document、video、audio、voice、video_note、animation、sticker、location、contact、poll 等。识别消息类型就是看哪个字段非空——本库模块 08 的 `fileOf()` 就是把这一谱系归一化的例子。
- **来源类**：from（谁发的）、chat（在哪）、reply_to_message（回复了谁）、forward_origin（转发自哪）——客服路由全靠这几个字段（模块 07）。
- **服务类**：new_chat_members、left_chat_member、pinned_message 等「事件通知型」消息，没有文本内容，别用处理普通消息的逻辑套它们（模板 04、22 就靠它们工作）。
- **互动类**：entities（文本里的 @、链接、加粗等结构化标记）、reply_markup（挂着的 inline 键盘）。

### file_id：Telegram 的文件「取件码」

文件一旦经过 Telegram（用户发给 Bot、Bot 发出去），就有一个 `file_id`。凭它可以**无限次重新发送同一文件**，不用重新上传、不占你的存储。规则要记牢：

- file_id **按 Bot 隔离**：A Bot 拿到的 file_id，B Bot 用不了。
- 同一个文件在不同尺寸/形态下有不同 file_id（如照片的多个尺寸各有一个，取最大的那个用）。
- 官方不承诺 file_id 永久有效，但实践中长期可用；原消息被删也不影响已保存的 file_id（这正是模板 06/10 做「网盘」的根基）。
- 想把文件下载到自己这边：`getFile` 拿临时下载路径（有大小上限，约 20MB，以官方文档为准）；Bot 通过 API 上传文件也有上限（约 50MB，以官方文档为准），自建 Local Bot API Server 可以大幅放宽——这些数字动手前复核官方文档。

### 格式化：parse_mode 三选一

- **HTML**（推荐）：`<b>`、`<i>`、`<a href>` 等少量标签，只需转义 `<>&` 三个字符，最不容易翻车。
- **MarkdownV2**：功能强但转义地狱——`_*[]()~` 等一大串字符在普通文本里出现都要逐个转义，用户内容拼进去必炸。
- **不设**：纯文本，最稳，放弃排版。

原则：**用户提供的内容永远先转义再拼进带格式的文本**，否则轻则整条发送失败（400 can't parse entities），重则被注入假链接（见 09 篇）。

### 媒体组与消息操作

- `sendMediaGroup` 一次发 2–10 个媒体组成相册，图注只认第一条的 caption。
- **编辑**：自己发的消息可编辑（文本改文本、媒体换媒体是不同方法），一般有时间窗（约 48 小时，以官方为准）；按钮键盘可以单独用 editMessageReplyMarkup 换，不用动正文。
- **删除**：自己的消息随便删；删别人的要群管理员权限。频道帖、服务消息各有细则，以官方文档为准。
- **置顶**：pinChatMessage，需要相应权限；置顶事件本身也是一条服务消息。

## 实操要点

1. 发文件优先用已保存的 file_id，其次 URL 直传（Telegram 自己去拉），最后才是自己上传二进制——顺序反过来就是浪费带宽和时间。
2. 长文本有上限（单条约 4096 字符，以官方为准），长内容要分段或改发文件（模块 25 的 AI 回复、31 的文档翻译都处理了这个）。
3. copyMessage vs forwardMessage：前者是「无痕副本」（看不到来源），后者带转发标记。发稿用前者、客服转交用后者，是模块 05/07 的分工。
4. 发媒体时把 caption 当正文用，别再单独补一条文字消息刷屏。

## 常见坑

- **MarkdownV2 报 can't parse entities**：用户昵称里带了个 `_` 或 `.` 就够了。改用 HTML 并转义，或干脆纯文本拼用户名。
- **file_id 跨 Bot 串用**：换 Bot 部署老模板时最常见，表现是 API 报 wrong file_id。每个 Bot 重新走一遍存文件流程。
- **sendMediaGroup 里每条都写 caption**：只有第一条生效，其余被忽略，不是 bug。
- **编辑很久以前的消息失败**：超过时间窗了；运营类消息要改就删了重发，或者一开始就把易变信息放键盘/置顶里。

## 在本库里看哪里落地

- 文件识别与存储：[modules/08 文件存储](../../modules/08-file-store.md)、模板 06/10。
- 发稿与复制语义：[modules/05 频道发帖](../../modules/05-channel-posting.md)。
- 路由靠来源字段：[modules/07 转发与回复路由](../../modules/07-forward-routing.md)。
- 付费媒体（sendPaidMedia）的购买与复看：[modules/42 付费媒体](../../modules/42-paid-media.md)；媒体类富交互的总览见 [14 富交互能力谱](14-games-rich-interaction.md)。
