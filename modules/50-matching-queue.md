# 50 · 匹配队列模块

> 陌生人社交的共用底座：把「想被匹配的人」排进队列，按规则两两配对，配对后管会话、防重复、能举报封禁。随机聊天（模板 52）与相亲交友（模板 77）共用这一套——52 是即时队列（来了就配、聊完即散），77 是档案池（卡片常驻、异步互选），队列与安全骨架相同，只是「候选来源」不同。

## 原理

**队列键设计**：等匹配的人一人一键 `matchq:<uid> = {t: 入队时间, chat, prefs}`。一人一键的好处是出队/超时清理就是删自己的键，不用维护一张大队列表反复整表读写（KV 无事务，整表读-改-写在并发下会互相覆盖——41 号狼人杀拆键的教训，全库通用）。找搭档时扫 `matchq:` 前缀，跳过自己与「最近配过的人」，取入队最早的——先来先配，公平且实现最简单。

**防重复配对**：每人存一份最近伙伴名单 `match:recent:<uid> = [uid...]`（只留最近 10 个），挑选时双向排除：我最近配过的、以及最近配过我的都不再配。没有这层，两个人反复进出队列会被无限重新配到一起，体验和骚扰只在一线间。

**会话**：配对成功写两条镜像会话键 `match:pair:<uid> = {peer, since}`（双方各一条，转发消息时按发送者查 peer 直达，不用扫表）。结束（/stop 或一方被封）时两条一起删，并把对方写进彼此的 recent。

**举报封禁骨架**：举报按「不同举报者」计数存 `match:rep:<uid> = [reporter...]`，达阈值写 `match:ban:<uid>` 并强制结束其当前会话、清其队列键。计数、阈值、通知管理员这套与 77 的实现完全同构——本模块给出骨架函数，业务侧（随机聊天的中继转发、交友的卡片浏览）各自接。

## 代码

```js
// ============================================================
// 匹配队列：一人一键 + 双向防重复
// joinQueue 入队；leaveQueue 出队；findPartner 扫队列取最早的
// 合格搭档（排除自己、被封者、recent 双向名单）。KV 无事务，
// 并发下两个人可能同时选中同一个搭档——配对落键时以
// match:pair 是否已存在做二次确认，先到先得，后到者重找。
// ============================================================
async function joinQueue(env, uid, data) {
await env.BOT_KV.put(
"matchq:" + uid,
JSON.stringify({ t: Date.now(),...data}),
{ expirationTtl: 600},
);
}
async function leaveQueue(env, uid) {
await env.BOT_KV.delete("matchq:" + uid);
}
async function isMatchBanned(env, uid) {
return Boolean(await env.BOT_KV.get("match:ban:" + uid));
}
async function recentOf(env, uid) {
const raw = await env.BOT_KV.get("match:recent:" + uid);
return raw? JSON.parse(raw): [];
}
async function findPartner(env, uid, prefsFit) {
const myRecent = await recentOf(env, uid);
const list = await env.BOT_KV.list({ prefix: "matchq:", limit: 1000});
const candidates = list.keys
.map((k) => k.name.slice("matchq:".length))
.filter((other) => other!== String(uid))
.sort();
for (const other of candidates) {
if (myRecent.map(String).includes(other)) continue;
if (await isMatchBanned(env, other)) continue;
const theirRecent = await recentOf(env, other);
if (theirRecent.map(String).includes(String(uid))) continue;
const raw = await env.BOT_KV.get("matchq:" + other);
if (!raw) continue;
const entry = JSON.parse(raw);
if (prefsFit &&!prefsFit(entry)) continue;
return { uid: other, entry};
}
return null;
}
// 配对落键：双方镜像写 match:pair，并互相记进 recent（留 10）
async function makePair(env, a, b) {
const now = Date.now();
for (const [me, peer] of [[a, b], [b, a]]) {
if (await env.BOT_KV.get("match:pair:" + me)) return false;
}
for (const [me, peer] of [[a, b], [b, a]]) {
await env.BOT_KV.put(
"match:pair:" + me,
JSON.stringify({ peer, since: now}),
);
const recent = await recentOf(env, me);
recent.unshift(peer);
await env.BOT_KV.put(
"match:recent:" + me,
JSON.stringify(recent.slice(0, 10)),
);
await leaveQueue(env, me);
}
return true;
}
async function breakPair(env, uid) {
const raw = await env.BOT_KV.get("match:pair:" + uid);
if (!raw) return null;
const { peer} = JSON.parse(raw);
await env.BOT_KV.delete("match:pair:" + uid);
await env.BOT_KV.delete("match:pair:" + peer);
return peer;
}

// ============================================================
// 举报与自动封禁（与模板 77 同构）
// reportMatchUser：不同举报者计数 → 达阈值（MATCH_REPORT_LIMIT
// 默认 3）→ 封禁 + 强拆当前会话 + 清队列 + 通知管理员。
// ============================================================
async function reportMatchUser(env, reporterId, targetUid, notifyAdmin) {
const key = "match:rep:" + targetUid;
const raw = await env.BOT_KV.get(key);
const reps = raw? JSON.parse(raw): [];
if (!reps.map(String).includes(String(reporterId))) reps.push(reporterId);
await env.BOT_KV.put(key, JSON.stringify(reps));
const limit = Number(env.MATCH_REPORT_LIMIT) || 3;
if (reps.length >= limit &&!(await isMatchBanned(env, targetUid))) {
await env.BOT_KV.put("match:ban:" + targetUid, "1");
await breakPair(env, targetUid);
await leaveQueue(env, targetUid);
if (notifyAdmin) await notifyAdmin(targetUid, reps.length);
return true;
}
return false;
}
```

## 接入步骤

1. 入队口：用户点「开始匹配」→ 先查 `match:ban` 拦截 → `joinQueue` → 立刻 `findPartner` 试配；配不到就留在队列里，等下一个人入队时以他为发起方再试（双方都要走同一段「入队即试配」逻辑）。
2. 配对成功：`makePair` 落键（返回 false 说明对方刚被别人配走，重跑 `findPartner`）；之后消息转发按 `match:pair:<发送者>` 查 peer 中继（52 的玩法），或进入各自的业务流（77 的互选确认）。
3. 结束口：/stop、超时、被封禁都走 `breakPair`，并给对方发一句「对方已离开」。
4. 举报口：卡片/会话里的举报按钮回调里调 `reportMatchUser`，notifyAdmin 传「给全部管理员发通知」的闭包。

## 注意点

- **队列键务必设 expirationTtl**（本模块 10 分钟）：用户入队后关掉 Telegram 是常态，没有 TTL 的队列会被僵尸塞满，活人永远配到死号。续期靠用户点「继续等待」重新入队刷新。
- **并发配对只能尽力而为**：KV 没有事务/锁，`makePair` 的二次确认把冲突压到极小但不是零——极小概率双配时，以 `match:pair` 后写覆盖为准，业务侧转发查不到 peer 时要能优雅提示「对方已离开」而不是抛错。
- **封禁是行为封禁不是身份封禁**：换号就能回来，这是所有 TG Bot 的共同边界；阈值别设太低（误报会冤枉人），也别只靠自动封禁——管理员复核通道（看举报数、手动解封）必须留。
- **未成年与安全提示是业务侧的责任**：本模块只给队列与封禁骨架，入场年龄确认、敏感词、防诈骗文案要在模板层做齐（见 52/77 的 README），别以为接了队列就能上线陌生人社交。
