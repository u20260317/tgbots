// ============================================================
// 66 直播开播提醒 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 订阅主播，开播第一时间推送：/follow twitch <主播名>、
// /follow youtube <频道ID/@handle/链接>；Cron 轮询各目标的开播
// 状态，状态从「未开播→直播中」或换了新一场直播时才推送，
// 不重复报（状态存 live:state: 键）。
// 平台口径：
// · YouTube：免 Key 可真跑——轮询频道 /live 页判断是否在播。
// · Twitch：Helix API 必须有开发者凭据 TWITCH_CLIENT_ID /
//   TWITCH_CLIENT_SECRET（dev.twitch.tv 免费申请），未配时订阅照存、
//   轮询跳过、命令里明确提示，不假装在监控。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET Twitch 应用凭据（Secret）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：live:<用户ID> = 订阅列表；live:state:<平台>:<目标> = 上次状态。
// ⚠️ 必须给 Worker 加 Cron Trigger（如 */5 * * * *），不开 Cron 就没轮询。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 41（通知适配器形态）+ 模块 09（Cron）+ 模块 01（骨架）
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

// ============================================================
// Twitch 状态查询（Helix API）
// 先用 client_credentials 换应用令牌（缓存进 KV，快过期再换），
// 再查 /helix/streams?user_login=<名>：data 非空 = 正在直播，
// stream id 换了 = 新的一场，用它做防重复推送的依据。
// ============================================================
async function twitchToken(env) {
  const cached = await env.BOT_KV.get("live:twtoken", "json").catch(() => null);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!data.access_token)
    throw new Error("Twitch 令牌换取失败，检查 Client ID/Secret");
  await env.BOT_KV.put(
    "live:twtoken",
    JSON.stringify({
      token: data.access_token,
      exp: Date.now() + (data.expires_in || 3600) * 1000,
    }),
  );
  return data.access_token;
}
async function twitchLive(env, login) {
  const token = await twitchToken(env);
  const r = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`,
    {
      headers: {
        "Client-Id": env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
    },
  );
  const data = await r.json().catch(() => ({}));
  const s = data?.data?.[0];
  if (!s) return { live: false };
  return {
    live: true,
    id: String(s.id),
    title: s.title || "",
    game: s.game_name || "",
    viewers: s.viewer_count ?? 0,
    url: `https://www.twitch.tv/${login}`,
  };
}

// ============================================================
// YouTube 状态查询（免 Key）
// 频道 /live 页在直播时会带 isLive 标记与本场视频 ID（canonical）。
// 解析不到标记按未开播处理（宁可漏报不误报）；handle 先解析成频道 ID。
// ============================================================
async function youtubeChannelId(input) {
  const s = input.trim();
  if (/^UC[\w-]{22}$/.test(s)) return s;
  const m = s.match(/channel\/(UC[\w-]{22})/);
  if (m) return m[1];
  const handle = s.startsWith("@") ? s : "@" + s.replace(/^@/, "");
  const r = await fetch(`https://www.youtube.com/${handle}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; tgbots-live-alert/1.0)",
    },
  });
  if (!r.ok) return null;
  const html = await r.text();
  const mm =
    html.match(/"channelId":"(UC[\w-]{22})"/) ||
    html.match(/channel\/(UC[\w-]{22})/);
  return mm ? mm[1] : null;
}
async function youtubeLive(channelId) {
  const r = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; tgbots-live-alert/1.0)",
    },
  });
  if (!r.ok) return { live: false };
  const html = await r.text();
  if (!html.includes('"isLive":true') && !html.includes('"isLiveNow":true'))
    return { live: false };
  const vid = html.match(
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/,
  );
  const title =
    html.match(/"title":"([^"]{1,120})","author"/) ||
    html.match(/<title>([^<]{1,120})<\/title>/);
  return {
    live: true,
    id: vid ? vid[1] : channelId,
    title: title ? title[1].replace(/\\u0026/g, "&") : "",
    url: vid
      ? `https://www.youtube.com/watch?v=${vid[1]}`
      : `https://www.youtube.com/channel/${channelId}/live`,
  };
}

