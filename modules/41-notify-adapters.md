# 41 · 通知适配器模块

> 模块 20（推送 API）是「什么都能往里发的通用口」，本模块是两个**带语义的专用适配器**：GitHub webhook 事件翻成人话推送、服务器/定时任务的存活监控（dead man's switch）。区别在于：通用口只管送达，这两个还要验签、解析事件、判断死活。

## 原理

**GitHub 适配器**：仓库设置里把 webhook 指到 Bot 的一个路径，GitHub 每次事件都 POST 一份 JSON 并带 `X-Hub-Signature-256` 签名（用你设的 Secret 做 HMAC-SHA-256）。Bot 验签 → 按事件类型挑字段 → 拼成一句话发到绑定群。只处理你关心的几种事件，其余静默丢弃，不然一个活跃仓库能把群刷爆。

**存活监控**：逻辑反过来——不是「出事时发消息」，而是「活着就定期打卡，超时没打卡才告警」。被监控的脚本/服务器每隔 N 分钟请求一次 `/ping/<名字>`，Bot 把时间戳记进 KV；Cron 每分钟扫一遍，超时未打卡就告警，恢复打卡再发一条「已恢复」。好处是被监控方挂得再彻底（连告警代码都跑不了）也能被发现，这正是 dead man's switch 的意义。

## 代码

```js
// ============================================================
// GitHub webhook 验签（HMAC-SHA-256）
// 签名 = "sha256=" + HMAC(secret, 原始请求体)。必须拿原始字节
// 算，不能先 JSON.parse 再 stringify——键序和空白都会变。
// 比较用恒定时间，避免时序侧信道（Web Crypto 无 timingSafeEqual，
// 手工异或累加实现一个简版）。
// ============================================================
async function verifyGithubSig(secret, rawBody, sigHeader) {
if (!sigHeader?.startsWith("sha256=")) return false;
const key = await crypto.subtle.importKey(
"raw",
new TextEncoder().encode(secret),
{ name: "HMAC", hash: "SHA-256"},
false,
["sign"],
);
const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
const mine = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
const theirs = sigHeader.slice(7);
if (mine.length!== theirs.length) return false;
let diff = 0;
for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ theirs.charCodeAt(i);
return diff === 0;
}

// ============================================================
// GitHub 事件格式化
// 只翻四类高价值事件；其余 return null 静默。同一 delivery
// GitHub 可能重发，用 gh:<deliveryId> 在 KV 里去重（TTL 1 天）。
// ============================================================
function formatGithubEvent(event, p) {
const repo = p.repository?.full_name || "";
switch (event) {
case "push": {
const commits = (p.commits || []).slice(0, 5);
const lines = commits.map((c) => `· ${c.message.split("\n")[0]}（${c.author?.username || c.author?.name}）`);
return `📦 ${repo} 有新推送（${p.ref.replace("refs/heads/", "")}）\n${lines.join("\n")}`;
}
case "pull_request": {
const pr = p.pull_request;
const act = { opened: "新开", closed: pr.merged? "已合并": "已关闭", reopened: "重开"}[p.action];
if (!act) return null;
return `🔀 ${repo} PR ${act}：#${pr.number} ${pr.title}\n${pr.html_url}`;
}
case "issues": {
if (!["opened", "closed", "reopened"].includes(p.action)) return null;
return `🐛 ${repo} Issue #${p.issue.number} ${p.action}：${p.issue.title}\n${p.issue.html_url}`;
}
case "release": {
if (p.action!== "published") return null;
return `🚀 ${repo} 发布新版本 ${p.release.tag_name}：${p.release.name || ""}\n${p.release.html_url}`;
}
default:
return null;
}
}

