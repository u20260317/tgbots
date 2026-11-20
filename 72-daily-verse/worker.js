// ============================================================
// 72 每日经文 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// /verse 按日期轮换推送一句经文（本地公版译本种子库，CONFIG 分库：
// bible 圣经 / quran 古兰经，可自行增删替换文本）；/pray 查礼拜时间
// （Aladhan 免费 API 按城市查，未配置城市时给通用提示）；订阅后
// Cron 每天定时推送当天经文。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// PRAY_CITY / PRAY_COUNTRY 默认礼拜城市（如 Beijing / China），
// 用户也可用 /pray <城市> <国家> 临时查、/setcity 记住自己的城市
// ADMIN_ID 管理员数字 ID（看 /vstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV（存用户偏好与订阅）。
// 键设计：verse:pref:<用户ID> = {faith, city, country}；
// verse:sub:<用户ID> = {chat, faith}。
// ⚠️ 需要 Cron：Triggers 加一条（如每天 0 0 * * * UTC = 北京 8 点）。
// 内容说明：种子库只收录公有领域译本的短句（圣经和合本 1919 年版、
// 古兰经马坚译本均已进入公版），部署者可整体替换为自有文本库。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 09（Cron）+ 模块 19（外部 API）+ 模块 01/02（骨架与菜单）
// ============================================================

// ============================================================
// 经文库（本地种子，按 faith 分库）
// 一天一句：用「一年中的第几天 % 库长度」取句，全年轮换不重样
// （库不够 365 条时会循环，属预期）。想扩库直接往数组里加，
// 想换译本整体替换字符串即可——这是内容不是代码，放手改。
// ============================================================
const VERSES = {
  bible: [
    { t: "起初，神创造天地。", r: "创世记 1:1" },
    { t: "耶和华是我的牧者，我必不致缺乏。", r: "诗篇 23:1" },
    {
      t: "你们要先求他的国和他的义，这些东西都要加给你们了。",
      r: "马太福音 6:33",
    },
    { t: "我靠着那加给我力量的，凡事都能做。", r: "腓立比书 4:13" },
    {
      t: "爱是恒久忍耐，又有恩慈；爱是不嫉妒，爱是不自夸，不张狂。",
      r: "哥林多前书 13:4",
    },
    { t: "喜乐的心乃是良药；忧伤的灵使骨枯干。", r: "箴言 17:22" },
    { t: "你要专心仰赖耶和华，不可倚靠自己的聪明。", r: "箴言 3:5" },
    {
      t: "神爱世人，甚至将他的独生子赐给他们，叫一切信他的，不致灭亡，反得永生。",
      r: "约翰福音 3:16",
    },
  ],
  quran: [
    { t: "奉至仁至慈的真主之名。", r: "开端章 1:1" },
    { t: "真主是天地的光明。", r: "光明章 24:35" },
    { t: "与艰难相伴的，确是容易。", r: "开拓章 94:6" },
    {
      t: "你们当纪念我，我就纪念你们；你们当感谢我，不要孤负我。",
      r: "黄牛章 2:152",
    },
    { t: "谁敬畏真主，他将为谁开辟一条出路。", r: "离婚章 65:2" },
    { t: "他创造了万物，并使各物匀称。", r: "至尊章 87:2" },
  ],
};
const FAITH_NAME = {
  bible: "📖 圣经（和合本）",
  quran: "☪️ 古兰经（马坚译本）",
};
function verseOfDay(faith) {
  const lib = VERSES[faith] || VERSES.bible;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const doy = Math.floor((now.getTime() - start) / 86400000);
  return lib[doy % lib.length];
}

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

async function getPref(env, uid) {
  const raw = await env.BOT_KV.get("verse:pref:" + uid);
  return raw ? JSON.parse(raw) : { faith: "bible", city: "", country: "" };
}
async function savePref(env, uid, pref) {
  await env.BOT_KV.put("verse:pref:" + uid, JSON.stringify(pref));
}

