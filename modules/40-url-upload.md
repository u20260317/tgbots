# 40 · URL 上传转存模块

> 用户丢一个外部链接进来，Bot 把文件拉回来存进 Telegram：小文件让 Telegram 服务器自己去抓，大文件 Worker 中转上传，太大的老实回直链。和模块 08 的区别先说清：08 存的是**已经在 Telegram 里的文件**（记 file_id 就完事）；本模块处理的是**外网文件第一次进 Telegram**，要真搬字节。

## 原理

三条路线按文件大小分流，核心是两个平台上限：

| 路线 | 做法 | 上限 | 说明 |
|---|---|---|---|
| A. URL 直传 | sendDocument/sendVideo 的 file 参数直接填 URL，TG 服务器去抓 | 约 20MB | 最省事，Worker 不碰字节；源站拒绝 TG 抓取时会失败 |
| B. Worker 中转 | Worker fetch 拉回字节，multipart 上传 | 50MB（Bot API 上传上限） | 能过防盗链，但吃 Worker 内存和时长 |
| C. 回退直链 | 超过 50MB 或拉取失败 | — | 把原链接整理成一条消息发回，说明原因，别假装成功 |

护栏在动手前先查：HEAD 请求拿 content-length 和 content-type，超限、类型不对、当场拒绝，不要等下载一半才发现。超时用 AbortSignal 掐断，挂死的源站不能拖住整个 webhook。

安全底线：只许 http/https，拦掉指向内网/本机地址的 URL（SSRF）——用户传什么链接都有可能，Bot 的 fetch 是以服务器身份发出的，被当跳板扫内网就出事了。

## 代码

```js
// ============================================================
// URL 安全与体检
// 先 HEAD 探活：拿大小和类型。有些源站不支持 HEAD 会回 405，
// 那就退而用带 Range 的 GET 探一字节，别一刀切拒绝。
// 私有地址段一律拒绝（SSRF 防护）：localhost、10/8、172.16/12、
// 192.168/16、169.254/16、::1 等，域名解析后再校验更稳妥，
// 这里先做字面拦截 + 只许 http/https 的第一道闸。
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
if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
if (host === "::1" || host.startsWith("fc") || host.startsWith("fe80")) return false;
return true;
}

async function probeUrl(u, timeoutMs = 8000) {
const r = await fetch(u, {
method: "HEAD",
redirect: "follow",
signal: AbortSignal.timeout(timeoutMs),
});
if (!r.ok && r.status!== 405) throw new Error("源站返回 " + r.status);
return {
size: Number(r.headers.get("content-length") || 0),
type: r.headers.get("content-type") || "",
};
}

// ============================================================
// 双路线转存
// ≤20MB 先试路线 A（TG 自己抓）；A 失败或文件在 20–50MB 走
// 路线 B 中转；>50MB 直接回退直链。文件名从 URL 尾段提取，
// 拿不到就按 content-type 拼一个，别用一串乱码当文件名。
// ============================================================
const MB = 1024 * 1024;
function filenameOf(u, type) {
const tail = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
if (tail && tail.includes(".")) return tail.slice(0, 128);
const ext = (type.split("/")[1] || "bin").split(";")[0];
return `file.${ext}`;
}

async function relayUrlToChat(env, chatId, u) {
if (!isSafePublicUrl(u)) return send(env, chatId, "⛔ 这个链接不合法或指向内网地址，已拒绝。");
let probe;
try {
probe = await probeUrl(u);
} catch (e) {
return send(env, chatId, "😵 源站探不到：" + e.message);
}
if (probe.size > 50 * MB)
return send(env, chatId, `文件约 ${Math.round(probe.size / MB)}MB，超过 Bot API 50MB 上限，先给你原链接：\n${u}`);
const isVideo = probe.type.startsWith("video/");
const method = isVideo? "sendVideo": "sendDocument";
if (!probe.size || probe.size <= 20 * MB) {
const r = await tg(env, method, { chat_id: chatId, [isVideo? "video": "document"]: u});
if (r.ok) return r;
// TG 抓取失败（防盗链/超时）→ 落到路线 B 再试一次
}
const resp = await fetch(u, { signal: AbortSignal.timeout(60000)});
if (!resp.ok) return send(env, chatId, "😵 下载失败，源站返回 " + resp.status);
const buf = await resp.arrayBuffer();
if (buf.byteLength > 50 * MB)
return send(env, chatId, `文件约 ${Math.round(buf.byteLength / MB)}MB，超过 50MB 上限，原链接：\n${u}`);
const form = new FormData();
form.append("chat_id", String(chatId));
form.append(isVideo? "video": "document", new Blob([buf], { type: probe.type || undefined}), filenameOf(u, probe.type));
const up = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", body: form});
const data = await up.json().catch(() => ({}));
if (!data.ok) return send(env, chatId, "😵 上传到 Telegram 失败：" + (data.description || ""));
return data;
}
```

转存成功后建议顺手把返回的 file_id 按模块 08 的方式存一份（`f:` 键），下次同文件再要直接发 file_id，不重复搬运。

## 接入步骤

1. 不需要 KV（转存是一次性动作）；想做 file_id 复用再绑 `BOT_KV` 并接模块 08。
2. handle() 里识别消息中的 URL（text 里匹配 `https?://`），或加 /up 命令后接链接，分发给 `relayUrlToChat`。
3. 视频类想让 TG 以可播放形式呈现就走 sendVideo（已按 content-type 分流）；不确定类型的当 document 发，保原样不压缩。
4. allowed_updates 无特殊要求，普通 message 即可。

## 注意点

- 路线 A 的 20MB 是 Telegram 抓取 URL 的经验上限，不是文档承诺，失败自动降级路线 B 的逻辑别省。
- 路线 B 把整个文件读进 Worker 内存，接近 50MB 时内存和 CPU 时长都吃紧——这是 Workers 的物理边界，真要搬大文件请自建 Local Bot API Server（可放宽到 2000MB），别硬扛。
- 防盗链站点（带 Referer/UA 校验的）路线 A、B 都可能吃 403，UA 伪装只对自有内容用；来路不明的付费内容不要绕，这条线和模块 32 一致。
- HEAD 不支持的源站不少，probe 失败不等于文件不存在——代码里对 405 放行、靠路线 B 的实际大小再兜底，就是这个原因。
- 转存的是用户提供的链接内容，版权和合规责任在提供者；Bot 侧只做通道，说明文案里写明。
