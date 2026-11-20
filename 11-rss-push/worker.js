// ============================================================
// 11 RSS / 定时推送 Bot（单文件 · Cloudflare Workers + Cron + 需绑定 KV）
// 原理：Worker 的 scheduled() 由 Cron Triggers 定时唤醒，逐个抓 RSS/Atom，
// 和 KV 里存的上次状态比对，只把新文章推到目标频道，去重不靠数据库服务器。
// 触发方式三选一（可混用）：
// A. Cloudflare Cron（推荐）：Worker -> Settings -> Triggers -> Cron Triggers
// 添加如 */30 * * * *（每 30 分钟）；代码不用改，scheduled 会自动跑。
// B. 手动网址：GET https://你的Worker地址/push?key=WEBHOOK_SECRET 立即跑一轮。
// C. 管理员私聊 Bot 发 /pushnow 立即跑一轮并回报条数。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// CHANNEL_ID 推送目标频道 @username 或 -100 数字 ID（Bot 须为频道管理员）
// RSS_FEEDS Feed 地址，多个用英文逗号隔开
// 选填：
// ADMIN_ID 管理员 ID（收手动命令/首轮播种通知）
// WEBHOOK_SECRET Webhook 密钥（同时是 /push 的口令）
// KEYWORDS 只推标题含这些词的文章，逗号隔开，不填全推
// MAX_PER_RUN 每个 Feed 单轮最多推几条，默认 3，防刷屏
// ⚠️ 需要 KV：Bindings 添加 KV Namespace，变量名必须叫 BOT_KV（只存去重状态）。
// ⚠️ 首轮只「播种」：第一次运行只记录当前文章、不推送，之后才推新增，避免一上来刷屏几十条。
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

// ============================================================
// 【核心模块】RSS / Atom 解析（零依赖）
// 用正则从 XML 里抠 item/entry 的标题、链接、唯一 ID；够用且不引第三方库，怪异 Feed 容错跳过。
// ============================================================
function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}
function tagOf(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}
function linkOf(block) {
  const simple = tagOf(block, "link");
  if (simple && /^https?:\/\//.test(simple)) return simple;
  const m = block.match(/<link[^>]*href="([^"]+)"[^>]*>/i); // Atom 风格
  return m ? m[1] : simple;
}
function parseFeed(xml) {
  const blocks =
    xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) || [];
  const feedTitle = tagOf(xml.split(/<item|<entry/i)[0], "title");
  return {
    feedTitle,
    items: blocks
      .map((b) => ({
        title: tagOf(b, "title"),
        link: linkOf(b),
        id:
          tagOf(b, "guid") || tagOf(b, "id") || linkOf(b) || tagOf(b, "title"),
      }))
      .filter((x) => x.title && x.link),
  };
}

// ============================================================
// 【核心模块】去重状态存储（KV）
// KV 键 rss_state：{ feed地址: [最近见过的文章ID,...]}，每 Feed 只留最近 30 个，足够防重复。
// ============================================================
async function loadState(env) {
  const raw = await env.BOT_KV.get("rss_state");
  return raw ? JSON.parse(raw) : {};
}
async function saveState(env, st) {
  await env.BOT_KV.put("rss_state", JSON.stringify(st));
}

