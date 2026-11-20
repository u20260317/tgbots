// ============================================================
// 69 求职招聘 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 企业发岗：/postjob 启动向导（FSM 逐步收集 标题→城市→薪资→
// 联系方式→介绍），提交后进管理员审核（jobok:/jobno: 按钮，
// 复用模块 10 审核流），过审才上架。
// 求职者：/jobs [城市] [关键词] 浏览/搜索职位；/apply <职位ID>
// 后把下一条消息（简历文本或文件）转发给企业，并拿到联系方式。
// 职位 30 天自动过期，Cron 清理并通知发布者。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（审核靠它，没配则无人能过审）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：job:<职位ID> = 职位记录；job:fsm:<用户ID> = 发岗向导状态；
// job:apply:<用户ID> = 正在投递的职位ID。
// ⚠️ 过期清理要给 Worker 加 Cron Trigger（如 0 2 * * *）；不配也能用，职位不会自动过期。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 20（FSM 状态机）+ 模块 10（审核流）+ 模块 07（转发路由）+ 模块 01（骨架）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
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
const randId = () =>
  Date.now().toString(36) +
  Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0");

// ============================================================
// 职位存储
// job:<id> = {id, title, city, salary, contact, desc, by, chat,
// status: pending/approved/rejected, at, expireAt}。
// 联系方式不在列表里公开，只在 /apply 投递成功后给投递者，
// 减少爬联系方式的骚扰（要更严就改成只走 Bot 内转发）。
// ============================================================
async function getJob(env, id) {
  const raw = await env.BOT_KV.get("job:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveJob(env, job) {
  await env.BOT_KV.put("job:" + job.id, JSON.stringify(job));
}
async function listJobs(env, status) {
  const list = await env.BOT_KV.list({ prefix: "job:", limit: 1000 });
  const out = [];
  for (const k of list.keys) {
    if (k.name.startsWith("job:fsm:") || k.name.startsWith("job:apply:"))
      continue;
    const j = await getJob(env, k.name.slice(4));
    if (j && (!status || j.status === status)) out.push(j);
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}
function jobCard(j, withContact = false) {
  const lines = [`💼 ${j.title}`, `📍 ${j.city} · 💰 ${j.salary}`];
  if (j.desc) lines.push(j.desc);
  lines.push(
    `🆔 ${j.id} · 发布于 ${new Date(j.at).toISOString().slice(0, 10)}`,
  );
  if (withContact) lines.push(`📞 联系方式：${j.contact}`);
  return lines.join("\n");
}

// ============================================================
// 发岗向导（FSM，模块 20 的 KV 状态机姿势）
// job:fsm:<uid> = {step, data}；每步校验后推进，/cancel 随时退出。
// 最后一步提交 → 生成 pending 职位 → 给每个管理员发审核卡
// （jobok:<id> 通过 / jobno:<id> 拒绝，模块 10 审核流）。
// ============================================================
const FSM_STEPS = [
  { key: "title", ask: "第 1/5 步：职位标题？（如：外卖骑手 / 前端工程师）" },
  { key: "city", ask: "第 2/5 步：工作城市？" },
  { key: "salary", ask: "第 3/5 步：薪资范围？（如：8000-12000/月）" },
  {
    key: "contact",
    ask: "第 4/5 步：联系方式？（电话/微信/TG，只给投递成功的人看）",
  },
  { key: "desc", ask: "第 5/5 步：职位介绍（要求/福利，发「跳过」可留空）" },
];
async function fsmGet(env, uid) {
  const raw = await env.BOT_KV.get("job:fsm:" + uid);
  return raw ? JSON.parse(raw) : null;
}
async function fsmSet(env, uid, state) {
  if (state) await env.BOT_KV.put("job:fsm:" + uid, JSON.stringify(state));
  else await env.BOT_KV.delete("job:fsm:" + uid);
}
async function fsmHandle(env, msg, state) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  const step = FSM_STEPS[state.step];
  state.data[step.key] = step.key === "desc" && text === "跳过" ? "" : text;
  state.step++;
  if (state.step < FSM_STEPS.length) {
    await fsmSet(env, uid, state);
    return send(
      env,
      chatId,
      FSM_STEPS[state.step].ask + "\n（随时 /cancel 取消）",
    );
  }
  await fsmSet(env, uid, null);
  const job = {
    id: randId(),
    ...state.data,
    by: uid,
    chat: chatId,
    status: "pending",
    at: Date.now(),
    expireAt: Date.now() + 30 * 24 * 3600 * 1000,
  };
  await saveJob(env, job);
  await send(
    env,
    chatId,
    "📨 已提交审核，通过后会上架（30 天有效）。审核结果会通知你。\n\n" +
      jobCard(job),
  );
  const kb = {
    inline_keyboard: [
      [
        { text: "✅ 通过", callback_data: `jobok:${job.id}` },
        { text: "❌ 拒绝", callback_data: `jobno:${job.id}` },
      ],
    ],
  };
  for (const a of admins(env))
    await send(
      env,
      Number(a),
      `🆕 待审职位（发布者 ${uid}）：\n\n${jobCard(job, true)}`,
      { reply_markup: kb },
    );
  if (!admins(env).length)
    await send(
      env,
      chatId,
      "⚠️ 注意：管理员还没配置 ADMIN_ID，这条职位暂时无人能审核。",
    );
}

// ============================================================
// 过期清理（Cron）
// 职位到 expireAt 自动删除并通知发布者；pending 的也一样过期。
// ============================================================
async function cleanExpired(env) {
  const jobs = await listJobs(env);
  const now = Date.now();
  for (const j of jobs) {
    if (j.expireAt && j.expireAt < now) {
      await env.BOT_KV.delete("job:" + j.id);
      await send(
        env,
        j.chat,
        `⌛ 职位「${j.title}」（${j.id}）已满 30 天自动下架，需要的话重新 /postjob 发布。`,
      );
    }
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
// · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
// · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
// 于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
// 的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "jobs", description: "看职位，如 /jobs 北京 司机" },
  { command: "postjob", description: "发布职位（企业，向导填写）" },
  { command: "apply", description: "投递职位，如 /apply 职位ID" },
  { command: "myjobs", description: "我发布的职位" },
  { command: "cancel", description: "取消当前向导/投递" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "pending", description: "待审职位（管理员）" },
];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    const ids = String(env.ADMIN_ID || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const id of ids) {
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
    }
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("job-board bot is running.", {
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
  async scheduled(event, env, ctx) {
    if (env.BOT_KV) ctx.waitUntil(cleanExpired(env));
  },
};

// ============================================================
// 业务主流程
// 审核回调 jobok:/jobno: 只认管理员；投递走「/apply 设状态 →
// 下一条消息 copyMessage 转给企业」的两段式（模块 07 路由）。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    const m = data.match(/^(jobok|jobno):(.+)$/);
    if (m && env.BOT_KV) {
      if (!isAdmin(env, cq.from.id)) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "⛔ 只有管理员能审核",
        });
        return;
      }
      const job = await getJob(env, m[2]);
      if (!job || job.status !== "pending") {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这条职位已处理过",
        });
        return;
      }
      job.status = m[1] === "jobok" ? "approved" : "rejected";
      await saveJob(env, job);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: job.status === "approved" ? "✅ 已通过" : "❌ 已拒绝",
      });
      await tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text:
          cq.message.text +
          `\n\n—— ${job.status === "approved" ? "✅ 已通过上架" : "❌ 已拒绝"}（审核人 ${cq.from.id}）`,
      });
      await send(
        env,
        job.chat,
        job.status === "approved"
          ? `✅ 你的职位「${job.title}」已通过审核上架，/jobs 可以看到。`
          : `❌ 你的职位「${job.title}」未通过审核，请修改后重新发布。`,
      );
      return;
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (!env.BOT_KV)
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "💼 求职招聘 Bot\n\n找工作：/jobs 看全部职位，/jobs 北京 司机 按城市+关键词搜，/apply 职位ID 投递（随后把简历发给我，我转给企业）。\n招人：/postjob 按向导发职位，管理员审核通过后上架，30 天有效。\n/myJobs 看我发布的（/myjobs）。",
    );
  if (cmd === "/cancel") {
    await fsmSet(env, uid, null);
    await env.BOT_KV.delete("job:apply:" + uid);
    return send(env, chatId, "已取消当前向导/投递。");
  }
  if (cmd === "/postjob") {
    if (msg.chat.type !== "private")
      return send(env, chatId, "发职位请私聊我发 /postjob。");
    await fsmSet(env, uid, { step: 0, data: {} });
    return send(
      env,
      chatId,
      "📝 开始发布职位。\n" + FSM_STEPS[0].ask + "\n（随时 /cancel 取消）",
    );
  }
  if (cmd === "/pending") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 管理员命令。");
    const pend = await listJobs(env, "pending");
    if (!pend.length) return send(env, chatId, "没有待审职位。");
    for (const j of pend.slice(0, 10))
      await send(env, chatId, jobCard(j, true), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ 通过", callback_data: `jobok:${j.id}` },
              { text: "❌ 拒绝", callback_data: `jobno:${j.id}` },
            ],
          ],
        },
      });
    return;
  }
  if (cmd === "/jobs") {
    const tokens = text.split(/\s+/).slice(1);
    let jobs = await listJobs(env, "approved");
    if (tokens[0])
      jobs = jobs.filter(
        (j) =>
          j.city.includes(tokens[0]) ||
          j.title.includes(tokens[0]) ||
          (j.desc || "").includes(tokens[0]),
      );
    if (tokens[1])
      jobs = jobs.filter(
        (j) =>
          j.title.includes(tokens[1]) || (j.desc || "").includes(tokens[1]),
      );
    if (!jobs.length)
      return send(
        env,
        chatId,
        "暂无匹配职位。换个关键词，或直接 /jobs 看全部。",
      );
    return send(
      env,
      chatId,
      `💼 职位（${jobs.length} 条，最近 10 条）：\n\n` +
        jobs
          .slice(0, 10)
          .map((j) => jobCard(j))
          .join("\n\n") +
        "\n\n投递：/apply 职位ID",
    );
  }
  if (cmd === "/apply") {
    const id = text.split(/\s+/)[1];
    const job = id ? await getJob(env, id) : null;
    if (!job || job.status !== "approved")
      return send(
        env,
        chatId,
        "用法：/apply 职位ID（ID 见 /jobs 列表），且职位需在架。",
      );
    await env.BOT_KV.put("job:apply:" + uid, job.id);
    return send(
      env,
      chatId,
      `📮 投递「${job.title}」：把你的简历直接发给我（文字或文件都行），我会原样转给企业。/cancel 可取消。`,
    );
  }
  if (cmd === "/myjobs") {
    const mine = (await listJobs(env)).filter(
      (j) => String(j.by) === String(uid),
    );
    if (!mine.length)
      return send(env, chatId, "你还没有发布过职位。/postjob 发一个。");
    return send(
      env,
      chatId,
      "📋 我发布的职位：\n\n" +
        mine.map((j) => `${jobCard(j)}\n状态：${j.status}`).join("\n\n") +
        "\n\n删除：/deljob 职位ID",
    );
  }
  if (cmd === "/deljob") {
    const id = text.split(/\s+/)[1];
    const job = id ? await getJob(env, id) : null;
    if (!job) return send(env, chatId, "没找到这个职位ID。");
    if (String(job.by) !== String(uid) && !isAdmin(env, uid))
      return send(env, chatId, "⛔ 只能删自己发布的职位。");
    await env.BOT_KV.delete("job:" + id);
    return send(env, chatId, `🗑️ 已删除职位「${job.title}」。`);
  }

  // 投递进行中：非命令消息 = 简历，转给企业（copyMessage 原样转发）
  const applying = await env.BOT_KV.get("job:apply:" + uid);
  if (applying && !text.startsWith("/")) {
    const job = await getJob(env, applying);
    await env.BOT_KV.delete("job:apply:" + uid);
    if (!job) return send(env, chatId, "这个职位已下架，投递取消。");
    await send(
      env,
      job.chat,
      `📮 新投递：职位「${job.title}」（${job.id}）\n投递人：${msg.from.first_name || ""}（ID ${uid}，可直接在 Bot 里查）`,
    );
    await tg(env, "copyMessage", {
      chat_id: job.chat,
      from_chat_id: chatId,
      message_id: msg.message_id,
    });
    return send(
      env,
      chatId,
      `✅ 已投递给企业。对方联系方式：${job.contact}\n（也已把你的简历转过去，企业可能直接联系你。）`,
    );
  }

  // 发岗向导进行中：非命令消息 = 当前步输入
  const state = await fsmGet(env, uid);
  if (state && msg.chat.type === "private" && text && !text.startsWith("/"))
    return fsmHandle(env, msg, state);
}
