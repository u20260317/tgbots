// ============================================================
// 63 频道数据分析 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 给频道主看自己频道的基础数据：把 Bot 拉进频道当管理员并绑定后，
// Bot 采样每一篇新帖的浏览量/转发量/反应数（stat: 键），/stats 出汇总，
// 订阅日报后 Cron 每天把近 24 小时采样汇总推给频道主。
// ⚠️ 诚实边界：Bot API 给不了频道完整历史统计——只有成员数
// （getChatMemberCount）和 Bot 在场之后新帖的采样数据。想要历史
// 曲线、竞品数据、订户增减明细，得接 TGStat / Telemetr 这类第三方
// 数据库 API（/deep 预留了 TGSTAT_API_URL 适配位）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 管理员数字 ID，多个英文逗号隔开（可代绑任意频道）
// TGSTAT_API_URL / TGSTAT_API_KEY 第三方深度数据 API（选填，未配时 /deep 给说明）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：stat:ch:<频道ID> = 绑定记录；stat:post:<频道ID>:<消息ID> = 帖子采样。
// ⚠️ 日报要加 Cron Trigger（如 0 1 * * *）；不配 Cron 也能用 /stats。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 19（外部 API）+ 模块 09（Cron）+ 模块 01（骨架）
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
const botId = (env) => Number(String(env.BOT_TOKEN).split(":")[0]);