// ============================================================
// 订阅与轮询（KV + Cron）
// live:<用户ID> = [{platform, name, label}]；轮询时把所有订阅按
// 目标去重、每个目标只查一次，状态翻转（或同一目标换了新场次 id）
// 才给订阅者推送。live:state:<平台>:<目标> 存 {live, id} 做对比。
// ============================================================
async function getSubs(env, uid) {
  const raw = await env.BOT_KV.get("live:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, uid, subs) {
  await env.BOT_KV.put("live:" + uid, JSON.stringify(subs));
}
const twitchReady = (env) =>
  !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
async function checkTarget(env, platform, name) {
  if (platform === "twitch") {
    if (!twitchReady(env)) return null; // 未配置：跳过，不假装
    return twitchLive(env, name);
  }
  return youtubeLive(name);
}
async function pollLive(env) {
  const list = await env.BOT_KV.list({ prefix: "live:", limit: 1000 });
  const targets = new Map(); // platform:name -> [uid...]
  for (const k of list.keys) {
    if (!/^live:\d+$/.test(k.name)) continue;
    const uid = k.name.slice(5);
    for (const s of await getSubs(env, uid)) {
      const key = `${s.platform}:${s.name}`;
      if (!targets.has(key)) targets.set(key, { ...s, uids: [] });
      targets.get(key).uids.push(uid);
    }
  }
  for (const t of targets.values()) {
    let now = null;
    try {
      now = await checkTarget(env, t.platform, t.name);
    } catch (e) {
      continue; // 单个目标查询失败不中断整轮
    }
    if (!now) continue;
    const stateKey = `live:state:${t.platform}:${t.name}`;
    const prev = await env.BOT_KV.get(stateKey, "json").catch(() => null);
    const isNewLive = now.live && (!prev?.live || prev.id !== now.id);
    await env.BOT_KV.put(
      stateKey,
      JSON.stringify({ live: now.live, id: now.id || "", at: Date.now() }),
    );
    if (!isNewLive) continue;
    const label =
      t.platform === "twitch"
        ? `🟣 Twitch · ${t.name}`
        : `🔴 YouTube · ${t.label || t.name}`;
    const text = `${label} 开播了！\n${now.title ? "「" + now.title + "」\n" : ""}${t.platform === "twitch" && now.game ? "分区：" + now.game + ` · ${now.viewers} 人在看\n` : ""}${now.url}`;
    for (const uid of t.uids)
      await send(env, Number(uid), text, { disable_web_page_preview: true });
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "follow", description: "订阅开播提醒，如 /follow twitch shroud" },
  { command: "unfollow", description: "退订，如 /unfollow twitch shroud" },
  { command: "live", description: "我的订阅与状态" },
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
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("live-alert bot is running.", {
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
        allowed_updates: ["message"],
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
    if (env.BOT_KV) ctx.waitUntil(pollLive(env));
  },
};

// ============================================================
// 业务主流程
// /follow 平台 目标；平台只认 twitch / youtube（可写 yt）。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🔔 直播开播提醒 Bot\n\n/follow youtube <频道ID/@handle/链接> 订阅 YouTube（免配置可真跑）\n/follow twitch <主播名> 订阅 Twitch（需管理员配好 Twitch 凭据）\n/live 看我的订阅 · /unfollow 平台 目标 退订\n\n提醒靠 Cron 轮询（推荐每 5 分钟一轮），开播后一轮内推送。",
    );
  if (!env.BOT_KV && ["/follow", "/unfollow", "/live"].includes(cmd))
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");

  const parts = text.split(/\s+/);
  if (cmd === "/follow") {
    const platform =
      (parts[1] || "").toLowerCase() === "yt"
        ? "youtube"
        : (parts[1] || "").toLowerCase();
    const target = parts.slice(2).join(" ").trim();
    if (!["twitch", "youtube"].includes(platform) || !target)
      return send(
        env,
        chatId,
        "用法：/follow twitch <主播名>\n或 /follow youtube <频道ID/@handle/频道链接>",
      );
    const subs = await getSubs(env, uid);
    let entry;
    if (platform === "twitch") {
      entry = { platform, name: target.toLowerCase(), label: target };
    } else {
      const cid = await youtubeChannelId(target).catch(() => null);
      if (!cid)
        return send(
          env,
          chatId,
          "🤔 没解析出 YouTube 频道 ID。给我 UC 开头的频道 ID、@handle 或频道链接再试。",
        );
      entry = { platform, name: cid, label: target };
    }
    if (
      subs.some((s) => s.platform === entry.platform && s.name === entry.name)
    )
      return send(env, chatId, "已经订阅过这个目标了。");
    subs.push(entry);
    await saveSubs(env, uid, subs);
    if (platform === "twitch" && !twitchReady(env))
      return send(
        env,
        chatId,
        `✅ 已订阅 Twitch · ${target}（订阅已保存）。\n⚠️ 但管理员还没配置 TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET，Twitch 轮询暂未启用——配好前不会推送，别以为已经在监控了。申请办法见 README。`,
      );
    return send(
      env,
      chatId,
      `✅ 已订阅 ${platform === "twitch" ? "Twitch" : "YouTube"} · ${target}，开播就推你。`,
    );
  }

  if (cmd === "/unfollow") {
    const platform =
      (parts[1] || "").toLowerCase() === "yt"
        ? "youtube"
        : (parts[1] || "").toLowerCase();
    const target = (parts[2] || "").toLowerCase();
    const subs = await getSubs(env, uid);
    const next = subs.filter(
      (s) =>
        !(
          s.platform === platform &&
          (s.name.toLowerCase() === target ||
            (s.label || "").toLowerCase() === target)
        ),
    );
    if (next.length === subs.length)
      return send(env, chatId, "没找到这条订阅，用 /live 看确切写法。");
    await saveSubs(env, uid, next);
    return send(env, chatId, "🔕 已退订。");
  }

  if (cmd === "/live") {
    const subs = await getSubs(env, uid);
    if (!subs.length)
      return send(env, chatId, "你还没有订阅。/follow 平台 目标 订一个。");
    const lines = [];
    for (const s of subs) {
      const st = await env.BOT_KV.get(
        `live:state:${s.platform}:${s.name}`,
        "json",
      ).catch(() => null);
      const note =
        s.platform === "twitch" && !twitchReady(env)
          ? "⚠️ Twitch 凭据未配置，未在监控"
          : st
            ? st.live
              ? "🔴 直播中（上次轮询）"
              : "⚪ 未开播"
            : "⏳ 待首次轮询";
      lines.push(
        `· ${s.platform === "twitch" ? "Twitch" : "YouTube"} · ${s.label || s.name} — ${note}`,
      );
    }
    return send(env, chatId, "🔔 我的订阅：\n" + lines.join("\n"));
  }
}
