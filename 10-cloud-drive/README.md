# 网盘 Bot（私有频道存储）

把 Telegram 私有频道当硬盘的个人网盘：文件发给 Bot → Bot 转存进你的私有频道 → 随时列表、搜索、取回、删除、生成分享链接。文件本体存在 Telegram 服务器上，KV 只存一份目录索引。

和 06 文件分享的区别：06 是「一个文件一个链接」的轻量分发，没有目录；10 是完整的个人网盘，有列表/搜索/标签/统计，适合长期攒文件。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. 先建一个**私有频道**（别公开），把 Bot 拉进去设为管理员。用 08-id-tools 查这个频道的数字 ID（-100 开头）。
3. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去 → Deploy。
4. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
5. Worker → Settings → Bindings → 添加 KV Namespace，变量名必须叫 `BOT_KV`，重新 Deploy。
6. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
7. 回 Telegram 给 Bot 发 /start，再随便发个文件测试是否转存成功（去存储频道里应能看到）。

变量清单：BOT_TOKEN*、ADMIN_ID*（主人 ID，只有主人能存/管）、STORAGE_CHANNEL_ID*（私有存储频道 -100 ID）、BOT_USERNAME*（拼分享链接）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV

## 说明
- 只有 ADMIN_ID 里的人能存文件、看目录、删除；陌生人私聊只会被拒绝。
- 例外是分享链接：每个文件存好后会生成 `https://t.me/Bot用户名?start=d_短码`，**任何人**点开都能领取该文件 — 链接只发给想给的人，短码泄露等于文件泄露；真要收回就删掉该文件重新存（短码会变）。
- 文字消息会存成「笔记」（发到存储频道的一条文本），同样可搜索/取回。
- 单文件大小受 Bot API 限制（转存为服务器间复制，一般 50MB 内稳妥，超大文件请分卷或直传频道）。
- 重要提醒：存储频道就是你的硬盘，**别手贱删频道、别把 Bot 踢出频道**；Bot 被移出管理员后存取都会失败。非常重要文件请另行备份一份，Telegram 不是备份服务。
- 索引存在 KV 的 `index` 键里：万一索引损坏，可在存储频道里人工翻找原件，文件本体不受影响。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
