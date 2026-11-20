# 01 · 基础骨架模块

> 所有模板共用的地基：Telegram API 请求封装、发消息快捷函数、Worker 入口（健康检查、/setWebhook 注册、webhook 密钥校验、异步处理）。任何新 Bot 都从这块开始搭。

## 代码

### tg()：唯一的 API 出口

全库所有 Telegram 调用都走这一个函数：拼 URL、POST JSON、返回解析后的响应。失败时返回空对象而不是抛错，业务代码用 `r.ok` 判断即可。

```js
async function tg(env, method, payload) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return r.json().catch(() => ({}));
}
```

### send() 与管理员名单工具

`send` 是发消息的快捷方式，`extra` 里可以塞 `reply_markup`（按钮）、`parse_mode` 等任意 sendMessage 参数。`admins/isAdmin` 是白名单判定的基础（详见 02 号模块）。

```js
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
```

### Worker 入口

三个路由：`/` 健康检查（浏览器打开能看到一句话，确认部署成功）；`/setWebhook` 一次性注册 webhook + 命令菜单（靠 WEBHOOK_SECRET 保护，别人猜不到就调不了）；`/webhook` 接收更新，先验 Telegram 的 secret_token 头，再 `ctx.waitUntil` 异步处理并立即返回 ok（Telegram 对响应速度有要求，慢了会重推）。

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("checkin-lottery bot is running.", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname === "/setWebhook") {
      if (
        !env.WEBHOOK_SECRET ||
        url.searchParams.get("key") !== env.WEBHOOK_SECRET
      )
        return new Response("forbidden", { status: 403 });
      const hook = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", {
        url: hook,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      const cm = await registerCommands(env);
      return Response.json({ setWebhook: hook, telegram: r, commands: cm });
    }
    if (url.pathname !== "/webhook" || request.method !== "POST")
      return new Response("not found", { status: 404 });
    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("x-telegram-bot-api-secret-token") !==
        env.WEBHOOK_SECRET
    )
      return new Response("forbidden", { status: 403 });
    const update = await request.json().catch(() => ({}));
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| BOT_TOKEN | 是 | BotFather 给的 token，必须设为 Secret |
| WEBHOOK_SECRET | 强烈建议 | 自己编的长随机串，/setWebhook 的钥匙 + webhook 验签 |
| ADMIN_ID | 按需 | 管理员数字 ID，多个英文逗号隔开 |

## 注意点

- token 永远只放 Secret，不要写进代码——仓库是公开的，写进去等于送人。
- `allowed_updates` 按 Bot 需要裁剪：要按钮回调就必须含 `callback_query`，要群成员事件就含 `chat_member`，漏了对应事件永远收不到。
- handle() 里再慢的操作都不会阻塞 webhook 响应，但单次执行受 Worker CPU 时间限制，长任务要拆。
