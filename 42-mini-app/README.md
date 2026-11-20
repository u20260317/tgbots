# Mini App 三件套 Bot

一个 Worker 同时是 Bot + 网站 + API：Mini App 页面由 Worker 自己托管（GET /app），页面把 initData POST 回同一个 Worker 验签、存留言。这是「单文件全栈」的样板，模块 28 的成品落地版。

## 三件套结构
- **Bot**：webhook 走 /webhook，/app 发 inline web_app 按钮、/kb 发键盘 web_app 按钮。
- **网站**：fetch 路由 /app 直接返回一份自包含 HTML（个人名片 + 留言板），引用 Telegram 官方 WebApp SDK，地址就是 Worker 自己的域名，不用再部署前端。
- **API**：POST /api/verify 只验签回显用户；POST /api/message 验签后把留言存 KV `mini:<用户ID>`（新前缀，已查注册表避冲突），私聊 /mymsgs 可查。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET、APP_URL（部署完 Worker 后填 `https://你的Worker域名/app`，web_app 按钮必须用绝对地址，填完不用重新部署）＋ 建议绑定 KV 变量名 BOT_KV（不绑则页面和验签可用，留言接口会明确报错）。

## ⚠️ 安全提醒（最重要的一条）
**initData 必须在服务端验签。** 页面里的 `Telegram.WebApp.initDataUnsafe` 是客户端自报数据、未经签名，任何人都能伪造，只能拿来预填界面（本页就是这样用的）；真正的身份认定只认 /api/verify 用 Bot Token 做 HMAC-SHA-256 验签后的结果。验签还查 auth_date 新鲜度（默认 1 小时）防重放。本模板两个 API 都先验签再办事，照抄时别把这一步省掉。

## 玩法说明
- /app：消息下方出按钮，点开应用（群里也能发这种）。
- /kb：输入框旁键盘出按钮（仅私聊）；**只有键盘按钮打开的应用能用 Telegram.WebApp.sendData() 回传数据**，Bot 侧 web_app_data 分支已接好回显。
- 应用里提交留言 → 存 KV → 私聊 /mymsgs 查看（最多留最近 20 条）。

## 注意事项
- 页面用了 Telegram 主题 CSS 变量（--tg-theme-*），在 TG 里打开会自动跟随深浅色；在普通浏览器打开没有 initData，验签徽标会显示失败，这是预期行为。
- BotFather 里还可以用 /setmenubutton 再配一个菜单按钮入口，和代码里的按钮不冲突。
- 换成你自己的应用时：改 APP_HTML 的内容和 apiMessage 的存储逻辑即可，验签模块原样保留。

## 拼装来源
模块 28（Mini App 接入）+ 模块 01（骨架）+ 模块 02（分级菜单）。
