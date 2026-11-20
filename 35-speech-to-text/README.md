# 语音转文字 Bot

语音/音频消息自动转成文字：私聊发语音即转，群里管理员开开关后全群语音自动转写。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、STT_API_KEY*（Secret）、STT_API_BASE（默认 `https://api.openai.com/v1`，任何 Whisper 兼容端点都行）、STT_MODEL（默认 whisper-1）、STT_LANG（默认 zh；设为空字符串则自动检测语言）、STT_MAX_SECONDS（单条最长秒数，默认 300）、ADMIN_ID、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV（只存群开关）。
⚠️ 群里用必须去 @BotFather 给本 Bot **/setprivacy 关闭隐私模式**，否则收不到群里的普通语音消息。

## 玩法说明
- 私聊：发语音或音频文件 → Bot 下载 → 调转写接口 → 以「回复原语音」的形式发回文字。
- 群里：默认关。群管理员发 /stt on 开启（状态存 stt:on:<群ID>），之后本群所有语音自动转写；/stt off 关闭；/stt 查状态。Bot 管理员（ADMIN_ID）在任何群都有开关权。
- 时长护栏：超过 STT_MAX_SECONDS 的语音直接拒绝并说明，不打接口，防长音频刷爆额度。

## 注意事项
- 转写链路：getFile 拿路径 → 从 Telegram 文件服务器下载（Bot 下载上限 20MB）→ multipart POST 到 {STT_API_BASE}/audio/transcriptions。接口报错会把上游错误摘要回复出来便于排查。
- 语音要经过你配的 API 服务商，涉隐私的语音别用不可信的第三方端点。
- 群转写是「每条语音一次 API 调用」，活跃大群注意额度与成本；不需要的群别开。

## 拼装来源
模块 30（语音转文字）+ 模块 01（骨架）+ 模块 02（分级菜单）。
