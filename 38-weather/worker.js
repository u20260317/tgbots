// ============================================================
// 38 天气 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 查天气：/tq 北京（或直接发城市名），返回当前天气 + 未来 3 天预报。
// 订阅：/sub 北京 订阅每日预报，Cron 触发时把当天预报推给所有订阅者；
// /unsub 退订，/mysub 看我的订阅。
// 数据源：Open-Meteo（免费、无需 Key）：地理编码 API 查经纬度 + 预报 API。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（存订阅 wx:sub:<用户ID>）。
// ⚠️ 每日推送要给 Worker 加 Cron Trigger（如 0 23 * * * = UTC 23:00 = 北京 7:00），
// 每次 scheduled 触发就给全部订阅者发当天预报；不配 Cron 也能用查询功能。
// 键设计：wx:sub:<用户ID> = { name, lat, lon, chat}，一人一城（改订阅直接覆盖）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 19（外部 API 调用）+ 模块 09（Cron）+ 模块 01（骨架）
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
// Open-Meteo 数据层
// 地理编码：城市名 → 经纬度（取第一个结果，带中文名匹配）。
// 预报：current 当前况 + daily 未来 3 天（最高/最低温、降水概率）。
// WMO 天气代码 → 中文描述对照表（Open-Meteo 用的就是 WMO code）。
// ============================================================
const WMO = {
  0: "☀️ 晴",
  1: "🌤️ 大部晴朗",
  2: "⛅ 多云",
  3: "☁️ 阴",
  45: "🌫️ 雾",
  48: "🌫️ 雾凇",
  51: "🌦️ 小毛毛雨",
  53: "🌦️ 毛毛雨",
  55: "🌦️ 浓毛毛雨",
  56: "🌧️ 冻毛毛雨",
  57: "🌧️ 冻毛毛雨",
  61: "🌧️ 小雨",
  63: "🌧️ 中雨",
  65: "🌧️ 大雨",
  66: "🌧️ 冻雨",
  67: "🌧️ 冻雨",
  71: "🌨️ 小雪",
  73: "🌨️ 中雪",
  75: "🌨️ 大雪",
  77: "🌨️ 雪粒",
  80: "🌦️ 小阵雨",
  81: "🌦️ 阵雨",
  82: "⛈️ 暴雨",
  85: "🌨️ 小阵雪",
  86: "🌨️ 阵雪",
  95: "⛈️ 雷阵雨",
  96: "⛈️ 雷雨+冰雹",
  99: "⛈️ 雷雨+冰雹",
};
const wmoText = (code) => WMO[code] || `天气代码 ${code}`;
async function geocode(city) {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const r = await fetch(u);
  const data = await r.json().catch(() => ({}));
  const hit = data?.results?.[0];
  if (!hit) return null;
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(" · "),
    lat: hit.latitude,
    lon: hit.longitude,
    tz: hit.timezone || "Asia/Shanghai",
  };
}
async function forecast(place) {
  const u =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(place.tz)}&forecast_days=3`;
  const r = await fetch(u);
  const data = await r.json().catch(() => ({}));
  if (!data.current || !data.daily) throw new Error("预报接口返回异常");
  return data;
}
function forecastText(place, data) {
  const c = data.current;
  const d = data.daily;
  const lines = [
    `🌍 ${place.name}`,
    `现在：${wmoText(c.weather_code)} ${c.temperature_2m}°C（体感 ${c.apparent_temperature}°C）`,
    `湿度 ${c.relative_humidity_2m}% · 风速 ${c.wind_speed_10m} km/h`,
    "",
  ];
  for (let i = 0; i < d.time.length; i++) {
    const label = i === 0 ? "今天" : i === 1 ? "明天" : "后天";
    lines.push(
      `${label} ${d.time[i].slice(5)}：${wmoText(d.weather_code[i])} ${d.temperature_2m_min[i]}~${d.temperature_2m_max[i]}°C，降水概率 ${d.precipitation_probability_max?.[i] ?? "-"}%`,
    );
  }
  return lines.join("\n");
}
async function weatherOf(city) {
  const place = await geocode(city);
  if (!place) return null;
  const data = await forecast(place);
  return { place, text: forecastText(place, data) };
}

// ============================================================
// 订阅存储与每日推送（KV + Cron）
// wx:sub:<用户ID> = { name, lat, lon, tz, chat}
// scheduled 每次触发：扫全部订阅 → 拉各自城市预报 → 推送。
// 推送失败（用户拉黑 Bot 等）自动退订，避免每轮白跑。
// ============================================================
async function pushDaily(env) {
  const list = await env.BOT_KV.list({ prefix: "wx:sub:", limit: 1000 });
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const sub = JSON.parse(raw);
    try {
      const data = await forecast(sub);
      const r = await send(
        env,
        sub.chat,
        `🌅 每日预报\n${forecastText(sub, data)}`,
      );
      if (!r.ok && r.error_code === 403) await env.BOT_KV.delete(k.name);
    } catch (e) {
      // 单个订阅失败不中断整轮
    }
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "tq", description: "查天气，如 /tq 北京" },
  { command: "sub", description: "订阅每日预报，如 /sub 北京" },
  { command: "unsub", description: "退订每日预报" },
  { command: "mysub", description: "我的订阅" },
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
// fetch 管查询/订阅命令，scheduled 管每日推送。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("weather bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(pushDaily(env));
  },
};

// ============================================================
// 业务主流程
// /tq 查、直接发城市名也查；/sub 订阅（先地理编码验证城市存在再落库）。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const arg = text.replace(/^\/(tq|sub)(@\w+)?\s*/, "").trim();

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🌦️ 天气 Bot（数据：Open-Meteo，免费）\n\n/tq 北京 查天气（直接发城市名也可以）\n/sub 北京 订阅每日预报\n/unsub 退订 · /mysub 看订阅",
    );

  if (cmd === "/tq" || (!text.startsWith("/") && text.length <= 20)) {
    const city = cmd === "/tq" ? arg : text;
    if (!city) return send(env, chatId, "用法：/tq 城市名，如 /tq 上海");
    try {
      const w = await weatherOf(city);
      if (!w)
        return send(
          env,
          chatId,
          `🤔 没找到「${city}」，换个城市名试试（如 上海、Tokyo）。`,
        );
      return send(env, chatId, w.text);
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 天气接口出错：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (!env.BOT_KV && (cmd === "/sub" || cmd === "/unsub" || cmd === "/mysub"))
    return send(
      env,
      chatId,
      "⚠️ 订阅功能需要先绑定 KV（变量名 BOT_KV）。查询 /tq 不受影响。",
    );

  if (cmd === "/sub") {
    if (!arg) return send(env, chatId, "用法：/sub 城市名，如 /sub 北京");
    const place = await geocode(arg).catch(() => null);
    if (!place)
      return send(
        env,
        chatId,
        `🤔 没找到「${arg}」，先用 /tq 验证一下城市名。`,
      );
    await env.BOT_KV.put(
      "wx:sub:" + msg.from.id,
      JSON.stringify({ ...place, chat: chatId }),
    );
    return send(
      env,
      chatId,
      `✅ 已订阅 ${place.name} 的每日预报。\n推送时间由 Worker 的 Cron 决定（推荐北京 7:00）。/unsub 可退订。`,
    );
  }

  if (cmd === "/unsub") {
    await env.BOT_KV.delete("wx:sub:" + msg.from.id);
    return send(env, chatId, "🔕 已退订每日预报。");
  }

  if (cmd === "/mysub") {
    const raw = await env.BOT_KV.get("wx:sub:" + msg.from.id);
    if (!raw) return send(env, chatId, "你还没有订阅。/sub 城市名 订阅一个。");
    const sub = JSON.parse(raw);
    return send(
      env,
      chatId,
      `📍 当前订阅：${sub.name}\n/unsub 退订，/sub 其他城市 可换订。`,
    );
  }
}
