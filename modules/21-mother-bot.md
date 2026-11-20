# 21 · 母体 Bot 多租户托管模块

> 一个 Worker 托管 N 个 Bot：用户在母体里选模板、交出自己 Bot 的 token，母体代设 webhook，子 Bot 立刻上线。Manybot、Botmother、BotHost Pro 都是这个品类；本库的模板化结构（单文件、无状态、配置外置）天然适合被这样装配。**这是全库安全等级最高的模块，先读完风险一节再动手。**

## 架构

```
用户 → 母体 Bot（入驻向导：选模板 → 交 token → 填配置）
              │ getMe 验真 → AES-GCM 加密存 KV → setWebhook 到 /w/<slug>
子 Bot 的用户 → TG → POST /w/<slug> → 查租户 → 解密 token → 按租户配置
              装配模板逻辑（KV 自动加租户前缀）→ 以子 Bot 身份回复
```

## token 加密存储（已实测可跑）

密钥是 32 字节随机数 base64，放在母体 Worker 的 Secret `TOKEN_ENC_KEY` 里，**不在 KV、不在代码**。KV 里只存密文。

```js
// ============================================================
// 【核心模块】租户 token 加解密（AES-GCM）
// ============================================================
async function importKey(env) {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encToken(env, token) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  const pack = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return pack(iv.buffer) + "." + pack(ct);
}
async function decToken(env, enc) {
  const [ivB, ctB] = enc.split(".");
  const un = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await importKey(env);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: un(ivB) }, key, un(ctB));
  return new TextDecoder().decode(pt);
}
```

## 入驻与装配

租户记录 `bot:<slug>` = `{ tokenEnc, botId, username, type, owner, secret, config, stopped }`。slug 用随机串（**不要把 token 放进 URL 路径**，会进访问日志——框架 aiogram-webhook 的文档专门警告过这点），webhook 再带每租户独立的 secret_token 双保险。

```js
// 入驻最后一步：验真通过后调用
async function onboardBot(env, origin, { token, type, owner, config }) {
  const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
  if (!me.ok) return { error: "token 无效" };
  const slug = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const secret = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rec = { tokenEnc: await encToken(env, token), botId: me.result.id, username: me.result.username, type, owner, secret, config, stopped: false };
  await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
  await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${origin}/w/${slug}`, secret_token: secret, allowed_updates: ["message", "callback_query", "chat_member", "chat_join_request"] }),
  });
  return { slug, username: me.result.username };
}
```

## 运行时分发

关键一步是给租户一个「换了身份的 env」：BOT_TOKEN 换成子 Bot 的，KV 包一层租户前缀——模板代码一行不用改，数据自动隔离。

```js
function scopedKV(kv, prefix) {
  return {
    get: (k, t) => kv.get(prefix + k, t),
    put: (k, v, o) => kv.put(prefix + k, v, o),
    delete: (k) => kv.delete(prefix + k),
    list: async (o = {}) => {
      const r = await kv.list({ ...o, prefix: prefix + (o.prefix || "") });
      return { keys: r.keys.map((k) => ({ ...k, name: k.name.slice(prefix.length) })), list_complete: r.list_complete, cursor: r.cursor };
    },
  };
}
// fetch 路由：/w/<slug>
const slug = url.pathname.split("/")[2];
const rec = JSON.parse(await env.BOT_KV.get("bot:" + slug) || "null");
if (!rec || rec.stopped) return new Response("ok"); // 已停用/熔断：静默吞掉
if (request.headers.get("x-telegram-bot-api-secret-token") !== rec.secret) return new Response("forbidden", { status: 403 });
const tenantEnv = { ...env, BOT_TOKEN: await decToken(env, rec.tokenEnc), BOT_KV: scopedKV(env.BOT_KV, `t:${rec.botId}:`), TENANT: rec };
ctx.waitUntil(TEMPLATES[rec.type](tenantEnv, update)); // TEMPLATES 是模板注册表：type → 该模板的 handle 函数
```

每个子 Bot 还要独立跑一遍模块 02 的命令注册（拿子 token 调 setMyCommands），入驻完成时顺手做掉。

## 风险（务必读）

- 🔴 **代管 token = 代管全部权限**。泄漏等于所有子 Bot 同时被接管。密文存储只是底线：母体界面永不回显 token 原文（只显示 `1234…wxyz` 掩码），日志里禁止出现 token 和 /w/ 路径外的敏感信息，母体管理员也看不到原文。
- 🔴 入驻时必须明示并让用户知情：交出 token 意味着什么、如何退出（BotFather /revoke 立即让托管失效——这是用户的安全阀，要主动教）、数据如何删除。
- 🟠 一个 token 只能挂一个 webhook：用户把 token 交给母体，就不能同时在别处自托管，入驻文案要提示冲突。
- 🟠 子 Bot 违规（垃圾、诈骗）可能连带母体：要有入驻审核、举报入口和 `stopped` 熔断开关（分发代码里已带）。
- 🟠 免费额度是全租户共享的：按租户限流分桶（见模块 27），大租户不能挤死小租户；租户多了要考虑分片或付费计划。
- 二期路线：官方 Bot API 9.6 新增 Managed Bots（getManagedBotToken 等），是官方版母体机制，成熟后可迁移。
