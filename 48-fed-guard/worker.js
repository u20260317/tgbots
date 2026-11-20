// ============================================================
// 48 联邦群管 Bot（单文件 · Cloudflare Workers · 需绑定 KV）
// 功能：
// 管「一群群」而不是一个群：联邦封禁（一群群共享一份封禁名单，
// 一处封、处处踢）、进群查 CAS 全局垃圾库、群笔记 #标签、关键词
// 过滤器自动回复。联邦成员群名单存在 fban:chats（fban: 命名空间内）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID Bot 管理员数字 ID（/unfban 解封只认这份名单，逗号分隔）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// CAS_MODE CAS 命中处理：warn=只警告（默认，先跑一周看误报）| kick=直接踢
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ BotFather 必须关隐私模式（/setprivacy → Disable），否则收不到
// 群内普通消息，笔记/过滤器都不触发；Bot 还要是各群管理员。
// 键设计（模块 33 注册约定）：fban:<用户ID> 封禁记录、fban:chats 联邦
// 成员群名单、note:<群ID>:<标签> 笔记、filter:<群ID>:<关键词> 过滤器。
// 与 04 的分工：04 管单群自治（验证码/违禁词/单群 ban），48 管跨群
// 联邦与群记忆，两者可同群共存（04 的流程在前、48 的检查在先亦可）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 33（群管进阶）+ 模块 11（群管理）+ 模块 01（骨架）
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
const isAdmin = (env, uid) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(uid));
async function isGroupAdmin(env, chatId, userId) {
  if (isAdmin(env, userId)) return true;
  const r = await tg(env, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}

// ============================================================
// 联邦成员名单与封禁名单（KV）
// fban:chats = [群ID...]（本 Bot 的联邦成员群）；fban:<用户ID> =
// { by, reason, at, fromChat}。/fban 在任一成员群发起即全网生效：
// 名单里的人进任何成员群都会在入群事件里被直接移出。
// ============================================================
async function fedChats(env) {
  return JSON.parse((await env.BOT_KV.get("fban:chats")) || "[]");
}
async function saveFedChats(env, chats) {
  await env.BOT_KV.put("fban:chats", JSON.stringify(chats));
}
async function isFedChat(env, chatId) {
  return (await fedChats(env)).includes(chatId);
}
async function fedBan(env, userId, info) {
  await env.BOT_KV.put("fban:" + userId, JSON.stringify(info));
}
async function fedCheck(env, chatId, user) {
  const raw = await env.BOT_KV.get("fban:" + user.id);
  if (!raw) return false;
  await tg(env, "banChatMember", { chat_id: chatId, user_id: user.id });
  await send(env, chatId, "🚫 该用户在联邦封禁名单内，已移出。");
  return true;
}

// ============================================================
// CAS 全局垃圾库查询
// GET api.cas.chat/check，免费无 key。第三方数据只作参考：默认只
// 警告（CAS_MODE=warn），观察误报后再切 kick；接口挂了当没命中。
// ============================================================
async function casListed(userId) {
  try {
    const r = await fetch("https://api.cas.chat/check?user_id=" + userId);
    const data = await r.json().catch(() => ({}));
    return data.ok === true;
  } catch {
    return false;
  }
}
async function guardNewMemberPlus(env, chatId, user) {
  if (await fedCheck(env, chatId, user)) return;
  if (await casListed(user.id)) {
    if ((env.CAS_MODE || "warn") === "kick") {
      await tg(env, "banChatMember", { chat_id: chatId, user_id: user.id });
      await send(
        env,
        chatId,
        "🚫 新成员在全局垃圾库名单内，已按本群设置移出。",
      );
    } else {
      await send(
        env,
        chatId,
        "⚠️ 新成员在全局垃圾库（CAS）名单内，请管理员留意其发言。",
      );
    }
  }
}

// ============================================================
// 群笔记 #tag
// note:<群ID>:<标签> = 笔记文本。管理员 /note 标签 内容（或回复某条
// 消息 /note 标签）保存；任何人发 #标签，Bot 回出笔记内容。
// ============================================================
async function saveNote(env, chatId, tag, text) {
  await env.BOT_KV.put(`note:${chatId}:${tag.toLowerCase()}`, text);
}
async function handleHashtag(env, msg) {
  const m = (msg.text || "").match(/#([^\s#]{1,32})/);
  if (!m) return false;
  const note = await env.BOT_KV.get(
    `note:${msg.chat.id}:${m[1].toLowerCase()}`,
  );
  if (note) {
    await send(env, msg.chat.id, note);
    return true;
  }
  return false;
}

// ============================================================
// 过滤器自动回复
// filter:<群ID>:<关键词> = 回复文本。普通消息包含关键词就回复原
// 消息。与 04 违禁词的区别：那个命中就删，这个命中就答。单群关键
// 词控制在几十条内（逐条扫前缀，量大改合成 JSON 键，见模块 33）。
// ============================================================
async function handleFilter(env, msg) {
  if (!msg.text || msg.text.startsWith("/")) return false;
  const list = await env.BOT_KV.list({
    prefix: `filter:${msg.chat.id}:`,
    limit: 100,
  });
  const lower = msg.text.toLowerCase();
  for (const k of list.keys) {
    const kw = k.name.split(":").slice(2).join(":");
    if (kw && lower.includes(kw.toLowerCase())) {
      const reply = await env.BOT_KV.get(k.name);
      if (reply) {
        await send(env, msg.chat.id, reply, {
          reply_to_message_id: msg.message_id,
        });
        return true;
      }
    }
  }
  return false;
}

// ============================================================
// 管理员白名单与分级命令菜单
// /unfban 是 Bot 管理员专属（解封是全网动作），进 COMMANDS_ADMIN
// 只给白名单看；/fban 等群管理员命令留在普通菜单（与 04 同口径）。
// 菜单隐藏只是体验，业务里 isAdmin / isGroupAdmin 才是真门。
// ============================================================
const COMMANDS_USER = [
  { command: "fedjoin", description: "本群加入联邦（群管理员）" },
  { command: "fedleave", description: "本群退出联邦（群管理员）" },
  { command: "fban", description: "联邦封禁：回复某人或带用户ID" },
  { command: "fcheck", description: "查某人在不在联邦名单" },
  { command: "note", description: "存群笔记：/note 标签 内容" },
  { command: "notes", description: "本群笔记清单" },
  { command: "filter", description: "加过滤器：/filter 关键词 回复内容" },
  { command: "filters", description: "本群过滤器清单" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "unfban", description: "联邦解封（Bot 管理员）：/unfban 用户ID" },
];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  const ids = String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids)
    await tg(env, "setMyCommands", {
      commands: [...COMMANDS_USER, ...COMMANDS_ADMIN],
      scope: { type: "chat", chat_id: Number(id) },
    });
  return r;
}

