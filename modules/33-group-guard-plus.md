# 33 · 群管进阶模块

> 04/11 号群管理管「一个群」的事，这一篇管「一群群」和「群的记忆」：联邦共享封禁名单、进群查全局垃圾库、群笔记（#标签存取）、关键词过滤器自动回复。

## 四个子能力

- **联邦封禁**：多个群共用一份封禁名单（存 KV），在一个群封的人，进其它联邦群也会被处理。适合同一管理员手下的一批群。
- **全局垃圾库**：新人进群时拿他的 ID 去查 CAS（Combot Anti-Spam）这类公开垃圾账号库，命中就按群设置警告或直接踢——挡的是全网到处发广告的惯犯号。
- **群笔记**：管理员把常用资料存成 `#标签`，任何成员发 `#标签` Bot 就把内容贴出来（群规、地址、价目表不用反复手打）。
- **过滤器自动回复**：和 04 号的违禁词过滤相反——违禁词是「命中就删」，过滤器是「命中关键词就回复预设内容」，本质是群内版的 17 号关键词回复。

## 代码

```js
// ============================================================
// 【核心模块】联邦封禁名单（KV）
// fban:<用户ID> = { by, reason, at, fromChat }
// /fban 由任一联邦群的管理员发起，名单全联邦共享；进群事件里查
// 一遍，命中直接踢。误封申诉走 /unfban，只认 Bot 管理员名单。
// ============================================================
async function fedBan(env, userId, info) {
  await env.BOT_KV.put("fban:" + userId, JSON.stringify(info));
}
async function fedCheck(env, chatId, user) {
  const raw = await env.BOT_KV.get("fban:" + user.id);
  if (!raw) return false;
  await tg(env, "banChatMember", { chat_id: chatId, user_id: user.id });
  await send(env, chatId, "🚫 该用户在联邦封禁名单内，已移出。");
  return true;
}

// ============================================================
// 【核心模块】CAS 全局垃圾库查询
// GET https://api.cas.chat/check?user_id=<ID>，命中返回
// { ok: true, result: {...} }，没命中 ok 为 false。免费无 key。
// 第三方数据只作参考：新号、误报都存在，建议先跑「只警告」模式，
// 观察一阵再切自动踢（开关自己按群加 KV 配置）。
// ============================================================
async function casListed(userId) {
  try {
    const r = await fetch("https://api.cas.chat/check?user_id=" + userId);
    const data = await r.json().catch(() => ({}));
    return data.ok === true;
  } catch {
    return false; // 查不到就当没命中，别因为接口挂了拦人
  }
}
async function guardNewMemberPlus(env, chatId, user) {
  if (await fedCheck(env, chatId, user)) return;
  if (await casListed(user.id))
    await send(
      env,
      chatId,
      "⚠️ 新成员在全局垃圾库名单内，请管理员留意其发言。",
    );
}

// ============================================================
// 【核心模块】群笔记 #tag
// note:<群ID>:<标签> = 笔记文本。保存：管理员回复一条消息发
// 「/note 标签」存那条的内容，或直接 /note 标签 内容。
// 读取：任何人发 #标签，Bot 回出笔记。标签不带 # 存，触发时再拼。
// ============================================================
async function saveNote(env, chatId, tag, text) {
  await env.BOT_KV.put(`note:${chatId}:${tag.toLowerCase()}`, text);
}
async function handleHashtag(env, msg) {
  const m = (msg.text || "").match(/#([^\s#]{1,32})/);
  if (!m) return;
  const note = await env.BOT_KV.get(
    `note:${msg.chat.id}:${m[1].toLowerCase()}`,
  );
  if (note) return send(env, msg.chat.id, note);
}

// ============================================================
// 【核心模块】过滤器自动回复
// filter:<群ID>:<关键词> = 回复文本。管理员 /filter 关键词 回复内容
// 添加；普通消息包含关键词就自动回复（回复原消息，不刷屏新发）。
// 与 04 号违禁词的区别在处理动作：那个删，这个答。
// 注意：逐条消息全量扫 filter: 前缀在关键词多了以后会变慢，
// 单群控制在几十条内；再多就把整群过滤器合成一个 JSON 键存。
// ============================================================
async function handleFilter(env, msg) {
  if (!msg.text || msg.text.startsWith("/")) return;
  const list = await env.BOT_KV.list({
    prefix: `filter:${msg.chat.id}:`,
    limit: 100,
  });
  const lower = msg.text.toLowerCase();
  for (const k of list.keys) {
    const kw = k.name.split(":").slice(2).join(":");
    if (kw && lower.includes(kw.toLowerCase())) {
      const reply = await env.BOT_KV.get(k.name);
      if (reply)
        return send(env, msg.chat.id, reply, {
          reply_to_message_id: msg.message_id,
        });
    }
  }
}
```

## 接入步骤

1. 前提同 04 号：Bot 是群管理员、隐私模式关闭、KV 已绑定。
2. 入群事件（new_chat_members）里在原有验证流程**之前**调 `guardNewMemberPlus`：联邦和垃圾库命中就不必再走验证码了。
3. 命令补三条并注册进命令表：`/fban`（回复某人消息使用）、`/note`、`/filter`，全部先过群管理员/Bot 管理员判定（见 11 号模块）。
4. 普通消息分支末尾依次调 `handleHashtag`、`handleFilter`（都没命中才落到原有处理）。

## 注意点

- 联邦封禁是连坐工具，误封影响一片群：/fban 必须记操作者和理由（代码里已存），并给被封者留申诉路径，别做成一言堂按钮。
- CAS 是第三方社区数据，命中≠实锤：自动踢之前先警告模式跑一周看看误报率，重要群尤其如此。
- 笔记和过滤器只有管理员能写、所有人能触发，写入口的权限校验漏了就会被人塞广告。
- 过滤器和违禁词同开时顺序别反：先违禁词删除，被删的消息就不要再触发自动回复了。
