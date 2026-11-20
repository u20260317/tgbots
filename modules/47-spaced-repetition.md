# 47 · 间隔重复算法模块（SM-2 简化版）

> 闪卡记忆的心脏：每张卡片按「记得多牢」动态排下一次复习时间。算法用 Anki 祖师爷 SM-2 的简化版——三个数（ease / interval / reps）决定一切，纯计算零外部 API，与 KV + Cron 天然合拍。落地模板：58（闪卡记忆）。

## 原理

**核心思想**：刚学会的卡明天就复习，连续答对几次后间隔指数拉长（1 天 → 6 天 → 按 ease 倍增），答错则打回重学。SM-2 给每张卡维护：

- `ease`（难易系数，初始 2.5，下限 1.3）：答得越轻松涨得越多，卡越「简单」间隔拉得越长；
- `interval`（当前间隔天数）：第 1 次答对 = 1 天，第 2 次 = 6 天，之后 = 上次间隔 × ease；
- `reps`（连续答对次数）：答错清零，interval 回到 1 天。

**评分口径**：原版 SM-2 用 0-5 分。本模块收敛成三档按钮，正好对应 Telegram 的一行三按钮：😵 忘了（q=1，等同答错）、🤔 想起来了（q=3）、😎 太简单（q=5）。映射公式沿用原版 ease 更新式 `ease + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))`。

**存储与调度**：卡片本体存一条 KV（`card:<uid>:<卡组>:<卡id>`，值里带 srs 状态），另存一份「今日到期索引」或直接全量扫前缀按 `due`（日期键）过滤——千级卡片内全量扫没问题（与模块 04 的排行榜同口径）。复习推送靠 Cron 每天扫到期卡提醒，或用户主动 /review 拉当天的量。本模块只管算法与存法，卡片 CRUD 与推送在模板 58。

## 代码

```js
// ============================================================
// 间隔重复调度（SM-2 简化版）
// 状态 srs = { ease:2.5, interval:0, reps:0, due:"YYYY-MM-DD"}。
// grade: 1=忘了 / 3=想起来了 / 5=太简单（Telegram 三按钮口径）。
// reviewCard(srs, grade, today) → 新 srs（纯函数，不碰存储）。
// ============================================================
const dayKey = (offsetDays = 0) =>
new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000)
.toISOString()
.slice(0, 10);
function newSrs(today) {
return { ease: 2.5, interval: 0, reps: 0, due: today};
}
function reviewCard(srs, grade, today) {
const s = {...srs};
if (grade < 3) {
// 忘了：连续答对清零，明天重来；ease 小幅下调作惩罚
s.reps = 0;
s.interval = 1;
s.ease = Math.max(1.3, s.ease - 0.2);
} else {
if (s.reps === 0) s.interval = 1;
else if (s.reps === 1) s.interval = 6;
else s.interval = Math.round(s.interval * s.ease);
s.reps += 1;
s.ease = Math.max(
1.3,
s.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)),
);
}
s.due = dayKey(0) === today? dayKey(s.interval): addDays(today, s.interval);
return s;
}
function addDays(dateStr, days) {
const d = new Date(dateStr + "T00:00:00+08:00");
d.setTime(d.getTime() + days * 86400000);
return d.toISOString().slice(0, 10);
}
// 到期判定与取卡：全量扫前缀后按 due <= today 过滤并排序
async function dueCards(env, uid, today) {
const list = await env.BOT_KV.list({ prefix: `card:${uid}:`, limit: 1000});
const due = [];
for (const k of list.keys) {
const raw = await env.BOT_KV.get(k.name);
if (!raw) continue;
const card = JSON.parse(raw);
if (card.srs && card.srs.due <= today) due.push({ key: k.name, card});
}
due.sort((a, b) => (a.card.srs.due < b.card.srs.due? -1: 1));
return due;
}
```

## 接入步骤

1. 建卡时给每张卡挂 `srs: newSrs(today)`，存 `card:<uid>:<卡组>:<卡id>`（卡面内容与 srs 同一条 JSON）。
2. 复习流程：`dueCards()` 拉今日到期 → 逐张出题（先示正面，用户点「看答案」再出三档评分按钮，回调里带卡 key 下标）→ 按 grade 调 `reviewCard()` 更新 srs 存回。
3. 推送（可选）：Cron 每天扫各用户到期数 >0 时提醒一句，别把卡片正文直接推出来（锁屏剧透答案）。

## 注意点

- **日期键时区要统一**：全库 dayKey 按 UTC+8；用户跨时区时 due 会差一天，属可接受近似，别为这个引入 per-user 时区设置（复杂度爆炸）。
- **ease 下限 1.3 是原版红线**：没有下限时难卡会 ease 归零、间隔永远 1 天，用户被同一张卡折磨到弃用。
- **别一上来就上 FSRS**：FSRS 拟合更准但要权重训练与历史数据，模板场景过重；SM-2 简化版参数透明、出问题能手算复现，这正是选它的理由。
- **答错别惩罚太狠**：本版只清 reps 并 ease -0.2；原版 SM-2 对低分还有更重的惩罚，实测太挫败，收敛到这档是刻意的。