// fetch 路由：POST /gh?key=<WEBHOOK_SECRET>（与 /setWebhook 共用密钥习惯）
async function handleGithubWebhook(env, request) {
const raw = await request.text();
const ok = await verifyGithubSig(env.GH_SECRET, raw, request.headers.get("x-hub-signature-256"));
if (!ok) return new Response("bad signature", { status: 401});
const delivery = request.headers.get("x-github-delivery");
if (delivery) {
const seen = await env.BOT_KV.get("gh:" + delivery);
if (seen) return new Response("dup");
await env.BOT_KV.put("gh:" + delivery, "1", { expirationTtl: 86400});
}
const text = formatGithubEvent(request.headers.get("x-github-event"), JSON.parse(raw));
if (text && env.NOTIFY_CHAT_ID) await send(env, env.NOTIFY_CHAT_ID, text);
return new Response("ok");
}

// ============================================================
// 存活监控（dead man's switch）
// ping:<名字> = { last: 上次打卡时间戳, alerted: 是否已告警}
// 打卡入口：GET /ping/<名字>?key=<WEBHOOK_SECRET>，被监控方
// 用 curl 一行就能接：curl -fsS https://.../ping/备份脚本?key=xx
// 扫描挂在 Cron 上（模块 09）：超时 → 告警一次（alerted 标记
// 防每分钟重复轰炸）；恢复打卡 → 发恢复通知并清标记。
// ============================================================
async function handlePing(env, name) {
const prev = JSON.parse((await env.BOT_KV.get("ping:" + name)) || "null");
await env.BOT_KV.put("ping:" + name, JSON.stringify({ last: Date.now(), alerted: false}));
if (prev?.alerted && env.NOTIFY_CHAT_ID)
await send(env, env.NOTIFY_CHAT_ID, `✅ 「${name}」已恢复打卡。`);
return new Response("ok");
}

async function scanPings(env, timeoutMs = 30 * 60 * 1000) {
const list = await env.BOT_KV.list({ prefix: "ping:", limit: 100});
for (const k of list.keys) {
const rec = JSON.parse((await env.BOT_KV.get(k.name)) || "null");
if (!rec || rec.alerted) continue;
if (Date.now() - rec.last > timeoutMs) {
rec.alerted = true;
await env.BOT_KV.put(k.name, JSON.stringify(rec));
if (env.NOTIFY_CHAT_ID)
await send(env, env.NOTIFY_CHAT_ID, `🔴 「${k.name.slice(5)}」已超过 ${Math.round(timeoutMs / 60000)} 分钟没有打卡，可能已挂，请检查！`);
}
}
}
```

## 接入步骤

1. KV 绑定 `BOT_KV`；环境变量：`GH_SECRET`（GitHub webhook 的 Secret，Secret 类型）、`NOTIFY_CHAT_ID`（接收群/个人 ID，用 08 号工具查）。
2. fetch 路由加两个分支：`POST /gh` → handleGithubWebhook；`GET /ping/<名字>` → 校验 key 后 handlePing。
3. GitHub 仓库 Settings → Webhooks → Add：Payload URL 填 `https://你的Worker/gh?key=...`，Content type 选 application/json，Secret 填与 GH_SECRET 相同的值，事件选 Push / Pull requests / Issues / Releases。
4. Cron 每分钟触发 scanPings（见 09 号模块的节奏表，表达式 `* * * * *`）；超时阈值按被监控方的打卡周期设，一般取周期的 2–3 倍。

## 注意点

- GitHub 验签必须用**原始请求体**，这是最常见的验签失败原因；其次是 Secret 两边不一致，排查时先在 GitHub 的 Recent Deliveries 里看返回码。
- ping 的 key 别用太弱的串——打卡口虽然只写时间戳，但被恶意狂打能掩盖真实故障（一直「活着」），key 当密码管理。
- 告警阈值别设太紧：网络抖动、GitHub Actions 排队都会让打卡晚几分钟，阈值取周期 2–3 倍 + alerted 只报一次，才不会狼来了。
- GitHub 事件全开会刷屏：仓库侧订阅时只勾真正关心的事件，格式化函数里对 push 的 commit 列表也做了截断（前 5 条）。
