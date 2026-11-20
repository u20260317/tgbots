# 27 · 限流与 429 重试模块

> 改造基础模块的 tg()：Telegram 对发送频率有硬限制，超了回 429 让你等。这一篇给出节流 + 按 retry_after 退避重试的 tg() 增强版，广播群发不被限流打断。

## 原理

Telegram 的大致红线：全局约 30 条/秒、同一个私聊 1 条/秒、同一个群 20 条/分钟。超限时接口返回 `{"ok":false, "error_code":429, "parameters":{"retry_after": 秒数}}`——这不是故障，是让你等这么久再发。正确姿势是两层：**发送前节流**（同一个 chat 两条之间留间隔，主动不撞线）+ **撞线后退避**（读 retry_after 睡够再重试，其它错误指数退避，几次不行就放弃并记录）。

下面的 tg() 是 01 号基础模块那版的直接替换：签名和返回值不变，业务代码无感。

## 代码

```js
// ============================================================
// 【核心模块】出站节流桶（进程内）
// 记每个 chat 上次发送的时间戳，没到间隔就先睡一会再发。
// 注意：这是 Worker 进程内存，多个实例之间不共享，只能挡住
// 单实例内的连发；真要全局严格限速得上队列（见注意点）。
// ============================================================
const lastSentAt = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function throttle(chatId, gapMs) {
  if (chatId == null) return;
  const now = Date.now();
  const wait = (lastSentAt.get(chatId) || 0) + gapMs - now;
  if (wait > 0) await sleep(wait);
  lastSentAt.set(chatId, Date.now());
}

// ============================================================
// 【核心模块】tg() 增强版：节流 + 429 退避重试
// 429：严格按 retry_after 等待后重试，最多 5 次。
// 5xx/网络错误：1s、2s、4s 指数退避，最多 3 次。
// 403（被用户拉黑/被踢）：重试也没用，直接返回让业务层清理名单。
// 只对发送类方法节流，getChatMember 这类查询不用等。
// ============================================================
const SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendDocument",
  "copyMessage",
  "forwardMessage",
  "editMessageText",
]);
async function tg(env, method, payload) {
  if (SEND_METHODS.has(method)) await throttle(payload.chat_id, 1100);
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    let data = {};
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      data = await r.json().catch(() => ({}));
    } catch (e) {
      data = { ok: false, description: String(e) };
    }
    if (data.ok) return data;
    if (data.error_code === 429 && attempt < 5) {
      await sleep((data.parameters?.retry_after || 1) * 1000);
      continue;
    }
    if (data.error_code >= 500 && attempt < 3) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    return data; // 其它错误（400/403 等）原样返回，业务层按 ok 判断处理
  }
}

// ============================================================
// 【核心模块】广播队列（分片慢发）
// 名单可能上千，一口气全发必撞限流：切成小片，片间停顿，
// 失败的（多半是拉黑/退号）收集起来回调用方统一清理。
// 在 webhook 里用 ctx.waitUntil 跑，别阻塞响应；名单特别长时
// 分多轮：本轮发前 N 个，剩下的靠 Cron 续跑（见 09 号模块）。
// ============================================================
async function sendBroadcast(env, chatIds, text, onFailed) {
  const failed = [];
  const CHUNK = 25;
  for (let i = 0; i < chatIds.length; i += CHUNK) {
    const slice = chatIds.slice(i, i + CHUNK);
    for (const id of slice) {
      const r = await tg(env, "sendMessage", { chat_id: id, text });
      if (!r.ok) failed.push(id);
    }
    if (i + CHUNK < chatIds.length) await sleep(1000); // 片间喘口气
  }
  if (onFailed && failed.length) await onFailed(failed);
  return { sent: chatIds.length - failed.length, failed: failed.length };
}
```

## 接入步骤

1. 用本篇的 tg() 整体替换 01 号模块的原版（连同上面的节流桶一起复制），其余代码不用改。
2. 广播类功能（09 号模板的 /broadcast 等）把逐条 sendMessage 换成 `sendBroadcast`，失败名单回调里从 KV 订阅表删掉（和 09 号模板原本的清理逻辑一致）。
3. 长广播放进 `ctx.waitUntil(...)` 或 Cron 里跑，不要堵 webhook 响应。

## 注意点

- retry_after 是命令不是建议：不睡够就重试只会再吃一个 429，连续违规还可能被短时封接口。
- 进程内节流桶只在单个 Worker 实例内有效，流量大到多实例并发时仍可能撞线——退避重试是第二道防线，两层都要有；再大的量就该上 Cloudflare Queues 串行消费。
- Worker 单次执行有时长和子请求数上限，几千人的广播一轮跑不完：按「每轮固定条数 + 进度存 KV + Cron 续跑」拆，别硬撑。
- 403 别重试：用户拉黑或退号是永久状态，重试纯浪费，还拖慢整批广播。
