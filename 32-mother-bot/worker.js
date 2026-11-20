// ============================================================
// 32 母体 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// ⚠️⚠️⚠️ 风险提示（部署前必读）⚠️⚠️⚠️
// 本 Bot 会代管「别人 Bot 的 Token」——Token = 那个 Bot 的全部权限。
// · 子 Bot Token 一律 AES-GCM 加密后才存 KV，密钥 TOKEN_ENC_KEY 只放 Secret；
// · 任何界面/日志都不回显 Token 原文，用户列表只显示 Bot 用户名与掩码；
// · 入驻即告知用户：把 Token 交给母体意味着什么、随时可去 @BotFather
// 用 /revoke 让托管立即失效（这是用户的安全阀）；
// · 只建议自用或熟人小圈子部署，别拿它公开招揽陌生人 Token。
// 功能：
// 入驻向导（FSM）：选模板 → 发 Token → getMe 验真 → 确认 → 加密存储 →
// 母体代设 Webhook 到 /w/<slug> → 子 Bot 立刻上线。
// v1 内置 2 个子模板内核：客服（02 简化版：用户消息转发店主、店主回复即回达）
// 与签到（13 简化版：/qd /me /top）。子 Bot 数据用租户前缀 KV 隔离。
// 必填变量：
// BOT_TOKEN 母体 Bot Token（Secret）
// TOKEN_ENC_KEY 加密密钥：32 字节随机数的 base64（Secret）
// ADMIN_ID 平台管理员数字 ID，多个英文逗号隔开（熔断/总览用）
// 选填：
// WEBHOOK_SECRET 母体 Webhook 密钥
// TZ_OFFSET 子 Bot 签到时区，默认 8
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：bot:<slug> 租户记录（模块 21）；fsm:<聊天>:<用户> 入驻向导状态；
// t:<子BotID>: 租户数据前缀（scopedKV 自动加，内核无感知）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 21（母体多租户）+ 模块 20（FSM）+ 模块 07（转发路由）+ 模块 16（签到）
// ============================================================

// ============================================================
// Telegram Bot API 通信层
// 统一封装 tg()：所有给 Telegram 发的请求都走这里，改 API 地址/加重试只改这一处。
// 母体和子 Bot 共用它——靠 env.BOT_TOKEN 区分身份（租户 env 里换成子 Token）。
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
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;
const randHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ============================================================
// 租户 Token 加解密（AES-GCM）
// 密钥在 Secret TOKEN_ENC_KEY（32 字节 base64），KV 里只存密文 iv.ct。
// 已实测加解密可跑。绝不把明文 Token 写日志、写回显、写其他键。
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

// ============================================================
// 租户 KV 隔离（scopedKV）
// 给租户一个包了前缀的 KV：内核代码照常 get/put("pts:123")，
// 实际落键 t:<子BotID>:pts:123，租户之间天然隔离（模块 21）。
// ============================================================
function scopedKV(kv, prefix) {
  return {
    get: (k, t) => kv.get(prefix + k, t),
    put: (k, v, o) => kv.put(prefix + k, v, o),
    delete: (k) => kv.delete(prefix + k),
    list: async (o = {}) => {
      const r = await kv.list({ ...o, prefix: prefix + (o.prefix || "") });
      return {
        keys: r.keys.map((k) => ({ ...k, name: k.name.slice(prefix.length) })),
        list_complete: r.list_complete,
        cursor: r.cursor,
      };
    },
  };
}

// ============================================================
// 通用状态机（FSM，入驻向导用）
// fsm:<chatId>:<userId> = { step, data}，1 小时过期。
// ⚠️ 向导进行中 data 里会短暂存用户刚发的 Token 明文（等验真后加密落库），
// 完成/取消即清；KV 权限等同密钥权限，别把 KV 导出给任何人。
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

