// ============================================================
// 41 狼人杀主持人 Bot（单文件 · Cloudflare Workers · 需绑定 KV）
// 功能：
// Bot 当法官，在群里主持一局狼人杀：/werewolf 开房 → 按钮报名 →
// 私聊发身份牌 → 夜晚狼人/预言家/女巫在私聊里点按钮行动 → 天亮
// 公布昨夜结果 → 白天公投放逐 → 判定胜负，没结束自动进入下一夜。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ 玩家必须先私聊本 Bot 发过 /start，否则身份牌私发不出去，
// 开局时会被自动剔除（群里只公布人数变化，绝不公布其身份）。
// 规则口径（写死在本文件，要改改 maybeDawn）：狼刀取最先提交的一刀；
// 女巫救药只能救狼刀、毒药无视救药；女巫整局各一瓶药。
// 键设计：wolf:<群ID> 局元信息、wolfp:<群ID>:<uid> 玩家、wolfn:/wolfv:
// 夜晚行动与公投（全部按人拆键，防多人同时点击时整表回写互相覆盖）；
// wolfroom:<用户ID> 存所在群（私聊反查）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 35（狼人杀主持人）+ 模块 01（骨架）+ 模块 02（分级菜单）
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
const answer = (env, cq, text) =>
  tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    ...(text ? { text } : {}),
  });

// ============================================================
// 狼人杀对局状态（KV）
// 并发要点：报名/公投/夜晚行动都是多人几乎同时点按钮，若把整局
// 状态塞在一个 JSON 里「读-改-写」，后写的会盖掉先写的（实测出现
// 过「回调提示报名成功、名单里却没有他」）。所以按写入主体拆键，
// 每人只写自己的键，互不覆盖：
// wolf:<群ID> = 局元信息 { phase, host, round, witchPotion }
// wolfp:<群ID>:<uid> = { name, role, alive }（玩家一人一键）
// wolfn:<群ID>:kill|check|save|poison = 夜晚行动结果（单人写）
// wolfn:<群ID>:acted:<uid> = 已行动标记（一人一键）
// wolfv:<群ID>:<投票人> = 目标 uid（公投一人一键）
// wolfroom:<用户ID> = 群ID：夜晚行动在私聊里发生，靠它反查对局。
// getGame() 把散键拼回整局对象给逻辑层用；状态变更走 setPlayer /
// setNightField / setVote 等定点写，不再整表回写。注意 KV list 有
// 最终一致延迟：刚写入的键可能几秒后才在 list 里可见，房主开局
// 这类人工节奏的操作不受影响。
// ============================================================
async function saveMeta(env, chatId, g) {
  await env.BOT_KV.put(
    "wolf:" + chatId,
    JSON.stringify({
      phase: g.phase,
      host: g.host,
      round: g.round,
      witchPotion: g.witchPotion,
    }),
  );
}
async function setPlayer(env, chatId, uid, p) {
  await env.BOT_KV.put(`wolfp:${chatId}:${uid}`, JSON.stringify(p));
}
async function delPlayer(env, chatId, uid) {
  await env.BOT_KV.delete(`wolfp:${chatId}:${uid}`);
  await env.BOT_KV.delete("wolfroom:" + uid);
}
async function getNight(env, chatId, playerIds) {
  const pre = `wolfn:${chatId}:`;
  const [kill, check, save, poison] = await Promise.all([
    env.BOT_KV.get(pre + "kill"),
    env.BOT_KV.get(pre + "check"),
    env.BOT_KV.get(pre + "save"),
    env.BOT_KV.get(pre + "poison"),
  ]);
  // acted 标记按玩家逐个直读单键：list 有边缘缓存延迟，逐键 get 新鲜得多
  const acted = [];
  for (const uid of playerIds || []) {
    if ((await env.BOT_KV.get(pre + "acted:" + uid)) === "1") acted.push(uid);
  }
  return {
    kill: kill || null,
    check: check || null,
    save: save === "1",
    poison: poison || null,
    acted,
  };
}
async function setNightField(env, chatId, field, value) {
  const key = `wolfn:${chatId}:${field}`;
  if (value === null || value === undefined) await env.BOT_KV.delete(key);
  else await env.BOT_KV.put(key, String(value));
}
async function getVotes(env, chatId, playerIds) {
  // 投票人必是玩家：按玩家逐个直读单键，避免 list 延迟导致「全员
  // 已投完却不自动结算」
  const votes = {};
  for (const uid of playerIds || []) {
    const v = await env.BOT_KV.get(`wolfv:${chatId}:${uid}`);
    if (v) votes[uid] = v;
  }
  return votes;
}
async function setVote(env, chatId, voter, target) {
  await env.BOT_KV.put(`wolfv:${chatId}:${voter}`, String(target));
}
async function getGame(env, chatId) {
  const raw = await env.BOT_KV.get("wolf:" + chatId);
  if (!raw) return null;
  const g = JSON.parse(raw);
  const pre = `wolfp:${chatId}:`;
  const res = await env.BOT_KV.list({ prefix: pre });
  g.players = {};
  for (const k of res.keys) {
    const v = await env.BOT_KV.get(k.name);
    if (v) g.players[k.name.slice(pre.length)] = JSON.parse(v);
  }
  const playerIds = Object.keys(g.players);
  g.night = await getNight(env, chatId, playerIds);
  g.votes = await getVotes(env, chatId, playerIds);
  return g;
}
async function clearRoundKeys(env, chatId) {
  for (const pre of [`wolfn:${chatId}:`, `wolfv:${chatId}:`]) {
    const res = await env.BOT_KV.list({ prefix: pre });
    for (const k of res.keys) await env.BOT_KV.delete(k.name);
  }
}
async function clearGame(env, chatId, g) {
  await env.BOT_KV.delete("wolf:" + chatId);
  await clearRoundKeys(env, chatId);
  if (g)
    for (const uid of Object.keys(g.players)) await delPlayer(env, chatId, uid);
}
const aliveOf = (g, role) =>
  Object.entries(g.players)
    .filter(([, p]) => p.alive && (!role || p.role === role))
    .map(([uid]) => uid);
