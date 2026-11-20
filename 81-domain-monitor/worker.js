// ============================================================
// 81 域名 / SSL 到期监控 Bot（单文件 · Workers + 需绑定 KV + Cron）
// 功能：
// /domain <域名> 订阅监控；Cron 每天查两件事——域名注册到期日
// （RDAP 公开协议，免 key）与 TLS 证书到期日；到期前 30 / 7 / 1
// 天分级提醒订阅者；/domains 看列表与当前到期信息。
// ⚠️ 证书检查的硬边界：Workers 的 fetch 读不到对端证书有效期
// （TLS 握手细节不暴露给 JS），证书到期日必须借外部探针：
// DOMAIN_PROBE_URL 指一个返回 JSON {certDaysLeft 或 certExpiry}
// 的检测服务（如自建小探针、第三方 SSL 检查 API）。没配探针时
// 本 Bot 只做 RDAP 域名到期监控，并在回复里注明证书未监控——
// 不假装查过证书。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// DOMAIN_PROBE_URL 证书探针端点（GET?domain=<域名> → JSON）
// ADMIN_ID 管理员数字 ID（看 /domstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：dom:sub:<uid> = [域名...]；
// dom:state:<域名> = {regExpiry, certExpiry, stage}，
// stage 记录已提醒到的最紧迫等级（30/7/1），防重复打扰。
// ⚠️ 需要 Cron：Triggers 加一条（如 0 10 * * * 每天一次足够）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 41（监控形态）+ 模块 19（RDAP/探针 API）+ 09/01/02
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
const daysLeft = (iso) =>
  Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

