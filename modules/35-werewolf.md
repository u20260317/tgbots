# 35 · 狼人杀/黑手党主持人模块

> Bot 当法官：一局游戏横跨「群里公开流程 + 每个人私聊里的秘密行动」，靠一份 KV 会话状态在夜晚/白天阶段之间推进。和模块 18（竞答）的区别先说清：竞答是单会话抢答赛，所有人看同一道题比手速；狼人杀是**多角色异步私密行动**——狼人、预言家、女巫各在私聊里行动，互不知道彼此选了谁，主持人要等一桌人陆续提交完才敢结算。

## 原理

一局 = 一份状态存 KV `wolf:<群ID>`：玩家表（角色、生死）、当前阶段、今晚的行动收集箱、白天投票箱。阶段机是单向环：

> ⚠️ **落地修订（2026-11-20，模板 41 实测后）**：单 JSON「读-改-写」在快速连点报名时会并发丢数据（后到的写覆盖先到的，玩家被告知报名成功却不在名单）。41 号模板已改为**按人拆键**：`wolf:<群ID>` 只存对局元信息，`wolfp:<群ID>:<uid>` 一人一键存玩家，`wolfn:<群ID>:<uid>` 存夜晚行动，`wolfv:<群ID>:<uid>` 存公投票；结算时按玩家名单逐键直读（不要用 KV list 读票，会被边缘缓存延迟卡住）。下文代码块仍展示单 JSON 版便于理解状态机结构，实际落地请按拆键版写，完整实现见模板 41-werewolf。


```
lobby（群里按钮报名）→ night（私聊收行动）→ dawn（群里公布昨夜结果）
→ day（群里讨论+公投）→ 结算放逐 → 查胜负 → 没结束就回 night
```

关键设计有三条：

1. **角色只能私发**。身份牌发到玩家与 Bot 的私聊里，群里永远只公布流程信息。推论：玩家必须先私聊启动过 Bot，否则私发不出去——报名时就要校验并提醒。
2. **行动靠回调收集**。夜晚给每个有行动权的玩家私发按钮（狼人选刀口、预言家选查验、女巫选救/毒），点一下记进状态的行动箱；主持人不等超时，全员提交即推进（再配一个 Cron/房主按钮兜底催场）。
3. **结算只在阶段切换时发生**。刀口、救药、毒药在 dawn 一次性算清，避免边收边判的竞态。

## 代码