// ============================================================
// 【核心模块】推送主流程
// 逐个 Feed 抓取 -> 与状态比对 -> 新文章按时间正序推频道 -> 回写状态。返回本轮统计给调用方。
// ============================================================
async function runPush(env) {
  const feeds = String(env.RSS_FEEDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keywords = String(env.KEYWORDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const maxPer = Number(env.MAX_PER_RUN) || 3;
  const state = await loadState(env);
  let pushed = 0,
    seeded = 0,
    errors = 0;
  for (const feed of feeds) {
    try {
      const r = await fetch(feed, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; tgbots-rss/1.0)" },
      });
      if (!r.ok) {
        errors++;
        continue;
      }
      const { feedTitle, items } = parseFeed(await r.text());
      if (!items.length) continue;
      const seen = state[feed];
      if (!seen) {
        // 首轮播种：只记状态不推送
        state[feed] = items.map((x) => x.id).slice(0, 30);
        seeded++;
        continue;
      }
      const fresh = items
        .filter((x) => !seen.includes(x.id))
        .filter(
          (x) =>
            !keywords.length ||
            keywords.some((k) => x.title.toLowerCase().includes(k)),
        );
      const toPush = fresh.slice(0, maxPer).reverse(); // 正序：旧的先发
      for (const it of toPush) {
        const res = await send(
          env,
          env.CHANNEL_ID,
          `📰 ${it.title}\n\n${it.link}\n—— ${feedTitle || "RSS"}`,
        );
        if (res.ok) pushed++;
      }
      state[feed] = [...items.map((x) => x.id), ...seen]
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 30);
    } catch {
      errors++;
    }
  }
  await saveState(env, state);
  return { pushed, seeded, errors, feeds: feeds.length };
}

// ============================================================
// 【核心模块】Worker 入口与路由
// fetch 管 Bot 命令与手动触发，scheduled 管 Cron 定时触发，两条路都汇到 runPush。
// ============================================================
// ============================================================
// 【核心模块】管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
//   · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
//   · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
//     于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
//     的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [{ command: "start", description: "使用说明" }];
const COMMANDS_ADMIN = [
  { command: "pushnow", description: "立即抓取一轮（管理员）" },
  { command: "status", description: "订阅源状态（管理员）" },
];
async function registerCommands(env) {
  // 先注册默认菜单（所有人可见的用户命令）
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  // 再给白名单里每个管理员单独注册全集菜单（只在他私聊里生效）
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("rss-push bot is running.", {
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
    if (url.pathname === "/push") {
      if (
        !env.WEBHOOK_SECRET ||
        url.searchParams.get("key") !== env.WEBHOOK_SECRET
      )
        return new Response("forbidden", { status: 403 });
      if (!env.BOT_KV) return new Response("BOT_KV 未绑定", { status: 500 });
      const stat = await runPush(env);
      return Response.json({ ok: true, ...stat });
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
  // Cron Triggers 唤醒入口：在 Worker 的 Triggers 里加 Cron 表达式后自动定时执行
  async scheduled(event, env, ctx) {
    if (env.BOT_KV) ctx.waitUntil(runPush(env));
  },
};

async function handle(env, update) {
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const text = msg.text || "";
  const isAdmin = admins(env).includes(String(msg.from.id));
  if (text.startsWith("/start"))
    return send(
      env,
      msg.chat.id,
      "📰 RSS 定时推送 Bot：我会按 Cron 节奏把订阅源的新文章推到频道。管理员可发 /pushnow 立即跑一轮、/status 看配置。",
    );
  if (!isAdmin) return;
  if (!env.BOT_KV)
    return send(
      env,
      msg.chat.id,
      "⚠️ 还没绑定 KV（变量名 BOT_KV），推送无法去重。",
    );
  if (text.startsWith("/pushnow")) {
    await send(env, msg.chat.id, "⏳ 正在抓取一轮……");
    const stat = await runPush(env);
    return send(
      env,
      msg.chat.id,
      `✅ 本轮完成：推送 ${stat.pushed} 条，新播种 ${stat.seeded} 个源，失败 ${stat.errors} 个（共 ${stat.feeds} 个源）。`,
    );
  }
  if (text.startsWith("/status")) {
    const state = await loadState(env);
    return send(
      env,
      msg.chat.id,
      `📊 配置源 ${
        String(env.RSS_FEEDS || "")
          .split(",")
          .filter(Boolean).length
      } 个，已播种 ${Object.keys(state).length} 个。\n目标频道：${env.CHANNEL_ID}\n关键词过滤：${env.KEYWORDS || "（无，全推）"}`,
    );
  }
}
