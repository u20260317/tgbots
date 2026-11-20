# AI 聊天 Bot

接 OpenAI 兼容接口的大模型聊天 Bot：per-user 上下文记忆、可切换人设、每日用量上限，私聊直接聊、群里 /ask 提问。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、AI_API_KEY*（Secret）、AI_API_BASE（接口基地址，默认 `https://api.openai.com/v1`，任何 OpenAI 兼容端点都行：厂商官方兼容口、聚合中转、自建网关）、AI_MODEL（默认 gpt-4o-mini）、AI_PERSONA（默认人设文本，覆盖内置默认）、AI_DAILY_LIMIT（每人每日轮数，默认 50）、AI_MAX_TURNS（上下文保留轮数，默认 10）、ADMIN_ID、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。

## 玩法说明
- 私聊：发任意文本直接对话，Bot 记住上下文（按 AI_MAX_TURNS 截断）；群里只认 /ask 问题和「回复 Bot 消息」，防刷屏烧额度。
- /persona 看人设库（按钮切换），预置：默认/毒舌/老师/程序员/翻译官；/persona set <文本> 存自定义人设；切换人设会清空上下文。
- /reset 清空上下文；/me 看今日用量与当前人设；管理员 /aistats 看今日总轮数与活跃用户数。
- 回复超 4096 字符自动分段发送；每轮先查用量上限，超了直接拒绝，不打 API。

## 注意事项
- 上下文与用量都在 KV：ai:<用户ID> 存对话，ai:usage:<用户ID>:<日期> 存计数（两天自动过期）。
- API Key 只放 Secret；接口报错会把上游错误摘要回给用户（不含 Key），方便排查。
- 想换模型/换厂商只改 AI_API_BASE + AI_MODEL + AI_API_KEY 三个变量，不用动代码。
- 流式输出（sendMessageDraft）只适用于私聊且实现复杂，本模板用整段回复，够用且稳。

## 拼装来源
模块 25（AI 对话）+ 模块 01（骨架）+ 模块 02（分级菜单）。
