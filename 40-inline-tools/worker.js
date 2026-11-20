// ============================================================
// 40 Inline 工具 Bot（单文件 · Cloudflare Workers · 无需 KV）
// 功能：
// 在任意聊天输入框打 @Bot用户名 + 内容，就地出结果卡片，点一下发进聊天：
// · 词库搜索：内置演示词库（可改 CONFIG 换成你自己的商品/FAQ/文档索引）
// · 单位换算：10 km mi、100 c f、1 gb mb、5 kg lb 等
// · 计算器：1+2*3、(4+5)/2、2^10（自带安全表达式解析，不用 eval）
// · 时间戳：ts 看当前时间戳；纯数字按时间戳转日期
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 必须去 @BotFather /setinline 给本 Bot 开启 Inline 模式，否则 @ 不出来。
// 无状态：不绑 KV、不存任何用户数据。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 26（Inline 模式）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
// 演示词库（CONFIG）
// key 是检索词（中英别名都放进来），value 是发出去的正文。
// 换成自己的内容即可：商品目录、FAQ、文档索引、频道导航都行。
// ============================================================
const DICT = {
  webhook: {
    title: "Webhook 是什么",
    text: "Webhook：Telegram 服务器把新消息 POST 到你的 HTTPS 地址，比轮询 getUpdates 省资源，是生产环境标配。",
  },
  kv: {
    title: "Cloudflare KV 是什么",
    text: "KV：Cloudflare 的全球键值存储，读多写少、低延迟，适合存 Bot 的小状态（名单/索引/计数）。",
  },
  token: {
    title: "Bot Token 安全须知",
    text: "Bot Token 只放 Secret、绝不进代码和聊天；泄露后去 @BotFather 用 /revoke 立即重置。",
  },
  stars: {
    title: "Telegram Stars 是什么",
    text: "Stars 是 Telegram 官方虚拟货币，数字商品必须用它收款：sendInvoice 币种填 XTR，用户内购、平台结算。",
  },
  母体: {
    title: "母体 Bot 是什么",
    text: "母体 Bot：一个 Worker 托管 N 个子 Bot。用户交出自己 Bot 的 token，母体加密存储并代设 webhook，按租户配置分发逻辑。",
  },
};

// ============================================================
// 单位换算
// 表驱动：同组单位互转，value 是「折合基准单位」的倍率；温度是仿射变换单独处理。
// 支持写法：<数字> <源单位> <目标单位>，如 10 km mi / 1 gb mb / 5 kg lb。
// ============================================================
const UNIT_GROUPS = [
  {
    base: "m",
    units: {
      mm: 0.001,
      cm: 0.01,
      m: 1,
      km: 1000,
      in: 0.0254,
      ft: 0.3048,
      mi: 1609.344,
    },
  },
  { base: "g", units: { mg: 0.001, g: 1, kg: 1000, lb: 453.592, oz: 28.3495 } },
  {
    base: "B",
    units: {
      b: 1,
      kb: 1000,
      mb: 1000 ** 2,
      gb: 1000 ** 3,
      tb: 1000 ** 4,
      kib: 1024,
      mib: 1024 ** 2,
      gib: 1024 ** 3,
    },
  },
  { base: "s", units: { s: 1, min: 60, h: 3600, d: 86400 } },
];
function convertUnit(q) {
  const m = q.match(/^(-?[\d.]+)\s*([a-zA-Z]+)\s+(?:to\s+)?([a-zA-Z]+)$/);
  if (!m) return null;
  const val = Number(m[1]);
  const from = m[2].toLowerCase();
  const to = m[3].toLowerCase();
  if (from === "c" || from === "f") {
    if (to !== "c" && to !== "f") return null;
    const c = from === "c" ? val : ((val - 32) * 5) / 9;
    const out = to === "c" ? c : (c * 9) / 5 + 32;
    return `${val}°${from.toUpperCase()} = ${fmtNum(out)}°${to.toUpperCase()}`;
  }
  for (const g of UNIT_GROUPS) {
    if (g.units[from] != null && g.units[to] != null) {
      const out = (val * g.units[from]) / g.units[to];
      return `${val} ${from} = ${fmtNum(out)} ${to}`;
    }
  }
  return null;
}
function fmtNum(n) {
  if (!isFinite(n)) return String(n);
  return Math.abs(n) >= 1e12 || (Math.abs(n) < 1e-6 && n !== 0)
    ? n.toExponential(4)
    : String(Math.round(n * 1e8) / 1e8);
}

