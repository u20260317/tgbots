# 母体 Bot（多租户托管）

> ## ⚠️⚠️⚠️ 风险提示（部署前必读）⚠️⚠️⚠️
> 本 Bot 会**代管别人 Bot 的 Token**——Token 就是那个 Bot 的全部权限（发消息、删消息、踢人，无所不能）。一旦母体被攻破或密钥泄露，**所有子 Bot 同时沦陷**。
> - 子 Token 一律 **AES-GCM 加密**后才存 KV，加密密钥 `TOKEN_ENC_KEY` 只放 Cloudflare Secret，丢了密钥等于所有密文作废（子 Bot 需重新入驻）；
> - 任何界面、回显、日志都**不出现 Token 原文**，列表只显示用户名和掩码；
> - 入驻文案已写明告知义务：用户随时可去 @BotFather 用 **/revoke** 让托管立即失效——这是用户的安全阀，不要试图弱化它；
> - **只建议自用或熟人小圈子部署**，别公开招揽陌生人交 Token；真要对外运营，先想清信任、合规与责任问题。

一个 Worker 托管 N 个子 Bot：用户在母体里选模板、交 Token，母体验真→加密存储→代设 Webhook，子 Bot 立刻上线，之后统一跑代码、统一升级。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*（母体自己的，Secret）、TOKEN_ENC_KEY*（Secret；生成方法：`openssl rand -base64 32` 或任意 32 字节随机数的 base64）、ADMIN_ID*（平台管理员，可看全部租户/熔断）、WEBHOOK_SECRET、TZ_OFFSET（子 Bot 签到时区，默认 8）＋ 必须绑定 KV 变量名 BOT_KV。

## 玩法说明
- 入驻向导（私聊）：/new → 按钮选模板 → 发子 Bot Token（格式校验 + getMe 验真）→ 核对页（只显示掩码）→ 确认开通。母体自动给子 Bot 设 Webhook 到 `/w/<slug>` 并注册子 Bot 的命令菜单。
- v1 内置 2 个子模板内核，证明多租户链路跑得通：
  - **客服**（02 简化版）：子 Bot 用户发消息 → 转发给店主；店主「回复」转发消息 → 回达用户。映射存租户 KV supmap:。
  - **签到**（13 简化版）：/qd 签到（基础 10 + 连签加成）、/me、/top 简版前十。数据存租户 KV pts:。
- /mybots 管理自己的子 Bot：停用/恢复/删除托管（删除会删子 Bot 的 Webhook 并销毁 Token 密文）。
- 平台管理员：/tenants 看全部租户，/tstop <slug> 熔断/恢复任意租户（熔断后该子 Bot 的更新被静默吞掉）。
- 子 Bot 数据隔离：内核照常写 pts:/supmap: 等键，scopedKV 自动加 `t:<子BotID>:` 前缀落库。

## 注意事项
- Webhook 路径用随机 slug 而不是 Token：Token 进 URL 会进访问日志，这是红线（模块 21 有说明）；每个租户还有独立 secret_token 二次验签。
- 一个 Token 只能挂一个 Webhook：子 Bot 入驻母体后，别再拿同一个 Token 去别处部署，会互相顶掉。
- 向导进行中，Token 明文会短暂存在 fsm: 状态键里（1 小时过期、完成即清）——KV 的访问权限等同密钥权限，别把 KV 导出/共享给任何人。
- 子 Bot 违规（垃圾/诈骗）可能连带母体：/tstop 熔断要舍得用；公开运营前先做入驻审核与举报通道（v1 未内置，自行评估）。
- 免费版 Workers 的子请求/CPU 是全体租户共享的，租户多了要按租户限流（模块 27）或分片部署。
- 扩内核：在 KERNELS 注册表里加一项 {name, commands, handle} 即可，handle 拿到的是已换好 Token 与租户 KV 的 env，照 01-30 任一模板的 handle 改即可。

## 拼装来源
模块 21（母体多租户托管）+ 模块 20（FSM 状态机）+ 模块 07（转发与回复路由）+ 模块 16（签到积分）。