// ============================================================
// 绑定管理
// 绑定姿势两种：① 把频道里任意一篇帖子转发给 Bot（最稳，ID 不用手打）；
// ② /bind @频道名 或 /bind -100xxxxxxxxxx。
// 绑定前必须验证两件事：Bot 在该频道是管理员（不在场就收不到帖子采样），
// 操作者是频道管理员或 Bot 管理员（防乱绑别人的频道刷数据）。
// ============================================================
async function botIsChannelAdmin(env, channelId) {
  const r = await tg(env, "getChatMember", {
    chat_id: channelId,
    user_id: botId(env),
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}
async function userCanBind(env, channelId, userId) {
  if (isAdmin(env, userId)) return true;
  const r = await tg(env, "getChatMember", {
    chat_id: channelId,
    user_id: userId,
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}
async function bindChannel(env, channel, notifyChat, userId) {
  await env.BOT_KV.put(
    "stat:ch:" + channel.id,
    JSON.stringify({
      id: channel.id,
      title: channel.title || channel.username || String(channel.id),
      username: channel.username || "",
      by: userId,
      chat: notifyChat,
      report: true,
      at: Date.now(),
    }),
  );
}
async function getBind(env, channelId) {
  const raw = await env.BOT_KV.get("stat:ch:" + channelId);
  return raw ? JSON.parse(raw) : null;
}

// ============================================================
// 帖子采样
// 两路数据：channel_post 更新（新帖到达时的 views/forwards 快照——注意
// 这是发帖瞬间的初始值，老帖的浏览增长 Bot API 不再回推）；
// message_reaction_count 更新（频道帖反应总数变化，匿名聚合）。
// 两路都只在 Bot 是频道管理员且 webhook 订阅了对应更新类型时才有。
// ============================================================
async function samplePost(env, post) {
  if (!post || !post.chat || post.chat.type !== "channel") return;
  const bind = await getBind(env, post.chat.id);
  if (!bind) return;
  const key = `stat:post:${post.chat.id}:${post.message_id}`;
  const old = await env.BOT_KV.get(key).then((r) => (r ? JSON.parse(r) : null));
  await env.BOT_KV.put(
    key,
    JSON.stringify({
      mid: post.message_id,
      views: post.views ?? old?.views ?? 0,
      forwards: post.forwards ?? old?.forwards ?? 0,
      reactions: old?.reactions ?? 0,
      text: String(post.text || post.caption || "").slice(0, 60),
      at: old?.at || Date.now(),
    }),
  );
}
async function sampleReactions(env, upd) {
  const chat = upd.chat;
  if (!chat || chat.type !== "channel") return;
  const bind = await getBind(env, chat.id);
  if (!bind) return;
  const total = (upd.total_reaction_count || []).reduce(
    (s, r) => s + (r.total_count || 0),
    0,
  );
  const key = `stat:post:${chat.id}:${upd.message_id}`;
  const old = await env.BOT_KV.get(key).then((r) => (r ? JSON.parse(r) : null));
  await env.BOT_KV.put(
    key,
    JSON.stringify({
      mid: upd.message_id,
      views: old?.views ?? 0,
      forwards: old?.forwards ?? 0,
      reactions: total,
      text: old?.text || "",
      at: old?.at || Date.now(),
    }),
  );
}
async function channelSummary(env, channelId, sinceMs = 0) {
  const list = await env.BOT_KV.list({
    prefix: `stat:post:${channelId}:`,
    limit: 1000,
  });
  const posts = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const p = JSON.parse(raw);
    if (p.at >= sinceMs) posts.push(p);
  }
  posts.sort((a, b) => b.views - a.views);
  const sum = posts.reduce(
    (s, p) => ({
      views: s.views + p.views,
      forwards: s.forwards + p.forwards,
      reactions: s.reactions + p.reactions,
    }),
    { views: 0, forwards: 0, reactions: 0 },
  );
  return {
    posts,
    sum,
    avgViews: posts.length ? Math.round(sum.views / posts.length) : 0,
  };
}
function summaryText(bind, memberCount, s, label) {
  const lines = [
    `📊 ${bind.title}（${label}）`,
    `👥 成员数：${memberCount ?? "未知（Bot 可能已被移出管理员）"}`,
    `📝 采样帖子：${s.posts.length} 篇 · 总浏览 ${s.sum.views} · 平均 ${s.avgViews} · 总转发 ${s.sum.forwards} · 总反应 ${s.sum.reactions}`,
  ];
  if (s.posts.length) {
    lines.push("", "🔥 浏览 Top 3：");
    for (const p of s.posts.slice(0, 3))
      lines.push(
        `· ${p.views} 👀 / ${p.reactions} ❤️ ${p.text ? "「" + p.text + "…」" : "#" + p.mid}`,
      );
  }
  lines.push(
    "",
    "ℹ️ 浏览/反应为 Bot 在场后的采样快照，非频道全量历史（见 /deep 说明）。",
  );
  return lines.join("\n");
}

// ============================================================
// 日报推送（Cron）
// 每个绑定推一份近 24 小时汇总到绑定人的私聊；推送 403（被拉黑）
// 自动关日报开关，绑定保留（/stats 还能手动看）。
// ============================================================
async function pushReports(env) {
  const list = await env.BOT_KV.list({ prefix: "stat:ch:", limit: 1000 });
  const since = Date.now() - 24 * 3600 * 1000;
  for (const k of list.keys) {
    const bind = await getBind(env, k.name.slice(8));
    if (!bind || !bind.report) continue;
    const mc = await tg(env, "getChatMemberCount", { chat_id: bind.id });
    const s = await channelSummary(env, bind.id, since);
    const r = await send(
      env,
      bind.chat,
      summaryText(bind, mc?.result, s, "日报 · 近 24 小时"),
    );
    if (!r.ok && r.error_code === 403) {
      bind.report = false;
      await env.BOT_KV.put("stat:ch:" + bind.id, JSON.stringify(bind));
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
  { command: "bind", description: "绑定频道（或转发频道帖子给我）" },
  { command: "channels", description: "我绑定的频道" },
  { command: "stats", description: "频道数据汇总" },
  { command: "deep", description: "深度数据说明/查询" },
  { command: "unbind", description: "解绑频道" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
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
// allowed_updates 必须含 channel_post 与 message_reaction_count，
// 否则采样两路都收不到——这是本 Bot 最容易漏的配置点。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("channel-analytics bot is running.", {
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
        allowed_updates: ["message", "channel_post", "message_reaction_count"],
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
    if (env.BOT_KV) ctx.waitUntil(pushReports(env));
  },
};

// ============================================================
// 业务主流程
// 转发帖子 = 绑定；/stats 默认看第一个绑定频道，也可 /stats @频道名。
// ============================================================
async function myBinds(env, uid) {
  const list = await env.BOT_KV.list({ prefix: "stat:ch:", limit: 1000 });
  const out = [];
  for (const k of list.keys) {
    const b = await getBind(env, k.name.slice(8));
    if (b && (String(b.by) === String(uid) || isAdmin(env, uid))) out.push(b);
  }
  return out;
}

async function handle(env, update) {
  if (!env.BOT_KV) return;
  if (update.channel_post) return samplePost(env, update.channel_post);
  if (update.message_reaction_count)
    return sampleReactions(env, update.message_reaction_count);

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  // 转发频道帖子 → 绑定该频道
  const fwd = msg.forward_from_chat;
  if (fwd && fwd.type === "channel") {
    if (!(await botIsChannelAdmin(env, fwd.id)))
      return send(
        env,
        chatId,
        `⚠️ 我还不是「${fwd.title}」的管理员。先在频道里把我加为管理员，再转发一篇帖子给我。`,
      );
    if (!(await userCanBind(env, fwd.id, uid)))
      return send(env, chatId, "⛔ 只有频道管理员能绑定这个频道。");
    await bindChannel(env, fwd, chatId, uid);
    return send(
      env,
      chatId,
      `✅ 已绑定频道「${fwd.title}」。\n从现在起的新帖会被采样，/stats 看汇总；每天 Cron 推一份日报（/unbind 解绑）。`,
    );
  }

  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const arg = text.replace(/^\/(bind|stats|unbind|deep)(@\w+)?\s*/, "").trim();

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "📊 频道数据分析 Bot\n\n1️⃣ 把我加为你的频道管理员\n2️⃣ 把频道里任意一篇帖子转发给我（或 /bind @频道名）完成绑定\n3️⃣ /stats 看成员数 + 新帖采样汇总，每天还有日报\n\n⚠️ 边界：Bot API 拿不到频道历史统计，我只能统计在场之后的新帖采样；深度数据见 /deep。",
    );

  if (cmd === "/bind") {
    if (!arg)
      return send(
        env,
        chatId,
        "用法：/bind @频道名 或 /bind -100xxxxxxxxxx；更稳的办法是直接转发一篇频道帖子给我。",
      );
    const chat = await tg(env, "getChat", {
      chat_id: arg.startsWith("@") || /^-?\d+$/.test(arg) ? arg : "@" + arg,
    });
    if (!chat.ok || chat.result.type !== "channel")
      return send(
        env,
        chatId,
        "🤔 没找到这个频道，或它不是频道。检查 @ 名是否正确。",
      );
    if (!(await botIsChannelAdmin(env, chat.result.id)))
      return send(
        env,
        chatId,
        `⚠️ 我还不是「${chat.result.title}」的管理员，先把我加进去再绑。`,
      );
    if (!(await userCanBind(env, chat.result.id, uid)))
      return send(env, chatId, "⛔ 只有频道管理员能绑定这个频道。");
    await bindChannel(env, chat.result, chatId, uid);
    return send(
      env,
      chatId,
      `✅ 已绑定「${chat.result.title}」，开始采样新帖。/stats 看数据。`,
    );
  }

  if (cmd === "/channels") {
    const binds = await myBinds(env, uid);
    if (!binds.length)
      return send(
        env,
        chatId,
        "你还没有绑定频道。转发一篇频道帖子给我即可绑定。",
      );
    return send(
      env,
      chatId,
      "📋 我的频道：\n" +
        binds
          .map((b) => `· ${b.title}（日报 ${b.report ? "开" : "关"}）`)
          .join("\n"),
    );
  }

  if (cmd === "/stats") {
    let bind = null;
    if (arg) {
      const chat = await tg(env, "getChat", {
        chat_id: arg.startsWith("@") || /^-?\d+$/.test(arg) ? arg : "@" + arg,
      });
      if (chat.ok) bind = await getBind(env, chat.result.id);
    } else {
      const binds = await myBinds(env, uid);
      bind = binds[0] || null;
    }
    if (!bind)
      return send(
        env,
        chatId,
        "还没绑定这个频道（或你没有任何绑定）。先 /bind 或转发帖子绑定。",
      );
    const mc = await tg(env, "getChatMemberCount", { chat_id: bind.id });
    const s = await channelSummary(env, bind.id, 0);
    return send(env, chatId, summaryText(bind, mc?.result, s, "全部采样"));
  }

  if (cmd === "/deep") {
    if (!env.TGSTAT_API_URL)
      return send(
        env,
        chatId,
        "🔍 深度数据（历史曲线/竞品/订户增减）不在 Bot API 能力内，真实产品（TGStat、Telemetr）靠自有数据库。\n\n本 Bot 预留了适配位：把你的 TGStat 类 API 地址填进 Worker 变量 TGSTAT_API_URL（可再加 TGSTAT_API_KEY），/deep @频道名 就能拉深度报告。未配置前 /deep 只给这段说明，不会假装有数据。",
      );
    const binds = await myBinds(env, uid);
    const bind = binds[0];
    if (!bind) return send(env, chatId, "先绑定一个频道再查深度数据。");
    try {
      const u = `${env.TGSTAT_API_URL}${env.TGSTAT_API_URL.includes("?") ? "&" : "?"}channel=${encodeURIComponent(bind.username || bind.id)}`;
      const r = await fetch(u, {
        headers: env.TGSTAT_API_KEY
          ? { Authorization: `Bearer ${env.TGSTAT_API_KEY}` }
          : {},
      });
      const data = await r.text();
      return send(
        env,
        chatId,
        `🔍 ${bind.title} 深度数据（第三方 API 原样摘要）：\n${data.slice(0, 1500)}`,
      );
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 深度数据接口出错：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (cmd === "/unbind") {
    const binds = await myBinds(env, uid);
    if (!binds.length) return send(env, chatId, "你没有可解绑的频道。");
    const target = binds[0];
    await env.BOT_KV.delete("stat:ch:" + target.id);
    return send(
      env,
      chatId,
      `🔕 已解绑「${target.title}」（采样数据保留在 KV，需要彻底清理请手动删 stat:post:${target.id}: 前缀）。`,
    );
  }
}
