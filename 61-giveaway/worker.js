// ============================================================
// 61 活动抽奖 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：频道/群活动抽奖（TgGrow / TGPicker 类）：
// 管理员 /giveaway 奖品|人数|时间 发起，帖子带「🎁 参与」按钮；
// 可配订阅条件（先关注指定频道才能参与，点按钮时现场核验）；
// 到时 Cron 自动开奖（也可 /drawgw 手动），crypto 随机抽、编辑原帖公布、
// 私信中奖者（私信不到就在帖里公示名单）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）；Bot 须是活动频道/群的管理员
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 平台管理员（逗号分隔）：任何聊天都能发起/开奖
// GIVEAWAY_CHATS 参与前必须订阅的频道/群（逗号分隔，如 @mychannel），
// 留空 = 无订阅条件；Bot 必须是这些频道的管理员才查得到订阅状态
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ 自动开奖需要 Cron Trigger */1 * * * *（每分钟）；不加也能用 /drawgw 手动开。
// 键设计：gw:<抽奖ID> 活动全记录（含参与名单）；gw:post:<频道>:<帖ID> 评论模式索引。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 06（订阅核验）+ 模块 16（抽奖）+ 模块 09（Cron）+ 模块 01
// ============================================================

// ============================================================
// 评论参与模式（默认关）
// 开启后：在频道关联的讨论组里「回复那条被自动转发的抽奖帖」即算参与。
// 限制（先说清）：依赖频道开讨论组 + 转发标记完整，用户关了转发签名、
// 讨论组未关联等情况都会漏登记；正式活动请以按钮参与为准，
// 评论模式只作补充。开启方法：把 COMMENT_MODE 改 true 重新部署。
// ============================================================
const CONFIG = { COMMENT_MODE: false };

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
const isAdmin = (env, uid) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(uid));
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

// 谁能发起：平台管理员，或本群的群管理员（私聊只认平台管理员）。
async function canHost(env, msg) {
  if (isAdmin(env, msg.from.id)) return true;
  if (msg.chat.type === "private") return false;
  const r = await tg(env, "getChatMember", {
    chat_id: msg.chat.id,
    user_id: msg.from.id,
  });
  return ["creator", "administrator"].includes(r?.result?.status);
}

