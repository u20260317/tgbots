# TTS 语音合成 Bot

文字转语音条：/tts 一段文本，回你一条条语音。是 35（语音转文字 STT）的反向搭档。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、TTS_API_URL*、TTS_API_KEY*（Secret）、WEBHOOK_SECRET。KV 选绑：绑 BOT_KV 才有每日限额（`tts:cnt:` 计数），不绑也能合成、不限量。

## 申请 Key
接口口径是 OpenAI 的 `audio/speech` 兼容格式：
- **OpenAI 官方**：platform.openai.com 注册 → API Keys 创建 Key；TTS_API_URL 填 `https://api.openai.com/v1/audio/speech`。按字符计费，长文本注意成本。
- **兼容接口**：任何实现了同一请求/响应口径的第三方或自建服务（请求体 {model, input, voice, response_format}，响应为音频字节）都能填，改 synthesize() 一个函数即可适配别家口径。
未配置 TTS_API_URL 时 /tts 会直接回复上面的申请说明，不会假装合成成功。

## 玩法说明
- /tts 文本，或回复一条文字消息发 /tts（朗读被回复的内容）。
- 长文本按句末标点分段（单段 ≤ 400 字，CONFIG.SEG_LIMIT），一段合成一条语音，顺序发送；中途失败会告诉你发到第几段。
- /voice 看当前音色/模型/限额；改音色改 worker.js 顶部 `CONFIG.VOICE`（OpenAI 口径可选 alloy/echo/fable/onyx/nova/shimmer）重新部署。

## 注意事项
- 请求时要的是 `response_format: "opus"`：Telegram 语音条（sendVoice）只吃 OGG/Opus；若接口返回 mp3（content-type 为 mpeg），Bot 自动退化为 sendAudio 发音频文件，不会硬塞。
- Workers 没有本地合成与转码能力，别指望在 Worker 里跑 TTS 模型或 ffmpeg。
- 每日限额按 UTC 日期、按段计数，绑 KV 才生效；额度是防滥用，合成 API 本身按量计费才是真正的成本闸。

## 拼装来源
模块 30（语音转文字管线）的反向 + 模块 19（外部 API 调用）+ 模块 01（骨架）。
