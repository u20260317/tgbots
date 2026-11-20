// ============================================================
// 71 星座运势 / 塔罗 Bot（单文件 · Cloudflare Workers）
// 功能：
// /astro 选星座看每日运势：默认本地种子文案库按「星座+日期」
// 确定性生成（同一天同星座结果稳定，像真正的每日运势）；
// 配了 ASTRO_API_URL 就优先拉外部运势 API，失败自动回落本地。
// /tarot 抽三张牌：22 张大阿卡纳本地牌库（含正/逆位），按钮
// 逐步揭示 过去/现在/未来 三张牌，最后给综合解读。
// ⚠️ 娱乐定位：运势与塔罗均为娱乐内容，不是科学预测；
// /start、每条运势和塔罗解读末尾都带此声明，别删。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ASTRO_API_URL 运势 API 适配位（选填，未配走本地文案库）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// 选填 KV：Bindings 添加 KV，变量名 BOT_KV（存星座偏好 astro:pref:
// 与塔罗会话 tarot:；不绑 KV 时 /astro 能用、/tarot 不能跨步抽牌）。
// 零必需外部 API，部署后访问
// https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 17（配置驱动内容）+ 模块 03（按钮与回调）+ 模块 01（骨架）
// ============================================================

// ============================================================
// 星座与文案库（CONFIG）
// 运势生成 = 确定性种子：hash(星座key + 北京日期) 当种子去文案
// 池里取词，同人同天结果一致、跨天自动变——每日运势的产品感
// 就靠这个。想扩充文案往池子里加句子即可。
// ============================================================
const SIGNS = [
  { key: "aries", name: "白羊座", emoji: "♈", range: "3.21-4.19" },
  { key: "taurus", name: "金牛座", emoji: "♉", range: "4.20-5.20" },
  { key: "gemini", name: "双子座", emoji: "♊", range: "5.21-6.21" },
  { key: "cancer", name: "巨蟹座", emoji: "♋", range: "6.22-7.22" },
  { key: "leo", name: "狮子座", emoji: "♌", range: "7.23-8.22" },
  { key: "virgo", name: "处女座", emoji: "♍", range: "8.23-9.22" },
  { key: "libra", name: "天秤座", emoji: "♎", range: "9.23-10.23" },
  { key: "scorpio", name: "天蝎座", emoji: "♏", range: "10.24-11.22" },
  { key: "sagittarius", name: "射手座", emoji: "♐", range: "11.23-12.21" },
  { key: "capricorn", name: "摩羯座", emoji: "♑", range: "12.22-1.19" },
  { key: "aquarius", name: "水瓶座", emoji: "♒", range: "1.20-2.18" },
  { key: "pisces", name: "双鱼座", emoji: "♓", range: "2.19-3.20" },
];
const POOL = {
  overall: [
    "节奏顺手，适合把拖了很久的小事一口气清掉。",
    "上午有点闷，下午开始转顺，别急着下结论。",
    "适合见人聊事，你的表达比平时更有说服力。",
    "财运和心情都在线，但别冲动消费犒劳自己。",
    "需要一点独处充电，推掉不必要的局不是摆烂。",
    "会有意外的小帮助，留心身边人不经意的一句话。",
    "计划赶不上变化，备选方案今天能救命。",
    "适合学习和整理，脑子比平时清楚。",
  ],
  love: [
    "单身者留意工作场合的新面孔；有伴的适合好好聊聊近况。",
    "别把沉默当冷淡，主动问一句比猜十句强。",
    "旧人旧事可能冒头，平常心对待，别回头太久。",
    "适合表达好感，小动作比大场面更打动人。",
  ],
  work: [
    "推进卡住的项目，先解决最难的那块。",
    "会议上少说多听，今天信息比观点值钱。",
    "适合收尾和归档，别急着开新坑。",
    "和同事协作顺畅，适合分工推进大任务。",
  ],
  money: [
    "正财稳，偏财别碰，冲动下单是大忌。",
    "适合盘点账目，可能发现一笔能省的订阅。",
    "小额进账信号，但别提前透支庆祝。",
    "投资观望为主，今天不适合做大决定。",
  ],
  colors: [
    "砖红",
    "雾蓝",
    "奶油白",
    "墨绿",
    "香槟金",
    "丁香紫",
    "曜石黑",
    "杏黄",
  ],
};