// ============================================================
// 安全计算器（递归下降，绝不用 eval）
// 支持 + - * / % ^、括号、一元负号、小数。非法输入返回 null。
// ============================================================
function calcExpr(src) {
  const s = src.replace(/\s+/g, "");
  if (!/^[\d.+\-*/%^()]+$/.test(s) || s.length > 100) return null;
  let i = 0;
  function parseExpr() {
    let v = parseTerm();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (s[i] === "*" || s[i] === "/" || s[i] === "%") {
      const op = s[i++];
      const rhs = parseFactor();
      v = op === "*" ? v * rhs : op === "/" ? v / rhs : v % rhs;
    }
    return v;
  }
  function parseFactor() {
    let base = parseUnary();
    if (s[i] === "^") {
      i++;
      return Math.pow(base, parseFactor());
    }
    return base;
  }
  function parseUnary() {
    if (s[i] === "-") {
      i++;
      return -parseUnary();
    }
    if (s[i] === "(") {
      i++;
      const v = parseExpr();
      if (s[i] !== ")") throw new Error("括号不配对");
      i++;
      return v;
    }
    const m = s.slice(i).match(/^\d*\.?\d+/);
    if (!m) throw new Error("数字解析失败");
    i += m[0].length;
    return Number(m[0]);
  }
  try {
    const v = parseExpr();
    if (i !== s.length || !isFinite(v)) return null;
    return v;
  } catch (e) {
    return null;
  }
}

// ============================================================
// Inline 结果组装
// answerInlineQuery 的 results 是文章卡片数组：点卡片 = 把 message_text 发进当前聊天。
// id 必须在一次回答内唯一；cache_time 设小一点，工具类结果讲究实时。
// ============================================================
function article(id, title, body, desc) {
  return {
    type: "article",
    id,
    title,
    description: desc || body.slice(0, 80),
    input_message_content: { message_text: body },
  };
}
function buildResults(q) {
  const out = [];
  const query = q.trim();
  if (!query) {
    out.push(
      article(
        "help",
        "🔎 输入关键词搜词库",
        "用法：@Bot 关键词 / 单位换算（如 10 km mi）/ 算式（如 1+2*3）/ ts 看时间戳",
      ),
      article(
        "ts",
        "🕐 当前时间戳",
        `当前时间戳：${Math.floor(Date.now() / 1000)}`,
      ),
    );
    return out;
  }
  // 时间戳
  if (query.toLowerCase() === "ts") {
    const now = Math.floor(Date.now() / 1000);
    out.push(
      article(
        "ts",
        `🕐 ${now}`,
        `时间戳：${now}\n北京时间：${new Date(now * 1000 + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19)}`,
      ),
    );
    return out;
  }
  if (/^\d{10,13}$/.test(query)) {
    const sec =
      query.length === 13 ? Math.floor(Number(query) / 1000) : Number(query);
    const bj = new Date(sec * 1000 + 8 * 3600 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    out.push(
      article("ts2", `🕐 ${query} → ${bj}`, `时间戳 ${query} = 北京时间 ${bj}`),
    );
    return out;
  }
  // 单位换算
  const conv = convertUnit(query);
  if (conv) out.push(article("conv", `🔁 ${conv}`, conv));
  // 计算器（含运算符且不是换算式时才算）
  if (/[+\-*/%^]/.test(query) && !conv) {
    const v = calcExpr(query);
    if (v !== null)
      out.push(
        article(
          "calc",
          `🧮 ${query} = ${fmtNum(v)}`,
          `${query} = ${fmtNum(v)}`,
        ),
      );
  }
  // 词库搜索（标题或正文命中）
  const kw = query.toLowerCase();
  let n = 0;
  for (const [key, item] of Object.entries(DICT)) {
    if (
      key.includes(kw) ||
      item.title.toLowerCase().includes(kw) ||
      item.text.toLowerCase().includes(kw)
    ) {
      out.push(article("dict" + n++, `📖 ${item.title}`, item.text));
    }
  }
  if (!out.length)
    out.push(
      article(
        "none",
        "🤷 没找到",
        `「${query}」没有匹配结果。试试：webhook、10 km mi、1+2*3、ts`,
      ),
    );
  return out.slice(0, 20);
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [{ command: "start", description: "使用说明" }];
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
// /setWebhook 时 allowed_updates 必须带 inline_query，否则 @ 调用永远不到达。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("inline-tools bot is running.", {
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
        allowed_updates: ["message", "inline_query"],
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
// inline_query 是主角；普通消息只回 /start 说明（引导去任意聊天 @ 它）。
// ============================================================
async function handle(env, update) {
  const iq = update.inline_query;
  if (iq) {
    return tg(env, "answerInlineQuery", {
      inline_query_id: iq.id,
      results: buildResults(iq.query || ""),
      cache_time: 5,
      is_personal: true,
    });
  }
  const msg = update.message;
  if (!msg) return;
  const text = (msg.text || "").trim();
  if (text.startsWith("/start") || text.startsWith("/help"))
    return send(
      env,
      msg.chat.id,
      "🧰 Inline 工具 Bot\n\n去任意聊天输入框打 @本Bot用户名 + 内容即可：\n· 关键词：搜内置词库（如 webhook）\n· 10 km mi：单位换算\n· 1+2*3：计算器\n· ts：当前时间戳；发纯数字时间戳转日期\n\n⚠️ 没反应？管理员要先去 @BotFather /setinline 开启 Inline 模式。",
    );
}
