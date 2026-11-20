# 44 · 音乐下载与识曲模块

> 和模块 32（视频下载）同一条管线，换个出口：贴音乐链接 → 可替换解析层拿直链 → sendAudio 回传；再加一个反向能力——发一段音频/语音进来，识曲 API 告诉你这是什么歌。先把版权边界写在最前面：**只处理公开可访问、用户有权下载的内容；不绕 DRM、不破付费墙、不做盗版资源分发**。解析层是别人的服务，Bot 只做通道，这条线和模块 32/40 一致。

## 原理

**下载管线**与视频下载同构，差异只有三处：解析请求固定 `downloadMode:"audio"`（只要音轨）、回传走 `sendAudio`（带 performer/title 元数据，TG 里显示成正经歌曲卡片）、体积通常小得多（鲜少撞 50MB 上限，但仍要探大小兜底）。解析层沿用 cobalt 兼容协议，自建或换源只改 `resolveMusic` 一个函数。

**识曲**的原理是音频指纹：把一段音频的声学特征算成指纹，去曲库里比对最相似的一首。以 AudD 为例：POST 一个音频文件（或音频 URL）到它的 recognize 接口，带 api_token，返回 artist/title/专辑/发行时间及各平台链接。片段太短（<3 秒）或太吵都会认不出，这是技术边界不是 bug，回复里要如实说。

**为什么识曲必须配 Token 而下载可以演示模式**：AudD 是付费/注册服务，没有免 key 的公共端点。没配 `AUDD_API_TOKEN` 时识曲入口直接提示未配置；下载没配解析服务时按 34 号的惯例走「演示模式」提示。两种未配置都要在用户动手时明确告知，不静默失败。

## 代码

```js
// ============================================================
// 音乐解析层（可替换，沿用模块 32 的模式）
// resolveMusic(pageUrl) → { url:直链, title, size?} 或抛错。
// 默认走 cobalt 兼容协议且只要音频（downloadMode:"audio"）。
// 未配 MUSIC_RESOLVER_API 抛演示模式错误，调用方原样提示用户。
// ============================================================
async function resolveMusic(env, pageUrl) {
if (!env.MUSIC_RESOLVER_API)
throw new Error(
"未配置解析服务（演示模式）：管理员需设置 MUSIC_RESOLVER_API 为 cobalt 兼容解析服务地址后才能真正下载。",
);
const base = env.MUSIC_RESOLVER_API.replace(/\/$/, "");
const r = await fetch(base + "/", {
method: "POST",
headers: { "content-type": "application/json", accept: "application/json"},
body: JSON.stringify({
url: pageUrl,
downloadMode: "audio",
audioFormat: "mp3",
filenameStyle: "basic",
}),
});
const data = await r.json().catch(() => ({}));
if (!r.ok ||!data.url) throw new Error(data?.error?.code || `解析服务 HTTP ${r.status}`);
let size;
try {
const h = await fetch(data.url, { method: "HEAD"});
size = Number(h.headers.get("content-length")) || undefined;
} catch {}
return { url: data.url, title: data.filename || "audio", size};
}

// ============================================================
// 识曲（AudD 音频指纹）
// 把语音/音频文件以 multipart 提交 recognize 接口（或传 return
// 参数要各平台链接）。片段建议 5-15 秒、避开纯人声说话段。
// 返回 { artist, title, album, releaseDate, songLink} 或 null。
// ============================================================
async function recognizeMusic(env, fileId) {
if (!env.AUDD_API_TOKEN) throw new Error("未配置 AUDD_API_TOKEN");
const gf = await tg(env, "getFile", { file_id: fileId});
if (!gf.ok) throw new Error("getFile 失败");
const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
const form = new FormData();
form.append("api_token", env.AUDD_API_TOKEN);
form.append("url", fileUrl);
form.append("return", "spotify,apple_music");
const r = await fetch("https://api.audd.io/", { method: "POST", body: form});
const data = await r.json().catch(() => ({}));
const hit = data?.result;
if (!hit) return null;
return {
artist: hit.artist || "",
title: hit.title || "",
album: hit.album || "",
releaseDate: hit.release_date || "",
songLink: hit.song_link || "",
};
}

// ============================================================
// sendAudio 回传与大小兜底
// 直链 ≤50MB 直接让 TG 拉（sendAudio 的 audio 参数填 URL）；
// 超限或 TG 拉失败时回直链让用户自己下。caption 附版权口径一行。
// ============================================================
async function deliverAudio(env, chatId, media) {
const MB = 1024 * 1024;
if (media.size && media.size > 50 * MB)
return send(
env,
chatId,
`📦 文件约 ${(media.size / MB).toFixed(1)}MB，超过 Bot API 50MB 上限。\n直链（有时效，尽快下）：\n${media.url}`,
);
const r = await tg(env, "sendAudio", {
chat_id: chatId,
audio: media.url,
caption: `${media.title}\n⚖️ 请只下载你有权下载的内容。`,
});
if (!r.ok)
return send(env, chatId, `😅 Telegram 没拉动这个直链（可能防盗链），直接给你链接：\n${media.url}`);
}
```

## 接入步骤

1. 下载入口：消息里匹配 URL → 先查每日限额（`mus:cnt:<用户>:<日期>`，模式同 34 号 `dl:cnt:`）→ `resolveMusic` → `deliverAudio`；任务计数可另存 `mus:<用户ID>` 做累计统计。
2. 识曲入口：私聊发语音/音频即识曲，或回复音频发 /whatsong；先查 `AUDD_API_TOKEN`，没配直接提示。
3. 环境变量：`MUSIC_RESOLVER_API`（解析服务，可选）、`AUDD_API_TOKEN`（识曲，Secret，可选）、`DAILY_LIMIT`（默认 10）。
4. 两个外部服务都可独立缺省：缺哪个就只关哪个功能，另一个照常工作，/start 说明里写清当前可用范围。

## 注意点

- 版权边界是这个模块的红线：只下公开内容、不绕 DRM/付费墙、不建盗版曲库；用户发来的链接内容责任在提供方，Bot 的 caption 和说明里把口径写明。
- 解析直链普遍带时效和防盗链：拿到立刻用、失败回退直链，不要把直链存 KV 里复用。
- 识曲对片段质量敏感：太短、环境噪音大、翻唱/现场版都可能认错或认不出，回复用「最接近的是」口径，别把结果说成铁定事实。
- AudD 按次计费（有免费额度）：识曲入口也要走每日限额，别只给下载管线设闸。
- sendAudio 的元数据（performer/title）可以从解析结果或识曲结果里带上，歌曲卡片会好看很多；乱填元数据（把未知文件标成名曲）属于误导，别做。
