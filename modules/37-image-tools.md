# 37 · 图片处理/OCR 模块

> 三件高频图片活：OCR 提字、改尺寸/转格式、生成引用图。先把结论放前面：Cloudflare Workers 里没有本地图像引擎（没有 PIL、没有 ImageMagick），所有路线都是「把活外包」——要么调外部 API，要么用图片代理服务，Bot 只做收发和编排。

## 原理

| 需求 | Workers 可行路线 | 说明 |
|---|---|---|
| OCR 提字 | 外部 OCR API（传图片 URL 或 base64） | Bot 先 getFile 拿到 TG 文件直链，再交给 OCR 服务解析 |
| 改尺寸/转格式 | 图片代理服务（如 wsrv.nl）或 Cloudflare Images | fetch 时带变换参数，拿到处理后的字节再回传 |
| 生成引用图 | 外部渲染服务（文字+头像排版出图） | 和模块 36 的引用贴纸共用同一条管线，这里出的是普通图片 |

共同套路：**图片不落地**。TG 文件直链有时效（约 1 小时），拿到就立刻用；处理结果字节直接 sendPhoto/sendDocument 回去，不存 Bot 侧。

## 代码

```js
// ============================================================
// 取 TG 文件直链
// getFile 两步：file_id → file_path → 拼 download 地址。
// 直链带 token，等于临时钥匙：只发给处理服务，别写进日志和回复。
// ============================================================
async function tgFileUrl(env, fileId) {
const r = await tg(env, "getFile", { file_id: fileId});
if (!r.ok) throw new Error("getFile 失败");
return `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${r.result.file_path}`;
}

// ============================================================
// OCR 提字（外部 OCR API）
// 以 OCR.Space 免费接口为例：传图片 URL、指定引擎和语言，
// 返回 ParsedResults[].ParsedText。多段文本按 \r\n 分段返回。
// 换其他 OCR 服务时只改这一函数，调用方不动。
// ============================================================
async function ocrImage(env, imageUrl, lang = "chs") {
const form = new FormData();
form.append("url", imageUrl);
form.append("language", lang); // chs 简中 / eng 英文 / jpn 日文…
form.append("OCREngine", "2"); // 引擎 2 对中文和表格更友好
const r = await fetch("https://api.ocr.space/parse/image", {
method: "POST",
headers: { apikey: env.OCR_KEY},
body: form,
});
const data = await r.json().catch(() => ({}));
const text = data?.ParsedResults?.[0]?.ParsedText?.trim();
if (!text) throw new Error(data?.ErrorMessage?.[0] || "没有识别出文字");
return text;
}

// 用法：用户发图 → 取最大尺寸那张的 file_id → 提字回发
async function handleOcrPhoto(env, msg) {
const photo = msg.photo[msg.photo.length - 1]; // 数组最后一张是最大尺寸
const url = await tgFileUrl(env, photo.file_id);
const text = await ocrImage(env, url);
return send(env, msg.chat.id, "📝 识别结果：\n" + text, {
reply_to_message_id: msg.message_id,
});
}

// ============================================================
// 改尺寸/转格式（图片代理路线）
// wsrv.nl 是公开的图片处理代理：url 参数给原图，后缀参数控制
// 宽高与输出格式，fetch 它就拿到处理后的字节。适合做贴纸前
// 的 512 规格化（接模块 36）、缩略图、WebP↔PNG 互转。
// 自有域名可用时，Cloudflare Images 的 fetch(cf.image) 是同理
// 的官方路线，参数换成 { width, height, format} 即可。
// ============================================================
async function resizeImage(srcUrl, { w = 512, h = 512, format = "webp"} = {}) {
const api =
"https://wsrv.nl/?url=" +
encodeURIComponent(srcUrl.replace(/^https?:\/\//, "")) +
`&w=${w}&h=${h}&fit=contain&output=${format}`;
const r = await fetch(api);
if (!r.ok) throw new Error("图片处理失败");
return r.arrayBuffer();
}

// ============================================================
// 生成引用图（渲染服务路线）
// 把「谁说了什么」排版成图：头像、名字、气泡、深色底。
// 渲染交给外部服务（POST JSON 进、PNG 出），Bot 负责取头像
// file_id 和转发字节。与模块 36 的区别只是出口：那边进贴纸包，
// 这边直接 sendPhoto 发回聊天。
// ============================================================
async function makeQuoteImage(env, { text, from}) {
const avatars = await tg(env, "getUserProfilePhotos", { user_id: from.id, limit: 1});
const avatarFileId = avatars?.result?.photos?.[0]?.[0]?.file_id || null;
const r = await fetch(env.QUOTE_API + "/render", {
method: "POST",
headers: { "content-type": "application/json"},
body: JSON.stringify({ text, name: from.first_name, avatarFileId}),
});
if (!r.ok) throw new Error("渲染服务不可用");
return r.arrayBuffer(); // 调用方用 multipart sendPhoto 发出
}
```

## 接入步骤

1. 环境变量：`OCR_KEY`（OCR 服务的 key，Secret）、`QUOTE_API`（渲染服务地址，做引用图才需要）。不需要 KV。
2. OCR 入口：私聊直接发图即识别，或群里回复图片发 /ocr（群里要回复触发，别默认全图扫描，费额度又吵）。
3. 规格化入口：给模块 36 的贴纸流程当前置步骤——用户发任意图，先 resizeImage 到 512 再走 uploadSticker。
4. 回图统一走 multipart sendPhoto（字节流），别把处理服务的临时 URL 直接填进 sendPhoto 的 photo 参数，链接过期用户就看不到图。

## 注意点

- 免费 OCR 接口有额度和精度上限：手写体、低清截图识别率明显下降，回复里附上「识别结果仅供参考」更稳妥；表格类图片开 isTable 参数（示例接口支持）效果更好。
- TG 文件直链里带着 Bot token，传给第三方服务等于短暂共享——只用信得过的服务，敏感图片（证件、聊天记录）在 Bot 的说明里提醒用户。
- 图片代理是别人的免费服务，随时可能限流或跑路：resizeImage 失败时要有兜底（原图直发或提示稍后再试），别让整个流程卡死在一个外部依赖上。
- 处理大图时注意 Workers 的内存与时长上限，超过 10MB 的原图先让代理服务缩一版再处理，别整张拉进 Worker 内存。
