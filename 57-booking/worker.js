// ============================================================
// 57 预约 / 订位 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：小商家预约本：用户 /book 三步按钮走完——选服务 → 选日期（近 7 天）
// → 选时段（占用表防撞）→ 生成预约单；管理员在通知里点确认/拒绝；
// Cron 在预约前 1 小时自动提醒用户。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// ADMIN_ID 管理员数字 ID（逗号分隔）：收预约通知、点确认/拒绝
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// TZ_OFFSET 日期与时段按哪个时区算，默认 8（北京时间）
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// ⚠️ 需要 Cron：加 Cron Trigger */10 * * * *（每 10 分钟）跑到点提醒；
// 不加 Cron 只是没提醒，预约本身照常。
// 键设计：book:<日期>:<服务ID> 时段占用表 { 时段: 预约ID}；
// book:r:<预约ID> 预约单全记录（提醒扫描靠它）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 20（FSM 思路，按钮版）+ 模块 09/34（Cron 提醒）+ 模块 01
// ============================================================

// ============================================================
// 服务与营业时段（改这里定制你的店）
// SERVICES：id 只能用字母/数字（进回调数据）；mins 是时长（仅展示）。
// 时段按 SLOT_MINUTES 从 WORK_START 切到 WORK_END；CLOSED_WDAYS 0=周日。
// ============================================================
const CONFIG = {
  SERVICES: [
    { id: "cut", name: "剪发", mins: 45 },
    { id: "color", name: "染发", mins: 120 },
    { id: "care", name: "护理", mins: 60 },
  ],
  WORK_START: "09:00",
  WORK_END: "18:00",
  SLOT_MINUTES: 30,
  DAYS_AHEAD: 7,
  CLOSED_WDAYS: [0],
};