// ============================================================
// Worker 入口与路由
// 标准 webhook 入口：健康检查、/setWebhook 一键挂载、密钥校验、更新分发。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("fed-guard bot is running.", {
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
};

// ============================================================
// 业务主流程
// 入群事件先过联邦/CAS 检查；命令按权限分级；普通消息末尾依次过
// 笔记触发与过滤器。写入口（note/filter/fban）全部先验群管理员。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!env.BOT_KV) {
    if (isGroup) return;
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");
  }

  // 入群检查：只在联邦成员群生效
  if (msg.new_chat_members && isGroup) {
    if (await isFedChat(env, chatId))
      for (const u of msg.new_chat_members)
        if (!u.is_bot) await guardNewMemberPlus(env, chatId, u);
    return;
  }

  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const args = text.replace(/^\/\w+(@\w+)?\s*/, "");
  if (!cmd.startsWith("/")) {
    if (isGroup && (await handleHashtag(env, msg))) return;
    if (isGroup) await handleFilter(env, msg);
    return;
  }

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🛡️ 联邦群管 Bot\n\n· 群管理员 /fedjoin 把本群加入联邦，之后 /fban 封的人在所有成员群都会被拦\n· /fcheck 查名单、/unfban 解封（仅 Bot 管理员）\n· /note 标签 内容 存群笔记，任何人发 #标签 触发\n· /filter 关键词 回复内容 加自动回复\n· 新人进成员群自动查联邦名单 + CAS 垃圾库\n\n与 04 的分工：04 管单群自治，48 管跨群联邦与群记忆。",
    );

  if (
    !isGroup &&
    ["/fedjoin", "/fedleave", "/fban", "/note", "/filter"].includes(cmd)
  )
    return send(env, chatId, "这条命令要在群里用。");

  if (cmd === "/fedjoin" || cmd === "/fedleave") {
    if (!(await isGroupAdmin(env, chatId, uid)))
      return send(env, chatId, "⛔ 只有群管理员能操作联邦成员资格。");
    const chats = await fedChats(env);
    if (cmd === "/fedjoin") {
      if (!chats.includes(chatId)) chats.push(chatId);
      await saveFedChats(env, chats);
      return send(
        env,
        chatId,
        `✅ 本群已加入联邦（当前共 ${chats.length} 个成员群）。联邦名单内的人进群会被直接移出。`,
      );
    }
    await saveFedChats(
      env,
      chats.filter((c) => c !== chatId),
    );
    return send(
      env,
      chatId,
      "✅ 本群已退出联邦（本群不再执行联邦封禁，名单本身保留）。",
    );
  }

  if (cmd === "/fban") {
    if (!(await isFedChat(env, chatId)))
      return send(env, chatId, "本群还不是联邦成员群，群管理员先 /fedjoin。");
    if (!(await isGroupAdmin(env, chatId, uid)))
      return send(env, chatId, "⛔ 只有群管理员能发起联邦封禁。");
    let targetId = null;
    let reason = "";
    if (msg.reply_to_message?.from) {
      targetId = msg.reply_to_message.from.id;
      reason = args;
    } else {
      const m = args.match(/^(\d+)\s*(.*)$/);
      if (m) {
        targetId = Number(m[1]);
        reason = m[2] || "";
      }
    }
    if (!targetId)
      return send(
        env,
        chatId,
        "用法：回复某人的消息发 /fban [理由]，或 /fban <用户ID> [理由]。",
      );
    if (isAdmin(env, targetId))
      return send(env, chatId, "⛔ 不能封禁 Bot 管理员。");
    await fedBan(env, targetId, {
      by: uid,
      reason: reason || "未填",
      at: Date.now(),
      fromChat: chatId,
    });
    await tg(env, "banChatMember", { chat_id: chatId, user_id: targetId });
    return send(
      env,
      chatId,
      `🚫 已联邦封禁 ${targetId}（理由：${reason || "未填"}），名单同步全部成员群；其进任何成员群都会被移出。解封找 Bot 管理员 /unfban。`,
    );
  }

  if (cmd === "/unfban") {
    if (!isAdmin(env, uid))
      return send(
        env,
        chatId,
        "⛔ 解封只认 Bot 管理员名单（防连坐误封被随意撤销）。",
      );
    const targetId = (args.match(/^(\d+)/) || [])[1];
    if (!targetId) return send(env, chatId, "用法：/unfban <用户ID>");
    await env.BOT_KV.delete("fban:" + targetId);
    return send(
      env,
      chatId,
      `✅ 已从联邦名单移除 ${targetId}（各群的实际 ban 状态需各群管理员自行解除）。`,
    );
  }

  if (cmd === "/fcheck") {
    let targetId = null;
    if (msg.reply_to_message?.from) targetId = msg.reply_to_message.from.id;
    else {
      const m = args.match(/^(\d+)/);
      if (m) targetId = Number(m[1]);
    }
    if (!targetId)
      return send(
        env,
        chatId,
        "用法：回复某人发 /fcheck，或 /fcheck <用户ID>。",
      );
    const raw = await env.BOT_KV.get("fban:" + targetId);
    if (!raw) return send(env, chatId, `✅ ${targetId} 不在联邦封禁名单内。`);
    const info = JSON.parse(raw);
    return send(
      env,
      chatId,
      `🚫 ${targetId} 在联邦名单内：理由「${info.reason}」，由 ${info.by} 于 ${new Date(info.at).toLocaleString("zh-CN")} 在群 ${info.fromChat} 封禁。`,
    );
  }

  if (cmd === "/note") {
    if (!(await isGroupAdmin(env, chatId, uid)))
      return send(env, chatId, "⛔ 只有群管理员能存笔记。");
    const sp = args.indexOf(" ");
    const replied = msg.reply_to_message;
    if (replied && args && !args.includes(" ")) {
      const content = replied.text || replied.caption;
      if (!content) return send(env, chatId, "被回复的消息没有文本内容可存。");
      await saveNote(env, chatId, args, content);
      return send(
        env,
        chatId,
        `✅ 笔记 #${args} 已保存，发 #${args} 即可触发。`,
      );
    }
    if (sp < 0)
      return send(
        env,
        chatId,
        "用法：/note 标签 内容，或回复一条消息发 /note 标签。",
      );
    const tag = args.slice(0, sp);
    await saveNote(env, chatId, tag, args.slice(sp + 1));
    return send(env, chatId, `✅ 笔记 #${tag} 已保存。`);
  }

  if (cmd === "/notes") {
    const list = await env.BOT_KV.list({
      prefix: `note:${chatId}:`,
      limit: 100,
    });
    if (!list.keys.length)
      return send(env, chatId, "本群还没有笔记，管理员 /note 标签 内容 添加。");
    return send(
      env,
      chatId,
      "📒 本群笔记：\n" +
        list.keys
          .map((k) => "#" + k.name.split(":").slice(2).join(":"))
          .join(" "),
    );
  }

  if (cmd === "/filter") {
    if (!(await isGroupAdmin(env, chatId, uid)))
      return send(env, chatId, "⛔ 只有群管理员能加过滤器。");
    const sp = args.indexOf(" ");
    if (sp < 0) return send(env, chatId, "用法：/filter 关键词 回复内容");
    const kw = args.slice(0, sp);
    await env.BOT_KV.put(
      `filter:${chatId}:${kw.toLowerCase()}`,
      args.slice(sp + 1),
    );
    return send(
      env,
      chatId,
      `✅ 过滤器已添加：有人提到「${kw}」我会自动回复。`,
    );
  }

  if (cmd === "/filters") {
    const list = await env.BOT_KV.list({
      prefix: `filter:${chatId}:`,
      limit: 100,
    });
    if (!list.keys.length)
      return send(
        env,
        chatId,
        "本群还没有过滤器，管理员 /filter 关键词 回复内容 添加。",
      );
    return send(
      env,
      chatId,
      "🔎 本群过滤器关键词：\n" +
        list.keys
          .map((k) => "· " + k.name.split(":").slice(2).join(":"))
          .join("\n"),
    );
  }
}