// ============================================================
// 订阅条件核验（复用模块 06）
// GIVEAWAY_CHATS 逐个 getChatMember，没关注全就返回缺失清单，
// 点「参与」时现场验——比事后清洗名单可靠，假关注当场就拦下。
// ============================================================
async function missingSubs(env, userId) {
  const chats = String(env.GIVEAWAY_CHATS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = [];
  for (const chat of chats) {
    const r = await tg(env, "getChatMember", {
      chat_id: chat,
      user_id: userId,
    });
    const st = r?.result?.status;
    if (
      !r.ok ||
      !["member", "administrator", "creator", "restricted"].includes(st)
    )
      missing.push(chat);
  }
  return missing;
}

// 开奖时间解析：N分钟后 / N小时后 / N天后 / 今天|明天 HH:MM / HH:MM（过了点算明天）
function parseDrawTime(env, s) {
  const now = Date.now();
  let m;
  if ((m = s.match(/^(\d+)\s*分钟后/))) return now + Number(m[1]) * 60 * 1000;
  if ((m = s.match(/^(\d+)\s*小时后/))) return now + Number(m[1]) * 3600 * 1000;
  if ((m = s.match(/^(\d+)\s*天后/))) return now + Number(m[1]) * 86400 * 1000;
  const tm = s.match(/(\d{1,2})[:：](\d{2})/);
  if (!tm) return null;
  const tz = (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;
  const build = (addDays) => {
    const d = new Date(now + tz);
    d.setUTCDate(d.getUTCDate() + addDays);
    d.setUTCHours(Number(tm[1]), Number(tm[2]), 0, 0);
    return d.getTime() - tz;
  };
  let at = build(/明天/.test(s) ? 1 : 0);
  if (!/明天/.test(s) && at <= now) at = build(1);
  return at;
}
const fmtTs = (env, ts) => {
  const d = new Date(ts + (Number(env.TZ_OFFSET) || 8) * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

// ============================================================
// 开奖（crypto 随机 + 名单落盘）
// Fisher-Yates 洗牌，随机源用 crypto.getRandomValues（不用 Math.random，
// 开奖要经得起质疑）；结果先写回 gw 记录再编辑原帖公布、私信中奖者，
// 私信失败（没私聊过 Bot）不中断，名单在帖里公示兜底。
// ============================================================
function shuffle(arr) {
  const a = [...arr];
  const buf = new Uint32Array(a.length);
  crypto.getRandomValues(buf);
  for (let i = a.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function drawGiveaway(env, g) {
  if (g.status !== "open") return;
  g.status = "drawn";
  g.winners = shuffle(g.entrants).slice(
    0,
    Math.min(g.count, g.entrants.length),
  );
  await env.BOT_KV.put("gw:" + g.id, JSON.stringify(g));
  const names = g.winners.map((w) => w.name).join("、");
  const text = g.entrants.length
    ? `🎁 抽奖已开奖！\n奖品：${g.prize}\n参与人数：${g.entrants.length}\n🏆 中奖者：${names || "（无）"}\n恭喜！中奖者会收到私信通知，没收到私信的请凭此名单联系管理员。`
    : `🎁 抽奖已结束：${g.prize}\n可惜无人参与，本次流局。`;
  if (g.msg)
    await tg(env, "editMessageText", {
      chat_id: g.chat,
      message_id: g.msg,
      text,
    }).catch(() => {});
  else await send(env, g.chat, text).catch(() => {});
  for (const w of g.winners)
    await send(
      env,
      w.uid,
      `🏆 恭喜你在「${g.prize}」抽奖中中奖了！请联系活动管理员领奖。`,
    ).catch(() => {});
}
async function runDueDraws(env) {
  const list = await env.BOT_KV.list({ prefix: "gw:", limit: 1000 });
  const now = Date.now();
  for (const k of list.keys) {
    if (k.name.startsWith("gw:post:")) continue;
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const g = JSON.parse(raw);
    if (g.status === "open" && g.drawAt <= now) await drawGiveaway(env, g);
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// ============================================================
const COMMANDS_USER = [
  { command: "giveaway", description: "发起抽奖（管理员）" },
  { command: "gwlist", description: "进行中的抽奖" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "drawgw", description: "手动开奖 /drawgw <ID>" },
];
async function registerCommands(env) {
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  const ids = String(env.ADMIN_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids) {
    await tg(env, "setMyCommands", {
      commands: [...COMMANDS_USER, ...COMMANDS_ADMIN],
      scope: { type: "chat", chat_id: Number(id) },
    });
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
      return new Response("giveaway bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(runDueDraws(env));
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
    if (!data.startsWith("gw:join:")) return;
    const gid = data.slice(8);
    const raw = await env.BOT_KV.get("gw:" + gid);
    if (!raw)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这个抽奖不存在了",
        show_alert: true,
      });
    const g = JSON.parse(raw);
    if (g.status !== "open")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "抽奖已结束",
        show_alert: true,
      });
    const uid = cq.from.id;
    if (g.entrants.some((e) => e.uid === uid))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "你已经参与过了，不用重复点",
        show_alert: true,
      });
    const missing = await missingSubs(env, uid);
    if (missing.length)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `先关注 ${missing.join("、")} 才能参与，关注后回来再点一次。`,
        show_alert: true,
      });
    g.entrants.push({
      uid,
      name:
        [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") ||
        String(uid),
    });
    await env.BOT_KV.put("gw:" + gid, JSON.stringify(g));
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `🎉 参与成功！当前共 ${g.entrants.length} 人，开奖：${fmtTs(env, g.drawAt)}`,
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  // 评论模式：讨论组里回复抽奖帖的自动转发消息 = 登记参与（尽力而为，见 CONFIG 注释）
  if (
    CONFIG.COMMENT_MODE &&
    msg.reply_to_message?.forward_from_chat &&
    msg.reply_to_message?.forward_from_message_id
  ) {
    const idx = await env.BOT_KV.get(
      `gw:post:${msg.reply_to_message.forward_from_chat.id}:${msg.reply_to_message.forward_from_message_id}`,
    );
    if (idx) {
      const g = JSON.parse((await env.BOT_KV.get("gw:" + idx)) || "null");
      if (
        g &&
        g.status === "open" &&
        !g.entrants.some((e) => e.uid === msg.from.id)
      ) {
        g.entrants.push({
          uid: msg.from.id,
          name:
            [msg.from.first_name, msg.from.last_name]
              .filter(Boolean)
              .join(" ") || String(msg.from.id),
        });
        await env.BOT_KV.put("gw:" + g.id, JSON.stringify(g));
      }
    }
    return;
  }

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "🎁 活动抽奖 Bot\n\n管理员在频道/群里发 /giveaway 奖品|人数|开奖时间 发起，成员点帖子上的「🎁 参与」按钮报名，到时自动开奖。\n例：/giveaway 会员月卡|3|2小时后",
    );

  if (cmd === "/giveaway") {
    if (!(await canHost(env, msg)))
      return send(env, chatId, "只有管理员能发起抽奖。");
    const body = text.replace(/^\/giveaway(@\w+)?\s*/, "");
    const parts = body.split("|").map((x) => x.trim());
    if (parts.length < 3 || !parts[0])
      return send(
        env,
        chatId,
        "格式：/giveaway 奖品|中奖人数|开奖时间\n例：/giveaway 会员月卡|3|2小时后\n时间可写：2小时后 / 明天 20:00 / 20:00",
      );
    const count = Number(parts[1]);
    const drawAt = parseDrawTime(env, parts[2]);
    if (!count || count < 1) return send(env, chatId, "中奖人数要是正整数。");
    if (!drawAt)
      return send(
        env,
        chatId,
        "开奖时间没看懂，可写：2小时后 / 明天 20:00 / 20:00",
      );
    const g = {
      id: newId(),
      chat: chatId,
      msg: 0,
      prize: parts[0].slice(0, 100),
      count,
      drawAt,
      host: msg.from.id,
      entrants: [],
      status: "open",
      winners: [],
    };
    const subNote = env.GIVEAWAY_CHATS
      ? `\n参与条件：先关注 ${env.GIVEAWAY_CHATS}`
      : "";
    const post = await send(
      env,
      chatId,
      `🎁 抽奖活动\n奖品：${g.prize}（共 ${count} 名）\n开奖时间：${fmtTs(env, drawAt)}${subNote}\n点下方按钮参与，开奖后自动公布并私信中奖者。`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎁 参与抽奖", callback_data: `gw:join:${g.id}` }],
          ],
        },
      },
    );
    if (post.ok) {
      g.msg = post.result.message_id;
      if (CONFIG.COMMENT_MODE)
        await env.BOT_KV.put(`gw:post:${chatId}:${g.msg}`, g.id);
    }
    await env.BOT_KV.put("gw:" + g.id, JSON.stringify(g));
    return;
  }

  if (cmd === "/drawgw") {
    const gid = text.split(/\s+/)[1];
    const raw = gid && (await env.BOT_KV.get("gw:" + gid));
    if (!raw)
      return send(env, chatId, "用法：/drawgw <抽奖ID>（ID 在 /gwlist 里看）");
    const g = JSON.parse(raw);
    if (!(isAdmin(env, msg.from.id) || g.host === msg.from.id))
      return send(env, chatId, "只有发起人或管理员能手动开奖。");
    if (g.status !== "open") return send(env, chatId, "这个抽奖已经开过了。");
    await drawGiveaway(env, g);
    return;
  }

  if (cmd === "/gwlist") {
    const list = await env.BOT_KV.list({ prefix: "gw:", limit: 1000 });
    const lines = [];
    for (const k of list.keys) {
      if (k.name.startsWith("gw:post:")) continue;
      const raw = await env.BOT_KV.get(k.name);
      if (!raw) continue;
      const g = JSON.parse(raw);
      if (g.chat === chatId && g.status === "open")
        lines.push(
          `· ${g.prize}（ID ${g.id}）· ${g.entrants.length} 人参与 · ${fmtTs(env, g.drawAt)} 开奖`,
        );
    }
    return send(
      env,
      chatId,
      lines.length
        ? "🎁 进行中的抽奖\n\n" + lines.join("\n")
        : "本聊天暂无进行中的抽奖。",
    );
  }
}
