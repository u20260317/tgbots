// ============================================================
// 68 机票 / 旅行助手 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 航班查询：/fly CA1837 查航班状态（接了航班 API 就回真实数据，
// 没接就给 FlightAware/飞常准查询链接兜底，不编造状态）。
// 低价提醒：/watch PEK SHA 800 订阅航线最高价，联盟票价 API 有
// 低于阈值的票时推送（PRICE_API_URL 可配，未配时订阅只存不查）。
// 行程单：/trip add 2026-12-01 08:30 CA1837 北京→上海 手动录入
// 行程，起飞前 3 小时 Cron 提醒；/trip 看行程。
// ⚠️ 诚实边界：机票比价/库存是联盟 API 生意（Travelpayouts 等），
// 没有免费全量票价源；本 Bot 只做订阅、提醒与跳转出票，不卖票。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// FLIGHT_API_URL / FLIGHT_API_KEY 航班状态 API 适配位（通用 GET 口径）
// PRICE_API_URL / PRICE_API_KEY 联盟票价 API 适配位（通用 GET 口径）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：trip:<用户ID> = {trips:[行程], watches:[低价订阅]}。
// 时间约定：录入与提醒都按北京时间（UTC+8）算，README 里写明。
// ⚠️ 提醒/低价轮询要给 Worker 加 Cron Trigger（如 */15 * * * *）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 19（外部 API）+ 模块 09（Cron）+ 模块 01（骨架）
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
// 航班状态查询（适配位）
// 通用口径：GET {FLIGHT_API_URL}?flight=<航班号>，期望 JSON 含
// status / dep / arr / depTime / arrTime 等字段（防御式读取，
// FlightAware AeroAPI 等真实接口字段不同，接的时候改这一个函数）。
// 未配置时返回 null，命令层走查询链接兜底。
// ============================================================
async function queryFlight(env, flightNo) {
  if (!env.FLIGHT_API_URL) return null;
  const u = `${env.FLIGHT_API_URL}${env.FLIGHT_API_URL.includes("?") ? "&" : "?"}flight=${encodeURIComponent(flightNo)}`;
  const r = await fetch(u, {
    headers: env.FLIGHT_API_KEY
      ? { Authorization: `Bearer ${env.FLIGHT_API_KEY}` }
      : {},
  });
  if (!r.ok) throw new Error(`航班接口 HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  const f = d.flight || d.data || d;
  return {
    status: f.status || f.state || "未知",
    dep: f.dep || f.origin || f.from || "",
    arr: f.arr || f.destination || f.to || "",
    depTime: f.depTime || f.scheduledDeparture || "",
    arrTime: f.arrTime || f.scheduledArrival || "",
  };
}
const flightLinks = (no) => ({
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "🛰️ FlightAware 查",
          url: `https://www.flightaware.com/live/flight/${encodeURIComponent(no.replace(/\s+/g, ""))}`,
        },
        {
          text: "✈️ 飞常准查",
          url: `https://www.variflight.com/flight/${encodeURIComponent(no.replace(/\s+/g, ""))}`,
        },
      ],
    ],
  },
});

// ============================================================
// 用户数据（行程单 + 低价订阅，一人一份记录）
// trip:<用户ID> = { trips: [{text, at, reminded}], watches:
// [{from, to, max, lastAlert}] }。时间戳统一存 UTC 毫秒，
// 录入的「2026-12-01 08:30」按北京时间解析。
// ============================================================
async function getData(env, uid) {
  const raw = await env.BOT_KV.get("trip:" + uid);
  return raw ? JSON.parse(raw) : { trips: [], watches: [] };
}
async function saveData(env, uid, data) {
  await env.BOT_KV.put("trip:" + uid, JSON.stringify(data));
}
function parseBeijingTime(s) {
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
}
const fmtBJ = (ts) =>
  new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");

