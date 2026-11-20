// ============================================================
// 组合 · 强订网盘（03 强制订阅 + 10 网盘/私有频道存储）
// 单文件 · Cloudflare Workers · 需绑定 KV（变量名 BOT_KV）
// 玩法：主人把文件存进私有频道网盘并生成分享链接；粉丝点链接领文件时，
// 必须先加入 REQUIRED_CHATS 的频道/群，没订阅领不到 —— 分发即涨粉。
// 分流规则：
// 主人（ADMIN_ID）：免订阅检查，网盘全部功能（存/列表/搜索/标签/删/统计）
// 粉丝：/start d_短码 -> 先查订阅，未订给加入按钮+验证（chk:短码），过了才发文件
// 必填变量：BOT_TOKEN（Secret）、ADMIN_ID、STORAGE_CHANNEL_ID、BOT_USERNAME、
// REQUIRED_CHATS（@频道或 -100 ID，逗号隔开）
// 选填：REQUIRED_LINKS、WEBHOOK_SECRET
// 前提：Bot 是存储频道管理员，也是 REQUIRED_CHATS 各频道的管理员（否则查不到成员）。
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
const owners = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isOwner = (env, id) => owners(env).includes(String(id));
const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const fmtSize = (n) =>
  !n
    ? ""
    : n > 1048576
      ? (n / 1048576).toFixed(1) + " MB"
      : n > 1024
        ? (n / 1024).toFixed(0) + " KB"
        : n + " B";
const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);

