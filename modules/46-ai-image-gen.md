# 46 · AI 绘图 API 适配模块

> 文生图与图生图（编辑）的统一适配层：把「调哪家绘图 API」收敛成一个函数，业务侧只管 prompt 与回图。口径以 OpenAI 兼容 images 接口为准（官方、Azure、多数中转与本地部署都兼容），落地模板：55（AI 绘图）、82（AI 头像/证件照）。

## 原理

**两个端点，一种形状**。OpenAI 兼容绘图接口只有两个动作：
- `POST {IMAGE_API}/images/generations`：JSON 体 `{model, prompt, size, n}`，纯文生图；
- `POST {IMAGE_API}/images/edits`：multipart 表单（`image` 文件 + `prompt` + `model`），图生图/编辑——头像风格化、局部重绘都走它，原图要先从 Telegram 的 file_id 换成字节（getFile → 下载）。

响应统一是 `{data:[{b64_json} 或 {url}]}`。两种都要处理：`url` 最省事（直接当 sendPhoto 的 photo 参数让 TG 去拉）；`b64_json` 要在 Worker 里解码成字节、包 FormData 以文件形式 sendPhoto——Workers 没有文件系统，全程内存里转手，图别太大（一般 ≤10MB 没问题）。

**为什么必须做适配层**：绘图 API 是全库最易变的外部依赖——价格、模型名、排队与审核策略各家差异极大，且经常要换源。把 base、key、model 全放环境变量（`IMAGE_API` / `IMAGE_API_KEY` / `IMAGE_MODEL`），换源只改配置；连协议都不同的源（如某些只提供异步任务的国产接口）才需要改 `genImage` 函数体，业务代码（命令、限额、回图）一行不动。

**未配置口径**：没配 `IMAGE_API` 时抛明确的「演示模式」错误并提示管理员要配什么——与 34 号视频下载同口径。不静默失败、不拿占位图糊弄用户。

## 代码

```js
// ============================================================
// AI 绘图适配层（OpenAI 兼容 images 口径）
// genImage(env, {prompt}) 文生图 / editImage(env, {fileId, prompt})
// 图生图：都返回 { b64_json} 或 { url}，回图交给 sendGenPhoto。
// 换源只改 IMAGE_API / IMAGE_API_KEY / IMAGE_MODEL 三个变量；
// 换协议改这两个函数体，业务侧（限额/命令/回图）不用动。
// ============================================================
async function callImages(env, path, init) {
if (!env.IMAGE_API)
throw new Error(
"未配置图像 API（演示模式）：管理员需设置 IMAGE_API / IMAGE_API_KEY（OpenAI 兼容 images 接口）后才能生成图片。",
);
const r = await fetch(env.IMAGE_API.replace(/\/$/, "") + path, {
...init,
headers: {
...(init.headers || {}),
...(env.IMAGE_API_KEY? { authorization: `Bearer ${env.IMAGE_API_KEY}`}: {}),
},
});
const data = await r.json().catch(() => ({}));
if (!r.ok) throw new Error(data?.error?.message || `图像 API HTTP ${r.status}`);
const item = data?.data?.[0];
if (!item) throw new Error("图像 API 没返回图片");
return item;
}
async function genImage(env, prompt, size = "1024x1024") {
return callImages(env, "/images/generations", {
method: "POST",
headers: { "content-type": "application/json"},
body: JSON.stringify({ model: env.IMAGE_MODEL || "gpt-image-1", prompt, size}),
});
}
async function editImage(env, fileId, prompt) {
const gf = await tg(env, "getFile", { file_id: fileId});
if (!gf.ok) throw new Error("getFile 失败");
const imgRes = await fetch(
`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`,
);
if (!imgRes.ok) throw new Error("原图下载失败");
const form = new FormData();
form.append("image", await imgRes.blob(), "photo.jpg");
form.append("prompt", prompt);
form.append("model", env.IMAGE_MODEL || "gpt-image-1");
return callImages(env, "/images/edits", { method: "POST", body: form});
}
// 回图：url 直传；b64 解码后走 multipart 文件上传
async function sendGenPhoto(env, chatId, item, caption) {
if (item.url)
return tg(env, "sendPhoto", { chat_id: chatId, photo: item.url, caption});
const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
const form = new FormData();
form.append("chat_id", String(chatId));
form.append("photo", new Blob([bytes], { type: "image/png"}), "gen.png");
if (caption) form.append("caption", caption);
const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
method: "POST",
body: form,
});
return r.json().catch(() => ({}));
}
```

## 接入步骤

1. 部署侧配三个变量：`IMAGE_API`（基地址，末尾不带 `/` 也行，代码会处理）、`IMAGE_API_KEY`（Secret）、`IMAGE_MODEL`（可空，默认 gpt-image-1）。
2. 把上面四个函数整段拷进 worker.js（依赖模块 01 的 `tg()`）。
3. 业务侧：收到 prompt → 先查每日限额（用量键沿用 `<业务>:cnt:<uid>:<日期>` 口径）→ 调 `genImage`/`editImage` → `sendGenPhoto` 回图 → 成功后计数 +1。限额在生成前校验、成功后计数，失败不扣额。

## 注意点

- **内容审核在 API 侧**：违规 prompt 会被上游直接拒（错误原样透传给用户即可），Bot 侧不必自建审核词表，但要在使用说明里写清生成内容的使用边界。
- **b64 大图吃内存**：Workers 单请求内存有限，`size` 别开到 4K 档；上游支持时优先要 url 响应格式。
- **edits 的原图格式**：部分模型只收 PNG/WebP，原图是 JPG 时个别源会报错——报错原样透传，或在提交前用 wsrv.nl 转一道格式（见模块 37）。
- **别把 key 写进代码或 KV**：只走 Secret 环境变量，这条与全库口径一致。
