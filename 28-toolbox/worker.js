// ============================================================
// 28 工具箱 Bot（单文件 · Cloudflare Workers · 无需 KV）
// 玩法：一堆日常小工具集合，查一次即走，不存任何数据。
// 必填变量：BOT_TOKEN（Secret）
// 选填：WEBHOOK_SECRET
// 命令清单：
// /qr 文本或链接 生成二维码图片
// /short https://长网址 生成短链接（is.gd 免费接口）
// /hash 文本 MD5 / SHA1 / SHA256 三种哈希一次出
// /b64e 文本 Base64 编码 · /b64d 编码 Base64 解码（支持中文）
// /uuid 生成一个 UUID
// /pick 苹果,香蕉,橙子 随机选一个（逗号分隔）
// /ts [时间戳或日期] 不带参数=当前时间；带秒/毫秒时间戳转日期；带日期转时间戳
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

// ============================================================
// 【核心模块】工具函数库（哈希 / 编码 / 随机）
// SHA 系列走 WebCrypto；MD5 不在 WebCrypto 里，用下面的纯 JS 实现（常量表由 sin 生成，已按标准向量校验）。
// Base64 用 UTF-8 安全的编解码，中文不乱码。
// ============================================================
// MD5-START
function md5(input) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const K = [];
  for (let i = 0; i < 64; i++)
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const bytes = Array.from(new TextEncoder().encode(input));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  let lo = bitLen >>> 0,
    hi = Math.floor(bitLen / 4294967296);
  for (let i = 0; i < 4; i++) {
    bytes.push(lo & 0xff);
    lo >>>= 8;
  }
  for (let i = 0; i < 4; i++) {
    bytes.push(hi & 0xff);
    hi >>>= 8;
  }
  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const rotl = (x, s) => ((x << s) | (x >>> (32 - s))) >>> 0;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let j = 0; j < 16; j++)
      M[j] =
        (bytes[off + j * 4] |
          (bytes[off + j * 4 + 1] << 8) |
          (bytes[off + j * 4 + 2] << 16) |
          (bytes[off + j * 4 + 3] << 24)) >>>
        0;
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + F + K[i] + M[g]) >>> 0, S[i])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const hexLE = (n) =>
    [0, 8, 16, 24]
      .map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, "0"))
      .join("");
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
// MD5-END
async function sha(algo, text) {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
function b64decode(code) {
  const bin = atob(code.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
const randInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ============================================================
// 【核心模块】管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
//   · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
//   · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
//     于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
//     的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "qr", description: "生成二维码" },
  { command: "short", description: "生成短链接" },
  { command: "hash", description: "文本哈希" },
  { command: "b64e", description: "Base64 编码" },
  { command: "b64d", description: "Base64 解码" },
  { command: "uuid", description: "生成 UUID" },
  { command: "pick", description: "随机选一个" },
  { command: "ts", description: "时间戳转换" },
  { command: "start", description: "工具列表" },
];
const COMMANDS_ADMIN = [];
async function registerCommands(env) {
  // 先注册默认菜单（所有人可见的用户命令）
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  // 再给白名单里每个管理员单独注册全集菜单（只在他私聊里生效）
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("toolbox bot is running.", {
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
};

// ============================================================
// 【核心模块】业务主流程
// 每个命令一个分支：参数取命令后的全文；外部小接口（二维码/短链）失败时明确报错不装成功。
// ============================================================
async function handle(env, update) {
  const msg = update.message;
  if (!msg) return;
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const arg = text.slice(text.split(/\s+/)[0].length).trim();

  if (cmd === "/qr") {
    if (!arg) return send(env, chatId, "用法：/qr 文本或链接");
    const photo = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(arg)}`;
    const r = await tg(env, "sendPhoto", {
      chat_id: chatId,
      photo,
      caption: `二维码内容：${arg.slice(0, 100)}`,
    });
    if (!r.ok)
      return send(env, chatId, "😢 二维码生成失败（外部接口异常），稍后再试。");
    return;
  }
  if (cmd === "/short") {
    if (!/^https?:\/\//i.test(arg))
      return send(env, chatId, "用法：/short https://example.com/长链接");
    const r = await fetch(
      `https://is.gd/create.php?format=simple&url=${encodeURIComponent(arg)}`,
    );
    const out = (await r.text()).trim();
    if (!r.ok || !/^https:\/\/is\.gd\//.test(out))
      return send(
        env,
        chatId,
        "😢 短链生成失败（is.gd 接口异常或链接不被接受）。",
      );
    return send(env, chatId, `🔗 短链接：${out}\n原链接：${arg}`);
  }
  if (cmd === "/hash") {
    if (!arg) return send(env, chatId, "用法：/hash 要哈希的文本");
    const [s1, s256] = await Promise.all([
      sha("SHA-1", arg),
      sha("SHA-256", arg),
    ]);
    return send(
      env,
      chatId,
      `🔐 哈希结果\n原文：${arg}\n\nMD5：${md5(arg)}\nSHA1：${s1}\nSHA256：${s256}`,
    );
  }
  if (cmd === "/b64e") {
    if (!arg) return send(env, chatId, "用法：/b64e 要编码的文本");
    return send(env, chatId, `Base64 编码：\n${b64encode(arg)}`);
  }
  if (cmd === "/b64d") {
    if (!arg) return send(env, chatId, "用法：/b64d 要解码的 Base64");
    try {
      return send(env, chatId, `Base64 解码：\n${b64decode(arg)}`);
    } catch {
      return send(env, chatId, "😢 这不是合法的 Base64 字符串。");
    }
  }
  if (cmd === "/uuid") return send(env, chatId, `🆔 ${crypto.randomUUID()}`);
  if (cmd === "/pick") {
    const items = arg
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length < 2)
      return send(
        env,
        chatId,
        "用法：/pick 苹果,香蕉,橙子（至少 2 个，逗号分隔）",
      );
    return send(
      env,
      chatId,
      `🎲 随机选一个：${items[randInt(items.length)]}\n（候选：${items.join(" / ")}）`,
    );
  }
  if (cmd === "/ts") {
    if (!arg) {
      const now = Date.now();
      return send(
        env,
        chatId,
        `🕐 当前时间\n秒：${Math.floor(now / 1000)}\n毫秒：${now}\n日期：${new Date(now).toISOString().replace("T", " ").slice(0, 19)} UTC`,
      );
    }
    if (/^\d{10}$/.test(arg) || /^\d{13}$/.test(arg)) {
      const ms = arg.length === 10 ? Number(arg) * 1000 : Number(arg);
      return send(
        env,
        chatId,
        `🕐 时间戳 ${arg} =\n${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC`,
      );
    }
    const parsed = Date.parse(arg.replace(" ", "T"));
    if (isNaN(parsed))
      return send(
        env,
        chatId,
        "用法：/ts 不带参数看当前；/ts 1730000000 时间戳转日期；/ts 2026-11-20 日期转时间戳",
      );
    return send(
      env,
      chatId,
      `🕐 ${arg} =\n秒：${Math.floor(parsed / 1000)}\n毫秒：${parsed}`,
    );
  }
  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🧰 工具箱 Bot\n/qr 文本 二维码 · /short 网址 短链\n/hash 文本 三种哈希 · /b64e /b64d Base64\n/uuid 生成 UUID · /pick a,b,c 随机选\n/ts 时间戳与日期互转",
    );
}
