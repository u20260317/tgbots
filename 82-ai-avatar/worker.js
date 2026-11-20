// ============================================================
// 82 AI 头像 / 证件照 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 发一张照片 → /avatar 选风格（商务 / 证件照 / 动漫 / 复古）→
// · AI 风格（商务/动漫/复古）：走可配置的图像编辑 API（口径同
// 55 号 AI 绘图模板的 IMAGE_API：OpenAI 兼容 images/edits），
// 未配 API 时明确提示，不假装生成；
// · 证件照：不走 AI，走本地规格裁剪——用 wsrv.nl 图片代理把原图
// 按 1 寸（295×413）/ 2 寸（413×579）规格裁出并回传。
// 每日限额存 avatar:cnt:<uid>:<日期>（默认 10 次，AI 与证件照都计）。
// 🔒 隐私：照片只在你点风格的那一刻转发给所配置的图像 API，
// Bot 不把原图落盘存储（KV 只暂存 file_id 等你选风格，10 分钟
// 过期）；不用了发 /clear 可立即清掉。首次使用会先弹隐私提示。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// IMAGE_API 图像 API 基地址（OpenAI 兼容，如 https://api.openai.com/v1）
// IMAGE_API_KEY 图像 API Key（Secret）
// IMAGE_MODEL 编辑模型名，默认 gpt-image-1
// AVATAR_DAILY_LIMIT 每人每日次数，默认 10
// ADMIN_ID 管理员数字 ID（看 /avatarstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV（存待选照片与用量计数）。
// 键设计：avatar:pend:<uid> = {fileId}（10 分钟过期）；
// avatar:cnt:<uid>:<日期> 当日次数；avatar:seen:<uid> 隐私已阅。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 46（AI 绘图 API 适配）+ 模块 37（图片代理）+ 01/02
// ============================================================

// ============================================================
// 风格表（CONFIG）
// AI 风格给 prompt 后缀（图生图编辑口径）；idphoto 是特殊值，
// 不走 AI、走规格裁剪分支。加风格往这里加一行即可。
// ============================================================
const STYLES = [
  {
    id: "biz",
    name: "💼 商务头像",
    prompt:
      "professional corporate headshot, studio lighting, clean background, confident, high quality portrait",
  },
  {
    id: "anime",
    name: "🌸 动漫风",
    prompt:
      "anime style portrait illustration, clean lines, vibrant colors, keep the person's likeness",
  },
  {
    id: "retro",
    name: "📷 复古胶片",
    prompt:
      "vintage film photography portrait, warm tones, grainy texture, 1990s style",
  },
  { id: "idphoto", name: "🪪 证件照规格", prompt: "" },
];

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
const dayKey = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function tgFileUrl(env, fileId) {
  const gf = await tg(env, "getFile", { file_id: fileId });
  if (!gf.ok) throw new Error("getFile 失败");
  return `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
}

// ============================================================
// 图像编辑层（OpenAI 兼容 images/edits，同模块 46）
// 把原图字节以 multipart 提交 {IMAGE_API}/images/edits
// （image + prompt + model），响应 data[0] 可能是 b64_json
// （解码后用 FormData 以文件形式 sendPhoto）或 url（直接回传）。
// 未配 IMAGE_API 直接抛「未配置」错误，调用方原样提示用户。
// ============================================================
async function editImage(env, fileId, prompt) {
  if (!env.IMAGE_API)
    throw new Error(
      "未配置图像 API（演示模式）：管理员需设置 IMAGE_API / IMAGE_API_KEY（OpenAI 兼容 images 接口）后才能生成 AI 风格头像。证件照规格裁剪不需要 API，现在就能用。",
    );
  const fileUrl = await tgFileUrl(env, fileId);
  const imgRes = await fetch(fileUrl);
  if (!imgRes.ok) throw new Error("原图下载失败");
  const imgBlob = await imgRes.blob();
  const form = new FormData();
  form.append("image", imgBlob, "photo.jpg");
  form.append("prompt", prompt);
  form.append("model", env.IMAGE_MODEL || "gpt-image-1");
  const r = await fetch(env.IMAGE_API.replace(/\/$/, "") + "/images/edits", {
    method: "POST",
    headers: env.IMAGE_API_KEY
      ? { authorization: `Bearer ${env.IMAGE_API_KEY}` }
      : {},
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(data?.error?.message || `图像 API HTTP ${r.status}`);
  const item = data?.data?.[0];
  if (!item) throw new Error("图像 API 没返回图片");
  return item; // { b64_json} 或 { url}
}
async function sendEditedPhoto(env, chatId, item, caption) {
  if (item.url)
    return tg(env, "sendPhoto", { chat_id: chatId, photo: item.url, caption });
  const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([bytes], { type: "image/png" }), "avatar.png");
  form.append("caption", caption);
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`,
    {
      method: "POST",
      body: form,
    },
  );
  return r.json().catch(() => ({}));
}