const ROLE_NAME = {
  wolf: "🐺 狼人",
  seer: "🔮 预言家",
  witch: "🧪 女巫",
  folk: "🧑‍🌾 平民",
};

// ============================================================
// 发牌（加密随机洗牌）
// 人数定配置：狼数 = max(1, floor(n/3))，预言家/女巫各 1，其余平民。
// 洗牌用 crypto.getRandomValues 做 Fisher-Yates，不用 Math.random——
// 身份分配是最不能被质疑作弊的一步。
// ============================================================
function dealRoles(playerIds) {
  const n = playerIds.length;
  const wolves = Math.max(1, Math.floor(n / 3));
  const roles = [
    ...Array(wolves).fill("wolf"),
    "seer",
    "witch",
    ...Array(n - wolves - 2).fill("folk"),
  ];
  const shuffled = [...playerIds];
  const buf = new Uint32Array(Math.max(1, n - 1));
  crypto.getRandomValues(buf);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = buf[i - 1] % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out = {};
  shuffled.forEach((uid, i) => (out[uid] = roles[i]));
  return out;
}

// ============================================================
// 开局与身份私发
// 身份牌只发私聊；私发失败（没启动过 Bot）的人当场剔除，群里只报
// 人数。剔除后不足 4 人整局取消。发完牌直接进入第 1 夜。
// ============================================================
async function startGame(env, chatId, g) {
  const ids = Object.keys(g.players);
  const roles = dealRoles(ids);
  for (const uid of ids) {
    g.players[uid].role = roles[uid];
    g.players[uid].alive = true;
    const r = await send(
      env,
      uid,
      `🎴 你的身份是：${ROLE_NAME[roles[uid]]}\n（本条只有你能看到，别截图外传）`,
    );
    if (!r?.ok) {
      delete g.players[uid];
      await delPlayer(env, chatId, uid);
    } else {
      await setPlayer(env, chatId, uid, g.players[uid]);
    }
  }
  if (Object.keys(g.players).length < 4) {
    await clearGame(env, chatId, g);
    return send(
      env,
      chatId,
      "😢 能收到身份牌的玩家不足 4 人，本局取消。参赛前请先私聊我发一次 /start 再报名。",
    );
  }
  g.phase = "night";
  g.round = 1;
  g.night = freshNight();
  g.votes = {};
  await clearRoundKeys(env, chatId);
  await saveMeta(env, chatId, g);
  await send(
    env,
    chatId,
    `🌕 游戏开始！共 ${Object.keys(g.players).length} 人。第 1 夜，天黑请闭眼——狼人、预言家、女巫请看私聊行动。`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⏩ 房主强制推进（夜晚卡住时）",
              callback_data: "wolf:force",
            },
          ],
        ],
      },
    },
  );
  return nightPrompts(env, chatId, g);
}
const freshNight = () => ({
  kill: null,
  check: null,
  save: false,
  poison: null,
  acted: [],
});

