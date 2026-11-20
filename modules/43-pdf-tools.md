# 43 · PDF 工具模块

> PDF 是 TG 里最高频的文档形态，但 Workers 里没有 PDF 引擎（没有 poppler、没有 Python 库）。本模块的路线分工先说清：**图片转 PDF 可以纯 JS 本地生成**（JPEG 能原样嵌入 PDF，这是唯一不需要外部服务的活）；**PDF 转图/合并/拆分走可配置外部 API**；**PDF 提文字走 OCR 外部 API**（OCR.space 直接吃 PDF）。别在 Worker 里硬解 PDF 二进制结构，页数一多必翻车。

## 原理

**为什么 JPEG 能「零成本」进 PDF**：PDF 的图片 XObject 支持 `/Filter /DCTDecode`，意思就是「这段数据本身就是一张 JPEG」，阅读器自己解码。所以图片转 PDF 的本质是写一个 PDF 容器：每页一个 Page 对象 + 一个内容流（把图片铺满页面）+ 一个图片对象（JPEG 字节原样塞进 stream），最后补 xref 偏移表。纯字符串拼接 + 字节拼接，几十行就能写完，不需要任何库。

需要 JPEG 的**宽高**来定页面大小（MediaBox），宽高藏在 JPEG 的 SOF0/SOF2 标记段里，扫一遍标记就能读出来，不用解码像素。

**PNG/WebP 怎么办**：不能直接 DCTDecode 嵌入。两个办法：一是走图片代理（模块 37 的 wsrv.nl）加 `output=jpg` 先转成 JPEG 再嵌入（本模块用这招）；二是自己解码 PNG 像素再 FlateDecode 嵌入——Workers 里没有现成解码器，不值得。

**其余三件活为什么外包**：
- PDF 转图/合并/拆分：要真正解析和重组 PDF 对象结构，纯 JS 手写等于自己造一个 PDF 引擎，交给外部 API（自建 Stirling-PDF、CloudConvert 类服务均可），Bot 只约定调用口径。
- PDF 提文字：扫描件 PDF 本质是图片，没文字层，必须 OCR；OCR.space 的接口直接接受 PDF 文件 URL 并逐页识别，是最省事的一条路。有文字层的 PDF 也能用它兜底（识别率换省事）。

## 代码

