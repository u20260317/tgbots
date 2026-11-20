# 07 · Mini App

## 本篇讲什么

Mini App（Web App）是什么、从哪里打开、前端页面怎么证明「我真是 Telegram 里打开的」、页面和 Bot 后端怎么分工。复杂界面（商城、表单、游戏）迟早要走到这一篇。

## 核心概念

### 本质：跑在 Telegram 里的网页

Mini App 就是一个 HTTPS 网页，被 Telegram 客户端用内嵌 WebView 打开。它不是 Bot 的一部分，而是 Bot 的「前端搭档」：页面负责复杂交互与展示，需要发消息、动数据、收钱时，回到 Bot API 与你的后端。

### 入口形态（决定能力边界）

- **键盘按钮（reply keyboard 的 web_app 按钮）**：能力最全，页面可通过 `sendData` 把数据回传给 Bot（以 `web_app_data` 服务消息到达）。商城、表单类常用。
- **inline 按钮（消息上的 web_app 按钮）**：适合从某条消息跳进详情页/小游戏；**这种入口 sendData 不可用**，数据回传要走你自己的后端接口。
- **菜单按钮（聊天框旁的 Menu Button）**：在 BotFather 或用 setChatMenuButton 配置，常驻入口。
- **附件菜单 / 直达链接（t.me/<bot>/<app>?startapp=参数）**：可分享、可带参，是 Mini App 做分发的主通道。

入口不同，能用的 API 和回传方式不同——选型时先想清楚数据怎么回 Bot，别做完了才发现此路不通。

### initData：可信的入场券

页面加载时，Telegram 通过 `Telegram.WebApp.initData` 给一段签过名的数据：包含 user（谁打开的）、chat、start_param、auth_date 和一个 `hash`。你的后端必须验签后才能信里面的身份：算法是「用 bot token 经 HMAC-SHA-256 派生密钥（salt 为固定串 WebAppData），再对排序后的参数串做 HMAC-SHA-256 与 hash 比对」，外加检查 auth_date 新鲜度防重放。**完整可跑的实现不要自己默写，去抄模块 28（已实测）**；这一篇只需记住原理：没验签的 initData 等于用户自称的身份，谁都能伪造。

### Telegram.WebApp JS API

页面侧的官方 JS 对象，主要能力：

- 生命周期：`ready()` 告知加载完成、`expand()` 展开高度、`close()` 关闭。
- 原生控件：MainButton（底部主按钮）、BackButton、SettingsButton，把关键操作交给原生按钮，体验最像原生应用。
- 主题与触感：`themeParams` 跟随用户主题配色、`HapticFeedback` 震动反馈、`colorScheme` 明暗。
- 环境信息：`initDataUnsafe`（未验签版，只能用来展示，不能用来鉴权）、平台与版本（决定某些 API 是否可用，要做能力检测）。

### 分工原则

- **页面**：浏览、选择、填表、展示——一切「看和点」。
- **后端/Bot**：身份与权限（验签后）、订单与支付状态、给用户发通知消息（页面里发不了 Telegram 消息）、长期数据。
- 页面和后端之间是你自己的 HTTPS API，记得它暴露在公网上：验签 + 限流 + 只认 initData 里的 user id 做身份（见 09 篇）。

## 实操要点

1. 页面必须 HTTPS，且在 Telegram 里调试要用真机/桌面客户端打开，普通浏览器看不到 initData。
2. startapp 参数用来做场景分发（从哪个链接进来、看哪个商品），后端按验签后的 start_param 路由。
3. 支付在 Mini App 场景里仍走 Bot 的发票流（页面调起 openInvoice，最终状态以 successful_payment 为准），别在页面里自建收款。
4. 做能力降级：老版本客户端缺某些 JS API 时，页面要能退化到核心功能可用。

## 常见坑

- **拿 initDataUnsafe 直接当登录态**：它没签名，改个 user id 就能冒充任何人。只用它渲染界面，鉴权一律后端验签。
- **inline 入口指望 sendData**：收不到。回传改走后端 API。
- **页面在 Telegram 里白屏**：多为资源跨域/混合内容/证书问题，先用客户端的调试方式看控制台（桌面端可开 DevTools，以官方文档为准）。
- **把 token 放进页面**：前端代码人人可见，token 出现在页面里等于公开（见 09 篇）。

## 在本库里看哪里落地

- 验签与回传的完整实现：[modules/28 Mini App 接入](../../modules/28-mini-app.md)（含实测记录）。
- 典型搭档：模块 22（商店）的复杂目录用 Mini App 做门面、Bot 做订单与通知。
- 身份与接口安全：[09 安全](09-security.md)。
