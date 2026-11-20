# 48 · 网页快照与 diff 模块

> 给没有 RSS 的页面做「变化监控」：定时抓正文 → 归一化 → 存哈希与文本快照 → 变了就推一段行级 diff 摘要。是模块 15（RSS）的姊妹篇：RSS 是源站主动给结构化更新，没 RSS 时只能自己抓自己比。落地模板：60（网站更新监控）、76（比价追踪的抓取层同源）。

## 原理

**四步管线**：
1. **抓**：`fetch` 拉 HTML（带自报家门的 UA、超时、大小上限），沿用模块 40 的 SSRF 私有地址拦截——监控目标是用户填的任意 URL，Bot 的 fetch 是服务器身份，不能当内网跳板；
2. **提取正文**：剥掉 script/style/nav/footer 等噪声标签与全部 HTML 标签，只留文本。 Workers 里没有 DOM 库，全靠正则做「够用的提取」——新闻/博客/公告页够用，复杂门户会混入导航文字，归一化后靠 diff 阈值兜（见下）；
3. **归一化 + 哈希**：连续空白折叠、行首尾去空白、删空行，再 `crypto.subtle.digest("SHA-256")` 存哈希当变化哨兵：哈希没变连 diff 都不用算；
4. **diff 摘要**：哈希变了才做行级对比——本模块用「行集合 + 简单 LCS 摘要」的轻量口径：输出新增行与删除行各最多 N 条（默认各 5 条、每条截 100 字），足够让用户判断「改了什么」，不追求 git 级精确 diff。

**防误报**：很多页面带动态噪声（时间戳、访问计数、随机推荐位），每次抓都「变」。两个对策：归一化时可配 `ignoreRe` 把已知噪声行整行删掉；提醒阈值——变化行数占总行数比例太小（如 <2%）时只更新快照不推送（可在调用侧调）。首次抓取只播种不推送，与 11 号 RSS 同口径。

## 代码

```js
// ============================================================
// URL 安全（SSRF 防护，与模块 40 同口径）
// ============================================================
function isSafePublicUrl(u) {
let url;
try {
url = new URL(u);
} catch {
return false;
}
if (!["http:", "https:"].includes(url.protocol)) return false;
const host = url.hostname.toLowerCase();
if (host === "localhost" || host.endsWith(".local")) return false;
if (
/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
)
return false;
if (host === "::1" || host.startsWith("fc") || host.startsWith("fe80"))
return false;
return true;
}

// ============================================================
// 正文提取与归一化
// extractText(html)：删 script/style/注释与整页标签，只留文本
// 行；normalize() 折叠空白去空行，可选 ignoreRe 整行删噪声。
// ============================================================
function extractText(html) {
return html
.replace(/<script[\s\S]*?<\/script>/gi, "")
.replace(/<style[\s\S]*?<\/style>/gi, "")
.replace(/<!--[\s\S]*?-->/g, "")
.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
.replace(/<[^>]+>/g, "")
.replace(/&nbsp;/g, " ")
.replace(/&amp;/g, "&")
.replace(/&lt;/g, "<")
.replace(/&gt;/g, ">")
.replace(/&quot;/g, '"');
}
function normalize(text, ignoreRe) {
let lines = text
.split("\n")
.map((l) => l.replace(/\s+/g, " ").trim())
.filter(Boolean);
if (ignoreRe) lines = lines.filter((l) =>!ignoreRe.test(l));
return lines.join("\n");
}
async function sha256(text) {
const buf = await crypto.subtle.digest(
"SHA-256",
new TextEncoder().encode(text),
);
return [...new Uint8Array(buf)]
.map((b) => b.toString(16).padStart(2, "0"))
.join("");
}

// ============================================================
// 抓取一页快照
// snapshot(url) → { text, hash}；失败抛错（调用方记失败次数，
// 连续失败要降频/提醒，别对挂掉的站每轮硬敲）。
// ============================================================
async function snapshot(url) {
if (!isSafePublicUrl(url)) throw new Error("链接不合法或指向内网地址");
const r = await fetch(url, {
headers: {
"user-agent":
"Mozilla/5.0 (compatible; SnapshotWatchBot/1.0; +https://telegram.org)",
accept: "text/html",
},
redirect: "follow",
signal: AbortSignal.timeout(10000),
});
if (!r.ok) throw new Error(`页面 HTTP ${r.status}`);
const html = (await r.text()).slice(0, 500000);
const text = normalize(extractText(html));
return { text, hash: await sha256(text)};
}

// ============================================================
// 行级 diff 摘要
// diffSummary(oldText, newText, maxLines=5)：集合口径——
// 新增行 = 新有旧无，删除行 = 旧有新无，各取前 maxLines 条、
// 每条截 100 字；同时返回总变化行数供调用方做阈值判断。
// ============================================================
function diffSummary(oldText, newText, maxLines = 5) {
const oldLines = oldText.split("\n");
const newLines = newText.split("\n");
const oldSet = new Set(oldLines);
const newSet = new Set(newLines);
const added = newLines.filter((l) =>!oldSet.has(l));
const removed = oldLines.filter((l) =>!newSet.has(l));
const cut = (arr) =>
arr.slice(0, maxLines).map((l) => l.slice(0, 100));
return {
added: cut(added),
removed: cut(removed),
changed: added.length + removed.length,
total: newLines.length,
};
}
```

## 接入步骤

1. 订阅时先 `snapshot()` 播种：存 `snap:<id> = {url, hash, text, subs}`（text 全文存 KV，注意 25MB 值上限——正文截到 500KB 已远低于上限）。
2. Cron 按监控节奏（建议 ≥1 小时）逐个 `snapshot()` 比哈希：没变跳过；变了算 `diffSummary`，变化占比达阈值（默认 ≥2% 或 ≥3 行）才推送，推完用新快照覆盖。
3. 连续失败计数：快照里记 `fails`，连续 5 次失败给订阅者发一次「目标站可能挂了/改版了」，并自动降频或暂停，别无限重试。

## 注意点（抓取礼仪）

- **UA 自报家门**：UA 里带 Bot 名与出处链接，被站长找上门能联系到人；不要伪装成真人浏览器绕反爬——绕不过去的站就如实告诉用户监控不了。
- **频率克制**：单站 ≥1 小时间隔是底线；同域名多个订阅合并成一次抓取（按 URL 去重，订阅者扇出），别一个站被十个订阅敲十遍。
- **robots 与条款**：robots.txt 禁止的路径不抓；目标站明示禁止自动访问时停手。监控公开页面用于个人提醒是通行用法，但不等于可以无视站方规则。
- **JS 渲染页抓不到是硬边界**：纯前端渲染的页面 fetch 回来只有空壳 HTML，正文提取为空——订阅时先播种校验，正文为空直接告知用户「这个站需要浏览器渲染，本 Bot 监控不了」，不收订阅装样子。
- **diff 是摘要不是存档**：行集合口径对「段落挪位」会误报增删，在意顺序的场景（如价格表）应在调用侧改用结构化解析（见 76 的适配层），别硬套文本 diff。
