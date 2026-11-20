// ============================================================
// 37 贴纸制作 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 发图 → 选 emoji → 自动建贴纸包/往已有包里加贴纸，返回 t.me/addstickers 链接。
// Telegram 静态贴纸硬规格：PNG 或 WEBP、512×512（一边 512、另一边 ≤512）。
// · 发 PNG/WEBP 文件（以「文件」形式发送）→ file_id 直接建包；
// · 发普通照片（JPEG）→ 需要外部规格处理服务把图转成 512 PNG：
// 变量 STICKER_RESIZER 填你的处理服务地址（POST {url} → {url}），
// 不填则 Bot 会提示改发 PNG/WEBP 文件。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// STICKER_RESIZER 外部图片规格处理服务地址（把任意图转成 512×512 PNG 并返回直链）
// BOT_USERNAME 本 Bot 用户名（拼贴纸包名用；不填则每次冷启动 getMe 查）
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：stk:pend:<用户ID> 存待选 emoji 的图片；stk:set:<用户ID> 存当前贴纸包。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 36（贴纸制作）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const EMOJIS = ["😀", "😂", "🥰", "😎", "🤔", "😭", "🔥", "👍", "🎉", "❤️"];

let cachedUsername = null;
async function botUsername(env) {
  if (env.BOT_USERNAME) return env.BOT_USERNAME.replace(/^@/, "");
  if (cachedUsername) return cachedUsername;
  const me = await tg(env, "getMe", {});
  cachedUsername = me?.result?.username || "bot";
  return cachedUsername;
}
async function fileLink(env, fileId) {
  const gf = await tg(env, "getFile", { file_id: fileId });
  const path = gf?.result?.file_path;
  return path
    ? `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`
    : null;
}

// 外部规格处理：把原图直链 POST 给处理服务，拿回 512 PNG 直链。
async function resizeToSticker(env, srcUrl) {
  const r = await fetch(env.STICKER_RESIZER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: srcUrl }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.url) throw new Error("规格处理服务返回异常");
  return data.url;
}

