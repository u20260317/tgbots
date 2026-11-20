# 28 · Mini App 接入模块

> 在 Bot 里打开一个网页应用（Telegram Mini App）：Bot 负责发入口按钮、校验网页回传的身份数据、在聊天里收网页提交的结果。网页本身托管在哪都行（另一个 Worker、Pages、任意 HTTPS 站点）。

## 原理

Mini App 就是嵌在 Telegram 里的网页，有两种入口：**inline 按钮**（`web_app` 字段，私聊和群里都能用）和**回复键盘按钮**（同样是 `web_app` 字段，只有私聊）。网页打开时，Telegram 把一份 `initData` 交给网页（里面有 user 信息、auth_date 和一个 `hash` 签名），网页把这份数据原样发给你的后端，后端用 Bot Token 按固定算法验签——**验签通过才能信里面的 user.id**，因为 initData 是在客户端手里的，不验签等于谁都能伪造身份。

验签算法（官方规定）：先算 `secret = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)`，再把 initData 里除 hash 外的字段按 key 字母序拼成 `key=value` 逐行字符串，用 secret 对它再做一次 HMAC_SHA256，结果和 hash 比对一致即为真。下面给的是 Workers 里用 Web Crypto 的完整实现。

## 代码

```js
// ============================================================
// 【核心模块】Mini App initData 验签（HMAC-SHA-256）
// 网页把 Telegram.WebApp.initData 原样 POST 给后端，后端调本函数：
// 返回解析出的 user 对象 = 身份可信；返回 null = 伪造或过期，拒绝。
// 顺带查 auth_date 新鲜度（默认 1 小时），防旧数据被截获重放。
// ============================================================
const enc = new TextEncoder();
async function hmac(keyBytes, dataStr) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dataStr));
  return new Uint8Array(sig);
}
const toHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function validateInitData(env, initData, maxAgeSec = 3600) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), env.BOT_TOKEN);
  const calc = toHex(await hmac(secret, dataCheckString));
  if (calc !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

// ============================================================
// 【核心模块】Mini App 入口按钮（两种挂法）
// inline 按钮：发在消息下方，群里也能点（每个点击者打开自己的会话）。
// 键盘按钮：替换输入框旁的键盘区，只在私聊出现；只有键盘按钮打开的
// 应用才能用 Telegram.WebApp.sendData() 回传数据（见下节）。
// ============================================================
function miniAppButtons(env) {
  const url = env.APP_URL; // 你的网页地址，必须 HTTPS
  return {
    inline: {
      reply_markup: {
        inline_keyboard: [[{ text: "🛍️ 打开商城", web_app: { url } }]],
      },
    },
    keyboard: {
      reply_markup: {
        keyboard: [[{ text: "🛍️ 打开商城", web_app: { url } }]],
        resize_keyboard: true,
      },
    },
  };
}
```

## web_app_data：网页把结果发回聊天

网页里调 `Telegram.WebApp.sendData(JSON.stringify({...}))`，Bot 这边会收到一条 `message.web_app_data = { data: "字符串", button_text }` 的更新——下单结果、表单内容都靠它回传。注意两个前提：应用必须是从**键盘按钮**打开的（inline 按钮打开的调 sendData 无效），且 data ≤ 4096 字节，大数据让网页直接 POST 你的后端接口，别走这条道。

```js
// 在 handle() 的消息分支里加一段即可
if (msg.web_app_data) {
  const payload = JSON.parse(msg.web_app_data.data || "{}");
  // payload 就是网页 sendData 的内容，按你的业务处理（如下单）
  return send(env, chatId, "✅ 已收到你在应用里的提交。");
}
```

## 接入步骤

1. 先把网页部署到一个 HTTPS 地址，填进环境变量 `APP_URL`。
2. BotFather 用 `/newapp` 或 `/setmenubutton` 可以再配一个菜单按钮入口，和代码里的按钮不冲突。
3. 入口消息用上面任一挂法发出；后端接口收到 initData 时先 `validateInitData`，验不过直接 403。
4. 需要回传结果的场景用键盘按钮入口 + web_app_data 分支；只展示/跳转的场景 inline 按钮就够。

## 注意点

- 验签必须在服务端做，网页里自带的 `initDataUnsafe` 是未验签数据，只能用来预填界面，不能当身份凭证。
- initData 会过期也会被截获重放：除了 auth_date 新鲜度，关键操作（支付、改资料）建议后端再发一次性 nonce 让网页带回。
- Mini App 页面里别假设能拿到用户手机号/邮箱——initData 只有基础资料，联系方式要走 requestContact 等单独授权流程。
