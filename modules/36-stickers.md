# 36 · 贴纸制作模块

> 把「做贴纸」这件事 Bot 化：用户发图或发一句话，Bot 建包、塞贴纸、回链接。核心是贴纸包 API 三件套（createNewStickerSet / addStickerToSet / getStickerSet）加一套绕不开的格式规格。

## 原理

Telegram 贴纸不是普通图片，三个硬规格先记牢：

| 类型 | 格式 | 尺寸 | 其他 |
|---|---|---|---|
| 静态 | PNG 或 WebP | 一边 = 512px，另一边 ≤ 512px | 建议透明底 |
| 动态 | TGS（Lottie gzip） | 512×512 | ≤ 64KB，不能有外部引用 |
| 视频 | WebM（VP9） | 一边 = 512px | ≤ 3 秒、≤ 256KB、无音轨 |

贴纸包归属在某个**用户账号**名下（createNewStickerSet 要传 user_id，一般是 Bot 主人或请求者本人），但包名必须以 `_by_<Bot用户名>` 结尾。塞贴纸有三条现成通道：已有的 sticker file_id 直接复用、uploadStickerFile 先传文件拿 file_id、或 multipart 直接随建包请求上传。Bot 侧最稳的路线是：拿到合规文件 → uploadStickerFile → 拿 file_id → create/add。

## 代码

```js
// ============================================================
// 贴纸包命名与建包
// 包名规则：只许小写字母/数字/下划线、字母开头，且必须以
// _by_<bot username> 结尾，否则 API 直接报错。标题是展示名，随意。
// stickers 数组每项是 InputSticker：sticker（file_id/URL/上传句柄）
// + emoji_list（至少 1 个）+ format（static/animated/video）。
// ============================================================
function stickerSetName(env, slug) {
return `${slug}_by_${env.BOT_USERNAME}`; // BOT_USERNAME 不带 @
}
async function createPack(env, ownerId, slug, title, firstSticker) {
return tg(env, "createNewStickerSet", {
user_id: ownerId,
name: stickerSetName(env, slug),
title,
stickers: [firstSticker],
sticker_format: firstSticker.format,
});
}
async function addToPack(env, ownerId, slug, sticker) {
return tg(env, "addStickerToSet", {
user_id: ownerId,
name: stickerSetName(env, slug),
sticker,
});
}
async function getPack(env, slug) {
return tg(env, "getStickerSet", { name: stickerSetName(env, slug)});
// result.stickers[].file_id 全量清单；result.title / thumbnail 等元信息
}

// ============================================================
// 先传后塞：uploadStickerFile 拿 file_id
// 用户发来的合规文件（WebP/PNG 文档）先用 getFile 下载字节，
// 再 multipart 上传。sticker_format 要和文件实际类型一致。
// 上传返回的 file_id 只用于贴纸接口，别拿去当普通文件发。
// ============================================================
async function uploadSticker(env, ownerId, fileBytes, format, filename) {
const form = new FormData();
form.append("user_id", String(ownerId));
form.append("sticker_format", format); // static / animated / video
form.append("sticker", new Blob([fileBytes]), filename);
const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/uploadStickerFile`, {
method: "POST",
body: form,
});
const data = await r.json().catch(() => ({}));
if (!data.ok) throw new Error(data.description || "uploadStickerFile 失败");
return data.result.file_id;
}

// ============================================================
// 引用贴纸（QuotLy 式）：把一句话渲染成贴纸图
// 原理：贴纸图 = 头像 + 名字 + 气泡文字排版成 512 宽 PNG。
// Workers 里没有成熟的本地排版引擎，通行做法是调外部渲染服务
// （传入 {text, name, avatarUrl, color} 返回 PNG 字节），
// 或用模块 37 的图像服务生成；拿到字节后走上面的 uploadSticker
// → addToPack 进「我的引用包」，回 t.me/addstickers/<包名> 链接。
// ============================================================
async function makeQuoteSticker(env, ownerId, { text, name, avatarFileId}) {
const render = await fetch(env.QUOTE_API + "/render", {
method: "POST",
headers: { "content-type": "application/json"},
body: JSON.stringify({ text, name, avatarFileId}),
});
if (!render.ok) throw new Error("渲染服务不可用");
const png = await render.arrayBuffer();
const fileId = await uploadSticker(env, ownerId, png, "static", "quote.webp");
return addToPack(env, ownerId, "quotes", {
sticker: fileId,
format: "static",
emoji_list: ["💬"],
});
}
```

管理类方法顺手记下：`setStickerPositionInSet` 调顺序、`deleteStickerFromSet` 删一张、`setStickerSetTitle` 改标题、`deleteStickerSet` 删整包——都只要包名（删改同样要包归属人的 user_id 语境，实际由 Bot 代调即可）。

## 接入步骤

1. 环境变量：`BOT_USERNAME`（不带 @，拼包名用）。不需要 KV（贴纸包状态都在 Telegram 侧，getStickerSet 随时查）。
2. 用户入口建议两个：① 发合规文件（WebP/PNG 文档、或现成贴纸转发进来取 file_id）→ 选包 → addToPack；② 回复一条消息发 /quote → 走引用贴纸管线。
3. 包不存在时先 createPack（第一张贴纸随建包一起提交），存在时走 addToPack；用 getPack 的返回判断，别靠报错猜。
4. 成功后回 `https://t.me/addstickers/<包名>`，用户点开就能整包添加。

## 注意点

- 用户直接发的**照片是 JPEG**，不符合静态贴纸规格，别指望 API 宽容：要么要求以「文件」形式发 WebP/PNG，要么先走模块 37 的格式转换再上传。
- 一个包最多 120 张（视频包 50 张），满了要新建分包（如 quotes2）。
- emoji_list 必填且影响搜索推荐，每张贴纸配 1–3 个贴切的 emoji，别全填同一个。
- 引用贴纸里的头像和名字来自被引用者——只处理用户主动回复触发的那条，别做批量抓取群消息生成贴纸的功能。