// ============================================================
// 贴纸包操作（KV + Bot API）
// stk:set:<用户ID> = { name, title, count}：name 是包的唯一短名（创建后不可改），
// 形如 stk_<uid>_<随机>_by_<Bot用户名>（Telegram 要求包名以 _by_<bot> 结尾）。
// stk:pend:<用户ID> = { source}：source 是 file_id 或处理后的直链，等用户选 emoji。
// ============================================================
async function getSet(env, uid) {
  const raw = await env.BOT_KV.get("stk:set:" + uid);
  return raw ? JSON.parse(raw) : null;
}
async function addSticker(env, msg, source, emoji) {
  const uid = msg.from.id;
  const uname = await botUsername(env);
  let set = await getSet(env, uid);
  const sticker = { sticker: source, format: "static", emoji_list: [emoji] };
  if (!set) {
    const name = `stk_${uid}_${newId()}_by_${uname}`;
    const title = `${msg.from.first_name || "我"} 的贴纸包`;
    const r = await tg(env, "createNewStickerSet", {
      user_id: uid,
      name,
      title,
      stickers: [sticker],
      sticker_type: "regular",
    });
    if (!r.ok) throw new Error(r.description || "建包失败");
    set = { name, title, count: 1 };
  } else {
    const r = await tg(env, "addStickerToSet", {
      user_id: uid,
      name: set.name,
      sticker,
    });
    if (!r.ok) throw new Error(r.description || "加贴纸失败");
    set.count += 1;
  }
  await env.BOT_KV.put("stk:set:" + uid, JSON.stringify(set));
  return set;
}
function emojiKeyboard() {
  const rows = [];
  for (let i = 0; i < EMOJIS.length; i += 5)
    rows.push(
      EMOJIS.slice(i, i + 5).map((e) => ({
        text: e,
        callback_data: `stk:emo:${e}`,
      })),
    );
  rows.push([{ text: "❌ 算了", callback_data: "stk:cancel" }]);
  return { inline_keyboard: rows };
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "newpack", description: "开始一个新的贴纸包" },
  { command: "mypack", description: "我的贴纸包链接" },
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
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("sticker-maker bot is running.", {
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
// 私聊流程：发图 → （必要时规格处理）→ 选 emoji → 建包/加贴纸 → 回链接。
// 回调前缀 stk: 管 emoji 选择与取消。
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
    const data = String(cq.data || "");
    if (!data.startsWith("stk:")) return;
    const chatId = cq.message.chat.id;
    if (data === "stk:cancel") {
      await env.BOT_KV.delete("stk:pend:" + cq.from.id);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: "已取消。重新发图就行。",
      });
    }
    if (data.startsWith("stk:emo:")) {
      const emoji = data.slice("stk:emo:".length);
      const raw = await env.BOT_KV.get("stk:pend:" + cq.from.id);
      if (!raw)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "图片已过期，重新发一张",
          show_alert: true,
        });
      const pend = JSON.parse(raw);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      try {
        const fakeMsg = { from: cq.from };
        const set = await addSticker(env, fakeMsg, pend.source, emoji);
        await env.BOT_KV.delete("stk:pend:" + cq.from.id);
        return tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `✅ 贴纸已加入包（共 ${set.count} 张）！\n贴纸包：https://t.me/addstickers/${set.name}\n继续发图可以接着加；/newpack 另开新包。`,
        });
      } catch (e) {
        return tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `😵 失败：${String(e.message || e).slice(0, 200)}\n常见原因：图片不是 512×512 的 PNG/WEBP。换一张处理好的图再发。`,
        });
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🎨 贴纸制作 Bot\n\n把图片发给我，选个 emoji，就能生成你的专属贴纸包。\n\n📐 规格要求（Telegram 硬规定）：PNG 或 WEBP、512×512。\n· 最稳：把处理好的 PNG/WEBP 以「文件」形式发我\n· 发普通照片也行，但管理员要配了规格处理服务（STICKER_RESIZER）才能自动转换\n\n/newpack 另开新包 · /mypack 看我的包",
    );
  if (cmd === "/newpack") {
    await env.BOT_KV.delete("stk:set:" + msg.from.id);
    await env.BOT_KV.delete("stk:pend:" + msg.from.id);
    return send(env, chatId, "🆕 好，下一张图会开一个新贴纸包。发图吧。");
  }
  if (cmd === "/mypack") {
    const set = await getSet(env, msg.from.id);
    if (!set) return send(env, chatId, "你还没有贴纸包，先发一张图开包。");
    return send(
      env,
      chatId,
      `🎨 你的贴纸包（共 ${set.count} 张）：\nhttps://t.me/addstickers/${set.name}`,
    );
  }

  // ---------- 收图 ----------
  let source = null;
  const doc = msg.document;
  const photo = msg.photo && msg.photo[msg.photo.length - 1];
  if (doc && ["image/png", "image/webp"].includes(doc.mime_type)) {
    source = doc.file_id; // 规格对口的原文件，file_id 直用
  } else if (doc || photo) {
    const fileId = doc ? doc.file_id : photo.file_id;
    if (!env.STICKER_RESIZER)
      return send(
        env,
        chatId,
        "这张是普通照片（JPEG），Telegram 贴纸只收 512×512 的 PNG/WEBP。\n两个办法：\n1️⃣ 自己处理成 512×512 PNG，以「文件」形式发我\n2️⃣ 让管理员配置 STICKER_RESIZER 规格处理服务，之后发照片自动转",
      );
    try {
      const link = await fileLink(env, fileId);
      if (!link) throw new Error("拿不到文件直链");
      source = await resizeToSticker(env, link);
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 规格处理失败：${String(e.message || e).slice(0, 150)}。改发 512×512 PNG 文件试试。`,
      );
    }
  } else if (text) {
    // 用户直接发 emoji 文本作为上一步的选择
    const raw = await env.BOT_KV.get("stk:pend:" + msg.from.id);
    if (raw && text.length <= 8) {
      const pend = JSON.parse(raw);
      try {
        const set = await addSticker(env, msg, pend.source, text);
        await env.BOT_KV.delete("stk:pend:" + msg.from.id);
        return send(
          env,
          chatId,
          `✅ 贴纸已加入包（共 ${set.count} 张）：https://t.me/addstickers/${set.name}`,
        );
      } catch (e) {
        return send(
          env,
          chatId,
          `😵 失败：${String(e.message || e).slice(0, 200)}`,
        );
      }
    }
    return send(env, chatId, "先发一张图给我，再选 emoji。");
  }
  if (source) {
    await env.BOT_KV.put(
      "stk:pend:" + msg.from.id,
      JSON.stringify({ source }),
      { expirationTtl: 1800 },
    );
    return send(
      env,
      chatId,
      "图收到了，给这张贴纸选个 emoji（点按钮或直接发一个 emoji）：",
      {
        reply_markup: emojiKeyboard(),
      },
    );
  }
}
