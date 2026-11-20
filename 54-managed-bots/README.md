# Managed Bots 母体 Bot

> ## ⚠️⚠️⚠️ 风险提示（部署前必读）⚠️⚠️⚠️
> 本 Bot 会**代管别人 Bot 的 Token**——Token 就是那个 Bot 的全部权限。一旦母体被攻破或密钥泄露，**所有子 Bot 同时沦陷**。
> - 子 Token 一律 **AES-GCM 加密**后才存 KV，加密密钥 `TOKEN_ENC_KEY` 只放 Cloudflare Secret，丢了密钥等于所有密文作废；
> - 任何界面、回显、日志都**不出现 Token 原文**，列表只显示用户名和掩码；
> - 用户随时可去 @BotFather 用 **/revoke** 让托管立即失效——这是用户的安全阀，不要试图弱化它；
> - **只建议自用或熟人小圈子部署**，别公开招揽陌生人交 Token；真要对外运营，先想清信任、合规与责任问题。
> 与 32 号母体的区别：32 是用户把已有 Bot 的 Token **粘贴**给母体；54 走官方 Managed Bots 流程，子 Bot 在官方页面里**新建**、Token 由 Telegram 直接下发给母体，用户全程不用碰 Token 明文。

基于 Bot API 9.6 Managed Bots 的「一键开子 Bot」母体：用户给个建议用户名，点官方深链确认，子 Bot 创建完成、Token 自动加密托管。

## 前提（缺一不可）
- 本 Bot 必须先在 **BotFather 的 mini app 里开启 bot-management 模式（can_manage_bots）**，否则深链点开无法完成创建、本 Bot 也收不到 managed_bot 更新；
- 必须配 TOKEN_ENC_KEY（32 字节随机数的 base64，生成：`openssl rand -base64 32`）放 Secret，没配时 /newbot 会直接拒绝并说明原因；
- **不要试图走 MTProto 路线**：bots.createBot 需要用户账号客户端，单文件 Worker 里没有 MTProto 客户端，走不通；深链 + getManagedBotToken 是唯一可行路线。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、TOKEN_ENC_KEY*、WEBHOOK_SECRET、ADMIN_ID（看全部托管记录）＋ 必须绑定 KV 变量名 BOT_KV。不需要 Cron。
⚠️ allowed_updates 必须含 managed_bot（代码已带）。

## 玩法说明
- /newbot → 发建议用户名（5–32 位字母/数字/下划线、以 bot 结尾）→ Bot 回官方深链按钮 `https://t.me/newbot/<本Bot>/<建议名>` → 用户在官方页确认 → Bot 收到 managed_bot 更新，按建议名认领申请人，调 getManagedBotToken 取 Token，加密存 bot:<子BotID>，通知申请人（只显示掩码）。
- /mybots 列表（掩码）+ 每台子 Bot 带「换 Token / 删除托管」按钮。
- /rotate <子BotID或@用户名>：调 replaceManagedBotToken 换新 Token 并重新加密落库，旧 Token 立即失效。
- /revoke <子BotID或@用户名>：删除本地托管记录。注意这只删母体的保管记录，子 Bot 本身与管理权仍在 BotFather 侧，要彻底停用去 BotFather 操作。
- 管理员 /tenants 看全部托管记录（申请人、用户名、ID，不含 Token）。

## 注意事项
- 申请人归属靠「建议用户名」对回：managed_bot 更新只带子 Bot 本人信息，所以深链登记的 mgb:pend:<建议名> 是认领凭据，24 小时过期；过期后创建的 Bot 会兜底归到 ADMIN_ID 名下，没配管理员则丢弃并在代码注释里说明。
- getManagedBotToken 取不到 Token 时会把官方错误原样回给申请人并提示检查 bot-management 模式，绝不假装托管成功。
- 一个建议用户名同一时间只登记一位申请人；热门名被官方占用时在官方页就会报错，回来换名重走即可。
- 托管规模受免费版 Workers 子请求与 KV 额度约束，子 Bot 真正跑业务请另用 32 号多租户内核或单独部署模板。

## 拼装来源
模块 21（母体多租户托管：AES-GCM 加密 + bot: 键约定）+ 模块 20（FSM 向导）+ 模块 01（骨架）。
