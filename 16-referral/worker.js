// ============================================================
// 16 邀请引流统计 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 两种合规引流统计（不群发、不采集、不拉人，只统计你自己的邀请成果）：
// A. Bot 深链拉新：每个用户有专属链接 t.me/Bot?start=ref_<我的ID>，
// 新人通过它首次启动 Bot，邀请人 +1 并实时收到通知。
// B. 群邀请链接：Bot 为每个用户在目标群生成带名字的专属邀请链接，
// 有人通过它进群时 Telegram 的 chat_member 事件会带上链接名，自动归因。
// 命令：/invite 我的链接与战绩 · /topinv 邀请榜 · 管理员 /refstats 总览
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// BOT_USERNAME Bot 用户名（不带 @，拼深链）
// 选填：
// TARGET_CHAT_ID 目标群 ID（启用 B 玩法；Bot 须为群管理员）
// REWARD_TEXT 奖励规则文案（如「邀 10 人送月卡」），/invite 时展示
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（键：ref:<邀请人ID>、refdone:<新人ID>）。
// ⚠️ B 玩法要点：allowed_updates 已含 chat_member；Bot 不是群管理员时收不到该事件。
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
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;

// ============================================================
// 【核心模块】邀请归因存储（KV）
// ref:<邀请人ID> = { count, name} 只存计数与显示名；refdone:<新人ID> = 邀请人ID，防同一个人反复刷。
// ============================================================
async function creditReferrer(env, referrerId, newUser) {
  if (String(referrerId) === String(newUser.id)) return false; // 不能邀自己
  const done = await env.BOT_KV.get("refdone:" + newUser.id);
  if (done) return false; // 已经归因过
  const raw = await env.BOT_KV.get("ref:" + referrerId);
  const rec = raw ? JSON.parse(raw) : { count: 0, name: "" };
  rec.count += 1;
  await env.BOT_KV.put("ref:" + referrerId, JSON.stringify(rec));
  await env.BOT_KV.put("refdone:" + newUser.id, String(referrerId));
  await send(
    env,
    referrerId,
    `🎉 邀请 +1！${who(newUser)} 通过你的链接来了，你已累计邀请 ${rec.count} 人。`,
  ).catch(() => {});
  return true;
}
async function myRecord(env, user) {
  const raw = await env.BOT_KV.get("ref:" + user.id);
  const rec = raw ? JSON.parse(raw) : { count: 0, name: who(user) };
  rec.name = who(user);
  await env.BOT_KV.put("ref:" + user.id, JSON.stringify(rec));
  return rec;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// 注意：allowed_updates 含 chat_member，群邀请归因靠它（Bot 需为目标群管理员）。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("referral bot is running.", {
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
        allowed_updates: ["message", "chat_member"],
      });
      return Response.json({ setWebhook: hook, telegram: r });
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
// A 深链归因在 /start 里处理；B 群邀请归因在 chat_member 事件里按邀请链接名 ref<用户ID> 匹配。
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

  // ---------- B：群成员变化事件（邀请链接归因） ----------
  const cm = update.chat_member;
  if (cm) {
    const joined =
      cm.new_chat_member?.status === "member" &&
      ["left", "kicked"].includes(cm.old_chat_member?.status || "left");
    const linkName = cm.invite_link?.name || "";
    const m = linkName.match(/^ref(\d+)$/);
    if (joined && m && cm.new_chat_member?.user)
      await creditReferrer(env, m[1], cm.new_chat_member.user);
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;

  // ---------- A：深链拉新归因 ----------
  const refM = text.match(/^\/start(?:@\w+)?\s+ref_(\d+)/);
  if (refM) {
    const credited = await creditReferrer(env, refM[1], msg.from);
    return send(
      env,
      chatId,
      credited
        ? "👋 欢迎！你通过朋友的邀请链接而来，他已收到邀请奖励。"
        : "👋 欢迎！发 /invite 拿你的专属邀请链接。",
    );
  }

  if (cmd === "/start" || cmd === "/invite") {
    if (msg.chat.type !== "private")
      return send(env, chatId, "邀请链接请私聊我发 /invite 领取。");
    const rec = await myRecord(env, msg.from);
    let out = `🔗 你的专属邀请链接（Bot 拉新）：\nhttps://t.me/${env.BOT_USERNAME}?start=ref_${msg.from.id}\n\n📊 已邀请：${rec.count} 人`;
    if (env.TARGET_CHAT_ID) {
      const link = await tg(env, "createChatInviteLink", {
        chat_id: env.TARGET_CHAT_ID,
        name: "ref" + msg.from.id,
      });
      if (link.ok)
        out += `\n\n🔗 你的专属进群链接（拉人进群自动统计）：\n${link.result.invite_link}`;
      else out += "\n\n（进群链接生成失败：检查 Bot 是否为目标群管理员）";
    }
    if (env.REWARD_TEXT) out += `\n\n🎁 奖励规则：${env.REWARD_TEXT}`;
    out += "\n\n排行榜发 /topinv";
    return send(env, chatId, out);
  }

  if (cmd === "/topinv") {
    const list = await env.BOT_KV.list({ prefix: "ref:", limit: 1000 });
    const rows = [];
    for (const k of list.keys) {
      if (k.name.startsWith("refdone:")) continue;
      const raw = await env.BOT_KV.get(k.name);
      if (raw) {
        const r = JSON.parse(raw);
        rows.push({ name: r.name || k.name.slice(4), count: r.count });
      }
    }
    rows.sort((a, b) => b.count - a.count);
    if (!rows.length)
      return send(env, chatId, "还没有邀请记录，发 /invite 开始拉新。");
    return send(
      env,
      chatId,
      "🏆 邀请榜 Top 10\n\n" +
        rows
          .slice(0, 10)
          .map((r, i) => `${i + 1}. ${r.name} — ${r.count} 人`)
          .join("\n"),
    );
  }

  if (cmd === "/refstats" && admins(env).includes(String(msg.from.id))) {
    const list = await env.BOT_KV.list({ prefix: "refdone:", limit: 1000 });
    return send(env, chatId, `📊 累计归因新人总数：${list.keys.length} 人。`);
  }
}