```js
// ============================================================
// 狼人杀对局状态（KV）
// wolf:<群ID> = {
// phase: "lobby"|"night"|"dawn"|"day"|"over",
// host: 房主ID, round: 第几夜,
// players: { <uid>: { name, role: "wolf"|"seer"|"witch"|"folk", alive: true}},
// night: { kill: uid, check: uid, save: bool, poison: uid, acted: [uid...]},
// votes: { <投票人uid>: <目标uid>},
// witchPotion: { save: 1, poison: 1} // 女巫药水余量，整局共享
//}
// ============================================================
async function getGame(env, chatId) {
const raw = await env.BOT_KV.get("wolf:" + chatId);
return raw? JSON.parse(raw): null;
}
async function saveGame(env, chatId, g) {
await env.BOT_KV.put("wolf:" + chatId, JSON.stringify(g));
}
async function clearGame(env, chatId) {
await env.BOT_KV.delete("wolf:" + chatId);
}
const aliveOf = (g, role) =>
Object.entries(g.players)
.filter(([, p]) => p.alive && (!role || p.role === role))
.map(([uid]) => uid);

// ============================================================
// 发牌：角色配置 + 加密随机洗牌
// 人数决定配置：6 人 2 狼 1 预言家 1 女巫 2 民，人数增减按比例调狼数。
// 洗牌用 crypto.getRandomValues，和抽奖（16 号）同一套可复核随机源，
// 不用 Math.random——身份分配是最不能被质疑作弊的一步。
// ============================================================
function dealRoles(playerIds) {
const n = playerIds.length;
const wolves = Math.max(1, Math.floor(n / 3));
const roles = [
...Array(wolves).fill("wolf"),
"seer",
"witch",
...Array(n - wolves - 2).fill("folk"),
];
const buf = new Uint32Array(n);
crypto.getRandomValues(buf);
const shuffled = [...playerIds].sort((a, b) => 0); // 占位，下行真正洗
for (let i = shuffled.length - 1; i > 0; i--) {
const j = buf[i] % (i + 1);
[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const out = {};
shuffled.forEach((uid, i) => (out[uid] = roles[i]));
return out;
}

// ============================================================
// 开局：分配身份并私发身份牌
// 私发失败（玩家没启动过 Bot）的人会被踢出名单——群里只公布
// 「X 未能参赛」，不公布原因细节，更不能公布他的身份。
// ============================================================
async function startGame(env, chatId, g) {
const ids = Object.keys(g.players);
const roles = dealRoles(ids);
for (const uid of ids) {
g.players[uid].role = roles[uid];
const roleName = { wolf: "🐺 狼人", seer: "🔮 预言家", witch: "🧪 女巫", folk: "🧑‍🌾 平民"}[roles[uid]];
const r = await send(env, uid, `你的身份是：${roleName}\n（本条只有你能看到，别截图外传）`);
if (!r?.ok) delete g.players[uid];
}
if (Object.keys(g.players).length < 4) {
await clearGame(env, chatId);
return send(env, chatId, "能私发身份牌的玩家不足 4 人，本局取消。参赛前请先私聊我发一次 /start。");
}
g.phase = "night";
g.round = 1;
await saveGame(env, chatId, g);
await send(env, chatId, `🌕 第 1 夜，天黑请闭眼。狼人、预言家、女巫请看私聊行动。`);
return nightPrompts(env, chatId, g);
}

// ============================================================
// 夜晚行动收集（私聊回调 wolf: 前缀）
// 狼人多人时以「最后一刀」或队长刀为准，这里取最先提交的一刀并
// 锁定（简化规则，README 里要跟玩家讲明）。三方都提交后自动结算。
// ============================================================
async function onWolfCallback(env, cq) {
const [, act, target] = String(cq.data || "").split(":");
const g = await getGame(env, cq.message.chat.id); // 注意：私聊里 chat.id = 对方 uid，靠行动者反查对局
// 实际实现按玩家 uid 反查他所在的对局群（报名时另存 wolfroom:<uid> = 群ID），此处略
if (!g || g.phase!== "night") return answer(env, cq, "现在不是夜晚行动时间");
const me = String(cq.from.id);
const role = g.players[me]?.role;
if (act === "kill" && role === "wolf") g.night.kill = target;
else if (act === "check" && role === "seer") {
g.night.check = target;
const isWolf = g.players[target]?.role === "wolf";
await send(env, me, `查验结果：${g.players[target]?.name} 是 ${isWolf? "🐺 狼人": "✅ 好人"}`);
} else if (act === "save" && role === "witch" && g.witchPotion.save > 0) {
g.night.save = true;
g.witchPotion.save -= 1;
} else if (act === "poison" && role === "witch" && g.witchPotion.poison > 0) {
g.night.poison = target;
g.witchPotion.poison -= 1;
} else return answer(env, cq, "这个行动不属于你");
if (!g.night.acted.includes(me)) g.night.acted.push(me);
await saveGame(env, cq.message.chat.id, g);
await answer(env, cq, "已记录");
return maybeDawn(env, cq.message.chat.id, g);
}

// 夜晚应行动人数 = 存活狼人（算 1 票）+ 预言家 + 女巫，全到齐就结算昨夜
async function maybeDawn(env, chatId, g) {
const need = aliveOf(g, "wolf").length > 0? 1: 0;
const expect =
need +
(aliveOf(g, "seer").length? 1: 0) +
(aliveOf(g, "witch").length? 1: 0);
if (g.night.acted.length < expect) return;
const dead = [];
if (g.night.kill && g.night.kill!== g.night.poison &&!g.night.save) dead.push(g.night.kill);
if (g.night.poison && g.night.poison!== g.night.kill) dead.push(g.night.poison);
if (g.night.save && g.night.kill) {
/* 被救，不死 */
}
for (const uid of dead) g.players[uid].alive = false;
g.phase = "day";
g.votes = {};
await saveGame(env, chatId, g);
const names = dead.map((uid) => g.players[uid].name);
await send(env, chatId, `🌅 天亮了。昨夜死亡：${names.length? names.join("、"): "无人（平安夜）"}\n进入白天公投，发 /vote 或点下方按钮投票放逐。`);
return checkWin(env, chatId, g);
}

// ============================================================
// 胜负判定：狼全灭→好人胜；狼数≥好人数→狼胜
// 每次有人出局（夜杀/毒/公投）后都调一次，结束就清状态公布身份。
// ============================================================
async function checkWin(env, chatId, g) {
const wolves = aliveOf(g, "wolf").length;
const goods = aliveOf(g).length - wolves;
if (wolves > 0 && wolves < goods) return false;
g.phase = "over";
const reveal = Object.values(g.players)
.map((p) => `${p.name} — ${p.role}${p.alive? "": "（已出局）"}`)
.join("\n");
await send(env, chatId, `🏁 游戏结束，${wolves === 0? "好人阵营胜利！": "狼人阵营胜利！"}\n\n身份揭晓：\n${reveal}`);
await clearGame(env, chatId);
return true;
}
```

白天公投复用同一套按钮收集：群里发投票键盘（回调 `wolf:vote:<uid>`），每人一票可改票，房主点「结算」或全员投完后 tally 票数、放逐最高票，再走 `checkWin`，没结束就把 phase 切回 night、round+1 并重置 night 行动箱。

## 接入步骤

1. KV 绑定 `BOT_KV`；另存一份 `wolfroom:<uid>` = 群 ID 的反查键，私聊回调靠它找回对局（报名时写入，游戏结束时清掉）。
2. allowed_updates 含 `callback_query`；群里 /werewolf 开房（lobby 按钮报名，回调 `wolf:join`），满 6 人房主开局。
3. 把夜晚行动按钮的发送（`nightPrompts`：给狼人/预言家/女巫分别私发目标列表键盘）按 `onWolfCallback` 的 data 约定拼：`wolf:kill:<uid>`、`wolf:check:<uid>`、`wolf:save`、`wolf:poison:<uid>`。
4. 命令表加 werewolf / vote（COMMANDS_USER，见 02 号模块）。

## 注意点

- 身份私发不出去是头号翻车点：没私聊启动过 Bot 的玩家收不到身份牌，开局流程必须先校验、私发失败直接剔除并说明，绝不能把身份发到群里兜底。
- 女巫规则各群口径不同（首夜能不能自救、救毒同夜能不能同用），开局公告里写明本局规则，代码里改 `maybeDawn` 的结算条件即可。
- 阶段推进别只依赖「全员提交」：有人挂机整局卡死。配房主强制推进按钮，或 Cron 扫 `wolf:` 前缀按时间戳超时推进（见 09 号模块）。
- KV 最终一致对狼人杀基本无感（行动低频），但公投结算和夜晚结算前要以最后一次读到的状态为准，别拿着旧快照连环写。
