# GitHub 通知 Bot

把 GitHub 仓库的 push / PR / Issue / Release 事件格式化成中文消息，推到绑定的 Telegram 聊天。每个聊天一份独立 HMAC 密钥。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、ADMIN_ID（可在任何群管理绑定）＋ 必须绑定 KV 变量名 BOT_KV（存绑定 gh:<聊天ID>）。

## 绑定流程
1. 在想收通知的聊天（私聊或群）里发 /ghbind —— 群里需群管理员身份。Bot 回你两样东西：
   - Payload URL：`https://你的Worker地址/github/<聊天ID>`
   - Secret：一串随机密钥（**只显示这一次**，重新 /ghbind 会换新，GitHub 侧要同步改）
2. 去 GitHub 仓库 Settings → Webhooks → Add webhook：填上面两项，Content type 选 `application/json`，事件选 push / Pull requests / Issues / Releases（或 Send everything，多余事件 Bot 会安静忽略）。
3. 保存后 GitHub 立刻 ping 一次，聊天里收到「🔌 连通成功」就说明通了。
- /ghinfo 看绑定地址（密钥不回显）；/ghunbind 解绑（记得去 GitHub 删对应 Webhook）。

## 安全说明
- 验签：GitHub 用 Secret 对**原始请求体**算 HMAC-SHA256 放 X-Hub-Signature-256 头，Bot 用恒定时间比较验签；签名不对直接 401，不做任何处理。**没有密钥的人就算知道 /github/<聊天ID> 地址也伪造不了事件。**
- 聊天 ID 不是秘密、密钥才是：密钥只在 /ghbind 时显示一次，KV 里也只存这一份；怀疑泄露就重新 /ghbind 换新并同步 GitHub。
- 一个聊天一份绑定，可绑多个仓库（每个仓库都填同一个 URL+密钥即可）；多个聊天互不可见。

## 注意事项
- 目前格式化事件：ping、push（最多列 5 个提交）、pull_request（opened/merged/closed/reopened）、issues（opened/closed/reopened）、release（published）。想加事件在 formatEvent 里补分支。
- 消息带 disable_web_page_preview，防链接预览刷屏。
- GitHub 侧 Webhook 的 Recent Deliveries 可以看投递与响应，排障先看那里是不是 200。

## 拼装来源
模块 41（通知适配器：GitHub/运维通知）+ 模块 20（消息推送 API 的 HTTP 入口姿势）+ 模块 01（骨架）。