// ============================================================
// 夜晚行动收集（私聊回调）
// 给每个有行动权的角色私发目标按钮：狼人 wolf:kill:<uid>（首刀锁定）、
// 预言家 wolf:check:<uid>（结果只回给他本人）、女巫先看今晚刀口再选
// wolf:save / wolf:poison:<uid> / wolf:pass。三方都提交后自动天亮。
// ============================================================
function targetKeyboard(g, act, excludeUid) {
  const rows = aliveOf(g)
    .filter((uid) => uid !== excludeUid)
    .map((uid) => [
      { text: g.players[uid].name, callback_data: `wolf:${act}:${uid}` },
    ]);
  return { inline_keyboard: rows };
}
async function nightPrompts(env, chatId, g) {
  for (const uid of aliveOf(g, "wolf"))
    await send(
      env,
      uid,
      `🌙 第 ${g.round} 夜：选择今晚的刀口（队里最先提交的一刀为准）：`,
      {
        reply_markup: targetKeyboard(g, "kill", uid),
      },
    );
  for (const uid of aliveOf(g, "seer"))
    await send(env, uid, `🔮 第 ${g.round} 夜：选择今晚要查验的人：`, {
      reply_markup: targetKeyboard(g, "check", uid),
    });
  // 女巫不在开局时发提示：她要先知道刀口，等狼人首刀落定后再发（见 witchPrompt）。
}
// 狼人首刀落定后才通知女巫：这时刀口已定，救/毒才有意义。
async function witchPrompt(env, g) {
  for (const uid of aliveOf(g, "witch")) {
    if (g.witchPotion.save <= 0 && g.witchPotion.poison <= 0) continue;
    const rows = [];
    if (g.witchPotion.save > 0 && g.night.kill)
      rows.push([
        { text: "💊 用解药救今晚的刀口", callback_data: "wolf:save" },
      ]);
    if (g.witchPotion.poison > 0)
      for (const t of aliveOf(g))
        if (t !== uid)
          rows.push([
            {
              text: "☠️ 毒 " + g.players[t].name,
              callback_data: "wolf:poison:" + t,
            },
          ]);
    rows.push([{ text: "🙌 今晚不用药", callback_data: "wolf:pass" }]);
    const killName = g.night.kill ? g.players[g.night.kill]?.name : "无人";
    await send(
      env,
      uid,
      "🧪 第 " +
        g.round +
        " 夜：今晚狼人的刀口是 " +
        killName +
        "。解药剩 " +
        g.witchPotion.save +
        "、毒药剩 " +
        g.witchPotion.poison +
        "，请选择：",
      { reply_markup: { inline_keyboard: rows } },
    );
  }
}
async function onNightAction(env, cq, act, target) {
  const me = String(cq.from.id);
  const room = await env.BOT_KV.get("wolfroom:" + me);
  if (!room) return answer(env, cq, "你不在任何对局里");
  const chatId = room;
  const g = await getGame(env, chatId);
  if (!g || g.phase !== "night") return answer(env, cq, "现在不是夜晚行动时间");
  const role = g.players[me]?.role;
  if (!g.players[me]?.alive) return answer(env, cq, "你已经出局了");
  let firstKill = false;
  if (act === "kill" && role === "wolf") {
    if (!g.night.kill) {
      g.night.kill = target;
      await setNightField(env, chatId, "kill", target);
      firstKill = true;
    } // 首刀锁定，后来者只登记行动
  } else if (act === "check" && role === "seer") {
    g.night.check = target;
    await setNightField(env, chatId, "check", target);
    const isWolf = g.players[target]?.role === "wolf";
    await send(
      env,
      me,
      `🔮 查验结果：${g.players[target]?.name} 是 ${isWolf ? "🐺 狼人" : "✅ 好人"}`,
    );
  } else if (
    act === "save" &&
    role === "witch" &&
    g.witchPotion.save > 0 &&
    g.night.kill
  ) {
    g.night.save = true;
    g.witchPotion.save -= 1;
    await setNightField(env, chatId, "save", "1");
    await saveMeta(env, chatId, g);
  } else if (act === "poison" && role === "witch" && g.witchPotion.poison > 0) {
    g.night.poison = target;
    g.witchPotion.poison -= 1;
    await setNightField(env, chatId, "poison", target);
    await saveMeta(env, chatId, g);
  } else if (act === "pass" && role === "witch") {
    // 不用药，也算已行动
  } else return answer(env, cq, "这个行动不属于你（或药已用完/刀口未定）");
  if (!g.night.acted.includes(me)) {
    g.night.acted.push(me);
    await setNightField(env, chatId, "acted:" + me, "1");
  }
  await answer(env, cq, "已记录");
  if (firstKill) await witchPrompt(env, g);
  return maybeDawn(env, chatId, g);
}