// ============================================================
// 子模板内核 · 客服（02 简化版）
// 租户视角：env 已换成子 Bot 身份，rec.owner 是店主（收消息的人）。
// 用户消息 → forwardMessage 转给店主，并记 supmap:<店主侧消息ID>=用户ID；
// 店主「回复」那条转发 → 按映射 copyMessage 回用户。隐私设置挡住转发来源时
// forward 会失败，自动降级 copyMessage（映射照样成立）。
// ============================================================
const supportKernel = {
  name: "客服 Bot",
  commands: [{ command: "start", description: "开始咨询" }],
  async handle(env, update, rec) {
    const msg = update.message;
    if (!msg || !msg.from) return;
    const chatId = msg.chat.id;
    const owner = rec.owner;
    if (msg.from.id === owner) {
      const reply = msg.reply_to_message;
      if (reply) {
        const target = await env.BOT_KV.get("supmap:" + reply.message_id);
        if (target) {
          await tg(env, "copyMessage", {
            chat_id: Number(target),
            from_chat_id: chatId,
            message_id: msg.message_id,
          });
          return send(env, chatId, "↩️ 已回给对方。");
        }
      }
      return send(
        env,
        chatId,
        "你是本 Bot 的店主：用户消息会转到这里，你「回复」任意一条转发消息即可回达对方。",
      );
    }
    const text = (msg.text || "").trim();
    if (text.startsWith("/start"))
      return send(
        env,
        chatId,
        "👋 你好！直接发消息就能联系店主，店主回复后我会转达给你。",
      );
    let r = await tg(env, "forwardMessage", {
      chat_id: owner,
      from_chat_id: chatId,
      message_id: msg.message_id,
    });
    if (!r.ok)
      r = await tg(env, "copyMessage", {
        chat_id: owner,
        from_chat_id: chatId,
        message_id: msg.message_id,
      });
    if (r.ok) {
      await env.BOT_KV.put(
        "supmap:" + r.result.message_id,
        String(msg.from.id),
      );
      return send(env, chatId, "✅ 已转达店主，请等回复。");
    }
    return send(env, chatId, "😵 转达失败，稍后再试。");
  },
};

