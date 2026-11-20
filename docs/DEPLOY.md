# 手把手部署指南（所有 Bot 通用）

每个 Bot 都是同一个套路，学会一个就会全部。全程免费，只需要：一个 Telegram 账号 + 一个 Cloudflare 账号。

## 第 1 步：在 BotFather 建 Bot，拿 Token

1. Telegram 搜索 **@BotFather**（带蓝标的官方号），发 `/newbot`。
2. 按提示起名（显示名随意），再起一个以 `bot` 结尾的用户名（如 `my_channel_post_bot`）。
3. BotFather 会回一串 Token，形如 `123456789:AAE...`。**这串等于 Bot 的密码，不要发给任何人、不要截图外传。**
4. 可选设置：`/setdescription` 写简介、`/setuserpic` 换头像、`/setcommands` 设置命令菜单。

## 第 2 步：查 ID（很多 Bot 要填）

先部署一个 **08-id-tools**（它只需要 BOT_TOKEN 一个变量）：

- 查**自己的用户 ID**：私聊它发 `/id`。
- 查**群 ID**：把它拉进群，在群里发 `/id`（群 ID 是 -100 开头的负数）。
- 查**频道 ID**：把频道消息转发给它；或把 Bot 加为频道管理员后在频道关联群里看。
- 审核群、客服群的 ID 同理，都是「拉进去发 /id」。

## 第 3 步：在 Cloudflare 部署 Worker

1. 登录 Cloudflare 控制台 → 左侧 **Workers & Pages** → **Create** → **Create Worker**。
2. 名字随便起（会成为网址的一部分，如 `post-bot.xxx.workers.dev`），点 **Deploy** 先建空壳。
3. 点 **Edit code**，把本仓库对应目录里的 `worker.js` 全文替换进去（网页编辑器支持直接拖拽 .js 文件进去），点 **Deploy**。
4. 回 Worker 的 **Settings → Variables and Secrets**，点 **Add**，逐个添加该 Bot README 里列的变量：
   - `BOT_TOKEN`：类型选 **Secret**，值粘贴第 1 步的 Token。
   - `WEBHOOK_SECRET`：类型 Secret，自己编一串长随机字符（如 24 位字母数字），记住它，第 4 步要用。
   - 其它（ADMIN_ID、CHANNEL_ID 等）：类型选 Text/Variable 明文即可。
   - 添加完变量后需要再 **Deploy** 一次才生效（控制台会提示）。
5. 需要 KV 的 Bot（06、09、10、11、13、14、15、16、17、18、19、21、22、24，另 12 仅答题模式、23 仅价格提醒、组合 combo-drive-gate 需要；20 不用 KV）：先到 **Workers & Pages → KV** 建一个命名空间（如 `bot-kv`），再到该 Worker 的 **Settings → Bindings → Add → KV Namespace**，变量名必须填 `BOT_KV`，选刚建的命名空间，保存并重新 Deploy。

## 第 4 步：挂 Webhook（让 Telegram 把消息推给 Worker）

浏览器打开（把地址和 key 换成你自己的）：

```
https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
```

返回 JSON 里 `"ok":true` 就是成功。之后去 Telegram 给 Bot 发 `/start` 测试。

> 原理：每个 worker.js 都内置了这个 /setWebhook 路由，口令不对会 403，所以别把 WEBHOOK_SECRET 泄露出去。也可以不用这个路由，手动调 Telegram 的 setWebhook API，效果一样。

## 第 5 步：按类型做最后配置

- **要进频道/群当管理员的 Bot**（01、03、04、05）：在频道/群的管理员设置里添加 Bot，按 README 勾权限（发帖 / 删消息 / 封禁 / 禁言 / 置顶，按需）。
- **强制订阅（03）**：Bot 必须同时是「被订阅频道」的管理员，否则查不到用户是否已加入。
- **群管理（04）**：如果群开启了话题（Topics）或 Bot 收不到群消息，去 BotFather 用 `/setprivacy` 给这个 Bot 选 **Disable**（关闭隐私模式），否则它只能收到命令，看不到普通消息，违禁词/链接过滤会失效。其它需要读群消息的 Bot 同理。

## 常见问题

| 现象 | 排查 |
|------|------|
| Bot 完全没反应 | 先查 Webhook：浏览器打开 `https://api.telegram.org/bot<Token>/getWebhookInfo` 看 url 对不对、有没有报错；再查 BOT_TOKEN 是否填错 |
| /setWebhook 返回 403 | key 和 Worker 里设的 WEBHOOK_SECRET 不一致，或没设这个变量 |
| 打开 Worker 地址显示 BOT_TOKEN 未配置 | 变量没加，或加完没重新 Deploy |
| 发到频道失败 `chat not found` / `not enough rights` | CHANNEL_ID 写错（@用户名或 -100 数字 ID 二选一），或 Bot 不是频道管理员 |
| 查成员/删消息失败 | Bot 在对应频道/群不是管理员，或权限没勾 |
| 群里 Bot 只对命令有反应 | BotFather `/setprivacy` 把该 Bot 设为 Disable |
| 改了代码/变量不生效 | 每次修改后都要点 Deploy |
| Token 泄露了 | BotFather 发 `/revoke` 选对应 Bot，旧 Token 立即作废，把新 Token 填回 Secret 并重新 Deploy |

## 额度说明

Cloudflare Workers 免费版每天 10 万次请求，Telegram Bot 的每次消息/按钮算 1 次请求，个人和小社群使用绰绰有余。KV 免费额度对 06/09 这类小数据量同样足够。
