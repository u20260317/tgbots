// ============================================================
// 17 任务赚钱 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：管理员发布任务，用户做任务攒积分，积分攒够申请兑换，管理员审核发放。
// 任务两类：
// join 加入指定频道/群 —— Bot 用 getChatMember 自动验证，真完成才给分
// manual 手动类（如转发、截图类）—— 用户点「提交完成」，管理员看卡点通过/驳回
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// EXCHANGE_RATE 兑换说明文案（如「100 分 = 1 USDT，管理员手动发放」）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（键：task:<任务ID>、pts:<用户ID>、
// done:<用户ID>:<任务ID>、claim:<申请ID>、exch:<兑换ID>）。
// ⚠️ Bot 必须是 join 类任务目标频道的管理员，否则查不到成员状态、验证会一直失败。
// 管理员命令：
// /addtask join @频道用户名 积分 任务标题
// /addtask manual https://说明或链接 积分 任务标题
// /tasks 管理视角列表（含 ID） · /deltask 任务ID
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// ============================================================

// ============================================================
// 【核心模块】Telegram Bot API 通信层
// 统一封装 tg()：所有给 Telegram 发的请求都走这里，改 API 地址/加重试只改这一处。
// ============================================================
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
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const adminChat = (env) => admins(env)[0];
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;

