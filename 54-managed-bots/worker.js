// ============================================================
// 54 Managed Bots 母体 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：用 Bot API 9.6 的 Managed Bots 能力帮用户「一键开子 Bot」：
// /newbot 向导收一个建议用户名 → 生成深链 t.me/newbot/<本Bot>/<建议名> →
// 用户点深链在官方流程里确认创建 → 本 Bot 收到 managed_bot 更新 →
// 调 getManagedBotToken 取子 Bot 的 Token → AES-GCM 加密存 KV。
// /mybots 管理（列表只显示掩码）、/rotate 换 Token、/revoke 删除托管记录。
// ⚠️ 为什么不走 MTProto：bots.createBot 等 MTProto 方法需要用户账号客户端，
// 单文件 Worker 里没有 MTProto 客户端，那条路线不可行；深链 + 官方
// getManagedBotToken 是 Worker 里唯一走得通的路线（模块 21）。
// 前提：本 Bot 必须先在 BotFather 的 mini app 里开启 bot-management
// 模式（can_manage_bots），否则深链点开无法完成创建、也收不到更新。
// 必填变量：
// BOT_TOKEN 本 Bot 的 Token（Secret）
// TOKEN_ENC_KEY 子 Token 加密密钥：32 字节随机数的 base64（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 平台管理员（逗号分隔），可看全部托管记录
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：bot:<子BotID> 托管记录（模块 21 约定）；fsm:<uid> 向导状态；
// mgb:pend:<建议名> 待确认创建（靠用户名把 managed_bot 更新对回申请人）；
// mgb:me 本 Bot 用户名缓存（拼深链用）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 21（母体多租户托管）+ 模块 20（FSM 向导）+ 模块 01（骨架）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
// ============================================================
async function tg(env, method, payload, token) {
  const r = await fetch(
    `https://api.telegram.org/bot${token || env.BOT_TOKEN}/${method}`,
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

// ============================================================
// 子 Token 加解密（AES-GCM，复用模块 21）
// 密钥在 Secret TOKEN_ENC_KEY（32 字节 base64），KV 里只存密文 iv.ct。
// 绝不把明文 Token 写日志、写回显、写其他键；列表只显示掩码。
// ============================================================
async function importKey(env) {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encToken(env, token) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  const pack = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return pack(iv.buffer) + "." + pack(ct);
}
async function decToken(env, enc) {
  const [ivB, ctB] = enc.split(".");
  const un = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await importKey(env);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: un(ivB) },
    key,
    un(ctB),
  );
  return new TextDecoder().decode(pt);
}
const maskToken = (t) => (t ? t.slice(0, 4) + "…" + t.slice(-4) : "");

// 本 Bot 用户名（拼深链要用）：优先读 KV 缓存，没有就 getMe 现查并回存。
async function myUsername(env) {
  const cached = await env.BOT_KV.get("mgb:me");
  if (cached) return cached;
  const me = await tg(env, "getMe", {});
  const name = me?.result?.username || "";
  if (name) await env.BOT_KV.put("mgb:me", name);
  return name;
}

