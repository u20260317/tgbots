# 20 · 通用多步对话状态机（FSM）模块

> 把「分步填表/向导」从每个 Bot 各写一遍，抽象成通用骨架：当前步 + 已填数据存 KV，任何消息进来先看状态再决定走哪步。aiogram 的 FSM、PTB 的 ConversationHandler、grammY 的 conversations、Telegraf 的 Scenes——四大框架的头牌功能都是它。入驻向导、结账流程、投稿表单、答题审核，第一个会用到的地方都一样。

## 状态存取

状态按「会话+用户」隔离，带 1 小时自动过期（向导没填完不长期占位）：

```js
// ============================================================
// 【核心模块】通用状态机（FSM）
// fsm:<chatId>:<userId> = { step, data, updatedAt }
// ============================================================
async function fsmGet(env, chatId, userId) {
  const raw = await env.BOT_KV.get(`fsm:${chatId}:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function fsmSet(env, chatId, userId, step, data = {}) {
  await env.BOT_KV.put(
    `fsm:${chatId}:${userId}`,
    JSON.stringify({ step, data, updatedAt: Date.now() }),
    { expirationTtl: 3600 },
  );
}
async function fsmClear(env, chatId, userId) {
  await env.BOT_KV.delete(`fsm:${chatId}:${userId}`);
}
```

## 分发姿势

消息处理开头先查状态：有状态就交给向导续走，没有才走普通命令。任何一步发 /cancel 都能退出——这是向导的标配安全带。

```js
// 在 handle() 的命令分发之前插入
const st = await fsmGet(env, chatId, msg.from.id);
if (st) {
  if (cmd === "/cancel") {
    await fsmClear(env, chatId, msg.from.id);
    return send(env, chatId, "已取消。");
  }
  return wizardStep(env, msg, st); // 按 st.step 续走，并把新数据并进 st.data
}
```

## 一个完整例子：三步向导

```js
async function wizardStep(env, msg, st) {
  const chatId = msg.chat.id, uid = msg.from.id, text = (msg.text || "").trim();
  if (st.step === "name") {
    st.data.name = text;
    await fsmSet(env, chatId, uid, "phone", st.data);
    return send(env, chatId, "第 2 步：请发你的手机号（或发 /cancel 退出）");
  }
  if (st.step === "phone") {
    st.data.phone = text;
    await fsmClear(env, chatId, uid); // 收官先清状态，再执行业务动作
    return finishSignup(env, msg, st.data);
  }
}
// 启动：if (cmd === "/signup") { await fsmSet(env, chatId, uid, "name"); return send(..., "第 1 步：请发你的名字"); }
```

## 注意点

- 每步都要校验输入（手机号格式、金额范围），校验不过就原地重问，不要推进状态。
- 按钮也能驱动状态机：回调里同样先 fsmGet 再按 step 分发，data 编步号即可。
- 收官动作（建单、发货）放在 fsmClear 之后做，失败了用户重走流程不会被旧状态卡住。
- 群聊里状态按用户隔离，两个人同时填表互不干扰；但向导更适合私聊，群里建议引导去私聊。