// ============================================================
// Cron 轮询：起飞提醒 + 低价监控
// 起飞提醒：行程在未来 3 小时内且没提醒过 → 推一条并标记；
// 已过期 24 小时的行程自动清掉。
// 低价监控：PRICE_API_URL 未配直接跳过（命令侧已说明只存不查）；
// 配了就按航线查价，低于阈值且与上次提醒价不同才推，防重复骚扰。
// ============================================================
async function queryPrice(env, w) {
  const u = `${env.PRICE_API_URL}${env.PRICE_API_URL.includes("?") ? "&" : "?"}from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;
  const r = await fetch(u, {
    headers: env.PRICE_API_KEY
      ? { Authorization: `Bearer ${env.PRICE_API_KEY}` }
      : {},
  });
  if (!r.ok) throw new Error(`票价接口 HTTP ${r.status}`);
  const d = await r.json().catch(() => ({}));
  const item = d.data || d.result || d;
  return { price: Number(item.price), url: item.url || item.link || "" };
}
async function pollTravel(env) {
  const list = await env.BOT_KV.list({ prefix: "trip:", limit: 1000 });
  const now = Date.now();
  for (const k of list.keys) {
    const uid = k.name.slice(5);
    const data = await getData(env, uid);
    let changed = false;
    for (const t of data.trips) {
      if (!t.reminded && t.at - now > 0 && t.at - now <= 3 * 3600 * 1000) {
        await send(
          env,
          Number(uid),
          `✈️ 行程提醒（起飞前 3 小时内）\n${t.text}\n时间：${fmtBJ(t.at)}（北京时间）\n建议提前到机场，值机愉快！`,
        );
        t.reminded = true;
        changed = true;
      }
    }
    const before = data.trips.length;
    data.trips = data.trips.filter((t) => t.at > now - 24 * 3600 * 1000);
    if (data.trips.length !== before) changed = true;
    if (env.PRICE_API_URL) {
      for (const w of data.watches) {
        try {
          const p = await queryPrice(env, w);
          if (p.price > 0 && p.price <= w.max && p.price !== w.lastAlert) {
            w.lastAlert = p.price;
            changed = true;
            await send(
              env,
              Number(uid),
              `💰 低价提醒：${w.from} → ${w.to} 出现 ¥${p.price}（你的阈值 ¥${w.max}）`,
              p.url
                ? {
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: "🎫 去看看/出票", url: p.url }],
                      ],
                    },
                  }
                : {},
            );
          }
        } catch (e) {
          // 单条航线查价失败不中断整轮
        }
      }
    }
    if (changed) await saveData(env, uid, data);
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "fly", description: "查航班，如 /fly CA1837" },
  { command: "watch", description: "低价订阅，如 /watch PEK SHA 800" },
  { command: "watches", description: "我的低价订阅" },
  { command: "trip", description: "行程单，如 /trip add 日期 时间 内容" },
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
      return new Response("travel-assistant bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(pollTravel(env));
  },
};

// ============================================================
// 业务主流程
// /fly 查航班；/watch|/watches|/unwatch 低价订阅；/trip 行程单。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const parts = text.split(/\s+/);
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🧳 机票 / 旅行助手\n\n/fly CA1837 查航班状态\n/watch PEK SHA 800 订阅航线低价（出发/到达用三字码，800 是最高价）\n/trip add 2026-12-01 08:30 CA1837 北京→上海 录行程，起飞前 3 小时提醒\n/trip 看行程 · /watches 看低价订阅\n\n时间都按北京时间算。",
    );
  if (!env.BOT_KV && ["/watch", "/watches", "/unwatch", "/trip"].includes(cmd))
    return send(
      env,
      chatId,
      "⚠️ 订阅/行程功能需要先绑定 KV（变量名 BOT_KV）。/fly 查询不受影响。",
    );

  if (cmd === "/fly") {
    const no = (parts[1] || "").toUpperCase();
    if (!no) return send(env, chatId, "用法：/fly 航班号，如 /fly CA1837");
    try {
      const f = await queryFlight(env, no);
      if (!f)
        return send(
          env,
          chatId,
          `✈️ ${no}：管理员还没接航班数据 API，我没法直接给状态。点下面按钮去权威源查（实时准确）：`,
          flightLinks(no),
        );
      return send(
        env,
        chatId,
        `✈️ ${no}\n状态：${f.status}\n${f.dep} → ${f.arr}\n起飞：${f.depTime || "?"} · 到达：${f.arrTime || "?"}`,
      );
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 航班接口出错，先用链接查：${String(e.message || e).slice(0, 100)}`,
        flightLinks(no),
      );
    }
  }

  if (cmd === "/watch") {
    const from = (parts[1] || "").toUpperCase();
    const to = (parts[2] || "").toUpperCase();
    const max = Number(parts[3]);
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || !max)
      return send(
        env,
        chatId,
        "用法：/watch 出发三字码 到达三字码 最高价，如 /watch PEK SHA 800",
      );
    const data = await getData(env, uid);
    if (data.watches.some((w) => w.from === from && w.to === to))
      return send(
        env,
        chatId,
        "这条航线已经订阅了，/watches 查看，/unwatch 取消。",
      );
    data.watches.push({ from, to, max, lastAlert: 0 });
    await saveData(env, uid, data);
    return send(
      env,
      chatId,
      `✅ 已订阅 ${from} → ${to} 低价（≤ ¥${max}）。` +
        (env.PRICE_API_URL
          ? "有低价票会第一时间推你。"
          : "\n⚠️ 但管理员还没配置 PRICE_API_URL（联盟票价 API），目前只存不查、不会推送——配好前别以为在盯价了。申请办法见 README。"),
    );
  }
  if (cmd === "/watches") {
    const data = await getData(env, uid);
    if (!data.watches.length)
      return send(env, chatId, "你还没有低价订阅。/watch PEK SHA 800 订一个。");
    return send(
      env,
      chatId,
      "💰 我的低价订阅：\n" +
        data.watches
          .map((w) => `· ${w.from} → ${w.to} ≤ ¥${w.max}`)
          .join("\n") +
        "\n\n取消：/unwatch 出发 到达",
    );
  }
  if (cmd === "/unwatch") {
    const from = (parts[1] || "").toUpperCase();
    const to = (parts[2] || "").toUpperCase();
    const data = await getData(env, uid);
    const next = data.watches.filter((w) => !(w.from === from && w.to === to));
    if (next.length === data.watches.length)
      return send(env, chatId, "没找到这条订阅，/watches 看确切写法。");
    data.watches = next;
    await saveData(env, uid, data);
    return send(env, chatId, `🔕 已取消 ${from} → ${to} 的低价订阅。`);
  }

  if (cmd === "/trip") {
    const sub = (parts[1] || "list").toLowerCase();
    const data = await getData(env, uid);
    if (sub === "add") {
      const rest = text.replace(/^\/trip(@\w+)?\s+add\s*/i, "");
      const at = parseBeijingTime(rest);
      if (!at)
        return send(
          env,
          chatId,
          "用法：/trip add 2026-12-01 08:30 CA1837 北京→上海\n（日期时间必须写全，按北京时间算）",
        );
      if (at < Date.now())
        return send(env, chatId, "这个时间已经过去了，检查下日期？");
      const label =
        rest.replace(/\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}/, "").trim() ||
        "行程";
      data.trips.push({ text: label, at, reminded: false });
      data.trips.sort((a, b) => a.at - b.at);
      await saveData(env, uid, data);
      return send(
        env,
        chatId,
        `✅ 已录入行程：${label}\n时间：${fmtBJ(at)}（北京时间），起飞前 3 小时内会提醒你。`,
      );
    }
    if (sub === "del") {
      const n = Number(parts[2]);
      if (!n || n < 1 || n > data.trips.length)
        return send(env, chatId, "用法：/trip del 序号（序号见 /trip 列表）");
      const [gone] = data.trips.splice(n - 1, 1);
      await saveData(env, uid, data);
      return send(env, chatId, `🗑️ 已删除行程：${gone.text}`);
    }
    if (!data.trips.length)
      return send(
        env,
        chatId,
        "你还没有行程。/trip add 日期 时间 内容 录一个。",
      );
    return send(
      env,
      chatId,
      "🧳 我的行程（北京时间）：\n" +
        data.trips
          .map((t, i) => `${i + 1}. ${fmtBJ(t.at)} · ${t.text}`)
          .join("\n") +
        "\n\n删除：/trip del 序号",
    );
  }
}