// 三方都提交后自动天亮；房主强制推进也走同一个结算函数。
async function maybeDawn(env, chatId, g) {
  const expect =
    (aliveOf(g, "wolf").length ? 1 : 0) +
    (aliveOf(g, "seer").length ? 1 : 0) +
    (aliveOf(g, "witch").length &&
    (g.witchPotion.save > 0 || g.witchPotion.poison > 0)
      ? 1
      : 0);
  if (g.night.acted.length < expect) return;
  return dawnSettle(env, chatId, g, false);
}

// 结算昨夜：毒杀无视救药，救药只救狼刀；算完进白天公投。
async function dawnSettle(env, chatId, g, forced) {
  const dead = new Set();
  if (g.night.poison) dead.add(g.night.poison);
  if (g.night.kill && !g.night.save) dead.add(g.night.kill);
  for (const uid of dead) {
    g.players[uid].alive = false;
    await setPlayer(env, chatId, uid, g.players[uid]);
  }
  g.phase = "day";
  g.votes = {};
  await clearRoundKeys(env, chatId);
  await saveMeta(env, chatId, g);
  const names = [...dead].map((uid) => g.players[uid].name);
  const head = forced
    ? "🌅（强制推进）天亮了。"
    : `🌅 第 ${g.round} 天天亮了。`;
  await send(
    env,
    chatId,
    `${head}昨夜出局：${names.length ? names.join("、") : "无人（平安夜）"}。\n开始白天公投：点下方按钮投票（可改票），全员投完或房主点结算后放逐最高票。`,
    { reply_markup: voteKeyboard(g) },
  );
  return checkWin(env, chatId, g);
}

