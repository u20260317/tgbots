# 视频解析下载 Bot

贴视频页链接 → 选画质/音频 → 解析出直链 → Bot 把视频发回聊天。解析层可替换，Workers 只做 Telegram 侧收发。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、RESOLVER_API（解析服务基地址，**不填就是演示模式**：Bot 会明确提示未配置、不做假解析）、DL_DAILY_LIMIT（每人每日次数，默认 20）、ADMIN_ID（看 /dlstats）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。

## 解析层说明（重要）
- Workers 里**跑不了 yt-dlp / ffmpeg**（无二进制、无长驻进程），解析必须外置。本模板的 `resolveMedia()` 是唯一解析入口，默认实现走 **cobalt 兼容协议**：`POST {RESOLVER_API}/`，JSON `{url, videoQuality:"720", downloadMode}` → 响应 `{url, filename}`。自建 cobalt 实例、其他解析 API、你自己的外置下载服务，改这一个函数即可接上。
- 直链常带时效和防盗链：Bot 拿到后立刻 sendVideo 让 Telegram 去拉；拉不动时自动兜底把直链发给用户自己下。
- 大小探测：解析后先 HEAD 探 content-length，>50MB 直接回直链并说明（Bot API 发送上限 50MB，硬限制；要突破只能自建 Local Bot API Server，不在本模板范围）。

## 玩法说明
- 发含链接的消息（YouTube/TikTok/IG/X/B站等，取决于你的解析服务支持范围）→ 按钮选 🎬 视频 / 🎵 只要音频 / ❌ 取消。任务存 KV dl:<任务ID>，10 分钟过期，且只有发起人能点。
- 点选时才计每日次数（dl:cnt:），超限拒绝；管理员 /dlstats 看今日总量。
- 音频走 sendAudio，视频走 sendVideo（supports_streaming）。

## 注意事项（版权与合规）
- ⚖️ **只下载你有权下载的内容**（自己上传的、公共领域、已获授权的）。Bot 的 /start 与视频 caption 都带此提示。
- 本 Bot **不绕 DRM、不破付费墙**；解析服务本身的合规性、目标站点的服务条款，由部署者自行评估承担。
- 解析服务是别人的服务器：别把隐私链接丢给不可信的解析源；自建 cobalt 是最稳妥的姿势。

## 拼装来源
模块 32（视频/媒体链接解析下载）+ 模块 01（骨架）+ 模块 02（分级菜单）。
