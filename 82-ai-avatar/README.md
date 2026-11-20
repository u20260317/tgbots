# AI 头像 / 证件照 Bot

发照片选风格：AI 风格头像走图像编辑 API，证件照走规格裁剪。是盘点里「AI 头像/证件照」🟡 品类的落地，与 55 号 AI 绘图同源（共用 IMAGE_API 口径）。

## 部署要点
单体三步部署，变量：BOT_TOKEN*、IMAGE_API / IMAGE_API_KEY / IMAGE_MODEL（AI 风格用，OpenAI 兼容 images 接口）、AVATAR_DAILY_LIMIT（默认 10）、ADMIN_ID（看 /avatarstats）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。**证件照模式不需要任何 API**，只配 BOT_TOKEN 就能跑；AI 风格未配 IMAGE_API 时点选会明确提示「未配置」，不假装生成。

## 玩法说明
- 发照片 → 暂存 `avatar:pend:<uid>`（只存 file_id，10 分钟过期）→ 风格键盘（回调 `avatar:style:<id>`）。
- AI 风格（商务/动漫/复古）：`editImage()` 把原图以 multipart 提交 `{IMAGE_API}/images/edits`（口径同模块 46 与 55 号模板），响应 b64_json 解码后以文件 sendPhoto、url 则直传。限额在处理前校验、成功后计数 `avatar:cnt:`。
- 证件照：回调 `avatar:id:<1|2>` → wsrv.nl 代理 `fit=cover` 裁出 1 寸 295×413 / 2 寸 413×579（300dpi 换算）。居中裁剪，人脸靠边可能被裁，回复里有提醒。

## 隐私与合规（重要）
- **隐私**：原图只在点选风格那一刻转发给所配的图像 API / 图片代理，Bot 不落盘存储原图；首次使用弹隐私提示（文案在代码里 `PRIVACY_TEXT`），/clear 可立即清待处理记录。部署者应在 Bot 介绍里同步写明数据流向。
- **证件照只做规格裁剪排版**：把已有照片裁成标准尺寸是正常用途；**不得用于伪造证件、冒充身份**。模板不提供换底色造假、五官修改类功能，AI 风格生成的头像也不得冒充真实证件照使用——这类红线请部署者在用户协议里写清。

## 拼装来源
模块 46（AI 绘图 API 适配）+ 模块 37（图片处理/代理裁剪）+ 模块 01/02（骨架与分级菜单）。