// ============================================================
// 礼拜时间（Aladhan 免费 API）
// GET https://api.aladhan.com/v1/timingsByCity?city=&country=&method=
// 免 key。城市/国家用英文名（Beijing/China）。没配城市时不硬查，
// 回通用提示让用户先 /setcity——宁可不查也不能编时间。
// ============================================================
async function prayerTimes(city, country) {
  const u = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=2`;
  const r = await fetch(u);
  const data = await r.json().catch(() => ({}));
  const t = data?.data?.timings;
  if (!r.ok || !t) throw new Error("Aladhan 查询失败");
  const rows = [
    ["晨礼 Fajr", t.Fajr],
    ["日出 Sunrise", t.Sunrise],
    ["晌礼 Dhuhr", t.Dhuhr],
    ["晡礼 Asr", t.Asr],
    ["昏礼 Maghrib", t.Maghrib],
    ["宵礼 Isha", t.Isha],
  ];
  return rows.map(([n, v]) => `${n}：${String(v).slice(0, 5)}`).join("\n");
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集，
// 管理员命令只出现在管理员私聊菜单里。菜单隐藏只是体验层，
// 真正拦截靠业务里每个管理员命令的 isAdmin 判断，两层缺一不可。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "verse", description: "今日经文" },
  { command: "pray", description: "今日礼拜时间" },
  { command: "setcity", description: "设置我的城市 /setcity Beijing China" },
  { command: "faith", description: "选择经文库" },
  { command: "subverse", description: "订阅每日经文推送" },
  { command: "unsubverse", description: "退订每日推送" },
];
const COMMANDS_ADMIN = [
  { command: "vstats", description: "订阅统计（管理员）" },
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
// 健康检查、/setWebhook 一键挂载、Webhook 密钥校验、更新分发；
// scheduled 是 Cron 入口：每天把当天经文推给全部订阅者。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("daily-verse bot is running.", {
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
    ctx.waitUntil(pushDaily(env));
  },
};

// ============================================================
// 每日推送（Cron）
// 扫 verse:sub: 全部订阅，按各自选的 faith 推当天经文；
// 推送失败（用户拉黑等）自动退订，避免每轮白跑。
// ============================================================
async function pushDaily(env) {
  if (!env.BOT_KV) return;
  const list = await env.BOT_KV.list({ prefix: "verse:sub:", limit: 1000 });
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const sub = JSON.parse(raw);
    const v = verseOfDay(sub.faith || "bible");
    const r = await send(
      env,
      sub.chat,
      `🌅 今日经文 · ${FAITH_NAME[sub.faith || "bible"]}\n\n${v.t}\n—— ${v.r}`,
    );
    if (!r.ok) await env.BOT_KV.delete(k.name);
  }
}

// ============================================================
// 业务主流程
// /verse 今日经文；/faith 按钮换库（回调 verse:faith:<库>）；
// /pray 礼拜时间（参数城市 > 个人设置 > 环境默认 > 提示先设置）；
// /subverse、/unsubverse 管订阅；/vstats 管理员统计。
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
    if (!data.startsWith("verse:faith:")) return;
    const faith = data.split(":")[2];
    if (!VERSES[faith]) return;
    const pref = await getPref(env, cq.from.id);
    pref.faith = faith;
    await savePref(env, cq.from.id, pref);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `已切换到 ${FAITH_NAME[faith]}`,
    });
    const v = verseOfDay(faith);
    return send(
      env,
      cq.message.chat.id,
      `今日经文 · ${FAITH_NAME[faith]}\n\n${v.t}\n—— ${v.r}`,
    );
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
      "🕊️ 每日经文 Bot\n\n/verse 看今日经文（按日期轮换）\n/faith 切换经文库（圣经 / 古兰经）\n/pray 查今日礼拜时间（先用 /setcity Beijing China 设置城市）\n/subverse 订阅每日推送，/unsubverse 退订\n\n经文均取自公有领域译本，文本库可由部署者自行替换。",
    );

  if (cmd === "/verse") {
    const pref = await getPref(env, uid);
    const v = verseOfDay(pref.faith);
    return send(
      env,
      chatId,
      `今日经文 · ${FAITH_NAME[pref.faith]}\n\n${v.t}\n—— ${v.r}`,
    );
  }

  if (cmd === "/faith") {
    return send(env, chatId, "选择经文库：", {
      reply_markup: {
        inline_keyboard: [
          Object.keys(VERSES).map((f) => ({
            text: FAITH_NAME[f],
            callback_data: `verse:faith:${f}`,
          })),
        ],
      },
    });
  }

  if (cmd === "/setcity") {
    const [, city, country] = parts;
    if (!city || !country)
      return send(
        env,
        chatId,
        "用法：/setcity Beijing China（城市与国家用英文名）",
      );
    const pref = await getPref(env, uid);
    pref.city = city;
    pref.country = country;
    await savePref(env, uid, pref);
    return send(env, chatId, `✅ 已记住你的城市：${city}, ${country}`);
  }

  if (cmd === "/pray") {
    const pref = await getPref(env, uid);
    const city = parts[1] || pref.city || env.PRAY_CITY || "";
    const country = parts[2] || pref.country || env.PRAY_COUNTRY || "";
    if (!city || !country)
      return send(
        env,
        chatId,
        "🕌 还不知道你的城市，没法查礼拜时间。\n先发 /setcity Beijing China 设置，或直接 /pray Beijing China 查询。\n（时间由 Aladhan 免费 API 按城市计算，不同教法学派可能有几分钟差异，请以本地清真寺公告为准。）",
      );
    try {
      const t = await prayerTimes(city, country);
      return send(env, chatId, `🕌 ${city}, ${country} 今日礼拜时间\n\n${t}`);
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 查询失败：${String(e.message || e).slice(0, 150)}。检查一下城市英文名是否正确。`,
      );
    }
  }

  if (cmd === "/subverse") {
    const pref = await getPref(env, uid);
    await env.BOT_KV.put(
      "verse:sub:" + uid,
      JSON.stringify({ chat: chatId, faith: pref.faith }),
    );
    return send(
      env,
      chatId,
      `✅ 已订阅每日经文推送（${FAITH_NAME[pref.faith]}），每天定时送达。/unsubverse 可退订。`,
    );
  }

  if (cmd === "/unsubverse") {
    await env.BOT_KV.delete("verse:sub:" + uid);
    return send(env, chatId, "已退订每日经文推送。");
  }

  if (cmd === "/vstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "verse:sub:", limit: 1000 });
    return send(env, chatId, `📊 每日经文订阅者：${list.keys.length} 人`);
  }
}
