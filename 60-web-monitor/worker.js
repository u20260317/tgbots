// ============================================================
// 60 网站更新监控 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：盯没有 RSS 的网页：/watch <网址> 建监控，Bot 定期抓取页面正文、
// 算哈希与上次快照比对，变了就推送 diff 摘要（新增/删除行数 + 变化示例）。
// 对应 Visualping / changedetection.io 的 Telegram 告警形态，补 11（只认 RSS）的盲区。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ 需要 Cron：加 Cron Trigger，如 0 * * * *（每小时）。抓取频率由
// CONFIG.MIN_INTERVAL_MIN 再兜底，两道闸一起控免费版额度（见 README）。
// 键设计：snap:<uid>:<监控ID> = { url, hash, text 正文快照, last 上次检查, fails}
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 40（安全抓取）+ 模块 09（Cron）+ 模块 15（去重思路）+ 模块 01
// ============================================================

// ============================================================
// 抓取礼仪与频率
// UA 带项目地址表明身份，不伪装浏览器；MIN_INTERVAL_MIN 是单个监控的
// 最小检查间隔（分钟），Cron 跑得再勤也不会击穿它。
// ============================================================
const CONFIG = {
  UA: "tgbots-web-monitor/1.0 (+https://github.com/u20260317/tgbots)",
  MIN_INTERVAL_MIN: 55,
  MAX_TEXT: 8000,
};

// ============================================================
// Telegram Bot API 通信层
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
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// ============================================================
// 安全抓取 + 正文提取 + 哈希（与 44/59 同口径）
// SSRF 只许公网 http/https；正文提取剥噪声标签后压空白——监控的是
// 「内容变化」而不是 HTML 变化，归一化能滤掉时间戳、广告位这类假变化。
// ============================================================
function isSafePublicUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (
    /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fe80"))
    return false;
  return true;
}
function extractText(html) {
  let s = String(html);
  s = s.replace(
    /<(script|style|nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi,
    " ",
  );
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function fetchPageText(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": CONFIG.UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("源站返回 " + r.status);
  const text = extractText(await r.text());
  if (text.length < 50) throw new Error("没抓到正文（可能是纯 JS 渲染页面）");
  return text.slice(0, CONFIG.MAX_TEXT);
}
async function sha256hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// 行级 diff 摘要
// 把新旧正文按行集合比：新增行、删除行各计数并取前 3 行示例。
// 集合比对不抓「改了一半的行」的细节，但对「页面多了/少了哪段」足够，
// 且计算量小，适合在 Cron 里批量跑。
// ============================================================
function diffLines(oldText, newText) {
  const lines = (t) =>
    t
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.length >= 4)
      .slice(0, 500);
  const oldArr = lines(oldText);
  const newArr = lines(newText);
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  const added = [...new Set(newArr.filter((x) => !oldSet.has(x)))];
  const removed = [...new Set(oldArr.filter((x) => !newSet.has(x)))];
  return { added, removed };
}

// ============================================================
// 定时比对（Cron）
// 逐个监控先过最小间隔闸，再抓取比对：
// · 抓失败累计计数，连续 3 次失败只通知一次（防源站宕机刷屏）；
// · 哈希没变只更新 last；变了先存新快照再推 diff 摘要（先存后推，
// 推送失败也不会下一轮重复报同一个变化）。
// ============================================================
async function runChecks(env) {
  const list = await env.BOT_KV.list({ prefix: "snap:", limit: 1000 });
  const now = Date.now();
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const snap = JSON.parse(raw);
    if (now - (snap.last || 0) < CONFIG.MIN_INTERVAL_MIN * 60 * 1000) continue;
    let text;
    try {
      text = await fetchPageText(snap.url);
    } catch (e) {
      snap.fails = (snap.fails || 0) + 1;
      snap.last = now;
      if (snap.fails === 3)
        await send(
          env,
          snap.chat,
          `⚠️ 监控抓取连续失败 3 次：${snap.url}\n原因：${e.message}。后续恢复或变化时会再通知。`,
        ).catch(() => {});
      await env.BOT_KV.put(k.name, JSON.stringify(snap));
      continue;
    }
    const hash = await sha256hex(text);
    snap.last = now;
    if (snap.fails) snap.fails = 0;
    if (hash === snap.hash) {
      await env.BOT_KV.put(k.name, JSON.stringify(snap));
      continue;
    }
    const d = diffLines(snap.text || "", text);
    snap.hash = hash;
    snap.text = text;
    await env.BOT_KV.put(k.name, JSON.stringify(snap));
    const show = (arr, sign) =>
      arr
        .slice(0, 3)
        .map((x) => `${sign} ${x.slice(0, 100)}`)
        .join("\n");
    await send(
      env,
      snap.chat,
      `🔔 网页有更新：${snap.url}\n新增 ${d.added.length} 行 · 删除 ${d.removed.length} 行\n${d.added.length ? show(d.added, "＋") + "\n" : ""}${d.removed.length ? show(d.removed, "－") : ""}`.trim(),
    ).catch(() => {});
  }
}

