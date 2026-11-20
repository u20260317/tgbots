# 34 · 个人提醒 / 待办模块

> 每个人给自己定的闹钟和清单：「10 分钟后提醒我开会」「明天下午 3 点交报告」，到点 Bot 私聊戳你；待办则是能勾掉的任务列表。和 21 号的区别在文末，先看实现。

## 原理

三件事：**听懂时间**、**存下来**、**到点叫人**。时间解析走启发式正则：相对时间（X 分钟/小时后）最好认；绝对时间（今天/明天 + 时点）次之；周期（每周一 9 点）单独一类。解析不出来就回问，别瞎猜一个时间定了。存 KV `rem:<用户ID>:<提醒ID>`，值是 {text, at, repeat}；Cron 每分钟扫一遍到期的发出去，一次性的删掉、周期性的顺延到下个周期。待办简单些：一份数组存 `todo:<用户ID>`，按钮勾选即删。

## 代码

```js
// ============================================================
// 【核心模块】自然语言时间解析（启发式）
// 支持：「10分钟后」「2小时后」「今天21:30」「明天9点」
// 「每周一9:00」。认不出返回 null，让上层回问用户。
// 这是覆盖常见说法的简化实现，不是 NLP：复杂说法（下周五、
// 月底、节假日）一律走「认不出 → 给出示例让用户重说」的路子。
// tzOffset 按用户时区算（默认 +8），和 16 号模块的 dayKey 同理。
// ============================================================
function parseWhen(text, tzOffset = 8) {
  const now = new Date(Date.now() + tzOffset * 3600 * 1000);
  const rel = text.match(/(\d+)\s*(分钟|小时)后/);
  if (rel) {
    const ms = Number(rel[1]) * (rel[2] === "小时" ? 3600 : 60) * 1000;
    return { at: Date.now() + ms, repeat: "" };
  }
  const timeM = text.match(/(\d{1,2})[:：点](\d{2})?/);
  if (!timeM) return null;
  const hh = Number(timeM[1]);
  const mm = Number(timeM[2] || 0);
  const atLocal = new Date(now);
  atLocal.setHours(hh, mm, 0, 0);
  const weekM = text.match(/每周([一二三四五六日天])/);
  if (weekM) {
    const target = "一二三四五六日天".indexOf(weekM[1]) % 7; // 周一=0..周日=6
    const cur = (now.getDay() + 6) % 7;
    let add = (target - cur + 7) % 7;
    if (add === 0 && atLocal.getTime() <= now.getTime()) add = 7;
    atLocal.setDate(atLocal.getDate() + add);
    return {
      at: atLocal.getTime() - tzOffset * 3600 * 1000,
      repeat: "weekly",
    };
  }
  if (/明天/.test(text)) atLocal.setDate(atLocal.getDate() + 1);
  else if (atLocal.getTime() <= now.getTime())
    atLocal.setDate(atLocal.getDate() + 1); // 说「今天9点」但已过点，顺延明天
  return { at: atLocal.getTime() - tzOffset * 3600 * 1000, repeat: "" };
}

// ============================================================
// 【核心模块】提醒存取与到期扫描（配合 09 号 Cron，每分钟一轮）
// rem:<用户ID>:<提醒ID> = { text, at, repeat }
// 扫描用 list 前缀 "rem:" 全量过：用户量级在千以内没问题；
// 再大就按小时分桶存，别每分钟全表扫。
// ============================================================
async function addReminder(env, userId, text, when) {
  const id = Date.now().toString(36);
  await env.BOT_KV.put(
    `rem:${userId}:${id}`,
    JSON.stringify({ text, at: when.at, repeat: when.repeat }),
  );
  return id;
}
async function runReminders(env) {
  const list = await env.BOT_KV.list({ prefix: "rem:", limit: 1000 });
  const now = Date.now();
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const rem = JSON.parse(raw);
    if (rem.at > now) continue;
    const userId = k.name.split(":")[1];
    await send(env, userId, "⏰ 提醒：" + rem.text);
    if (rem.repeat === "weekly") {
      rem.at += 7 * 86400 * 1000;
      await env.BOT_KV.put(k.name, JSON.stringify(rem));
    } else {
      await env.BOT_KV.delete(k.name);
    }
  }
}

// ============================================================
// 【核心模块】待办清单（按钮勾选）
// todo:<用户ID> = [{ id, text }...]。列表渲染成按钮：点一条 = 完成
// 并移除，回调前缀 rem:done:<id>（和提醒同族，见 03 号前缀表）。
// 加待办：/todo 内容；看清单：/todo（不带内容）。
// ============================================================
async function getTodos(env, userId) {
  const raw = await env.BOT_KV.get("todo:" + userId);
  return raw ? JSON.parse(raw) : [];
}
function todoView(todos) {
  if (!todos.length) return { text: "🎉 待办清单是空的。" };
  return {
    text: "📋 你的待办（点按钮勾掉已完成）：",
    reply_markup: {
      inline_keyboard: todos.map((td) => [
        { text: "⬜ " + td.text, callback_data: "rem:done:" + td.id },
      ]),
    },
  };
}
async function handleTodoDone(env, cq) {
  const id = cq.data.slice("rem:done:".length);
  const todos = (await getTodos(env, cq.from.id)).filter((td) => td.id !== id);
  await env.BOT_KV.put("todo:" + cq.from.id, JSON.stringify(todos));
  await tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: "✅ 已完成",
  });
  const v = todoView(todos);
  return tg(env, "editMessageText", {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    text: v.text,
    ...(v.reply_markup ? { reply_markup: v.reply_markup } : {}),
  });
}
```

## 接入步骤

1. KV 绑定 `BOT_KV`；Worker 的 Cron Trigger 设每分钟（`* * * * *`），scheduled 里调 `runReminders(env)`（见 09 号模块）。
2. 命令：`/remind 内容+时间`（如 `/remind 10分钟后 开会`，解析时先抠时间短语、剩下的是提醒内容）或直接把「提醒我…」句式接进普通文本分支；`/todo` 系列管清单。注册进 COMMANDS_USER。
3. 回调分发加 `rem:` 前缀分支指向 `handleTodoDone`。
4. TZ_OFFSET 环境变量按用户主要时区填，解析和回显时间都用它。

## 注意点

- Cron 是每分钟粒度，提醒误差最多约 1 分钟，秒级准时的需求（抢购、开奖）别用这个。
- 时间解析失败一定要回问并给示例句式，闷头猜错时间比不提醒更招骂。
- 用户改时区/出差时旧提醒按老时区响，属预期行为，/reminders 列表里把触发时间写全（几月几日几点）方便自查。
- 和 21 号定时播报的区别：21 是**管理员对群/频道**的固定时刻广播（jobs 表、面向所有人），本模块是**每个用户对自己**的相对/自然语言提醒（per-user 数据、只私聊本人），数据结构和入口都不要混。