// ============================================================
// Telegram Bot API 通信层与时间工具
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
const tzMs = (env) => (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;
const pad = (n) => String(n).padStart(2, "0");
// 当地日期字符串（可整体平移天数）：先把时间轴平移到当地时区再读年月日。
function dateStr(env, addDays = 0) {
  const d = new Date(Date.now() + tzMs(env) + addDays * 86400 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function wdayOf(env, addDays = 0) {
  return new Date(Date.now() + tzMs(env) + addDays * 86400 * 1000).getUTCDay();
}
const slotLabel = (s) => s.slice(0, 2) + ":" + s.slice(2); // "0930" → "09:30"
function allSlots() {
  const [sh, sm] = CONFIG.WORK_START.split(":").map(Number);
  const [eh, em] = CONFIG.WORK_END.split(":").map(Number);
  const out = [];
  for (let t = sh * 60 + sm; t < eh * 60 + em; t += CONFIG.SLOT_MINUTES)
    out.push(pad(Math.floor(t / 60)) + pad(t % 60));
  return out;
}
// 预约开始时刻（毫秒）：日期+时段按当地时间解释
function startTs(env, date, slot) {
  const [y, mo, d] = date.split("-").map(Number);
  return (
    Date.UTC(y, mo - 1, d, Number(slot.slice(0, 2)), Number(slot.slice(2))) -
    tzMs(env)
  );
}
const svcName = (id) => CONFIG.SERVICES.find((s) => s.id === id)?.name || id;

// ============================================================
// 时段占用表（防撞单）
// book:<日期>:<服务ID> = { "0930": 预约ID,...}，一个时段只许一张单。
// 确认占用时先读表复检（按钮渲染到点击之间可能被人抢先），KV 无事务，
// 极端并发下靠这层复检 + 管理员人工确认兜底，撞单率压到可接受。
// ============================================================
async function getOcc(env, date, sid) {
  const raw = await env.BOT_KV.get(`book:${date}:${sid}`);
  return raw ? JSON.parse(raw) : {};
}
async function getBooking(env, bid) {
  const raw = await env.BOT_KV.get("book:r:" + bid);
  return raw ? JSON.parse(raw) : null;
}
async function saveBooking(env, b) {
  await env.BOT_KV.put("book:r:" + b.id, JSON.stringify(b));
}
async function freeSlot(env, b) {
  const occ = await getOcc(env, b.date, b.service);
  if (occ[b.slot] === b.id) {
    delete occ[b.slot];
    await env.BOT_KV.put(`book:${b.date}:${b.service}`, JSON.stringify(occ));
  }
}

// ============================================================
// 到点提醒（Cron 扫描）
// 每轮扫 book:r: 前缀：已确认、未提醒、距开始 ≤65 分钟的单逐个提醒并打标。
// 65 分钟窗口配 */10 的 Cron：最坏迟 10 分钟，仍在「提前 1 小时」语义内。
// ============================================================
async function runReminders(env) {
  const list = await env.BOT_KV.list({ prefix: "book:r:", limit: 1000 });
  const now = Date.now();
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (!raw) continue;
    const b = JSON.parse(raw);
    if (b.status !== "confirmed" || b.reminded) continue;
    const start = startTs(env, b.date, b.slot);
    if (start - now > 65 * 60 * 1000 || start < now) continue;
    await send(
      env,
      b.uid,
      `⏰ 预约提醒：您预约的「${svcName(b.service)}」在今天 ${slotLabel(b.slot)}（${b.date}），别忘了到店。`,
    ).catch(() => {});
    b.reminded = true;
    await saveBooking(env, b);
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// ============================================================
const COMMANDS_USER = [
  { command: "book", description: "预约服务" },
  { command: "mybooks", description: "我的预约" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [{ command: "bookings", description: "今日预约单" }];
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
      return new Response("booking bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(runReminders(env));
  },
};

// 按钮视图：服务 → 日期 → 时段，三级都在原消息上编辑，不刷屏。
function svcKb() {
  return {
    inline_keyboard: CONFIG.SERVICES.map((s) => [
      {
        text: `${s.name}（约 ${s.mins} 分钟）`,
        callback_data: `bk:svc:${s.id}`,
      },
    ]),
  };
}
function dateKb(env, sid) {
  const rows = [];
  const wnames = ["日", "一", "二", "三", "四", "五", "六"];
  for (let i = 0; i < CONFIG.DAYS_AHEAD; i++) {
    const ds = dateStr(env, i);
    const closed = CONFIG.CLOSED_WDAYS.includes(wdayOf(env, i));
    rows.push([
      {
        text: `${ds.slice(5)} 周${wnames[wdayOf(env, i)]}${i === 0 ? "（今天）" : ""}${closed ? " · 休息" : ""}`,
        callback_data: closed ? "bk:closed" : `bk:date:${sid}:${ds}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}
async function slotKb(env, sid, date) {
  const occ = await getOcc(env, date, sid);
  const now = Date.now();
  const slots = allSlots().filter(
    (s) => !occ[s] && startTs(env, date, s) > now,
  );
  const rows = [];
  for (let i = 0; i < slots.length; i += 4)
    rows.push(
      slots.slice(i, i + 4).map((s) => ({
        text: slotLabel(s),
        callback_data: `bk:slot:${sid}:${date}:${s}`,
      })),
    );
  return { inline_keyboard: rows };
}

// ============================================================
// 业务主流程
// 预约流回调 bk:；管理员确认/拒绝 bok:/bno:（一单一组，带预约 ID）。
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
    const uid = cq.from.id;
    const chatId = cq.message?.chat?.id || uid;
    const edit = (text, kb) =>
      tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text,
        ...(kb ? { reply_markup: kb } : {}),
      });

    if (data.startsWith("bok:") || data.startsWith("bno:")) {
      if (!isAdmin(env, uid))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能处理预约",
          show_alert: true,
        });
      const bid = data.slice(4);
      const b = await getBooking(env, bid);
      if (!b || b.status !== "pending")
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这张单已经处理过了",
          show_alert: true,
        });
      if (data.startsWith("bok:")) {
        b.status = "confirmed";
        await saveBooking(env, b);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "✅ 已确认",
        });
        await send(
          env,
          b.uid,
          `✅ 预约已确认！\n${svcName(b.service)} · ${b.date} ${slotLabel(b.slot)}\n到店报名字即可，开始前 1 小时还会提醒你。`,
        );
        return edit(
          `✅ 已确认预约 ${bid}\n${svcName(b.service)} · ${b.date} ${slotLabel(b.slot)} · ${b.name}`,
        );
      }
      b.status = "rejected";
      await saveBooking(env, b);
      await freeSlot(env, b);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已拒绝并释放时段",
      });
      await send(
        env,
        b.uid,
        `⚠️ 很抱歉，您预约的 ${svcName(b.service)}（${b.date} ${slotLabel(b.slot)}）被拒绝了，可能时段有冲突。重新 /book 选个时间吧。`,
      );
      return edit(
        `❌ 已拒绝预约 ${bid}\n${svcName(b.service)} · ${b.date} ${slotLabel(b.slot)} · ${b.name}`,
      );
    }

    if (!data.startsWith("bk:")) return;
    const parts = data.split(":");
    const act = parts[1];
    if (act === "closed")
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "这天休息，换一天吧",
        show_alert: true,
      });
    if (act === "svc") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return edit(
        `已选「${svcName(parts[2])}」，再选日期：`,
        dateKb(env, parts[2]),
      );
    }
    if (act === "date") {
      const kb = await slotKb(env, parts[2], parts[3]);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (!kb.inline_keyboard.length)
        return edit(
          `${parts[3]} 的「${svcName(parts[2])}」已无可用时段，/book 重新选。`,
        );
      return edit(
        `已选 ${parts[3]}，再选时间（灰色时段已被订走不会出现）：`,
        kb,
      );
    }
    if (act === "slot") {
      const [, , sid, date, slot] = parts;
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return edit(
        `确认预约？\n服务：${svcName(sid)}\n时间：${date} ${slotLabel(slot)}`,
        {
          inline_keyboard: [
            [
              {
                text: "✅ 确认预约",
                callback_data: `bk:ok:${sid}:${date}:${slot}`,
              },
              { text: "↩️ 重选服务", callback_data: "bk:again" },
            ],
          ],
        },
      );
    }
    if (act === "again") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return edit("选择服务：", svcKb());
    }
    if (act === "ok") {
      const [, , sid, date, slot] = parts;
      const occ = await getOcc(env, date, sid);
      if (occ[slot]) {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "手慢了，这个时段刚被订走",
          show_alert: true,
        });
        return edit("这个时段刚被订走，/book 重新选一个吧。");
      }
      const b = {
        id: newId(),
        uid,
        name:
          [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") ||
          String(uid),
        service: sid,
        date,
        slot,
        status: "pending",
        reminded: false,
        at: Date.now(),
      };
      occ[slot] = b.id;
      await env.BOT_KV.put(`book:${date}:${sid}`, JSON.stringify(occ));
      await saveBooking(env, b);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 预约单已生成",
      });
      await edit(
        `🧾 预约单 ${b.id}\n${svcName(sid)} · ${date} ${slotLabel(slot)}\n状态：待管理员确认，确认后会通知你。`,
      );
      const admins = String(env.ADMIN_ID || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      for (const a of admins) {
        await send(
          env,
          a,
          `📥 新预约待确认\n${svcName(sid)} · ${date} ${slotLabel(slot)}\n顾客：${b.name}（ID ${uid}）`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 确认", callback_data: `bok:${b.id}` },
                  { text: "❌ 拒绝", callback_data: `bno:${b.id}` },
                ],
              ],
            },
          },
        );
      }
      return;
    }
    if (act === "cx") {
      const b = await getBooking(env, parts[2]);
      if (!b || b.uid !== uid || !["pending", "confirmed"].includes(b.status))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这张单不能取消了",
          show_alert: true,
        });
      b.status = "cancelled";
      await saveBooking(env, b);
      await freeSlot(env, b);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已取消，时段已释放",
      });
      return edit(
        `已取消预约 ${b.id}（${svcName(b.service)} · ${b.date} ${slotLabel(b.slot)}）。`,
      );
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/ +/)[0].split("@")[0];

  if (cmd === "/start")
    return send(
      env,
      chatId,
      "📅 预约 Bot\n\n/book 选服务、日期、时段三步完成预约，管理员确认后生效，开始前 1 小时自动提醒。\n/mybooks 看我的预约（可取消）。",
    );
  if (cmd === "/book")
    return send(env, chatId, "选择服务：", { reply_markup: svcKb() });
  if (cmd === "/mybooks") {
    const list = await env.BOT_KV.list({ prefix: "book:r:", limit: 1000 });
    const mine = [];
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (!raw) continue;
      const b = JSON.parse(raw);
      if (
        b.uid === uid &&
        ["pending", "confirmed"].includes(b.status) &&
        startTs(env, b.date, b.slot) > Date.now() - 3600 * 1000
      )
        mine.push(b);
    }
    if (!mine.length)
      return send(env, chatId, "你还没有有效的预约。/book 订一个。");
    mine.sort(
      (a, b) => startTs(env, a.date, a.slot) - startTs(env, b.date, b.slot),
    );
    for (const b of mine) {
      await send(
        env,
        chatId,
        `🧾 ${svcName(b.service)} · ${b.date} ${slotLabel(b.slot)}\n状态：${b.status === "confirmed" ? "✅ 已确认" : "⏳ 待确认"}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ 取消这单", callback_data: `bk:cx:${b.id}` }],
            ],
          },
        },
      );
    }
    return;
  }
  if (cmd === "/bookings" && isAdmin(env, uid)) {
    const today = dateStr(env);
    const lines = [];
    for (const s of CONFIG.SERVICES) {
      const occ = await getOcc(env, today, s.id);
      for (const slot of Object.keys(occ).sort()) {
        const b = await getBooking(env, occ[slot]);
        if (b && b.status !== "cancelled" && b.status !== "rejected")
          lines.push(
            `${slotLabel(slot)} ${s.name} · ${b.name} · ${b.status === "confirmed" ? "已确认" : "待确认"}`,
          );
      }
    }
    return send(
      env,
      chatId,
      `📋 今日（${today}）预约\n\n` + (lines.join("\n") || "今天还没有预约。"),
    );
  }
}
