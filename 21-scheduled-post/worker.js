// ============================================================
// 21 定时播报 Bot（单文件 · Cloudflare Workers + Cron + 需绑定 KV）
// 玩法：管理员设定「每天/每周某天几点几分发什么」，Bot 到点自动发到目标
// 频道/群。适合每日公告、价格播报、打卡提醒、活动预告这类循环内容。
// 必填变量：BOT_TOKEN（Secret）、ADMIN_ID
// 选填：TARGET_CHAT_ID（默认发送目标；在群里建任务则默认发本群）、
// TZ_OFFSET（时区偏移，默认 8=北京）、WEBHOOK_SECRET
// ⚠️ 需要 KV：变量名 BOT_KV（键 jobs 存任务表）。
// ⚠️ 需要 Cron：Worker → Triggers 加 */5 * * * *（每 5 分钟检查一次到点没；
// 任务按 nextRun 时间戳判断，5 分钟粒度足够，别设每分钟省额度）。
// 管理员命令：
// /add 09:30 daily 播报内容 每天 09:30 发（目标群/频道）
// /add 20:00 weekly:1 本周总结 每周一 20:00 发（0=周日 … 6=周六）
// /jobs 列表 · /deljob 任务ID 删除
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
const admins = (env) =>
  String(env.ADMIN_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");
const offsetMs = (env) => (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;

// ============================================================
// 【核心模块】计划任务存储与下一次时间计算（KV）
// jobs = [{ id, hh, mm, rule:daily|weekly, weekday, chat, text, nextRun}]
// nextRun 用「目标时区墙钟」算出下一次触发的 UTC 毫秒，调度时只比时间戳，不解析规则。
// ============================================================
async function loadJobs(env) {
  const raw = await env.BOT_KV.get("jobs");
  return raw ? JSON.parse(raw) : [];
}
async function saveJobs(env, jobs) {
  await env.BOT_KV.put("jobs", JSON.stringify(jobs));
}
function computeNext(env, job, from = Date.now()) {
  const off = offsetMs(env);
  const local = new Date(from + off);
  const target = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      job.hh,
      job.mm,
      0,
    ),
  );
  let t = target.getTime() - off;
  if (t <= from) t += 86400 * 1000;
  if (job.rule === "weekly") {
    while (new Date(t + off).getUTCDay() !== job.weekday) t += 86400 * 1000;
  }
  return t;
}
const fmtLocal = (env, ts) =>
  new Date(ts + offsetMs(env)).toISOString().replace("T", " ").slice(0, 16);

// ============================================================
// 【核心模块】定时调度（Cron 触发）
// 每轮 Cron 扫任务表：到点的发送并顺延 nextRun；发送失败也顺延（防失败重试刷屏），错误记 console。
// ============================================================
async function runDue(env) {
  const jobs = await loadJobs(env);
  let sent = 0;
  for (const job of jobs) {
    if (job.nextRun <= Date.now()) {
      const r = await send(env, job.chat, job.text).catch(() => ({}));
      if (r.ok) sent++;
      job.nextRun = computeNext(env, job);
    }
  }
  await saveJobs(env, jobs);
  return sent;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// fetch 管管理员命令，scheduled 管到点发送，两条路共用任务表。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "add", description: "新建定时任务（管理员）" },
  { command: "jobs", description: "定时任务列表（管理员）" },
  { command: "deljob", description: "删除定时任务（管理员）" },
  { command: "start", description: "使用说明" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("scheduled-post bot is running.", {
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
      const cm = await tg(env, "setMyCommands", { commands: COMMANDS });
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
    if (env.BOT_KV) ctx.waitUntil(runDue(env));
  },
};

// ============================================================
// 【核心模块】业务主流程
// 管理员建/删/查定时任务；目标会话 = 在群里建任务发本群，私聊建任务发 TARGET_CHAT_ID。
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
  const text = msg.text || "";
  const cmd = text.split(/\s+/)[0].split("@")[0];
  if (!isAdmin(env, msg.from.id)) {
    if (text.startsWith("/"))
      return send(env, msg.chat.id, "⛔ 定时播报只接受管理员指令。");
    return;
  }
  if (cmd === "/add") {
    const m = text.match(
      /^\/add\s+(\d{1,2}):(\d{2})\s+(daily|weekly:([0-6]))\s+([\s\S]+)/,
    );
    if (!m)
      return send(
        env,
        msg.chat.id,
        "用法：\n/add 09:30 daily 播报内容\n/add 20:00 weekly:1 每周一晚八点发（0=周日）",
      );
    const chat =
      msg.chat.type === "private" ? env.TARGET_CHAT_ID || "" : msg.chat.id;
    if (!chat)
      return send(
        env,
        msg.chat.id,
        "私聊建任务需要先设 TARGET_CHAT_ID，或直接在目标群里发 /add。",
      );
    const job = {
      id: newId(),
      hh: Number(m[1]),
      mm: Number(m[2]),
      rule: m[3].startsWith("weekly") ? "weekly" : "daily",
      weekday: Number(m[4] || 0),
      chat,
      text: m[5].trim(),
    };
    job.nextRun = computeNext(env, job);
    const jobs = await loadJobs(env);
    jobs.push(job);
    await saveJobs(env, jobs);
    return send(
      env,
      msg.chat.id,
      `✅ 已建任务 ${job.id}：${job.rule === "weekly" ? "每周" + "日一二三四五六"[job.weekday] : "每天"} ${String(job.hh).padStart(2, "0")}:${String(job.mm).padStart(2, "0")} 发到 ${chat}\n下一次：${fmtLocal(env, job.nextRun)}（本地时间）`,
    );
  }
  if (cmd === "/jobs") {
    const jobs = await loadJobs(env);
    if (!jobs.length)
      return send(env, msg.chat.id, "还没有定时任务。/add 建一条。");
    return send(
      env,
      msg.chat.id,
      "⏰ 定时任务：\n\n" +
        jobs
          .map(
            (j) =>
              `${j.id} · ${j.rule === "weekly" ? "每周" + "日一二三四五六"[j.weekday] : "每天"} ${String(j.hh).padStart(2, "0")}:${String(j.mm).padStart(2, "0")} → ${j.chat}\n下一次 ${fmtLocal(env, j.nextRun)}\n${j.text.slice(0, 60)}`,
          )
          .join("\n\n"),
    );
  }
  if (cmd === "/deljob") {
    const id = text.split(/\s+/)[1];
    const jobs = await loadJobs(env);
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length)
      return send(env, msg.chat.id, "没找到这个任务 ID，发 /jobs 看列表。");
    await saveJobs(env, next);
    return send(env, msg.chat.id, `已删除任务 ${id}。`);
  }
  if (cmd === "/start")
    return send(
      env,
      msg.chat.id,
      "⏰ 定时播报 Bot（管理员专用）\n/add HH:MM daily 内容 建每日任务\n/add HH:MM weekly:星期 内容 建每周任务\n/jobs 列表 · /deljob ID 删除\n记得给 Worker 加 */5 分钟的 Cron 触发器。",
    );
}
