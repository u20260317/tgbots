// ============================================================
// 67 包裹追踪 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// /track <单号> 订阅包裹，Cron 轮询物流状态，状态一变就推送；
// /parcels 看在追的包裹，/untrack 取消。
// 数据源：17track API（全球承运商聚合，免费档需自备 Key）。
// ⚠️ 各家快递/聚合 API 都要自备 Key，没有免 Key 的官方查询接口：
// 未配 TRACK17_API_KEY 时订阅照存，但自动追踪不启用，Bot 会给
// 手动查询链接兜底并明确说明——不会假装在追踪。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// TRACK17_API_KEY 17track API Key（Secret，17track.net 后台申请）
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV。
// 键设计：parcel:<用户ID> = [{num, status, lastEvent, at}]。
// ⚠️ 自动追踪要给 Worker 加 Cron Trigger（如 */30 * * * *）。
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
// 17track API 客户端
// v2.2 口径：POST /track/v2.2/register 登记单号、/gettrackinfo 查询，
// 请求头 17token 带 Key。返回结构 accepted[0].track_info：
// latest_status.status 是标准状态码，latest_event 是最新一条轨迹。
// 解析全程防御式取值——对方字段缺失时返回 null，不硬解崩溃。
// ============================================================
const STATUS_CN = {
  NotFound: "❓ 未查到",
  InfoReceived: "📥 已揽收/已收单",
  InTransit: "🚚 运输中",
  Expired: "⌛ 长时间未更新",
  AvailableForPickup: "🏪 待取件",
  OutForDelivery: "🛵 派送中",
  DeliveryFailure: "⚠️ 派送失败",
  Delivered: "✅ 已签收",
  Exception: "🚨 异常（退回/扣关等）",
};
async function track17(env, path, numbers) {
  const r = await fetch(`https://api.17track.net/track/v2.2/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "17token": env.TRACK17_API_KEY,
    },
    body: JSON.stringify(numbers.map((number) => ({ number }))),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`17track HTTP ${r.status}`);
  return data?.data?.accepted || [];
}
function parseTrack(item) {
  const info = item?.track_info;
  if (!info) return null;
  const ev = info.latest_event || {};
  return {
    status: info.latest_status?.status || "",
    event: [
      ev.time_iso?.slice(0, 16).replace("T", " "),
      ev.location,
      ev.description,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
async function queryParcel(env, num) {
  const accepted = await track17(env, "gettrackinfo", [num]);
  const item =
    accepted.find((a) => String(a.number) === String(num)) || accepted[0];
  return item ? parseTrack(item) : null;
}

// ============================================================
// 订阅存储与状态轮询（KV + Cron）
// parcel:<用户ID> 一人一份列表；轮询按单号去重（多人追同一单号只
// 查一次），最新轨迹签名（状态+事件文本）变了才推送并回写记录。
// 已签收的包裹推完自动停止追踪（从列表移除并告知）。
// ============================================================
async function getParcels(env, uid) {
  const raw = await env.BOT_KV.get("parcel:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveParcels(env, uid, list) {
  await env.BOT_KV.put("parcel:" + uid, JSON.stringify(list));
}
async function pollParcels(env) {
  if (!env.TRACK17_API_KEY) return; // 未配 Key：不启用追踪（命令侧已说明）
  const list = await env.BOT_KV.list({ prefix: "parcel:", limit: 1000 });
  const byNum = new Map(); // num -> [{uid, rec}]
  const lists = new Map(); // uid -> 记录数组（与 byNum 里的 rec 同引用，回写必须用它）
  for (const k of list.keys) {
    const uid = k.name.slice(7);
    const recs = await getParcels(env, uid);
    lists.set(uid, recs);
    for (const rec of recs) {
      if (!byNum.has(rec.num)) byNum.set(rec.num, []);
      byNum.get(rec.num).push({ uid, rec });
    }
  }
  const dirty = new Set();
  for (const [num, holders] of byNum) {
    let now = null;
    try {
      now = await queryParcel(env, num);
    } catch (e) {
      continue;
    }
    if (!now) continue;
    const sig = `${now.status}|${now.event}`;
    for (const { uid, rec } of holders) {
      if (rec.sig === sig) continue;
      rec.sig = sig;
      rec.status = now.status;
      rec.lastEvent = now.event;
      dirty.add(uid);
      await send(
        env,
        Number(uid),
        `📦 包裹 ${num} 有新动态\n状态：${STATUS_CN[now.status] || now.status || "更新"}\n${now.event || ""}${now.status === "Delivered" ? "\n已签收，自动停止追踪 🎉" : ""}`,
      );
      if (now.status === "Delivered") rec.done = true;
    }
  }
  for (const uid of dirty) {
    // 回写内存里已更新 sig/status 的那份列表，不能重读 KV——重读会把
    // 刚更新的签名覆盖回去，导致每轮重复推送、签收也不停追。
    const kept = (lists.get(uid) || []).filter((r) => !r.done);
    await saveParcels(env, uid, kept);
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "track", description: "追踪包裹，如 /track LP123456789CN" },
  { command: "parcels", description: "我在追的包裹" },
  { command: "untrack", description: "取消追踪，如 /untrack 单号" },
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
      return new Response("parcel-tracking bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(pollParcels(env));
  },
};

// ============================================================
// 业务主流程
// /track 登记（有 Key 时顺手登记到 17track 并回当前状态；
// 没 Key 时给手动查询链接 + 未启用说明）。
// ============================================================
const manualLinks = (num) =>
  `手动查询：\n· 17track：https://t.17track.net/en#nums=${encodeURIComponent(num)}\n· 快递100：https://www.kuaidi100.com/all/global.shtml?nu=${encodeURIComponent(num)}`;

async function handle(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const arg = text
    .replace(/^\/(track|untrack)(@\w+)?\s*/, "")
    .trim()
    .toUpperCase();
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "📦 包裹追踪 Bot\n\n/track <单号> 订阅追踪，物流状态变化自动推送，签收后自动停追。\n/parcels 看在追的包裹 · /untrack <单号> 取消。\n数据源：17track（需管理员配好 API Key 才有自动追踪，未配时给手动查询链接）。",
    );
  if (!env.BOT_KV && ["/track", "/parcels", "/untrack"].includes(cmd))
    return send(env, chatId, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV）。");

  if (cmd === "/track") {
    if (!/^[A-Z0-9-]{6,40}$/.test(arg))
      return send(
        env,
        chatId,
        "用法：/track 单号（如 /track LP123456789CN）。单号只含字母数字，别带空格。",
      );
    const list = await getParcels(env, uid);
    if (list.some((r) => r.num === arg))
      return send(env, chatId, "这个单号已经在追踪了，/parcels 查看。");
    const rec = {
      num: arg,
      status: "",
      lastEvent: "",
      sig: "",
      at: Date.now(),
    };
    list.push(rec);
    await saveParcels(env, uid, list);
    if (!env.TRACK17_API_KEY)
      return send(
        env,
        chatId,
        `✅ 已记录单号 ${arg}。\n⚠️ 但管理员还没配置 TRACK17_API_KEY，自动追踪未启用，现在不会有状态推送。先手动查：\n${manualLinks(arg)}\n\nKey 申请办法见 README（17track 开发者后台，免费档够个人用）。`,
      );
    try {
      await track17(env, "register", [arg]).catch(() => []);
      const now = await queryParcel(env, arg);
      if (now) {
        rec.status = now.status;
        rec.lastEvent = now.event;
        rec.sig = `${now.status}|${now.event}`;
        await saveParcels(env, uid, list);
        return send(
          env,
          chatId,
          `✅ 已开始追踪 ${arg}\n当前状态：${STATUS_CN[now.status] || now.status || "已登记"}\n${now.event || ""}\n之后状态变化会自动推送。`,
        );
      }
      return send(
        env,
        chatId,
        `✅ 已开始追踪 ${arg}（17track 暂时还没查到轨迹，新包裹常见，之后轮询到会推送）。`,
      );
    } catch (e) {
      return send(
        env,
        chatId,
        `✅ 已记录单号 ${arg}，但首次查询 17track 出错：${String(e.message || e).slice(0, 120)}。后续 Cron 会继续尝试。`,
      );
    }
  }

  if (cmd === "/parcels") {
    const list = await getParcels(env, uid);
    if (!list.length)
      return send(env, chatId, "你还没有在追的包裹。/track 单号 订一个。");
    return send(
      env,
      chatId,
      "📦 我在追的包裹：\n" +
        list
          .map(
            (r) =>
              `· ${r.num} — ${STATUS_CN[r.status] || r.status || "待查询"}${r.lastEvent ? "\n  " + r.lastEvent : ""}`,
          )
          .join("\n") +
        (env.TRACK17_API_KEY
          ? ""
          : "\n\n⚠️ 未配置 TRACK17_API_KEY，以上仅为记录，无自动追踪。"),
    );
  }

  if (cmd === "/untrack") {
    const list = await getParcels(env, uid);
    const next = list.filter((r) => r.num !== arg);
    if (next.length === list.length)
      return send(env, chatId, "没找到这个单号，/parcels 看确切写法。");
    await saveParcels(env, uid, next);
    return send(env, chatId, `🔕 已取消追踪 ${arg}。`);
  }
}