// 管理员白名单与分级命令菜单（本 Bot 无管理员命令，菜单模块照常保留）
const COMMANDS_USER = [
  { command: "watch", description: "添加监控 /watch <网址>" },
  { command: "watchlist", description: "我的监控列表" },
  { command: "unwatch", description: "取消监控 /unwatch <ID>" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  return tg(env, "setMyCommands", { commands: COMMANDS_USER });
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
      return new Response("web-monitor bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(runChecks(env));
  },
};

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
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (!data.startsWith("snap:del:")) return;
    const key = `snap:${cq.from.id}:${data.slice(9)}`;
    const existed = await env.BOT_KV.get(key);
    if (existed) await env.BOT_KV.delete(key);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: existed ? "🗑 已取消监控" : "这条监控不存在了",
    });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "👀 网站更新监控 Bot\n\n/watch <网址> 盯一个没有 RSS 的网页，正文有变化就推你 diff 摘要。\n/watchlist 看监控列表，/unwatch <ID> 取消。\n检查频率约每小时一次。",
    );
  if (cmd === "/watch") {
    const url = text.replace(/^\/watch(@\w+)?\s*/, "").trim();
    if (!url) return send(env, chatId, "用法：/watch https://example.com/page");
    if (!isSafePublicUrl(url))
      return send(
        env,
        chatId,
        "⚠️ 只支持公网 http/https 地址，内网/本地地址不监控。",
      );
    await send(env, chatId, "🔎 正在抓取基线快照…");
    let pageText;
    try {
      pageText = await fetchPageText(url);
    } catch (e) {
      return send(
        env,
        chatId,
        `⚠️ 抓取失败：${e.message}。换个链接或稍后再试。`,
      );
    }
    const id = newId();
    await env.BOT_KV.put(
      `snap:${uid}:${id}`,
      JSON.stringify({
        id,
        uid,
        chat: chatId,
        url,
        hash: await sha256hex(pageText),
        text: pageText,
        last: Date.now(),
        fails: 0,
      }),
    );
    return send(
      env,
      chatId,
      `✅ 已开始监控（ID ${id}）：${url}\n基线快照已存，正文有变化会第一时间推你。`,
    );
  }
  if (cmd === "/watchlist") {
    const list = await env.BOT_KV.list({ prefix: `snap:${uid}:`, limit: 200 });
    if (!list.keys.length)
      return send(env, chatId, "你还没有监控。/watch <网址> 加一个。");
    const kb = [];
    const lines = [];
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (!raw) continue;
      const s = JSON.parse(raw);
      lines.push(
        `· ${s.url}（ID ${s.id}${s.fails ? `，近期抓取失败 ${s.fails} 次` : ""}）`,
      );
      kb.push([
        {
          text: `🗑 取消 ${s.url.slice(0, 40)}`,
          callback_data: `snap:del:${s.id}`,
        },
      ]);
    }
    return send(env, chatId, "👀 我的监控\n\n" + lines.join("\n"), {
      reply_markup: { inline_keyboard: kb },
    });
  }
  if (cmd === "/unwatch") {
    const id = text.split(/\s+/)[1];
    if (!id)
      return send(env, chatId, "用法：/unwatch <监控ID>（在 /watchlist 里看）");
    await env.BOT_KV.delete(`snap:${uid}:${id}`);
    return send(env, chatId, "🗑 已取消该监控。");
  }
}