// ============================================================
// 【核心模块】积分与任务存储（KV）
// task:<ID> 任务定义；pts:<用户ID> = { p, name} 积分档案；done: 防重复领；
// claim:<ID> manual 任务的待审提交；exch:<ID> 待审兑换申请。
// ============================================================
async function getKV(env, key) {
  const raw = await env.BOT_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function putKV(env, key, val) {
  await env.BOT_KV.put(key, JSON.stringify(val));
}
async function award(env, user, points) {
  const prof = (await getKV(env, "pts:" + user.id)) || { p: 0, name: "" };
  prof.p += points;
  prof.name = who(user);
  await putKV(env, "pts:" + user.id, prof);
  return prof.p;
}
async function listTasks(env) {
  const list = await env.BOT_KV.list({ prefix: "task:", limit: 100 });
  const out = [];
  for (const k of list.keys) {
    const t = await getKV(env, k.name);
    if (t) out.push({ id: k.name.slice(5), ...t });
  }
  return out;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "tasks", description: "任务列表" },
  { command: "me", description: "我的积分" },
  { command: "exchange", description: "申请兑换积分" },
  { command: "addtask", description: "发布任务（管理员）" },
  { command: "deltask", description: "下架任务（管理员）" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("task-earn bot is running.", {
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
      const cm = await tg(env, "setMyCommands", { commands: COMMANDS });
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

// ============================================================
// 【核心模块】业务主流程
// 用户侧：任务列表 -> join 类自动验证（verify:）/ manual 类提交审核（submit:）；
// 管理员侧：审核卡按钮（claimok:/claimno:、exok:/exno:）与发任务命令。
// ============================================================
async function handle(env, update) {
  if (!env.BOT_KV) {
    const m = update.message;
    if (m)
      return send(
        env,
        m.chat.id,
        "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。",
      );
    return;
  }
  const cq = update.callback_query;
  if (cq) {
    const [act, arg] = String(cq.data || "").split(":");
    // join 类自动验证
    if (act === "verify") {
      const task = await getKV(env, "task:" + arg);
      if (!task)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "任务不存在或已下架",
          show_alert: true,
        });
      if (await env.BOT_KV.get(`done:${cq.from.id}:${arg}`))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这个任务你已经领过奖励啦",
        });
      const r = await tg(env, "getChatMember", {
        chat_id: task.target,
        user_id: cq.from.id,
      });
      const ok =
        r.ok &&
        ["member", "administrator", "creator", "restricted"].includes(
          r.result.status,
        );
      if (!ok)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `还没检测到你加入 ${task.target}，加入后再点验证`,
          show_alert: true,
        });
      await env.BOT_KV.put(`done:${cq.from.id}:${arg}`, "1");
      const total = await award(env, cq.from, task.points);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `✅ 验证通过 +${task.points} 分`,
      });
      return send(
        env,
        cq.message.chat.id,
        `🎉 任务「${task.title}」完成，+${task.points} 分，当前共 ${total} 分。`,
      );
    }
    // manual 类提交
    if (act === "submit") {
      const task = await getKV(env, "task:" + arg);
      if (!task)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "任务不存在",
          show_alert: true,
        });
      if (await env.BOT_KV.get(`done:${cq.from.id}:${arg}`))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已完成/已提交过",
        });
      const claimId = newId();
      await putKV(env, "claim:" + claimId, {
        user: cq.from.id,
        name: who(cq.from),
        fname: cq.from.first_name || "",
        uname: cq.from.username || "",
        taskId: arg,
        title: task.title,
        points: task.points,
      });
      await tg(env, "sendMessage", {
        chat_id: adminChat(env),
        text: `📝 任务完成待审核\n用户：${who(cq.from)}\n任务：${task.title}（+${task.points} 分）\n目标：${task.target}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ 通过发分", callback_data: `claimok:${claimId}` },
              { text: "❌ 驳回", callback_data: `claimno:${claimId}` },
            ],
          ],
        },
      });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已提交，等管理员审核",
      });
      return send(
        env,
        cq.message.chat.id,
        "⏳ 已提交审核，通过后积分自动到账。",
      );
    }
    // 管理员审核：任务提交
    if (act === "claimok" || act === "claimno") {
      if (!isAdmin(env, cq.from.id))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能审核",
          show_alert: true,
        });
      const claim = await getKV(env, "claim:" + arg);
      if (!claim)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "申请不存在或已处理",
          show_alert: true,
        });
      await env.BOT_KV.delete("claim:" + arg);
      if (act === "claimok") {
        await env.BOT_KV.put(`done:${claim.user}:${claim.taskId}`, "1");
        const total = await award(
          env,
          {
            id: claim.user,
            first_name: claim.fname ?? claim.name,
            username: claim.uname || "",
          },
          claim.points,
        );
        await send(
          env,
          claim.user,
          `🎉 任务「${claim.title}」审核通过，+${claim.points} 分，当前共 ${total} 分。`,
        );
      } else
        await send(
          env,
          claim.user,
          `😢 任务「${claim.title}」的提交被驳回，如有疑问联系管理员。`,
        );
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已处理",
      });
      return tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: act === "claimok" ? "✅ 已通过" : "❌ 已驳回",
                callback_data: "done",
              },
            ],
          ],
        },
      });
    }
    // 管理员审核：兑换申请
    if (act === "exok" || act === "exno") {
      if (!isAdmin(env, cq.from.id))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能审核",
          show_alert: true,
        });
      const ex = await getKV(env, "exch:" + arg);
      if (!ex)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "申请不存在或已处理",
          show_alert: true,
        });
      await env.BOT_KV.delete("exch:" + arg);
      if (act === "exok") {
        const prof = (await getKV(env, "pts:" + ex.user)) || { p: 0 };
        prof.p -= ex.amount;
        await putKV(env, "pts:" + ex.user, prof);
        await send(
          env,
          ex.user,
          `🎉 兑换申请已通过，${ex.amount} 分已扣除，奖励由管理员发放（当前剩余 ${prof.p} 分）。`,
        );
      } else
        await send(
          env,
          ex.user,
          "😢 兑换申请被驳回，积分未扣除，如有疑问联系管理员。",
        );
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已处理",
      });
      return tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: act === "exok" ? "✅ 已通过（请手动发放）" : "❌ 已驳回",
                callback_data: "done",
              },
            ],
          ],
        },
      });
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private" || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const userIsAdmin = isAdmin(env, msg.from.id);

  if (userIsAdmin && cmd === "/addtask") {
    const m = text.match(/^\/addtask\s+(join|manual)\s+(\S+)\s+(\d+)\s+(.+)/);
    if (!m)
      return send(
        env,
        msg.chat.id,
        "用法：\n/addtask join @频道用户名 积分 任务标题\n/addtask manual https://链接或说明 积分 任务标题",
      );
    const id = newId();
    await putKV(env, "task:" + id, {
      type: m[1],
      target: m[2],
      points: Number(m[3]),
      title: m[4].trim(),
    });
    return send(
      env,
      msg.chat.id,
      `✅ 任务已发布，ID：${id}\n${m[4]}（+${m[3]} 分，${m[1] === "join" ? "自动验证" : "人工审核"}）`,
    );
  }
  if (userIsAdmin && cmd === "/deltask") {
    const id = text.split(/\s+/)[1];
    if (!id) return send(env, msg.chat.id, "用法：/deltask 任务ID");
    await env.BOT_KV.delete("task:" + id);
    return send(env, msg.chat.id, `已下架任务 ${id}。`);
  }

  if (cmd === "/tasks" || cmd === "/start") {
    const tasks = await listTasks(env);
    if (!tasks.length)
      return send(
        env,
        msg.chat.id,
        "📋 暂时没有任务，晚点再来。发 /me 看积分。",
      );
    await send(env, msg.chat.id, "📋 任务列表（点按钮去完成/验证）：");
    for (const t of tasks) {
      const done = await env.BOT_KV.get(`done:${msg.from.id}:${t.id}`);
      const kb =
        t.type === "join"
          ? {
              inline_keyboard: [
                [
                  {
                    text: `➕ 去加入 ${t.target}`,
                    url: t.target.startsWith("@")
                      ? "https://t.me/" + t.target.slice(1)
                      : t.target,
                  },
                ],
                [
                  {
                    text: "✅ 我已加入，验证",
                    callback_data: `verify:${t.id}`,
                  },
                ],
              ],
            }
          : {
              inline_keyboard: [
                [
                  {
                    text: "🔗 打开任务目标",
                    url: /^https?:\/\//.test(t.target)
                      ? t.target
                      : "https://t.me/",
                  },
                ],
                [
                  {
                    text: "📝 提交完成（人工审核）",
                    callback_data: `submit:${t.id}`,
                  },
                ],
              ],
            };
      await send(
        env,
        msg.chat.id,
        `${done ? "✅ " : "🎯 "}${t.title}\n奖励：+${t.points} 分${t.type === "join" ? `\n目标：加入 ${t.target}` : ""}${done ? "\n（已完成）" : ""}`,
        done ? {} : { reply_markup: kb },
      );
    }
    return;
  }
  if (cmd === "/me") {
    const prof = (await getKV(env, "pts:" + msg.from.id)) || { p: 0 };
    return send(
      env,
      msg.chat.id,
      `🧾 你的积分：${prof.p}\n兑换说明：${env.EXCHANGE_RATE || "（管理员未设置）"}\n申请兑换发 /exchange 积分数`,
    );
  }
  if (cmd === "/exchange") {
    const amount = Number(text.split(/\s+/)[1]);
    const prof = (await getKV(env, "pts:" + msg.from.id)) || { p: 0 };
    if (!amount || amount <= 0)
      return send(env, msg.chat.id, "用法：/exchange 积分数");
    if (prof.p < amount)
      return send(
        env,
        msg.chat.id,
        `积分不足：你有 ${prof.p} 分，想兑 ${amount} 分。`,
      );
    const exId = newId();
    await putKV(env, "exch:" + exId, {
      user: msg.from.id,
      name: who(msg.from),
      amount,
    });
    await tg(env, "sendMessage", {
      chat_id: adminChat(env),
      text: `💱 兑换申请待审核\n用户：${who(msg.from)}\n申请扣除：${amount} 分\n通过后请按兑换规则手动给用户发放奖励：`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 通过并扣分", callback_data: `exok:${exId}` },
            { text: "❌ 驳回", callback_data: `exno:${exId}` },
          ],
        ],
      },
    });
    return send(
      env,
      msg.chat.id,
      "⏳ 兑换申请已提交管理员审核，通过后扣分并发放。",
    );
  }
  if (text.startsWith("/"))
    return send(
      env,
      msg.chat.id,
      "命令：/tasks 任务列表 · /me 我的积分 · /exchange 积分数 申请兑换",
    );
}
