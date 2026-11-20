# PDF 工具 Bot

图片转 PDF（本地纯 JS 生成）、PDF 提文字（OCR）、PDF 转图/合并/拆分（外部服务）。模块 43 的成品落地版——也是全库第一个「完全空白品类」补齐的模板。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、OCR_API_KEY（可选）、PDF_API_URL（可选）、DAILY_LIMIT（默认 20）＋ 必须绑定 KV 变量名 BOT_KV（收集篮 `pdf:<用户ID>`、用量 `pdf:cnt:`，新前缀，已查模块 04 注册表避冲突）。

## 玩法说明
- **图片转 PDF（零配置、纯本地）**：连发多张图片（照片或图片文件）进收集篮，点「生成 PDF」或发 /pdf，Bot 在 Worker 里把 JPEG 原样嵌入 PDF 拼成一个文件回传。PNG/WebP 会先经图片代理转成 JPEG。篮子 1 小时有效，/clear 清空。
- **PDF 提文字**：回复一个 PDF 发 /pdftext，走 OCR.space 逐页识别回文本（长文截断展示）。未配 OCR_API_KEY 时用官方演示 key helloworld，额度很小。
- **转图 / 拆分 / 合并**：/pdf2img、/split 对回复的 PDF 操作；/merge 合并收集篮里的多个 PDF。三者都走外部 PDF 服务（PDF_API_URL），**未配置时在入口就明确提示**，不会假装处理。接口口径：POST {PDF_API_URL}/to-images|split（multipart 单个 file 字段）、/merge（多个 files 字段），返回文件字节——自建 Stirling-PDF 类服务按这个口径包一层即可。

## 注意事项
- 本地生成的 PDF 一图一页、页面尺寸 = 图片像素尺寸；生成器已做结构验证（xref 偏移实测正确），但不做压缩，几十张高清图拼出的 PDF 会很大，注意 Bot 50MB 上传上限。
- CMYK 色彩的 JPEG 在个别阅读器可能反色，来源不可控的图片都会先过一遍代理转换再嵌入。
- TG 文件直链带 Token，只发给 OCR/代理/你自配的 PDF 服务，敏感文档提醒用户慎用第三方通道。
- 每人每天处理次数上限默认 20（DAILY_LIMIT 可调），护免费 OCR 与外部服务额度。

## 拼装来源
模块 43（PDF 工具）+ 模块 01（骨架）+ 模块 02（分级菜单）。
