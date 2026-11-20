# 25 · AI 对话模块

> 给 Bot 接上大模型：走 OpenAI 兼容接口（/chat/completions），每个用户的上下文单独存 KV，人设、截断、用量三件套管住效果和成本。

## 原理

Chat Completions 接口本身是无状态的——模型记不住上一句，每次请求都要把历史消息一起发过去。所以上下文必须 Bot 自己存：`ai:<用户ID>` 一份记录，里面是消息数组 + 当日用量计数。流程是：用户发话 → 读出历史 → 拼上人设 system prompt → 截断到上限 → 调接口 → 把回复也存回历史 → 发给用户。

接口选 OpenAI 兼容格式（`POST {AI_BASE}/chat/completions`，Bearer Key），是因为国内外绝大多数模型服务和中转都兼容这个格式，换模型只改三个环境变量，不动代码。

## 代码

```js
// ============================================================
// 【核心模块】AI 上下文存储（KV）
// ai:<用户ID> = { msgs: [{role, content}...], day: "2026-11-20", used: 当日已用次数 }
// msgs 不含 system prompt，人设每次请求时临时拼到最前面，改人设不用清历史。
// ============================================================
async function getAiCtx(env, userId) {
  const raw = await env.BOT_KV.get("ai:" + userId);
  return raw ? JSON.parse(raw) : { msgs: [], day: "", used: 0 };
}
async function saveAiCtx(env, userId, ctx) {
  await env.BOT_KV.put("ai:" + userId, JSON.stringify(ctx));
}

// ============================================================
// 【核心模块】AI 调用（OpenAI 兼容接口）
// 截断策略：保留最近 AI_MAX_TURNS 轮对话，老的直接丢——上下文越长越贵，
// 也越容易被旧话题带偏。system 人设永远在第一条，不参与截断。
// ============================================================
async function callAI(env, ctx, userText) {
  const maxMsgs = (Number(env.AI_MAX_TURNS) || 10) * 2;
  const history = ctx.msgs.slice(-maxMsgs);
  const messages = [
    { role: "system", content: env.AI_SYSTEM || "你是一个友好的助手，回答简洁。" },
    ...history,
    { role: "user", content: userText },
  ];
  const r = await fetch(env.AI_BASE + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + env.AI_KEY,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0.7,
    }),
  });
  const data = await r.json().catch(() => ({}));
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error(data?.error?.message || "AI 接口无返回");
  ctx.msgs.push(
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  );
  ctx.msgs = ctx.msgs.slice(-maxMsgs);
  return reply;
}

// ============================================================
// 【核心模块】AI 对话入口（含用量控制）
// 用量按天计数：day 不是今天就清零，used 超过 AI_DAILY_LIMIT 直接拒答，
// 防一个人刷爆你的接口额度。/reset 清空自己的上下文重新开聊。
// 回复超过 4096 字符（Telegram 单条上限）时按段切开发送。
// ============================================================
async function handleAiMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  const ctx = await getAiCtx(env, userId);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (ctx.day !== today) {
    ctx.day = today;
    ctx.used = 0;
  }
  if (text === "/reset") {
    ctx.msgs = [];
    await saveAiCtx(env, userId, ctx);
    return send(env, chatId, "🧹 上下文已清空，我们重新开始聊吧。");
  }
  const limit = Number(env.AI_DAILY_LIMIT) || 50;
  if (ctx.used >= limit)
    return send(env, chatId, `今天已经聊了 ${limit} 次，明天再来吧。`);
  ctx.used += 1;
  let reply;
  try {
    reply = await callAI(env, ctx, text);
  } catch (e) {
    return send(env, chatId, "😵 AI 暂时不舒服：" + e.message);
  }
  await saveAiCtx(env, userId, ctx);
  for (let i = 0; i < reply.length; i += 4000)
    await send(env, chatId, reply.slice(i, i + 4000));
}
```

## 可选：流式输出（sendMessageDraft）

Bot API 提供 `sendMessageDraft`：在私聊里先发一条「草稿消息」，再用同一个 `draft_id` 反复更新它的文本，最后用 sendMessage 发正式版，视觉上就是打字机流式效果。接法：调接口时带 `stream: true` 读 SSE 流，每攒一小段就 `tg(env, "sendMessageDraft", { chat_id, draft_id, text: 已生成部分 })`，结束再 sendMessage 全文。限制要写清：**只对私聊生效**、草稿约 30 秒过期、部分客户端版本不渲染草稿。群聊里别用，还是等全文生成完一次发。

## 接入步骤

1. KV 绑定 `BOT_KV`（上下文和用量都存里面）。
2. 环境变量：`AI_BASE`（如 `https://api.openai.com/v1` 或任意兼容中转）、`AI_KEY`（Secret）、`AI_MODEL`、`AI_SYSTEM`（人设，可选）、`AI_MAX_TURNS`（默认 10）、`AI_DAILY_LIMIT`（默认 50）。
3. 在 handle() 里把私聊的普通文本消息（非命令）分发给 `handleAiMessage(env, msg)`；命令表里加 `reset` 并写进 COMMANDS_USER（见 02 号模块）。

## 注意点

- `AI_KEY` 只放 Secret，别写进代码；中转站的 key 更是只认钱，泄露等于送人。
- 上下文是用户的聊天记录，明文躺在 KV 里——README 里要跟使用者讲明，并提供 /reset 自行清除。
- 用量控制是按消息次数粗算的，接口按 token 收费时成本和次数不完全成正比，大手笔用户再加一层按字符数估算。
- 模型胡说八道是常态，涉及医疗、法律、转账类话题时在人设里加免责声明，别让 Bot 冒充专业人士。