```js
// ============================================================
// 读取 JPEG 宽高（扫 SOF 标记）
// 从文件头逐个跳标记段，命中 SOF0(0xC0)/SOF2(0xC2) 就读出高宽。
// 不解码像素，几 KB 内必出结果；读不到返回 null（不是 JPEG）。
// ============================================================
function jpegSize(buf) {
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (buf[0]!== 0xff || buf[1]!== 0xd8) return null;
let i = 2;
while (i + 9 < buf.byteLength) {
if (buf[i]!== 0xff) {
i++;
continue;
}
const marker = buf[i + 1];
if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7)};
}
i += 2 + dv.getUint16(i + 2);
}
return null;
}

// ============================================================
// 多张 JPEG 拼成一个 PDF（纯 JS 最小实现）
// images: [{ bytes:Uint8Array, w, h}]，一图一页，页面尺寸 = 图片
// 像素尺寸（单位 pt）。对象编号：1=Catalog、2=Pages，每图占
// Page/Content/Image 三个对象；最后按字节偏移写 xref 表。
// 这是「能打开、能打印」的最小正确实现，不做压缩与字体嵌入。
// ============================================================
function imagesToPdf(images) {
const enc = new TextEncoder();
const chunks = [];
let len = 0;
const push = (data) => {
const b = typeof data === "string"? enc.encode(data): data;
chunks.push(b);
len += b.byteLength;
};
const offsets = [];
const mark = (num) => (offsets[num] = len);
push("%PDF-1.4\n");
const kids = images.map((_, i) => `${3 + 3 * i} 0 R`).join(" ");
mark(1);
push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
mark(2);
push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`);
images.forEach((img, i) => {
const pageNum = 3 + 3 * i;
const contentNum = 4 + 3 * i;
const imgNum = 5 + 3 * i;
mark(pageNum);
push(
`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.w} ${img.h}] /Resources << /XObject << /Im${i} ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
);
const content = `q\n${img.w} 0 0 ${img.h} 0 0 cm\n/Im${i} Do\nQ\n`;
mark(contentNum);
push(`${contentNum} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
mark(imgNum);
push(
`${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.byteLength} >>\nstream\n`,
);
push(img.bytes);
push("\nendstream\nendobj\n");
});
const xrefAt = len;
const total = 3 + 3 * images.length;
let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
for (let i = 1; i < total; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
push(xref);
push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
const out = new Uint8Array(len);
let pos = 0;
for (const c of chunks) {
out.set(c, pos);
pos += c.byteLength;
}
return out;
}

// ============================================================
// 非 JPEG 先转 JPEG（图片代理路线）
// PNG/WebP 不能 DCTDecode 嵌入：拿 TG 文件直链走 wsrv.nl 加
// output=jpg 转一版回来。是 JPEG 的直接跳过（看文件头 FF D8）。
// ============================================================
async function ensureJpeg(env, fileId) {
const gf = await tg(env, "getFile", { file_id: fileId});
if (!gf.ok) throw new Error("getFile 失败");
const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
let resp = await fetch(fileUrl);
if (!resp.ok) throw new Error("下载原图失败");
let bytes = new Uint8Array(await resp.arrayBuffer());
if (bytes[0] === 0xff && bytes[1] === 0xd8) return bytes;
const api = "https://wsrv.nl/?url=" + encodeURIComponent(fileUrl.replace(/^https?:\/\//, "")) + "&output=jpg";
resp = await fetch(api);
if (!resp.ok) throw new Error("图片转 JPEG 失败（代理服务不可用）");
bytes = new Uint8Array(await resp.arrayBuffer());
if (bytes[0]!== 0xff || bytes[1]!== 0xd8) throw new Error("转换结果不是 JPEG");
return bytes;
}

// ============================================================
// PDF 提文字（OCR 外部 API）
// OCR.space 直接吃 PDF：把 TG 文件直链以 filetype=PDF 提交，
// 逐页识别结果拼在 ParsedText 里返回。扫描件和文字层 PDF 都能走。
// ============================================================
async function pdfTextViaOcr(env, pdfUrl) {
const form = new FormData();
form.append("url", pdfUrl);
form.append("filetype", "PDF");
form.append("language", "chs");
form.append("OCREngine", "2");
const r = await fetch("https://api.ocr.space/parse/image", {
method: "POST",
headers: { apikey: env.OCR_API_KEY || "helloworld"},
body: form,
});
const data = await r.json().catch(() => ({}));
const text = (data?.ParsedResults || [])
.map((p) => p.ParsedText || "")
.join("\n")
.trim();
if (!text) throw new Error(data?.ErrorMessage?.[0] || "没有提取出文字");
return text;
}

// ============================================================
// PDF 转图/合并/拆分（外部 API 约定）
// 统一口径：POST {PDF_API_URL}/<动作>，multipart 带 file 字段，
// 返回处理后的文件字节。未配 PDF_API_URL 时调用方必须明确提示
// 「未配置」，不要静默失败或假装处理。换服务商只改这一函数。
// ============================================================
async function pdfExternal(env, action, pdfBytes, filename) {
if (!env.PDF_API_URL) throw new Error("未配置 PDF_API_URL");
const form = new FormData();
form.append("file", new Blob([pdfBytes], { type: "application/pdf"}), filename || "file.pdf");
const r = await fetch(env.PDF_API_URL.replace(/\/$/, "") + "/" + action, {
method: "POST",
body: form,
});
if (!r.ok) throw new Error("PDF 服务返回 " + r.status);
return new Uint8Array(await r.arrayBuffer());
}
```

## 接入步骤

1. 图片转 PDF 是本地能力，零配置：收集图片 file_id（会话存 KV `pdf:` 前缀）→ 逐张 `ensureJpeg` → `jpegSize` → `imagesToPdf` → multipart sendDocument 回传。
2. PDF 提文字配 `OCR_API_KEY`（不配用 OCR.space 演示 key，额度小）；把 PDF 的 TG 直链交给 `pdfTextViaOcr`。
3. 转图/合并/拆分要配 `PDF_API_URL`（自建或第三方，接口口径见 `pdfExternal` 的约定）；没配时在命令入口就提示，别等用户传了文件才报错。
4. 用量计数用 `pdf:cnt:<用户>:<日期>` 键（与 34 号 `dl:cnt:` 同模式），防免费 OCR 额度被刷爆。

## 注意点

- 本地生成的 PDF 页面尺寸 = 图片像素数（pt），手机照片动辄 3000+ pt，阅读器里要缩放——介意的话在 `imagesToPdf` 里按比例缩到 A4 宽 595pt 再写 MediaBox 与内容流矩阵。
- JPEG 必须是基线或渐进式都行（DCTDecode 通吃），但 CMYK 色彩的 JPEG 在部分阅读器会反色，来源不可控时先经 wsrv 转一版 RGB 再嵌入更稳。
- TG 文件直链带 Bot Token，交给 OCR/代理服务等于短暂共享，只用信得过的服务，敏感文档在 Bot 说明里提醒用户。
- 外部 PDF API 是单点依赖：超时要掐断（AbortSignal），失败如实报错并保留原文件，别吞掉用户的文件后只回一句「失败了」。
- Bot API 下载上限 20MB、上传上限 50MB：超限的 PDF 在入口就拦，别等外部服务处理完才发现回传不了。
