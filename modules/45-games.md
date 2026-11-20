# 45 · HTML5 游戏平台模块

> Telegram 游戏不是 Mini App：它走的是一套更老的 Game API——Bot 用 sendGame 发一张游戏卡片，用户点 Play 后 Bot 在回调里回一个游戏 URL，分数由 Bot 用 setGameScore 写回那张卡片（卡片下方会自动显示好友排行榜）。本模块讲清这条链路和它最容易踩的一个坑：**游戏页面拿不到 initData，身份必须由 Bot 在回 URL 时自己注入**。

## 原理

链路四步：

1. **注册**：先在 BotFather 用 `/newgame` 注册游戏，拿到 `game_short_name`（如 `snake`）。代码里的 short_name 必须与注册的**一字不差**，sendGame 填错直接报错。
2. **发卡**：`sendGame { chat_id, game_short_name}` 发出一张游戏卡片（封面+Play 按钮）。也可以走 Inline 模式：inline_query 结果里 `type:"game"` + game_short_name，在任何聊天里 @ 出来。
3. **回 URL**：用户点 Play，Bot 收到 `callback_query`（带 `game_short_name`、`chat_instance`，以及卡片的 message 或 inline_message_id）。Bot 用 `answerCallbackQuery { url}` 把这个用户送进游戏页——**URL 是按人生成的**，这就是注入身份的唯一机会（见下节）。
4. **记分**：游戏结束，页面把分数报给 Bot 的后端，Bot 调 `setGameScore { user_id, score, chat_id+message_id 或 inline_message_id}`，分数出现在卡片的排行榜里。默认只有更高分才更新（force=true 可强制覆盖），disable_edit_message 控制要不要在卡片上贴「新纪录」字样。

**身份注入（关键）**：游戏页在 Telegram 的 webview 里打开，但 Game API 不像 Mini App 那样给页面 initData。通行做法：回 URL 时把 `{ uid, chat_id, message_id}` 打包成一个带 HMAC 签名的 token 拼在 URL 查询串里，页面结束时把 token + 分数 POST 回后端，后端验签后才调 setGameScore。没有这一步，任何人都能伪造别人的高分。

**防作弊的诚实边界**：分数终究是客户端报上来的，签名只能证明「是这个玩家这局报的」，证明不了「他真打了这么多分」。休闲排行榜够用；要认真防作弊得让游戏逻辑跑在服务端（回合制/服务端判定），那是另一个量级的工程，本模块不假装解决。

## 代码

```js
// ============================================================
// 发游戏卡片（sendGame）
// game_short_name 必须与 BotFather /newgame 注册的完全一致。
// 一张卡片一个游戏；发多个游戏就发多张卡片，或用 inline 结果。
// ============================================================
async function sendGameCard(env, chatId, gameShortName) {
return tg(env, "sendGame", { chat_id: chatId, game_short_name: gameShortName});
}

// ============================================================
// 分数令牌（HMAC 签名的身份注入）
// 回游戏 URL 时生成：payload = { u:用户ID, c:聊天ID, m:消息ID,
// inl:inline_message_id}，token = base64url(payload) + "." + 签名。
// 签名密钥由 BOT_TOKEN 派生，令牌只证明身份与场次，不证明分数真实性。
// ============================================================
const enc45 = new TextEncoder();
async function signToken(env, payloadObj) {
const key = await crypto.subtle.importKey(
"raw",
await crypto.subtle.digest("SHA-256", enc45.encode("game:" + env.BOT_TOKEN)),
{ name: "HMAC", hash: "SHA-256"},
false,
["sign"],
);
const body = btoa(JSON.stringify(payloadObj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sig = await crypto.subtle.sign("HMAC", key, enc45.encode(body));
const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
return body + "." + hex.slice(0, 32);
}
async function verifyToken(env, token) {
const [body, sig] = String(token || "").split(".");
if (!body ||!sig) return null;
const expect = (await signToken(env, JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))))).split(".")[1];
if (expect!== sig) return null;
try {
return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
} catch {
return null;
}
}

// ============================================================
// Play 回调 → 按人生成游戏 URL
// callback_query 里带 game_short_name 才是游戏回调（普通按钮回调
// 没有这个字段）。把令牌拼进 URL，用户点开的就是「他自己的场次」。
// ============================================================
async function onGameCallback(env, cq, games) {
const game = games[cq.game_short_name];
if (!game) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "游戏不存在"});
const payload = {
u: cq.from.id,
c: cq.message?.chat?.id,
m: cq.message?.message_id,
inl: cq.inline_message_id || undefined,
g: cq.game_short_name,
};
const token = await signToken(env, payload);
const url = `${game.url}?s=${encodeURIComponent(token)}`;
return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, url});
}

// ============================================================
// 记分（setGameScore）+ KV 排行榜
// setGameScore 让分数显示在 TG 卡片自带的榜上；自己再存一份 KV
// （gscore:<游戏>:<用户ID> = { s:最高分, name}）是为了能跨卡片、
// 跨聊天出总榜——TG 的卡片榜只在那一张卡片的聊天里看得到。
// ============================================================
async function submitScore(env, payload, score) {
const params = {
user_id: payload.u,
score: Math.max(0, Math.floor(score) || 0),
disable_edit_message: false,
};
if (payload.inl) params.inline_message_id = payload.inl;
else {
params.chat_id = payload.c;
params.message_id = payload.m;
}
const r = await tg(env, "setGameScore", params);
if (env.BOT_KV) {
const key = `gscore:${payload.g}:${payload.u}`;
const old = JSON.parse((await env.BOT_KV.get(key)) || '{"s":0}');
if (params.score > old.s)
await env.BOT_KV.put(key, JSON.stringify({ s: params.score, name: payload.name || old.name || ""}));
}
return r;
}
```

## 接入步骤

1. BotFather `/newgame`：选 Bot、填游戏名/描述/封面，拿到 short_name，逐字抄进代码的游戏注册表。
2. Worker 路由：`/game/<name>` 返回游戏页 HTML（自包含单页，零外部资源最稳），`/api/score` 收页面 POST 的 `{ s:令牌, score}`。
3. webhook 的 handle 里先判 `cq.game_short_name` 分发到 `onGameCallback`（要在普通 callback 分发之前，游戏回调没有 data 字段）。
4. 游戏页结束时 fetch POST 分数；页面里能读到的只有 URL 上的令牌，原样带回即可，别让页面自己拼用户 ID。
5. 排行榜命令扫 `gscore:<游戏>:` 前缀出总榜（模式同模块 04 的全量扫描）。

## 注意点

- short_name 对不上是头号报错源：注册名、sendGame、游戏注册表三处必须一致，改名要回 BotFather 删了重注册。
- 游戏页必须是 HTTPS 且能被 Telegram 的 webview 打开；页面里别依赖 Telegram.WebApp SDK（Game 环境没有它，只有普通浏览器 API）。
- setGameScore 对同一条卡片重复提交低分默认不更新（除非 force），这正是「最高分」语义；想记每局流水自己往 KV 里 append，别指望 TG 侧。
- 令牌要设时效意识：场次令牌活太久会被转发复用刷分，payload 里可加过期时间戳，验签时一并查（休闲场景可省，代码里留了 payload 可扩展的位置）。
- Inline 模式发游戏卡片（type:"game"）时没有 message 坐标，记分只能靠 inline_message_id——payload 里的 inl 字段就是为它留的，两个分支都要测。