// ============================================================
// 白天公投与胜负判定
// wolf:vote:<uid> 一人一票可改票；全员投完自动结算，房主也可
// wolf:tally 强制结算。放逐后查胜负，没结束就进入下一夜。
// ============================================================
function voteKeyboard(g) {
  const rows = aliveOf(g).map((uid) => [
    { text: `🗳 投 ${g.players[uid].name}`, callback_data: `wolf:vote:${uid}` },
  ]);
  rows.push([{ text: "🧮 房主结算公投", callback_data: "wolf:tally" }]);
  return { inline_keyboard: rows };
}
async function tallyVotes(env, chatId, g) {
  const counts = {};
  for (const t of Object.values(g.votes)) counts[t] = (counts[t] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top) {
    await send(env, chatId, "没人投票，本轮无人出局。");
  } else {
    g.players[top[0]].alive = false;
    await setPlayer(env, chatId, top[0], g.players[top[0]]);
    await send(
      env,
      chatId,
      `⚖️ 公投结果：${g.players[top[0]].name} 以 ${top[1]} 票被放逐。`,
    );
  }
  if (await checkWin(env, chatId, g)) return;
  g.phase = "night";
  g.round += 1;
  g.night = freshNight();
  g.votes = {};
  await clearRoundKeys(env, chatId);
  await saveMeta(env, chatId, g);
  await send(env, chatId, `🌕 第 ${g.round} 夜，天黑请闭眼。`, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "⏩ 房主强制推进（夜晚卡住时）",
            callback_data: "wolf:force",
          },
        ],
      ],
    },
  });
  return nightPrompts(env, chatId, g);
}
async function checkWin(env, chatId, g) {
  const wolves = aliveOf(g, "wolf").length;
  const goods = aliveOf(g).length - wolves;
  if (wolves > 0 && wolves < goods) return false;
  g.phase = "over";
  const reveal = Object.values(g.players)
    .map(
      (p) =>
        `${p.name} — ${ROLE_NAME[p.role] || "？"}${p.alive ? "" : "（已出局）"}`,
    )
    .join("\n");
  await send(
    env,
    chatId,
    `🏁 游戏结束，${wolves === 0 ? "好人阵营胜利！" : "狼人阵营胜利！"}\n\n身份揭晓：\n${reveal}`,
  );
  await clearGame(env, chatId, g);
  return true;
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令（房主是每局动态产生的，不走白名单），
// COMMANDS_ADMIN 留空；模块照常保留，加管理员命令时按注释扩。
// ============================================================
const COMMANDS_USER = [
  { command: "werewolf", description: "开一局狼人杀（群里用）" },
  { command: "myrole", description: "私聊查我的身份" },
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
    for (const id of ids)
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// fetch 只管 webhook；游戏推进全靠回调，没有 Cron（卡住时房主强制推进）。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("werewolf bot is running.", {
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
// 群里：/werewolf 开房、wolf:join 报名、wolf:start 房主开局、
// wolf:vote:/wolf:tally 白天公投；私聊：夜晚行动回调、/myrole 查身份。
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
    const parts = String(cq.data || "").split(":");
    if (parts[0] !== "wolf") return;
    const act = parts[1];
    const target = parts[2];
    const chatId = cq.message.chat.id;
    const me = String(cq.from.id);

    if (act === "join") {
      const g = await getGame(env, chatId);
      if (!g || g.phase !== "lobby")
        return answer(env, cq, "现在没有正在报名的局");
      if (g.players[me]) return answer(env, cq, "你已经报名了");
      const p = {
        name: cq.from.first_name || "玩家",
        role: null,
        alive: true,
      };
      // 只写自己的玩家键：多人同时报名互不覆盖
      await setPlayer(env, chatId, me, p);
      await env.BOT_KV.put("wolfroom:" + me, String(chatId));
      g.players[me] = p;
      await answer(env, cq, "✅ 报名成功，等房主开局");
      return tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: lobbyText(g),
        reply_markup: lobbyKeyboard(),
      });
    }
    if (act === "start") {
      const g = await getGame(env, chatId);
      if (!g || g.phase !== "lobby") return answer(env, cq, "没有可开的局");
      if (String(g.host) !== me) return answer(env, cq, "只有房主能开局");
      if (Object.keys(g.players).length < 4)
        return answer(env, cq, "至少 4 人才能开局");
      await answer(env, cq, "发牌中…");
      return startGame(env, chatId, g);
    }
    if (act === "force") {
      const g = await getGame(env, chatId);
      if (!g || String(g.host) !== me)
        return answer(env, cq, "只有房主能强制推进");
      if (g.phase !== "night") return answer(env, cq, "现在不在夜晚阶段");
      await answer(env, cq, "⏩ 已强制推进到天亮");
      // 未行动者视为放弃：直接按当前行动箱结算
      return maybeDawnForce(env, chatId, g);
    }
    if (act === "vote") {
      const g = await getGame(env, chatId);
      if (!g || g.phase !== "day") return answer(env, cq, "现在不是公投时间");
      if (!g.players[me]?.alive) return answer(env, cq, "出局者不能投票");
      // 只写自己的一票：多人同时投票互不覆盖
      await setVote(env, chatId, me, target);
      g.votes[me] = target;
      await answer(env, cq, `已投 ${g.players[target]?.name || "目标"}`);
      if (Object.keys(g.votes).length >= aliveOf(g).length)
        return tallyVotes(env, chatId, g);
      return;
    }
    if (act === "tally") {
      const g = await getGame(env, chatId);
      if (!g || g.phase !== "day") return answer(env, cq, "现在不是公投时间");
      if (String(g.host) !== me) return answer(env, cq, "只有房主能结算");
      await answer(env, cq, "结算中…");
      return tallyVotes(env, chatId, g);
    }
    // 夜晚行动（私聊里点）
    return onNightAction(env, cq, act, target);
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const me = String(msg.from.id);
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🐺 狼人杀主持人\n\n群里发 /werewolf 开房，点按钮报名（至少 4 人），房主开局后身份牌会私发给你——所以参赛前先在这里私聊发一次 /start。\n夜晚行动都在私聊里点按钮，白天回群里公投。\n/myrole 私聊查自己当前身份。",
    );

  if (cmd === "/werewolf") {
    if (!isGroup)
      return send(
        env,
        chatId,
        "狼人杀要在群里开局，先把我拉进群再发 /werewolf。",
      );
    const old = await getGame(env, chatId);
    if (old && old.phase !== "over")
      return send(
        env,
        chatId,
        "本群已有一局在进行中（房主可联系管理员清局）。",
      );
    const hostPlayer = {
      name: msg.from.first_name || "房主",
      role: null,
      alive: true,
    };
    const g = {
      phase: "lobby",
      host: me,
      round: 0,
      players: { [me]: hostPlayer },
      night: freshNight(),
      votes: {},
      witchPotion: { save: 1, poison: 1 },
    };
    await setPlayer(env, chatId, me, hostPlayer);
    await env.BOT_KV.put("wolfroom:" + me, String(chatId));
    await saveMeta(env, chatId, g);
    return send(env, chatId, lobbyText(g), { reply_markup: lobbyKeyboard() });
  }

  if (cmd === "/myrole") {
    if (isGroup) return send(env, chatId, "身份只能私聊查，去私聊发 /myrole。");
    const room = await env.BOT_KV.get("wolfroom:" + me);
    const g = room ? await getGame(env, room) : null;
    if (!g || !g.players[me]?.role)
      return send(env, chatId, "你现在不在对局中，或还没发牌。");
    return send(
      env,
      chatId,
      `🎴 你当前的身份是：${ROLE_NAME[g.players[me].role]}${g.players[me].alive ? "" : "（已出局）"}`,
    );
  }
}
function lobbyText(g) {
  const names = Object.values(g.players)
    .map((p) => p.name)
    .join("、");
  return `🐺 狼人杀报名中（${Object.keys(g.players).length} 人）：${names}\n满 4 人后房主点「开始游戏」。⚠️ 没私聊过我的玩家发不到身份牌，开局会被剔除。`;
}
function lobbyKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✋ 我要参加", callback_data: "wolf:join" }],
      [{ text: "▶️ 开始游戏（房主）", callback_data: "wolf:start" }],
    ],
  };
}
// 强制推进：把未行动角色按「已行动」补齐后走正常结算
async function maybeDawnForce(env, chatId, g) {
  for (const uid of [
    ...aliveOf(g, "wolf"),
    ...aliveOf(g, "seer"),
    ...aliveOf(g, "witch"),
  ])
    if (!g.night.acted.includes(uid)) {
      g.night.acted.push(uid);
      await setNightField(env, chatId, "acted:" + uid, "1");
    }
  return dawnSettle(env, chatId, g, true);
}
