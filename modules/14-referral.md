# 14 · 邀请归因模块

> 「谁拉来的人，算谁的」：两条归因通道——Bot 深链（点链接启动 Bot）和群邀请链接（点链接进群）。核心是防刷：同一个人只能被归因一次。

## 记账函数（摘自 16-referral）

两道防线：不能邀自己；`refdone:<新人ID>` 落过记录就不再重复计数。邀请人的计数存 `ref:<邀请人ID>`。

```js
async function creditReferrer(env, referrerId, newUser) {
  if (String(referrerId) === String(newUser.id)) return false; // 不能邀自己
  const done = await env.BOT_KV.get("refdone:" + newUser.id);
  if (done) return false; // 已经归因过
  const raw = await env.BOT_KV.get("ref:" + referrerId);
  const rec = raw ? JSON.parse(raw) : { count: 0, name: "" };
  rec.count += 1;
  await env.BOT_KV.put("ref:" + referrerId, JSON.stringify(rec));
  await env.BOT_KV.put("refdone:" + newUser.id, String(referrerId));
  await send(
    env,
    referrerId,
    `🎉 邀请 +1！${who(newUser)} 通过你的链接来了，你已累计邀请 ${rec.count} 人。`,
  ).catch(() => {});
  return true;
}
```

## 通道 A：深链

用户专属链接 `t.me/Bot?start=ref_<ID>`，新人启动 Bot 时从 /start 参数里解析出来归因：

```js

  // ---------- A：深链拉新归因 ----------
  const refM = text.match(/^\/start(?:@\w+)?\s+ref_(\d+)/);
  if (refM) {
    const credited = await creditReferrer(env, refM[1], msg.from);
    return send(
      env,
      chatId,
      credited
        ? "👋 欢迎！你通过朋友的邀请链接而来，他已收到邀请奖励。"
        : "👋 欢迎！发 /invite 拿你的专属邀请链接。",
    );
  }

```

## 通道 B：群邀请链接

给每个用户在目标群建一条专属邀请链接（name 标成 `ref<用户ID>`），新人进群时 `chat_member` 更新里带着链接名，反查归因。前提：Bot 是群管理员、allowed_updates 含 chat_member。

## 注意点（合规边界）

- 本模块只做「自己邀请链接的统计」，不做批量私信拉人、采集群成员、自动加人——那些是平台明令禁止的刷量玩法，本库不收录。
- 归因奖励要设上限和延迟发放（进群秒退不算），防小号农场；16 的实现是即时计数，做活动时建议再加一道「在群满 24 小时」校验。
