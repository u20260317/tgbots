// ============================================================
// 25 记账 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 玩法：在会话里一句话记一笔账，账本按「会话」隔离——群里用就是全群
// 共享账本（AA/活动经费），私聊用就是个人账本。按月分键存，查账单
// 自动汇总本月收入、支出和结余。
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET、TZ_OFFSET（按哪个时区切月份，默认 8=北京）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV
// （键：ledger:<会话ID>:<YYYY-MM> 存当月 entries 数组）。
// 用法：
// 记账 -25 午餐 （支出 25；不写符号也算支出）
// 记账 +8000 工资 （收入 8000；也可用 /jz 代替「记账」）
// /账单 本月明细+汇总 · /账单 2026-10 指定月份
// /删账 编号 删除本月账单里的一条（编号见 /账单）
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
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""}`;
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const tzDate = (env, ts = Date.now()) =>
  new Date(ts + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000);
const monthOf = (env, ts = Date.now()) =>
  tzDate(env, ts).toISOString().slice(0, 7);
const fmtAmt = (n) => (Math.round(n * 100) / 100).toString();

// ============================================================
// 【核心模块】账本存储（KV）
// ledger:<会话ID>:<YYYY-MM> = [{ id, amt(带符号), note, by, byId, t }]
// 按会话+月份分键：查月账单只读一条记录，群账本和个人账本天然隔离。
// ============================================================
async function getEntries(env, chatId, month) {
  const raw = await env.BOT_KV.get(`ledger:${chatId}:${month}`);
  return raw ? JSON.parse(raw) : [];
}
async function putEntries(env, chatId, month, entries) {
  await env.BOT_KV.put(`ledger:${chatId}:${month}`, JSON.stringify(entries));
}
function billText(env, month, entries) {
  if (!entries.length)
    return `🧾 ${month} 还没有账目。\n记一笔：记账 -25 午餐 / 记账 +8000 工资`;
  let inc = 0,
    out = 0;
  const lines = entries.map((e) => {
    if (e.amt >= 0) inc += e.amt;
    else out += -e.amt;
    const d = tzDate(env, e.t);
    const when = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    return `#${e.id} ${when} ${e.amt >= 0 ? "+" : "-"}${fmtAmt(Math.abs(e.amt))} ${e.note || ""}（${e.by}）`;
  });
  return `🧾 ${month} 账单（共 ${entries.length} 笔）\n\n${lines.join("\n")}\n\n收入 +${fmtAmt(inc)} · 支出 -${fmtAmt(out)} · 结余 ${fmtAmt(inc - out)}\n删账：/删账 编号`;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
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
const COMMANDS_USER = [
  { command: "jz", description: "记一笔账，如 /jz -25 午餐" },
  { command: "bill", description: "查看账单" },
];
const COMMANDS_ADMIN = [];
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
      return new Response("ledger bot is running.", {
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
};

// ============================================================
// 【核心模块】业务主流程
// 记账（「记账」或 /jz 开头，金额带 +/-，无符号默认支出）-> /账单 汇总 -> /删账 按编号删。
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
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;
  const cmd = text.split(/\s+/)[0].split("@")[0];

  // ---------- 记一笔 ----------
  const jm = text.match(
    /^(?:记账|\/jz(?:@\w+)?)\s+([+-]?\d+(?:\.\d+)?)\s*([\s\S]*)$/,
  );
  if (jm) {
    let amt = Number(jm[1]);
    if (!/^[+-]/.test(jm[1])) amt = -Math.abs(amt); // 无符号默认支出
    if (!amt)
      return send(
        env,
        chatId,
        "金额不能是 0。用法：记账 -25 午餐 / 记账 +8000 工资",
      );
    const month = monthOf(env);
    const entries = await getEntries(env, chatId, month);
    const entry = {
      id: newId(),
      amt,
      note: jm[2].trim(),
      by: who(msg.from),
      byId: msg.from.id,
      t: Date.now(),
    };
    entries.push(entry);
    await putEntries(env, chatId, month, entries);
    let inc = 0,
      out = 0;
    for (const e of entries) {
      if (e.amt >= 0) inc += e.amt;
      else out += -e.amt;
    }
    return send(
      env,
      chatId,
      `✅ 已记账 #${entry.id}：${amt >= 0 ? "+" : "-"}${fmtAmt(Math.abs(amt))} ${entry.note}\n本月结余 ${fmtAmt(inc - out)}（收入 ${fmtAmt(inc)} / 支出 ${fmtAmt(out)}）`,
    );
  }

  // ---------- 查账单 ----------
  if (cmd === "/账单" || cmd === "/bill") {
    const arg = text.split(/\s+/)[1];
    const month = /^\d{4}-\d{2}$/.test(arg || "") ? arg : monthOf(env);
    const entries = await getEntries(env, chatId, month);
    return send(env, chatId, billText(env, month, entries));
  }

  // ---------- 删账 ----------
  if (cmd === "/删账" || cmd === "/delbill") {
    const id = (text.split(/\s+/)[1] || "").replace(/^#/, "");
    if (!id)
      return send(
        env,
        chatId,
        "用法：/删账 编号（编号见 /账单，只能删本月的）",
      );
    const month = monthOf(env);
    const entries = await getEntries(env, chatId, month);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return send(env, chatId, `本月账单里没找到 #${id}。`);
    const [gone] = entries.splice(idx, 1);
    await putEntries(env, chatId, month, entries);
    return send(
      env,
      chatId,
      `🗑 已删除 #${id}：${gone.amt >= 0 ? "+" : "-"}${fmtAmt(Math.abs(gone.amt))} ${gone.note}`,
    );
  }

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🧾 记账 Bot\n记账 -25 午餐（支出，不写符号也算支出）\n记账 +8000 工资（收入）\n/账单 本月明细+汇总 · /账单 2026-10 查指定月\n/删账 编号 删一条\n群里用是全群共享账本，私聊用是个人账本。",
    );
}