// ============================================================
// 塔罗牌库（22 张大阿卡纳）
// 每张含正位/逆位一句话解读；抽牌用 crypto 随机，会话内不重复。
// ============================================================
const ARCANA = [
  ["愚者", "新的开始、冒险、保持天真", "鲁莽、迟疑、怕迈出第一步"],
  ["魔术师", "资源齐备、行动力、把想法落地", "才华被埋没、计划只停留在嘴上"],
  ["女祭司", "直觉、潜意识、答案在安静里", "忽视直觉、秘密带来的困扰"],
  ["皇后", "丰盛、滋养、创造力开花", "过度付出、创造力枯竭"],
  ["皇帝", "秩序、掌控、把框架立起来", "固执、控制欲、规则束缚"],
  ["教皇", "传统、导师、按规矩来没错", "打破常规、质疑权威"],
  ["恋人", "选择、契合、价值观一致", "犹豫不决、关系失衡"],
  ["战车", "冲劲、胜负欲、方向明确就出发", "失控、方向摇摆"],
  ["力量", "温柔而坚定、以柔克刚", "自我怀疑、耐心不足"],
  ["隐者", "独处、内省、慢下来找答案", "孤僻、逃避社交"],
  ["命运之轮", "转机、顺势而为、运气在转动", "抗拒变化、时运不济时先苟住"],
  ["正义", "公平、因果、把账算清楚", "偏颇、逃避责任"],
  ["倒吊人", "换个角度、暂停也是前进", "无谓牺牲、卡住太久"],
  ["死神", "结束与新生、断舍离的时机", "抗拒结束、拖泥带水"],
  ["节制", "平衡、调和、慢慢来比较快", "失衡、过度消耗"],
  ["恶魔", "欲望、执念、看清什么在绑架你", "挣脱束缚、戒断的开始"],
  ["高塔", "突变、旧结构崩塌、真相揭晓", "避免灾难、恐惧改变"],
  ["星星", "希望、疗愈、长夜之后有光", "失望、信心动摇"],
  ["月亮", "潜意识、不安、别在雾里做决定", "迷雾散开、直觉变准"],
  ["太阳", "成功、快乐、大大方方展示自己", "短暂的阴霾、乐观点总没错"],
  ["审判", "觉醒、召唤、给过去一个交代", "自我怀疑、逃避召唤"],
  ["世界", "圆满、完成、一个阶段的句号", "差临门一脚、收尾别松劲"],
];
const TAROT_POSITIONS = ["过去", "现在", "未来"];

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
const DISCLAIMER = "🎲 娱乐内容，非科学预测，图个乐子，别拿它做人生决策。";

// ============================================================
// 每日运势生成（确定性种子 + 可选外部 API）
// 种子 = 星座 key + 北京日期，hash 后分别取整体星级与各分项
// 文案。配了 ASTRO_API_URL 先拉外部（GET?sign=&date=，期望
// {text} 或分项字段），失败/未配一律回落本地——永远有结果。
// ============================================================
const bjDate = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function localFortune(sign) {
  const seed = hashStr(sign.key + "@" + bjDate());
  const pick = (arr, salt) =>
    arr[hashStr(sign.key + salt + bjDate()) % arr.length];
  const stars = 3 + (seed % 3); // 3-5 星
  return [
    `${sign.emoji} ${sign.name} · ${bjDate()} 每日运势`,
    `整体运势：${"⭐".repeat(stars)}${"☆".repeat(5 - stars)}`,
    pick(POOL.overall, "o"),
    `💗 感情：${pick(POOL.love, "l")}`,
    `💼 事业：${pick(POOL.work, "w")}`,
    `💰 财运：${pick(POOL.money, "m")}`,
    `🍀 幸运数字 ${seed % 100} · 幸运色 ${pick(POOL.colors, "c")}`,
    "",
    DISCLAIMER,
  ].join("\n");
}
async function fortune(env, sign) {
  if (env.ASTRO_API_URL) {
    try {
      const u = `${env.ASTRO_API_URL}${env.ASTRO_API_URL.includes("?") ? "&" : "?"}sign=${encodeURIComponent(sign.key)}&date=${bjDate()}`;
      const r = await fetch(u);
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const text = d.text || d.fortune || d.content;
        if (text)
          return `${sign.emoji} ${sign.name} · ${bjDate()} 每日运势\n${text}\n\n${DISCLAIMER}`;
      }
    } catch (e) {
      // 外部源失败回落本地，不打扰用户
    }
  }
  return localFortune(sign);
}

