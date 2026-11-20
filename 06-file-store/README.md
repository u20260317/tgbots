# 文件存储分享 Bot

管理员发文件给 Bot→生成 t.me/Bot?start=f_短码 分享链接→任何人点链接即可领文件。文件本体存在 Telegram 服务器，KV 只存映射。

## 部署（3 分钟）
1. Telegram 找 @BotFather → /newbot 建 Bot，拿到 Token。
2. Cloudflare 控制台 → Workers & Pages → Create Worker → 命名 → Deploy → Edit code，把本目录 `worker.js` 全文粘贴进去（或拖拽上传）→ Deploy。
3. Worker → Settings → Variables and Secrets：按下面清单逐个添加（带 * 为必填，Token 选 Secret 类型）。
4. 浏览器打开 `https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET`，返回里 telegram.ok=true 即挂载成功。
5. 回 Telegram 给 Bot 发 /start 测试。

变量清单：BOT_TOKEN*、ADMIN_ID*、BOT_USERNAME*、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV

## 说明
先在 Worker 的 Bindings 里绑定 KV 再部署使用。想下架某个文件：在 KV 控制台删掉对应 f:短码 键即可。

通用手把手图文步骤、ID 怎么查、常见报错排查见仓库根目录 `docs/DEPLOY.md`。