// ============================================================
// 托管记录（bot:<子BotID>）
// { kind:"managed", owner, username, tokenEnc, at}
// 申请人归属靠 mgb:pend:<建议名小写> 对回：managed_bot 更新只带子 Bot
// 本人信息，创建前登记的建议名就是把更新认领回申请人的凭据。
// ============================================================
async function listManaged(env, owner) {
  const list = await env.BOT_KV.list({ prefix: "bot:", limit: 1000 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    if (rec.kind !== "managed") continue;
    if (owner && rec.owner !== owner) continue;
    out.push({ botId: k.name.slice(4), ...rec });
  }
  return out;
}
async function findManaged(env, owner, q) {
  const rows = await listManaged(env, owner);
  const qq = String(q || "")
    .replace(/^@/, "")
    .toLowerCase();
  return (
    rows.find(
      (r) => r.botId === String(q) || (r.username || "").toLowerCase() === qq,
    ) || null
  );
}

// ============================================================
// 管理员白名单与分级命令菜单
// ============================================================
const COMMANDS_USER = [
  { command: "newbot", description: "一键创建子 Bot" },
  { command: "mybots", description: "我托管的子 Bot" },
  { command: "rotate", description: "更换子 Bot 的 Token" },
  { command: "revoke", description: "删除托管记录" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [{ command: "tenants", description: "全部托管记录" }];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  const ids = String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids) {
    await tg(env, "setMyCommands", {
      commands: [...COMMANDS_USER, ...COMMANDS_ADMIN],
      scope: { type: "chat", chat_id: Number(id) },
    });
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// allowed_updates 必须含 managed_bot，否则用户建好子 Bot 本 Bot 也收不到通知。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("managed-bots bot is running.", {
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
        allowed_updates: ["message", "callback_query", "managed_bot"],
      });
      const cm = await registerCommands(env);
      await myUsername(env); // 顺手缓存本 Bot 用户名，深链要用
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
// managed_bot 更新处理
// 用户在官方流程里确认创建后，Telegram 给管理 Bot 推 managed_bot 更新，
// 里面带子 Bot 的用户信息。用它的 ID 调 getManagedBotToken 取 Token，
// 加密落库，再通知申请人。取不到 Token（多半是本 Bot 没开
// bot-management 模式）时明确报错给申请人，不假装成功。
// ============================================================
async function onManagedBot(env, mb) {
  const botUser = mb?.user || mb?.bot || {};
  const botId = botUser.id;
  if (!botId) return;
  const username = botUser.username || "";
  let owner = null;
  if (username) {
    const pend = await env.BOT_KV.get("mgb:pend:" + username.toLowerCase());
    if (pend) {
      owner = JSON.parse(pend).owner;
      await env.BOT_KV.delete("mgb:pend:" + username.toLowerCase());
    }
  }
  if (!owner) {
    const first = String(env.ADMIN_ID || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)[0];
    owner = first ? Number(first) : null;
  }
  if (!owner) return; // 认领不到申请人又没管理员兜底，只能丢弃（README 有说明）
  if (!env.TOKEN_ENC_KEY) {
    return send(
      env,
      owner,
      `⚠️ 子 Bot @${username} 已创建，但本 Bot 没配 TOKEN_ENC_KEY，Token 无法加密保存，本次托管未生效。请管理员补上密钥后重新走 /newbot。`,
    );
  }
  const r = await tg(env, "getManagedBotToken", { bot_id: botId });
  const token = r?.result?.token || r?.result;
  if (!r.ok || typeof token !== "string" || !token.includes(":")) {
    return send(
      env,
      owner,
      `⚠️ 子 Bot @${username} 已创建，但 getManagedBotToken 没取到 Token（${r.description || "未知错误"}）。多半是本 Bot 未在 BotFather mini app 开启 bot-management 模式，开启后重试。`,
    );
  }
  await env.BOT_KV.put(
    "bot:" + botId,
    JSON.stringify({
      kind: "managed",
      owner,
      username,
      tokenEnc: await encToken(env, token),
      at: Date.now(),
    }),
  );
  return send(
    env,
    owner,
    `✅ 子 Bot @${username} 已创建并托管成功！\nToken 已加密保存（掩码 ${maskToken(token)}），用 /mybots 管理，/rotate 可换 Token。\n⚠️ Token 等于这个 Bot 的全部权限：不要截图外传；怀疑泄露立刻 /rotate。`,
  );
}

// ============================================================
// 业务主流程
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
  if (update.managed_bot) return onManagedBot(env, update.managed_bot);

  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (!data.startsWith("mgb:")) return;
    const [, act, botId] = data.split(":");
    const rec = await findManaged(env, cq.from.id, botId);
    if (!rec)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "记录不存在或不是你的",
        show_alert: true,
      });
    if (act === "rev") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(
        env,
        cq.message.chat.id,
        `确认删除 @${rec.username} 的托管记录？删除后本 Bot 不再保管它的 Token（子 Bot 本身不会被删除，管理权仍在 BotFather 侧）。`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "确认删除", callback_data: `mgb:revy:${rec.botId}` },
                { text: "取消", callback_data: "mgb:no" },
              ],
            ],
          },
        },
      );
    }
    if (act === "revy") {
      await env.BOT_KV.delete("bot:" + rec.botId);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🗑 托管记录已删除",
      });
      return send(
        env,
        cq.message.chat.id,
        `已删除 @${rec.username} 的托管记录。`,
      );
    }
    if (act === "rot") {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "正在换 Token…",
      });
      return doRotate(env, cq.message.chat.id, rec);
    }
    if (act === "no")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已取消",
      });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from || msg.chat.type !== "private") return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/ +/)[0].split("@")[0];

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "🤖 Managed Bots 母体\n\n/newbot 一键创建子 Bot（官方 Managed Bots 流程，Token 加密托管）\n/mybots 我的子 Bot\n/rotate <子BotID或@用户名> 换 Token\n/revoke <子BotID或@用户名> 删除托管记录\n\n原理：本 Bot 生成官方深链，你在 Telegram 官方页面确认创建，Token 由 Telegram 直接交给本 Bot 加密保管，全程不经手第三方。",
    );

  if (cmd === "/tenants" && isAdmin(env, uid)) {
    const rows = await listManaged(env, null);
    if (!rows.length) return send(env, chatId, "暂无托管记录。");
    return send(
      env,
      chatId,
      "🏢 全部托管记录\n\n" +
        rows
          .map((r) => `@${r.username}（ID ${r.botId}）· 申请人 ${r.owner}`)
          .join("\n"),
    );
  }

  // ---- /newbot 向导（FSM 存 fsm:<uid>） ----
  if (cmd === "/newbot") {
    if (!env.TOKEN_ENC_KEY)
      return send(
        env,
        chatId,
        "⚠️ 本 Bot 还没配 TOKEN_ENC_KEY（子 Token 加密密钥），暂时不能开通托管，请联系管理员。",
      );
    await env.BOT_KV.put(
      "fsm:" + uid,
      JSON.stringify({ step: "name", at: Date.now() }),
      { expirationTtl: 3600 },
    );
    return send(
      env,
      chatId,
      "给子 Bot 起个用户名：只能用英文字母、数字、下划线，必须以 bot 结尾（如 my_shop_bot）。直接发给我。",
    );
  }
  if (cmd === "/mybots") {
    const rows = await listManaged(env, uid);
    if (!rows.length)
      return send(env, chatId, "你还没有托管的子 Bot。/newbot 创建一个。");
    for (const r of rows) {
      let mask = "（解密失败）";
      try {
        mask = maskToken(await decToken(env, r.tokenEnc));
      } catch {}
      await send(
        env,
        chatId,
        `@${r.username}（ID ${r.botId}）\nToken 掩码：${mask}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 换 Token", callback_data: `mgb:rot:${r.botId}` },
                { text: "🗑 删除托管", callback_data: `mgb:rev:${r.botId}` },
              ],
            ],
          },
        },
      );
    }
    return;
  }
  if (cmd === "/rotate" || cmd === "/revoke") {
    const q = text.split(/ +/)[1];
    if (!q)
      return send(
        env,
        chatId,
        `用法：${cmd} <子BotID或@用户名>，或在 /mybots 里点按钮。`,
      );
    const rec = await findManaged(env, uid, q);
    if (!rec) return send(env, chatId, "没找到属于你的这条托管记录。");
    if (cmd === "/rotate") return doRotate(env, chatId, rec);
    await env.BOT_KV.delete("bot:" + rec.botId);
    return send(
      env,
      chatId,
      `已删除 @${rec.username} 的托管记录（子 Bot 本身不受影响）。`,
    );
  }

  // 向导进行中：等用户发建议用户名
  const fsmRaw = await env.BOT_KV.get("fsm:" + uid);
  if (fsmRaw && !cmd.startsWith("/")) {
    const name = text.replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(name) || !/bot$/i.test(name))
      return send(
        env,
        chatId,
        "用户名不合规：5–32 位字母/数字/下划线，且必须以 bot 结尾。换个名字再发。",
      );
    await env.BOT_KV.delete("fsm:" + uid);
    await env.BOT_KV.put(
      "mgb:pend:" + name.toLowerCase(),
      JSON.stringify({ owner: uid, at: Date.now() }),
      { expirationTtl: 86400 },
    );
    const me = await myUsername(env);
    if (!me)
      return send(
        env,
        chatId,
        "⚠️ 取不到本 Bot 的用户名，深链生成失败，请联系管理员。",
      );
    const link = `https://t.me/newbot/${me}/${name}`;
    return send(
      env,
      chatId,
      `点下方按钮打开官方创建页，确认后子 Bot @${name} 就会创建完成，Token 会自动加密托管到本 Bot，你什么都不用再发。\n（链接 24 小时内有效；用户名被别人占用时官方页会提示，回来 /newbot 换个名即可。）`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 打开官方创建页", url: link }]],
        },
      },
    );
  }
}

async function doRotate(env, chatId, rec) {
  const r = await tg(env, "replaceManagedBotToken", {
    bot_id: Number(rec.botId),
  });
  const token = r?.result?.token || r?.result;
  if (!r.ok || typeof token !== "string" || !token.includes(":"))
    return send(
      env,
      chatId,
      `⚠️ 换 Token 失败：${r.description || "未知错误"}（旧 Token 未改动）。`,
    );
  await env.BOT_KV.put(
    "bot:" + rec.botId,
    JSON.stringify({
      ...rec,
      tokenEnc: await encToken(env, token),
      at: Date.now(),
    }),
  );
  return send(
    env,
    chatId,
    `✅ @${rec.username} 的 Token 已更换，新掩码 ${maskToken(token)}。旧 Token 已失效，用旧 Token 的部署记得更新。`,
  );
}