// ============================================================
// 【核心模块】订阅状态校验（来自 03 · 核心判定）
// 逐个查 getChatMember，返回用户还没加入的频道/群清单；领文件前的门禁靠它判定。
// ============================================================
const requiredChats = (env) =>
  String(env.REQUIRED_CHATS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const requiredLinks = (env) =>
  String(env.REQUIRED_LINKS || "")
    .split(",")
    .map((s) => s.trim());
function linkFor(env, chat, idx) {
  const links = requiredLinks(env);
  if (links[idx]) return links[idx];
  if (String(chat).startsWith("@")) return "https://t.me/" + chat.slice(1);
  return null;
}
async function missingSubs(env, userId) {
  const missing = [];
  for (const [i, chat] of requiredChats(env).entries()) {
    const r = await tg(env, "getChatMember", {
      chat_id: chat,
      user_id: userId,
    });
    if (
      !r.ok ||
      !["member", "administrator", "creator", "restricted"].includes(
        r?.result?.status,
      )
    )
      missing.push({ chat, idx: i });
  }
  return missing;
}
function joinKeyboard(env, missing, checkData) {
  const rows = missing.map((m) => {
    const link = linkFor(env, m.chat, m.idx);
    return link
      ? [{ text: `➕ 加入 ${m.chat}`, url: link }]
      : [{ text: `请先加入 ${m.chat}`, callback_data: "noop" }];
  });
  rows.push([
    { text: "✅ 我已加入，点我验证领文件", callback_data: checkData },
  ]);
  return { inline_keyboard: rows };
}
async function gateMessage(env, chatId, missing, checkData) {
  return send(
    env,
    chatId,
    "🔒 领文件前先加入下面全部频道/群，加入后点验证按钮，文件马上发你：",
    { reply_markup: joinKeyboard(env, missing, checkData) },
  );
}

// ============================================================
// 【核心模块】目录索引存储（来自 10 · KV）
// 网盘目录存 KV 的 index 键（文件名/类型/大小/存储消息 ID）；文件本体在私有频道，不在这里。
// ============================================================
async function loadIndex(env) {
  const raw = await env.BOT_KV.get("index");
  return raw ? JSON.parse(raw) : [];
}
async function saveIndex(env, idx) {
  await env.BOT_KV.put("index", JSON.stringify(idx));
}
const findByCode = (idx, code) => idx.find((x) => x.c === code);

// ============================================================
// 【核心模块】文件类型识别（来自 10）
// 识别发来的文件类型、名称与大小，用于登记目录。
// ============================================================
function fileOf(msg) {
  if (msg.document)
    return {
      kind: "document",
      name: msg.document.file_name || "未命名文件",
      size: msg.document.file_size || 0,
    };
  if (msg.photo?.length)
    return {
      kind: "photo",
      name: "图片 " + fmtDate(Date.now()),
      size: msg.photo[msg.photo.length - 1].file_size || 0,
    };
  if (msg.video)
    return {
      kind: "video",
      name: msg.video.file_name || "视频 " + fmtDate(Date.now()),
      size: msg.video.file_size || 0,
    };
  if (msg.audio)
    return {
      kind: "audio",
      name: msg.audio.file_name || msg.audio.title || "音频",
      size: msg.audio.file_size || 0,
    };
  if (msg.voice)
    return {
      kind: "voice",
      name: "语音 " + fmtDate(Date.now()),
      size: msg.voice.file_size || 0,
    };
  if (msg.animation)
    return {
      kind: "animation",
      name: "动图 " + fmtDate(Date.now()),
      size: msg.animation.file_size || 0,
    };
  if (msg.video_note)
    return {
      kind: "video_note",
      name: "圆形视频 " + fmtDate(Date.now()),
      size: msg.video_note.file_size || 0,
    };
  if (msg.sticker)
    return {
      kind: "sticker",
      name: "贴纸 " + (msg.sticker.emoji || ""),
      size: msg.sticker.file_size || 0,
    };
  return null;
}
const KIND_ICON = {
  document: "📄",
  photo: "🖼",
  video: "🎬",
  audio: "🎵",
  voice: "🎙",
  animation: "🎞",
  video_note: "⭕",
  sticker: "🏷",
  note: "📝",
};
const entryLine = (e) =>
  `${KIND_ICON[e.k] || "📦"} ${e.n}${e.s ? " · " + fmtSize(e.s) : ""} · ${fmtDate(e.t)} · 短码 ${e.c}${e.tag ? " · 🏷 " + e.tag : ""}`;
const entryKeyboard = (e) => ({
  inline_keyboard: [
    [
      { text: "⬇️ 取回", callback_data: `get:${e.c}` },
      { text: "🔗 分享", callback_data: `shr:${e.c}` },
      { text: "🗑 删除", callback_data: `del:${e.c}` },
    ],
  ],
});

// ============================================================
// 【核心模块】文件取回（来自 10）
// 按目录里的存储消息 ID，用 copyMessage 把私有频道里的原件复制发给请求者。
// ============================================================
async function retrieve(env, chatId, e) {
  const r = await tg(env, "copyMessage", {
    chat_id: chatId,
    from_chat_id: env.STORAGE_CHANNEL_ID,
    message_id: e.m,
  });
  if (!r.ok)
    await send(
      env,
      chatId,
      "⚠️ 取回失败：" + (r.description || "存储频道里的原文件可能已被删除"),
    );
  return r.ok;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "list", description: "我的文件列表" },
  { command: "search", description: "搜索文件" },
  { command: "stats", description: "存储统计" },
  { command: "start", description: "开始使用" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("combo-drive-gate bot is running.", {
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
// 强订网盘分流中枢：粉丝领件先过订阅门禁（chk:短码复查通过才发文件），主人走完整网盘管理。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    const [act, arg] = String(cq.data || "").split(":");
    const idx = env.BOT_KV ? await loadIndex(env) : [];
    if (cq.data === "noop")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "请联系管理员获取邀请链接",
      });
    if (cq.data === "gatecheck") {
      const missing = await missingSubs(env, cq.from.id);
      if (missing.length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "还没检测到加入：" + missing.map((m) => m.chat).join("、"),
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 验证通过",
      });
      return tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: "🎉 已验证订阅！通过主人分享的文件链接打开我，就能直接领文件。",
      });
    }
    // 粉丝验证领件
    if (act === "chk") {
      const e = findByCode(idx, arg);
      if (!e)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "文件不存在或已删除",
          show_alert: true,
        });
      const missing = await missingSubs(env, cq.from.id);
      if (missing.length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "还没检测到加入：" + missing.map((m) => m.chat).join("、"),
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 验证通过，文件来了",
      });
      await tg(env, "deleteMessage", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
      });
      await retrieve(env, cq.message.chat.id, e);
      return send(env, cq.message.chat.id, `✅ 上面就是「${e.n}」，保存好哦。`);
    }
    // 主人列表按钮
    if (act === "get") {
      const e = findByCode(idx, arg);
      if (!e)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "文件不存在",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "正在取回…",
      });
      return retrieve(env, cq.message.chat.id, e);
    }
    if (!isOwner(env, cq.from.id))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "只有主人能操作",
        show_alert: true,
      });
    if (act === "shr") {
      const e = findByCode(idx, arg);
      if (!e)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "文件不存在",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(
        env,
        cq.message.chat.id,
        `🔗 「${e.n}」分享链接（点开需先订阅指定频道才能领）：\nhttps://t.me/${env.BOT_USERNAME}?start=d_${e.c}`,
      );
    }
    if (act === "del") {
      const e = findByCode(idx, arg);
      if (!e)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "文件不存在",
          show_alert: true,
        });
      await tg(env, "deleteMessage", {
        chat_id: env.STORAGE_CHANNEL_ID,
        message_id: e.m,
      });
      await saveIndex(
        env,
        idx.filter((x) => x.c !== arg),
      );
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🗑 已删除",
      });
      return tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `🗑 已删除「${e.n}」`,
      });
    }
    if (act === "lp")
      return showList(env, cq.message.chat.id, idx, Number(arg) || 0, cq);
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  if (!env.BOT_KV)
    return send(
      env,
      msg.chat.id,
      "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。",
    );
  const text = msg.text || "";
  const idx = await loadIndex(env);
  const owner = isOwner(env, msg.from.id);

  // ---------- 分享深链：先过门禁再发文件 ----------
  const dm = text.match(/^\/start(?:@\w+)?\s+d_(\w+)/);
  if (dm) {
    const e = findByCode(idx, dm[1]);
    if (!e)
      return send(
        env,
        msg.chat.id,
        "😢 这个分享链接已失效（文件可能已被删除）。",
      );
    if (!owner) {
      const missing = await missingSubs(env, msg.from.id);
      if (missing.length)
        return gateMessage(env, msg.chat.id, missing, `chk:${e.c}`);
    }
    await retrieve(env, msg.chat.id, e);
    return send(env, msg.chat.id, `✅ 上面就是「${e.n}」，保存好哦。`);
  }

  // ---------- 粉丝其它消息：一律先过门禁 ----------
  if (!owner) {
    const missing = await missingSubs(env, msg.from.id);
    if (missing.length)
      return gateMessage(env, msg.chat.id, missing, "gatecheck");
    return send(
      env,
      msg.chat.id,
      "🎉 你已订阅达标！通过主人分享的文件链接打开我，就能直接领文件。",
    );
  }

  // ---------- 主人：网盘管理（同 10） ----------
  if (text.startsWith("/start") || text.startsWith("/help"))
    return send(
      env,
      msg.chat.id,
      "☁️ 强订网盘（主人模式）\n\n· 直接发文件/文字 = 存入网盘并生成「需订阅才能领」的分享链接\n· /list 文件列表 · /search 关键词 · /tag 短码 标签 · /del 短码 · /stats 统计\n粉丝领文件时会被强制订阅 REQUIRED_CHATS，主人自己免检。",
    );
  if (text.startsWith("/stats")) {
    const total = idx.reduce((a, e) => a + (e.s || 0), 0);
    return send(
      env,
      msg.chat.id,
      `📊 网盘统计\n文件数：${idx.length}\n总大小：${fmtSize(total) || "0 B"}\n门禁频道：${env.REQUIRED_CHATS}`,
    );
  }
  if (text.startsWith("/list")) return showList(env, msg.chat.id, idx, 0, null);
  if (text.startsWith("/search")) {
    const kw = text
      .replace(/^\/search(@\w+)?\s*/, "")
      .trim()
      .toLowerCase();
    if (!kw) return send(env, msg.chat.id, "用法：/search 关键词");
    const hits = idx.filter((e) =>
      (e.n + " " + (e.cap || "") + " " + (e.tag || ""))
        .toLowerCase()
        .includes(kw),
    );
    if (!hits.length)
      return send(env, msg.chat.id, "没搜到包含「" + kw + "」的文件。");
    await send(env, msg.chat.id, `🔍 找到 ${hits.length} 个：`);
    for (const e of hits.slice(0, 10))
      await send(env, msg.chat.id, entryLine(e), {
        reply_markup: entryKeyboard(e),
      });
    return;
  }
  if (text.startsWith("/tag")) {
    const m = text.match(/^\/tag\s+(\w+)\s+(.+)/);
    if (!m) return send(env, msg.chat.id, "用法：/tag 短码 标签");
    const e = findByCode(idx, m[1]);
    if (!e) return send(env, msg.chat.id, "短码不存在。");
    e.tag = m[2].trim();
    await saveIndex(env, idx);
    return send(env, msg.chat.id, `🏷 已给「${e.n}」打上标签：${e.tag}`);
  }
  if (text.startsWith("/del")) {
    const codeArg = text.replace(/^\/del(@\w+)?\s*/, "").trim();
    const e = findByCode(idx, codeArg);
    if (!e)
      return send(env, msg.chat.id, "用法：/del 短码，或在列表里点删除。");
    await tg(env, "deleteMessage", {
      chat_id: env.STORAGE_CHANNEL_ID,
      message_id: e.m,
    });
    await saveIndex(
      env,
      idx.filter((x) => x.c !== codeArg),
    );
    return send(env, msg.chat.id, `🗑 已删除「${e.n}」。`);
  }
  if (text.startsWith("/"))
    return send(
      env,
      msg.chat.id,
      "命令见 /help；直接发文件或文字就是存入网盘。",
    );

  // 存入网盘
  const f = fileOf(msg);
  const caption = msg.caption || "";
  let stored;
  if (f) {
    const payload = {
      chat_id: env.STORAGE_CHANNEL_ID,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    };
    if (["document", "photo", "video", "audio", "animation"].includes(f.kind))
      payload.caption = caption || f.name;
    stored = await tg(env, "copyMessage", payload);
  } else
    stored = await tg(env, "sendMessage", {
      chat_id: env.STORAGE_CHANNEL_ID,
      text,
    });
  if (!stored.ok)
    return send(
      env,
      msg.chat.id,
      "⚠️ 转存失败：" + (stored.description || "检查 Bot 是否为存储频道管理员"),
    );
  const e = {
    c: newCode(),
    n: f ? f.name : text.slice(0, 40) || "笔记",
    k: f ? f.kind : "note",
    s: f ? f.size : 0,
    m: stored.result.message_id,
    cap: caption,
    tag: "",
    t: Date.now(),
  };
  idx.unshift(e);
  await saveIndex(env, idx);
  return send(
    env,
    msg.chat.id,
    `☁️ 已存入网盘\n${entryLine(e)}\n🔗 分享链接（需订阅才能领）：https://t.me/${env.BOT_USERNAME}?start=d_${e.c}`,
    { reply_markup: entryKeyboard(e) },
  );
}

async function showList(env, chatId, idx, page, cq) {
  const PAGE = 8;
  if (!idx.length) {
    if (!cq) await send(env, chatId, "网盘还是空的，直接发个文件给我试试。");
    return;
  }
  const pages = Math.ceil(idx.length / PAGE);
  const p = Math.min(Math.max(page, 0), pages - 1);
  if (cq) await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  await send(
    env,
    chatId,
    `☁️ 网盘文件（第 ${p + 1}/${pages} 页，共 ${idx.length} 个）：`,
  );
  for (const e of idx.slice(p * PAGE, p * PAGE + PAGE))
    await send(env, chatId, entryLine(e), { reply_markup: entryKeyboard(e) });
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: "⬅️ 上一页", callback_data: `lp:${p - 1}` });
    if (p < pages - 1)
      nav.push({ text: "下一页 ➡️", callback_data: `lp:${p + 1}` });
    await send(env, chatId, "翻页：", {
      reply_markup: { inline_keyboard: [nav] },
    });
  }
}
