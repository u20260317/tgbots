# 16 · 签到积分与抽奖模块

> 留存玩法两件套：每日签到（连签加成）攒积分，管理员拿积分池办抽奖。日期按配置时区算（TZ_OFFSET），不然零点签到会算错天。

## 签到（摘自 13-checkin-lottery）

日期键 dayKey 决定「今天」：昨天签过则连签 +1，断签归 1；基础 10 分 + 连签加成，当天重复签只提示不重发。回复带完整日期，用户一眼能对账。

```js
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  // ---------- 签到 ----------
  if (cmd === "/qd" || cmd === "/checkin" || text === "签到") {
    const prof = await getProfile(env, msg.from.id);
    const today = dayKey(env);
    const todayLabel = (() => {
      const [y, m, d] = today.split("-").map(Number);
      return `${y}年${m}月${d}日`;
    })();
    if (prof.last === today)
      return send(
        env,
        chatId,
        `📅 ${todayLabel} 今天已经签过啦。当前积分 ${prof.p}，连签 ${prof.streak} 天，明天再来。`,
      );
    prof.streak = prof.last === yesterdayKey(env) ? prof.streak + 1 : 1;
    const gain = 10 + Math.min(prof.streak - 1, 10);
    prof.p += gain;
    prof.last = today;
    prof.name = who(msg.from);
    await saveProfile(env, msg.from.id, prof);
    return send(
      env,
      chatId,
      `✅ ${todayLabel} 签到成功 +${gain} 分（连签 ${prof.streak} 天）\n当前积分：${prof.p}`,
    );
  }
```

## 抽奖开奖

报名走按钮回调（见 03 号模块），名单存 KV `lot:`；开奖用 `crypto.getRandomValues` 抽（不用 Math.random，可复核的随机源），支持付费参与（报名先扣分，积分不足拦下）和多人中奖不重复。

```js
const isAdmin = (env, id) => admins(env).includes(String(id));
const dayKey = (env) =>
  new Date(Date.now() + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
const yesterdayKey = (env) =>
  new Date(
    Date.now() + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000 - 86400 * 1000,
  )
    .toISOString()
    .slice(0, 10);
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】积分存储（KV）
// pts:<用户ID> = { p:积分, last:上次签到日期, streak:连签天数, name:显示名}，签到/扣费/排行都走这里。
// ============================================================
async function getProfile(env, userId) {
  const raw = await env.BOT_KV.get("pts:" + userId);
```

## 注意点

- 时区是签到类第一大坑：dayKey 必须按目标用户时区算，模板默认 +8，可用 TZ_OFFSET 改。
- 积分增减都走同一个 addPoints 函数并同步显示名，排行榜（04 号模块的扫描模式）才不会出现改名后的双份记录。
- 抽奖付费参与属于「积分消费」，别和真实货币挂钩兑换，性质完全不同。