// ============================================================
// 塔罗抽牌（KV 会话，三步揭示）
// tarot:<uid> = {cards: [{idx, rev}]}；点一次按钮抽一张并原地
// 编辑消息揭示，抽满三张拼综合解读。牌不重复、正逆位各半概率。
// ============================================================
function drawCard(exclude) {
  const rnd = new Uint8Array(2);
  let idx;
  do {
    crypto.getRandomValues(rnd);
    idx = rnd[0] % ARCANA.length;
  } while (exclude.includes(idx));
  return { idx, rev: rnd[1] % 2 === 0 };
}
function tarotText(cards, done) {
  const lines = ["🔮 塔罗三张牌（过去 · 现在 · 未来）", ""];
  cards.forEach((c, i) => {
    const [name, up, rev] = ARCANA[c.idx];
    lines.push(
      `${TAROT_POSITIONS[i]}：${name}（${c.rev ? "逆位" : "正位"}）— ${c.rev ? rev : up}`,
    );
  });
  for (let i = cards.length; i < 3; i++)
    lines.push(`${TAROT_POSITIONS[i]}：❓ 待抽`);
  if (done) {
    const future = ARCANA[cards[2].idx];
    lines.push(
      "",
      `🧭 综合解读：未来的牌落在「${future[0]}」，结合前两张的走势——先处理好「现在」这张牌的课题，未来的门自然会开。`,
      "",
      DISCLAIMER,
    );
  }
  return lines.join("\n");
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "astro", description: "看每日运势（选星座）" },
  { command: "tarot", description: "塔罗抽三张牌" },
  { command: "mysign", description: "我的星座偏好" },
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
      return new Response("horoscope bot is running.", {
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
};

// ============================================================
// 业务主流程
// astro:<key> 选星座（顺手存偏好）；tarot:draw 逐步抽牌。
// ============================================================
const signKeyboard = () => ({
  inline_keyboard: [0, 1, 2].map((row) =>
    SIGNS.slice(row * 4, row * 4 + 4).map((s) => ({
      text: `${s.emoji} ${s.name}`,
      callback_data: `astro:${s.key}`,
    })),
  ),
});

async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    const chatId = cq.message.chat.id;
    const uid = cq.from.id;
    if (data.startsWith("astro:")) {
      const sign = SIGNS.find((s) => s.key === data.slice(6));
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (!sign) return;
      if (env.BOT_KV) await env.BOT_KV.put("astro:pref:" + uid, sign.key);
      return send(env, chatId, await fortune(env, sign));
    }
    if (data === "tarot:draw") {
      if (!env.BOT_KV) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "塔罗需要先绑定 KV",
        });
        return;
      }
      const key = "tarot:" + uid;
      const sess = JSON.parse((await env.BOT_KV.get(key)) || '{"cards":[]}');
      if (sess.cards.length >= 3) sess.cards = [];
      sess.cards.push(drawCard(sess.cards.map((c) => c.idx)));
      const done = sess.cards.length >= 3;
      await env.BOT_KV.put(key, JSON.stringify(sess), { expirationTtl: 3600 });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: done ? "三张齐了" : `已抽 ${sess.cards.length}/3`,
      });
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: tarotText(sess.cards, done),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: done
                  ? "🔁 再抽一组"
                  : `🎴 抽${["第一", "第二", "第三"][sess.cards.length]}张`,
                callback_data: "tarot:draw",
              },
            ],
          ],
        },
      });
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

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
      `✨ 星座运势 / 塔罗 Bot\n\n/astro 选你的星座看每日运势\n/tarot 抽三张塔罗牌（过去·现在·未来）\n/mysign 看/改我的星座偏好\n\n${DISCLAIMER}`,
    );

  if (cmd === "/astro") {
    const arg = text.replace(/^\/astro(@\w+)?\s*/, "").trim();
    const sign = SIGNS.find(
      (s) => s.name === arg || s.key === arg.toLowerCase(),
    );
    if (sign) return send(env, chatId, await fortune(env, sign));
    if (!arg && env.BOT_KV) {
      const pref = await env.BOT_KV.get("astro:pref:" + uid);
      const ps = SIGNS.find((s) => s.key === pref);
      if (ps) return send(env, chatId, await fortune(env, ps));
    }
    return send(
      env,
      chatId,
      "选你的星座（选过的会被记住，下次 /astro 直接出运势）：",
      { reply_markup: signKeyboard() },
    );
  }

  if (cmd === "/mysign") {
    if (!env.BOT_KV)
      return send(env, chatId, "未绑定 KV，记不住偏好；每次 /astro 现选即可。");
    const pref = await env.BOT_KV.get("astro:pref:" + uid);
    const ps = SIGNS.find((s) => s.key === pref);
    return send(
      env,
      chatId,
      ps
        ? `你的星座偏好：${ps.emoji} ${ps.name}（${ps.range}）。换星座：`
        : "还没选过星座，选一个记住它：",
      {
        reply_markup: signKeyboard(),
      },
    );
  }

  if (cmd === "/tarot") {
    if (!env.BOT_KV)
      return send(
        env,
        chatId,
        "⚠️ 塔罗抽牌需要先绑定 KV（变量名 BOT_KV）存抽牌会话。/astro 不受影响。",
      );
    await env.BOT_KV.put("tarot:" + uid, JSON.stringify({ cards: [] }), {
      expirationTtl: 3600,
    });
    return send(env, chatId, tarotText([], false), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎴 抽第一张", callback_data: "tarot:draw" }],
        ],
      },
    });
  }
}