// ============================================================
// RDAP 域名到期查询
// RDAP 是 WHOIS 的官方继任协议：GET https://rdap.org/domain/<域名>
// 会 302 跳到该后缀注册局的 RDAP 服务，响应 JSON 的 events 数组里
// eventAction="expiration" 的 eventDate 就是注册到期日。免 key。
// 部分小众后缀没有 RDAP 服务 → 查不到时如实返回 null，不编日期。
// ============================================================
async function rdapExpiry(domain) {
  const r = await fetch(
    `https://rdap.org/domain/${encodeURIComponent(domain)}`,
    {
      // 必须带 UA：rdap.org 对无 User-Agent 的请求直接 403（实测 Workers/undici 默认请求都会被拦）
      headers: {
        accept: "application/rdap+json, application/json",
        "user-agent":
          "domain-monitor-bot/1.0 (Telegram bot; RDAP expiry check)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  const ev = (data.events || []).find((e) => e.eventAction === "expiration");
  return ev?.eventDate || null;
}

// ============================================================
// 证书到期（外部探针）
// 没配 DOMAIN_PROBE_URL 直接返回 undefined（= 未监控，与「查不到」
// 的 null 区分开，回复文案不同）。探针口径：GET
// {DOMAIN_PROBE_URL}?domain=<域名> → { certExpiry: ISO} 或
// { certDaysLeft: n}，两种都认。自建探针只需在任何能读证书的
// 运行时（Node/Python 都行）里 tls.connect 后取 peerCertificate
// 的 valid_to 包成这个 JSON 即可。
// ============================================================
async function certExpiry(env, domain) {
  if (!env.DOMAIN_PROBE_URL) return undefined;
  const u = `${env.DOMAIN_PROBE_URL}${env.DOMAIN_PROBE_URL.includes("?") ? "&" : "?"}domain=${encodeURIComponent(domain)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  if (data.certExpiry) return data.certExpiry;
  if (typeof data.certDaysLeft === "number")
    return new Date(Date.now() + data.certDaysLeft * 86400000).toISOString();
  return null;
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "domain", description: "订阅监控 /domain example.com" },
  { command: "domains", description: "我的监控列表" },
];
const COMMANDS_ADMIN = [
  { command: "domstats", description: "监控统计（管理员）" },
];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    for (const id of admins(env)) {
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
// 健康检查、/setWebhook、Webhook 密钥校验、更新分发；
// scheduled 是 Cron 入口：逐域名查到期并按 30/7/1 分级提醒。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("domain-monitor bot is running.", {
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
    ctx.waitUntil(checkAll(env));
  },
};

async function getSubs(env, uid) {
  const raw = await env.BOT_KV.get("dom:sub:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, uid, subs) {
  await env.BOT_KV.put("dom:sub:" + uid, JSON.stringify(subs));
}

// ============================================================
// 每日检查与分级提醒（Cron）
// 对每个被监控域名取「域名到期 / 证书到期」里更早的那个算剩余
// 天数，落到 30/7/1 哪个档就提醒哪个档：stage 存已提醒过的最紧
// 档，只有跨入更紧的档才再推（续期后天数回升，stage 自动重置）。
// 提醒扇出给该域名的全部订阅者。
// ============================================================
async function checkAll(env) {
  if (!env.BOT_KV) return;
  const list = await env.BOT_KV.list({ prefix: "dom:sub:", limit: 1000 });
  const byDomain = new Map();
  for (const k of list.keys) {
    const uid = k.name.slice("dom:sub:".length);
    for (const d of JSON.parse((await env.BOT_KV.get(k.name)) || "[]")) {
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(uid);
    }
  }
  for (const [domain, uids] of byDomain) {
    const stateKey = "dom:state:" + domain;
    const rawState = await env.BOT_KV.get(stateKey);
    const state = rawState ? JSON.parse(rawState) : { stage: 99 };
    try {
      state.regExpiry = (await rdapExpiry(domain)) || state.regExpiry || null;
    } catch (e) {}
    try {
      const c = await certExpiry(env, domain);
      if (c !== undefined) state.certExpiry = c;
    } catch (e) {}
    const candidates = [state.regExpiry, state.certExpiry].filter(Boolean);
    if (!candidates.length) {
      await env.BOT_KV.put(stateKey, JSON.stringify(state));
      continue;
    }
    const minIso = candidates.sort()[0];
    const left = daysLeft(minIso);
    const stage = left <= 1 ? 1 : left <= 7 ? 7 : left <= 30 ? 30 : 99;
    if (stage < state.stage) {
      const which =
        minIso === state.certExpiry && state.certExpiry !== state.regExpiry
          ? "SSL 证书"
          : "域名注册";
      const text =
        stage === 99
          ? ""
          : `⏰ ${domain} 的${which}将在 ${left} 天后到期（${minIso.slice(0, 10)}），记得续期！`;
      if (text) for (const uid of uids) await send(env, uid, text);
    }
    state.stage = stage;
    state.checkedAt = Date.now();
    await env.BOT_KV.put(stateKey, JSON.stringify(state));
  }
}

// ============================================================
// 业务主流程
// /domain 订阅时先真查一次 RDAP：查得到到期日才算订阅成功并
// 当场展示；查不到（无 RDAP 的后缀）说明白，让用户决定。
// 退订按钮回调 dom:del:<下标>（个人订阅数组下标）。
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
  if (cq && String(cq.data || "").startsWith("dom:del:")) {
    const idx = Number(cq.data.split(":")[2]);
    const subs = await getSubs(env, cq.from.id);
    const removed = subs[idx];
    if (removed) {
      subs.splice(idx, 1);
      await saveSubs(env, cq.from.id, subs);
    }
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: removed ? `已停止监控 ${removed}` : "已删除",
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      `🌐 域名 / SSL 到期监控 Bot\n\n/domain <域名> 订阅，到期前 30 / 7 / 1 天分级提醒。\n/domains 看监控列表。\n\n域名到期日走 RDAP 公开协议（免 key）；证书到期${env.DOMAIN_PROBE_URL ? "走已配置的外部探针。" : "需管理员配置 DOMAIN_PROBE_URL 探针才监控（Workers 读不到对端证书），当前只监控域名到期。"}`,
    );

  if (cmd === "/domain") {
    const domain = (parts[1] || "")
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
      return send(
        env,
        chatId,
        "用法：/domain <域名>，如 /domain example.com（不用带 http://）",
      );
    await send(env, chatId, `⏳ 正在查 ${domain} 的到期信息…`);
    let exp = null;
    try {
      exp = await rdapExpiry(domain);
    } catch (e) {}
    if (!exp)
      return send(
        env,
        chatId,
        `😵 没查到 ${domain} 的 RDAP 到期信息（小众后缀可能没有 RDAP 服务，或域名不存在）。没有收下这个监控——查不到的东西没法提醒。`,
      );
    const subs = await getSubs(env, uid);
    if (!subs.includes(domain)) {
      subs.push(domain);
      await saveSubs(env, uid, subs);
    }
    await env.BOT_KV.put(
      "dom:state:" + domain,
      JSON.stringify({ regExpiry: exp, certExpiry: null, stage: 99 }),
    );
    return send(
      env,
      chatId,
      `✅ 已监控 ${domain}\n域名注册到期：${exp.slice(0, 10)}（剩 ${daysLeft(exp)} 天）\n到期前 30/7/1 天会提醒你。${env.DOMAIN_PROBE_URL ? "" : "\n（证书监控未开启：管理员未配 DOMAIN_PROBE_URL）"}`,
    );
  }

  if (cmd === "/domains") {
    const subs = await getSubs(env, uid);
    if (!subs.length)
      return send(env, chatId, "还没监控任何域名。/domain <域名> 开始。");
    const lines = [];
    for (const d of subs) {
      const raw = await env.BOT_KV.get("dom:state:" + d);
      const st = raw ? JSON.parse(raw) : {};
      lines.push(
        `🌐 ${d}\n 域名到期：${st.regExpiry ? `${st.regExpiry.slice(0, 10)}（剩 ${daysLeft(st.regExpiry)} 天）` : "未知"} · 证书：${st.certExpiry ? `${st.certExpiry.slice(0, 10)}（剩 ${daysLeft(st.certExpiry)} 天）` : env.DOMAIN_PROBE_URL ? "未知" : "未监控"}`,
      );
    }
    return send(env, chatId, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: subs.map((d, i) => [
          { text: `🗑 停止监控 ${d}`, callback_data: `dom:del:${i}` },
        ]),
      },
    });
  }

  if (cmd === "/domstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const states = await env.BOT_KV.list({ prefix: "dom:state:", limit: 1000 });
    return send(env, chatId, `📊 监控中的域名：${states.keys.length} 个`);
  }
}