// ============================================================
// 子模板内核 · 签到（13 简化版）
// /qd 每日签到（基础 10 + 连签加成）、/me、/top（简版前 10，无翻页/抽奖）。
// 数据走租户 KV 的 pts:<用户ID>，与 13 号模板同构。
// ============================================================
const checkinKernel = {
  name: "签到 Bot",
  commands: [
    { command: "qd", description: "每日签到领积分" },
    { command: "me", description: "我的积分与连签" },
    { command: "top", description: "积分排行榜" },
    { command: "start", description: "使用说明" },
  ],
  async handle(env, update, rec) {
    const msg = update.message;
    if (!msg || !msg.from) return;
    const text = (msg.text || "").trim();
    const cmd = text.split(/\s+/)[0].split("@")[0];
    const chatId = msg.chat.id;
    const off = (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;
    const day = (ts) => new Date(ts + off).toISOString().slice(0, 10);
    const getP = async (uid) => {
      const raw = await env.BOT_KV.get("pts:" + uid);
      return raw ? JSON.parse(raw) : { p: 0, last: "", streak: 0, name: "" };
    };
    if (cmd === "/qd" || text === "签到") {
      const prof = await getP(msg.from.id);
      const today = day(Date.now());
      if (prof.last === today)
        return send(
          env,
          chatId,
          `今天已经签过啦。当前积分 ${prof.p}，连签 ${prof.streak} 天。`,
        );
      prof.streak =
        prof.last === day(Date.now() - 86400 * 1000) ? prof.streak + 1 : 1;
      const gain = 10 + Math.min(prof.streak - 1, 10);
      prof.p += gain;
      prof.last = today;
      prof.name = who(msg.from);
      await env.BOT_KV.put("pts:" + msg.from.id, JSON.stringify(prof));
      return send(
        env,
        chatId,
        `✅ 签到成功 +${gain} 分（连签 ${prof.streak} 天）\n当前积分：${prof.p}`,
      );
    }
    if (cmd === "/me") {
      const prof = await getP(msg.from.id);
      return send(
        env,
        chatId,
        `🧾 ${who(msg.from)}\n积分：${prof.p}\n连签：${prof.streak} 天`,
      );
    }
    if (cmd === "/top") {
      const list = await env.BOT_KV.list({ prefix: "pts:", limit: 1000 });
      const rows = [];
      for (const k of list.keys) {
        const raw = await env.BOT_KV.get(k.name);
        if (raw) {
          const p = JSON.parse(raw);
          rows.push({ name: p.name || k.name.slice(4), p: p.p });
        }
      }
      rows.sort((a, b) => b.p - a.p);
      if (!rows.length)
        return send(env, chatId, "还没有人签到，发 /qd 抢榜一。");
      return send(
        env,
        chatId,
        "🏆 积分榜 Top 10\n\n" +
          rows
            .slice(0, 10)
            .map((r, i) => `${i + 1}. ${r.name} — ${r.p} 分`)
            .join("\n"),
      );
    }
    if (cmd === "/start" || cmd === "/help")
      return send(
        env,
        chatId,
        "🎲 签到 Bot\n/qd 每日签到领积分（连签有加成）\n/me 我的积分\n/top 积分榜",
      );
  },
};
const KERNELS = { support: supportKernel, checkin: checkinKernel };

// ============================================================
// 入驻装配
// 验真（getMe）→ 生成 slug/租户密钥 → 加密存记录 → 代设子 Webhook →
// 给子 Bot 注册它自己的命令菜单。slug 用随机串：Token 绝不进 URL。
// ============================================================
async function onboardBot(env, origin, { token, type, owner }) {
  const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meResp.json().catch(() => ({}));
  if (!me.ok) return { error: "Token 无效（getMe 验真没过），检查后重发。" };
  const slug = randHex(8);
  const secret = randHex(12);
  const rec = {
    tokenEnc: await encToken(env, token),
    botId: me.result.id,
    username: me.result.username,
    type,
    owner,
    secret,
    config: {},
    stopped: false,
    at: Date.now(),
  };
  await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
  const hookResp = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${origin}/w/${slug}`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      }),
    },
  );
  const hook = await hookResp.json().catch(() => ({}));
  if (!hook.ok)
    return { error: "代设 Webhook 失败：" + (hook.description || "未知错误") };
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: KERNELS[type].commands }),
  }).catch(() => {});
  return { slug, username: me.result.username };
}
async function getTenant(env, slug) {
  const raw = await env.BOT_KV.get("bot:" + slug);
  return raw ? JSON.parse(raw) : null;
}
async function listTenants(env, ownerId) {
  const list = await env.BOT_KV.list({ prefix: "bot:", limit: 1000 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    if (ownerId && rec.owner !== ownerId) continue;
    out.push({ slug: k.name.slice(4), ...rec });
  }
  return out;
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
  { command: "new", description: "开通一个子 Bot" },
  { command: "mybots", description: "我的子 Bot" },
  { command: "cancel", description: "取消当前向导" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "tenants", description: "全部租户（管理员）" },
  { command: "tstop", description: "熔断/恢复租户（管理员）" },
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
// 四条路：/ 健康检查、/setWebhook 挂载母体、/webhook 母体更新、
// /w/<slug> 子 Bot 更新（按租户密钥验签 → 解密 Token → 分发内核）。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("mother-bot is running.", {
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
    if (url.pathname.startsWith("/w/") && request.method === "POST") {
      if (!env.BOT_KV) return new Response("KV 未绑定", { status: 500 });
      const slug = url.pathname.slice(3);
      const rec = await getTenant(env, slug);
      if (!rec) return new Response("ok");
      if (request.headers.get("x-telegram-bot-api-secret-token") !== rec.secret)
        return new Response("forbidden", { status: 403 });
      if (rec.stopped) return new Response("ok"); // 熔断中：静默吞掉
      const update = await request.json().catch(() => ({}));
      ctx.waitUntil(dispatchTenant(env, rec, update));
      return new Response("ok");
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
    update.__origin = url.origin;
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};

// 子 Bot 分发：解密 Token → 组装租户 env（换 Token + 租户前缀 KV）→ 跑内核。
async function dispatchTenant(env, rec, update) {
  const kernel = KERNELS[rec.type];
  if (!kernel) return;
  let token;
  try {
    token = await decToken(env, rec.tokenEnc);
  } catch (e) {
    return; // 解密失败（多半是 TOKEN_ENC_KEY 被换过）：静默，别把异常打进日志带出敏感信息
  }
  const tenantEnv = {
    ...env,
    BOT_TOKEN: token,
    BOT_KV: scopedKV(env.BOT_KV, `t:${rec.botId}:`),
    TENANT: rec,
  };
  await kernel.handle(tenantEnv, update, rec);
}

// ============================================================
// 业务主流程（母体侧）
// 入驻向导 FSM：choose（选模板按钮 mb:type:*）→ token（发 Token 文本）→
// confirm（核对信息按钮 mb:go）→ onboardBot。我的 Bot 列表带停/启/删按钮。
// 回调前缀 mb: 只管母体向导与租户管理。
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
  const origin = update.__origin || "";

  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (!data.startsWith("mb:")) return;
    const chatId = cq.message.chat.id;
    const uid = cq.from.id;
    const parts = data.split(":");
    const act = parts[1];
    if (act === "type") {
      const type = parts[2];
      if (!KERNELS[type]) return;
      await fsmSet(env, chatId, uid, "token", { type });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `已选模板：${KERNELS[type].name}\n\n第 2 步：把你子 Bot 的 Token 发给我（从 @BotFather 拿）。\n\n⚠️ 说清楚再发：Token 交给我 = 这个 Bot 的消息由本母体托管处理；Token 会加密存储、绝不回显；你随时可以去 @BotFather 用 /revoke 让托管立即失效。\n不想继续发 /cancel。`,
      });
    }
    if (act === "go") {
      const st = await fsmGet(env, chatId, uid);
      if (!st || st.step !== "confirm")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "向导已过期，重新 /new",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⏳ 正在开通…",
      });
      const res = await onboardBot(env, origin, {
        token: st.data.token,
        type: st.data.type,
        owner: uid,
      });
      await fsmClear(env, chatId, uid);
      if (res.error)
        return tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `😵 开通失败：${res.error}`,
        });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `🎉 开通成功！你的子 Bot @${res.username}（${KERNELS[st.data.type].name}）已上线，去和它对话试试。\n管理：/mybots（停用/恢复/删除）`,
      });
    }
    if (act === "stop" || act === "start" || act === "del") {
      const slug = parts[2];
      const rec = await getTenant(env, slug);
      if (!rec || (rec.owner !== uid && !isAdmin(env, uid)))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "不是你的 Bot",
          show_alert: true,
        });
      if (act === "del") {
        const token = await decToken(env, rec.tokenEnc).catch(() => null);
        if (token)
          await fetch(
            `https://api.telegram.org/bot${token}/deleteWebhook`,
          ).catch(() => {});
        await env.BOT_KV.delete("bot:" + slug);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "🗑 已删除托管（Token 密文一并销毁）",
        });
      } else {
        rec.stopped = act === "stop";
        await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: rec.stopped ? "⏸️ 已停用" : "▶️ 已恢复",
        });
      }
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: "已更新。发 /mybots 看最新列表。",
      });
    }
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  if (msg.chat.type !== "private" && cmd !== "/tenants" && cmd !== "/tstop")
    return; // 入驻只在私聊办（Token 不能进群）

  // 向导进行中：先喂给 FSM
  const st = await fsmGet(env, chatId, uid);
  if (st && cmd !== "/cancel" && cmd !== "/start") {
    if (st.step === "token") {
      const token = text;
      if (!/^\d{6,}:[\w-]{30,}$/.test(token))
        return send(
          env,
          chatId,
          "这不像 Token（格式应是 数字:一串字符）。从 @BotFather 复制完整的发我，或 /cancel 退出。",
        );
      const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const me = await meResp.json().catch(() => ({}));
      if (!me.ok)
        return send(
          env,
          chatId,
          "这个 Token 验真没过（getMe 失败），检查一下重发，或 /cancel 退出。",
        );
      st.data.token = token;
      st.data.username = me.result.username;
      await fsmSet(env, chatId, uid, "confirm", st.data);
      return send(
        env,
        chatId,
        `核对一下：\n· 子 Bot：@${me.result.username}\n· 模板：${KERNELS[st.data.type].name}\n· Token：${maskToken(token)}（加密存储，不回显）\n\n确认开通？`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ 确认开通", callback_data: "mb:go" }],
            ],
          },
        },
      );
    }
    return send(env, chatId, "向导进行中，按提示操作，或 /cancel 退出。");
  }

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🏭 母体 Bot\n\n把你的 Bot 托管到这里：选模板、交 Token，子 Bot 立刻上线（本母体统一跑代码、统一升级）。\n\n/new 开通子 Bot（内置客服、签到两种模板）\n/mybots 管理我的子 Bot\n\n⚠️ Token 会加密存储；你随时可去 @BotFather /revoke 让托管失效。",
    );

  if (cmd === "/new") {
    await fsmSet(env, chatId, uid, "choose", {});
    return send(env, chatId, "第 1 步：选子 Bot 模板", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💬 客服 Bot（消息转发+回复）",
              callback_data: "mb:type:support",
            },
          ],
          [
            {
              text: "🎲 签到 Bot（签到/积分/排行）",
              callback_data: "mb:type:checkin",
            },
          ],
        ],
      },
    });
  }

  if (cmd === "/cancel") {
    await fsmClear(env, chatId, uid);
    return send(env, chatId, "已取消向导。");
  }

  if (cmd === "/mybots") {
    const mine = await listTenants(env, uid);
    if (!mine.length)
      return send(env, chatId, "你还没有子 Bot。/new 开通一个。");
    for (const rec of mine) {
      await send(
        env,
        chatId,
        `🤖 @${rec.username}（${KERNELS[rec.type]?.name || rec.type}）\n状态：${rec.stopped ? "⏸️ 已停用" : "✅ 运行中"}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                rec.stopped
                  ? { text: "▶️ 恢复", callback_data: `mb:start:${rec.slug}` }
                  : { text: "⏸️ 停用", callback_data: `mb:stop:${rec.slug}` },
                { text: "🗑 删除托管", callback_data: `mb:del:${rec.slug}` },
              ],
            ],
          },
        },
      );
    }
    return;
  }

  // ---------- 平台管理（管理员） ----------
  if (cmd === "/tenants") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有平台管理员能看。");
    const all = await listTenants(env, null);
    if (!all.length) return send(env, chatId, "还没有任何租户。");
    return send(
      env,
      chatId,
      `🏭 全部租户（${all.length}）\n\n` +
        all
          .slice(0, 30)
          .map(
            (r) =>
              `· @${r.username}（${r.type}）店主 ${r.owner} ${r.stopped ? "⏸️" : "✅"} slug=${r.slug}`,
          )
          .join("\n"),
    );
  }
  if (cmd === "/tstop") {
    if (!isAdmin(env, uid))
      return send(env, chatId, "⛔ 只有平台管理员能熔断。");
    const slug = text.split(/\s+/)[1];
    const rec = slug && (await getTenant(env, slug));
    if (!rec)
      return send(env, chatId, "用法：/tstop <slug>（slug 见 /tenants）");
    rec.stopped = !rec.stopped;
    await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
    return send(
      env,
      chatId,
      `已${rec.stopped ? "熔断" : "恢复"} @${rec.username}。`,
    );
  }
}