// ============================================================
// 证件照规格裁剪（wsrv.nl 代理，不走 AI）
// 1 寸 = 25×35mm、2 寸 = 35×49mm，按 300dpi 换算像素：
// 1 寸 295×413、2 寸 413×579。wsrv.nl 的 fit=cover 是「填满裁
// 剪」——会居中裁掉超出部分，人脸太靠边可能被裁，回复里有提醒。
// 只做规格裁剪排版，不做换底色造假类处理（见 README 合规说明）。
// ============================================================
function idPhotoUrl(srcUrl, spec) {
  const [w, h] = spec === "2" ? [413, 579] : [295, 413];
  return `https://wsrv.nl/?url=${encodeURIComponent(srcUrl.replace(/^https?:\/\//, ""))}&w=${w}&h=${h}&fit=cover&output=jpg`;
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明与隐私提示" },
  { command: "avatar", description: "给刚发的照片选风格" },
  { command: "clear", description: "清掉待处理的照片" },
];
const COMMANDS_ADMIN = [
  { command: "avatarstats", description: "今日用量（管理员）" },
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
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("ai-avatar bot is running.", {
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

const PRIVACY_TEXT =
  "🔒 隐私提示（首次使用请看）\n\n· 你发的照片，Bot 只在你点选风格的那一刻转发给你所配置的图像 API（或图片代理）处理，Bot 自己不保存原图文件。\n· 待选照片的 file_id 只在 KV 里暂存 10 分钟，发 /clear 可立即清掉。\n· AI 生成结果由第三方 API 产生，其隐私政策适用于处理环节；介意的话只用「证件照规格」模式（仅经图片代理裁剪）或不要上传敏感照片。";

async function styleKeyboard() {
  return {
    inline_keyboard: STYLES.map((s) => [
      { text: s.name, callback_data: `avatar:style:${s.id}` },
    ]),
  };
}

// ============================================================
// 业务主流程
// 私聊发照片 → 暂存 avatar:pend（file_id，10 分钟）→ 回风格键盘；
// 点风格（回调 avatar:style:<id>）：先过每日限额，再分流——
// idphoto 走规格裁剪（先问 1 寸/2 寸，回调 avatar:id:<规格>），
// 其余走图像编辑层。用量计数 avatar:cnt: 在真正处理前 +1。
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
    if (!data.startsWith("avatar:")) return;
    const uid = cq.from.id;
    const chatId = cq.message.chat.id;
    const raw = await env.BOT_KV.get("avatar:pend:" + uid);
    if (!raw)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "照片已过期，重新发一张吧",
        show_alert: true,
      });
    const pend = JSON.parse(raw);

    if (data.startsWith("avatar:style:")) {
      const style = STYLES.find((s) => s.id === data.split(":")[2]);
      if (!style) return;
      if (style.id === "idphoto") {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
        return send(env, chatId, "证件照要哪个规格？", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "1 寸（295×413）", callback_data: "avatar:id:1" },
                { text: "2 寸（413×579）", callback_data: "avatar:id:2" },
              ],
            ],
          },
        });
      }
      // AI 风格：先限额后处理
      const limit = Number(env.AVATAR_DAILY_LIMIT) || 10;
      const cntKey = `avatar:cnt:${uid}:${dayKey()}`;
      const used = Number(await env.BOT_KV.get(cntKey)) || 0;
      if (used >= limit)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `今天已生成 ${limit} 次，明天再来`,
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "🎨 生成中，稍等…",
      });
      try {
        const item = await editImage(env, pend.fileId, style.prompt);
        await env.BOT_KV.put(cntKey, String(used + 1), {
          expirationTtl: 172800,
        });
        return sendEditedPhoto(env, chatId, item, `${style.name} · AI 生成`);
      } catch (e) {
        return send(
          env,
          chatId,
          `😵 生成失败：${String(e.message || e).slice(0, 250)}`,
        );
      }
    }

    if (data.startsWith("avatar:id:")) {
      const spec = data.split(":")[2];
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✂️ 裁剪中…",
      });
      try {
        const src = await tgFileUrl(env, pend.fileId);
        const url = idPhotoUrl(src, spec);
        const r = await tg(env, "sendPhoto", {
          chat_id: chatId,
          photo: url,
          caption: `🪪 证件照 ${spec} 寸规格（${spec === "2" ? "413×579" : "295×413"} @300dpi）\n⚠️ 居中裁剪：人脸太靠边可能被裁，必要时换一张居中照片。`,
        });
        if (!r.ok) throw new Error("图片代理没拉动原图");
        const cntKey = `avatar:cnt:${uid}:${dayKey()}`;
        const used = Number(await env.BOT_KV.get(cntKey)) || 0;
        await env.BOT_KV.put(cntKey, String(used + 1), {
          expirationTtl: 172800,
        });
        return;
      } catch (e) {
        return send(
          env,
          chatId,
          `😵 裁剪失败：${String(e.message || e).slice(0, 200)}`,
        );
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🖼️ AI 头像 / 证件照 Bot\n\n直接发一张照片给我，再选风格：\n💼 商务头像 / 🌸 动漫风 / 📷 复古胶片（走 AI 图像 API）\n🪪 证件照规格（本地裁剪，不走 AI）\n\n" +
        PRIVACY_TEXT,
    );

  if (cmd === "/clear") {
    await env.BOT_KV.delete("avatar:pend:" + uid);
    return send(env, chatId, "已清掉待处理的照片记录。");
  }

  if (cmd === "/avatar") {
    const raw = await env.BOT_KV.get("avatar:pend:" + uid);
    if (!raw) return send(env, chatId, "先发一张照片给我，再选风格。");
    return send(env, chatId, "选个风格：", {
      reply_markup: await styleKeyboard(),
    });
  }

  if (cmd === "/avatarstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "avatar:cnt:", limit: 1000 });
    let total = 0;
    for (const k of list.keys) {
      if (k.name.endsWith(":" + dayKey()))
        total += Number(await env.BOT_KV.get(k.name)) || 0;
    }
    return send(env, chatId, `📊 今日生成/裁剪：${total} 次`);
  }

  // 收到照片：首次先弹隐私提示，再暂存并给风格键盘
  const photo = msg.photo?.[msg.photo.length - 1];
  if (photo) {
    const seen = await env.BOT_KV.get("avatar:seen:" + uid);
    if (!seen) {
      await send(env, chatId, PRIVACY_TEXT);
      await env.BOT_KV.put("avatar:seen:" + uid, "1");
    }
    await env.BOT_KV.put(
      "avatar:pend:" + uid,
      JSON.stringify({ fileId: photo.file_id }),
      { expirationTtl: 600 },
    );
    return send(env, chatId, "收到照片，选个风格：", {
      reply_markup: await styleKeyboard(),
    });
  }
}
