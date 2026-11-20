# 39 · 论坛话题管理模块

> 给开了「话题（Topics）」的超级群装一套话题 CRUD，并把它用在最值得用的地方：客服工单群——一个工单 = 一个话题，客服在话题里协作，用户完全无感。这是模块 30（工单）在话题群里的组织方式升级版。

## 原理

论坛话题 = 超级群里的一组独立消息线程。消息靠 `message_thread_id` 路由：发送时带上它，消息就落进对应话题；更新里也带这个字段，Bot 靠它知道回复来自哪个话题。

方法组（Bot API Forum Topics）：

| 方法 | 用途 |
|---|---|
| `createForumTopic` | 新建话题（name + 可选 icon_color / icon_custom_emoji_id） |
| `editForumTopic` | 改名/改图标 |
| `closeForumTopic` / `reopenForumTopic` | 关/开话题（关了不能发消息，相当于结单） |
| `deleteForumTopic` | 删话题（连消息一起没，慎用） |
| `unpinAllForumMessages` | 取消话题内全部置顶 |
| `getForumTopicIconStickers` | 拿可用作话题图标的贴纸清单 |

前提条件缺一不可：群是**超级群**且群设置里**开启了话题功能**、Bot 是**群管理员**且有管理话题权限。工单场景的映射关系：工单号 ↔ thread_id 存 KV，用户↔工单的映射直接复用模块 30 的 `userticket:` / `tmap:` 约定，本模块只多一张话题映射表。

## 代码

```js
// ============================================================
// 话题映射存储（KV）
// topic:<客服群ID>:<工单号> = thread_id（数字）
// 一张工单一个话题，结单时删映射并关话题；查不到映射 = 工单已结。
// ============================================================
async function getTopicThread(env, supportChatId, ticketId) {
const raw = await env.BOT_KV.get(`topic:${supportChatId}:${ticketId}`);
return raw? Number(raw): null;
}
async function saveTopicThread(env, supportChatId, ticketId, threadId) {
await env.BOT_KV.put(`topic:${supportChatId}:${ticketId}`, String(threadId));
}
async function dropTopicThread(env, supportChatId, ticketId) {
await env.BOT_KV.delete(`topic:${supportChatId}:${ticketId}`);
}

// ============================================================
// 建话题 + 在话题里发消息
// createForumTopic 返回 result.message_thread_id，后续往这个话题
// 发任何消息都带 message_thread_id 参数即可（sendMessage /
// copyMessage / forwardMessage 全支持）。icon_color 是固定色板
// 取值（0xRRGGBB 对应的几个预设色），乱填会被拒。
// ============================================================
async function openTicketTopic(env, supportChatId, ticket) {
const r = await tg(env, "createForumTopic", {
chat_id: supportChatId,
name: `${ticket.id} · ${ticket.subject}`.slice(0, 128), // 话题名上限 128 字
icon_color: 0x6fb9f0,
});
if (!r.ok) throw new Error(r.description || "createForumTopic 失败");
const threadId = r.result.message_thread_id;
await saveTopicThread(env, supportChatId, ticket.id, threadId);
await tg(env, "sendMessage", {
chat_id: supportChatId,
message_thread_id: threadId,
text: `🎫 新工单 ${ticket.id}\n用户：${ticket.userName}（${ticket.userId}）\n直接在本话题里回复即可回达用户，结单发 /close`,
});
return threadId;
}

async function postToTopic(env, supportChatId, threadId, text) {
return tg(env, "sendMessage", {
chat_id: supportChatId,
message_thread_id: threadId,
text,
});
}

// ============================================================
// 结单：关话题而不是删话题
// closeForumTopic 后话题只读、记录还在，随时 reopen 复活——
// 对客服场景比 delete 安全得多。删映射防新消息误投已结工单。
// ============================================================
async function closeTicketTopic(env, supportChatId, ticketId) {
const threadId = await getTopicThread(env, supportChatId, ticketId);
if (threadId)
await tg(env, "closeForumTopic", {
chat_id: supportChatId,
message_thread_id: threadId,
});
await dropTopicThread(env, supportChatId, ticketId);
}
```

路由衔接（和模块 30 共用）：用户私聊的新消息 → 按 `userticket:` 找到工单 → 按本模块映射找到 thread_id → copyMessage 进话题；客服在话题里回复 → 更新带 `message_thread_id`，反查工单和用户 → copyMessage 回用户。客服群从「一口大锅烩」变成一单一格，翻记录、认领、交接都清楚。

## 接入步骤

1. 客服群升级为超级群并在群设置开启 Topics，把 Bot 拉进去设为管理员（勾上管理话题权限）。
2. KV 绑定 `BOT_KV`，与模块 30 共用同一命名空间（映射键互不冲突：那边是 `ticket:` 系列，这边是 `topic:`）。
3. 工单创建分支里，把原来的「发卡片到客服群」换成 `openTicketTopic`；用户后续消息按 thread_id 投递（copyMessage 带 `message_thread_id`）。
4. 结单分支（模块 30 的 `tclose:` 回调或 /close 命令）追加 `closeTicketTopic`。

## 注意点

- 普通群没有话题功能，createForumTopic 会直接报错——上线前先在目标群实测一遍，别等工单来了才发现建不了话题。
- General（综合）话题的 message_thread_id 是 1，别把往 General 的消息误判成某个工单话题。
- 话题名上限 128 字符，用户主题再长也要截断（代码里已 slice）。
- deleteForumTopic 是真删除且不可恢复，客服场景一律用 close 代替；只有测试话题和明显的误建话题才删。
- Bot 被降权（取消管理员）后，已建话题还在，但 Bot 不能再建/关话题，工单会退化成发不进话题——权限变动后要回归测一遍。
