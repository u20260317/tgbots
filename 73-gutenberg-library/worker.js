// ============================================================
// 73 公版书库 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 检索 Project Gutenberg 的公版书目（走 Gutendex 免费 API，
// https://gutendex.com，免 key、免注册，可直接真跑）：
// /search <书名/作者> 出书籍卡 → 按钮选格式（EPUB/PDF/纯文本）→
// Bot 用 sendDocument 让 Telegram 直接抓取文件回传（>50MB 回直链）；
// /random 随机推荐一本；/shelf 个人书架（收藏存 KV）。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// ADMIN_ID 管理员数字 ID（看 /gbstats 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV（存书架）。
// 键设计：shelf:<用户ID> = [{id, title}] 个人书架。
// ⚖️ 版权：Project Gutenberg 只收录美国版权法下已进入公有领域的
// 作品（及少量获授权作品）。本 Bot 只做其公开目录的检索与回传，
// 不收录、不分发任何受版权保护的新书——这与盗版书库是两回事。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 19（外部 API）+ 模块 08（文件回传）+ 模块 01/02
// ============================================================

const GUTENDEX = "https://gutendex.com";

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

// ============================================================
// Gutendex 目录客户端
// Gutendex 是 Project Gutenberg 的非官方 JSON API 镜像，免 key。
// 书目对象：{ id, title, authors:[{name}], languages, download_count,
// formats: { "application/epub+zip": url, "application/pdf": url,
// "text/plain; charset=utf-8": url,...}}。
// 格式挑选口径：给用户 EPUB（阅读器最通用）/ PDF / TXT 三个按钮，
// 实际取 formats 里第一个匹配的键（同一格式可能带 charset 后缀）。
// ============================================================
async function gbFetch(path) {
  const r = await fetch(GUTENDEX + path, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Gutendex HTTP ${r.status}`);
  return r.json();
}
function pickFormats(book) {
  const out = {};
  for (const [mime, url] of Object.entries(book.formats || {})) {
    if (url.includes(".images") || url.endsWith(".zip")) continue;
    if (mime.startsWith("application/epub+zip")) out.epub = out.epub || url;
    else if (mime === "application/pdf") out.pdf = out.pdf || url;
    else if (mime.startsWith("text/plain")) out.txt = out.txt || url;
  }
  return out;
}
function bookCard(book) {
  const authors = (book.authors || []).map((a) => a.name).join("、") || "佚名";
  const langs = (book.languages || []).join("/") || "?";
  return `📚 《${book.title}》\n✍️ ${authors}\n🌐 语言：${langs} · ⬇️ 累计下载 ${book.download_count || 0}`;
}
function bookKeyboard(book) {
  const fmts = pickFormats(book);
  const row = [];
  if (fmts.epub)
    row.push({ text: "📗 EPUB", callback_data: `book:get:${book.id}:epub` });
  if (fmts.pdf)
    row.push({ text: "📕 PDF", callback_data: `book:get:${book.id}:pdf` });
  if (fmts.txt)
    row.push({ text: "📄 TXT", callback_data: `book:get:${book.id}:txt` });
  return {
    inline_keyboard: [
      row,
      [{ text: "⭐ 加入书架", callback_data: `book:shelf:${book.id}` }],
    ],
  };
}
async function getBook(id) {
  const data = await gbFetch(`/books?ids=${encodeURIComponent(id)}`);
  return (data.results || [])[0] || null;
}

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明" },
  { command: "search", description: "搜书 /search Pride" },
  { command: "random", description: "随机推荐一本公版书" },
  { command: "shelf", description: "我的书架" },
];
const COMMANDS_ADMIN = [
  { command: "gbstats", description: "书架统计（管理员）" },
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
      return new Response("gutenberg-library bot is running.", {
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

async function getShelf(env, uid) {
  const raw = await env.BOT_KV.get("shelf:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveShelf(env, uid, shelf) {
  await env.BOT_KV.put("shelf:" + uid, JSON.stringify(shelf));
}

// ============================================================
// 业务主流程
// /search 关键词检索（前 5 本逐本发卡）；书籍卡按钮：
// book:get:<id>:<格式> 取文件（先 HEAD 探大小，>50MB 回直链，
// 否则 sendDocument 传 URL，TG 拉不动时兜底直链）；
// book:shelf:<id> 收藏进书架；书架里 shelf:del:<id> 移除。
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
    const chatId = cq.message.chat.id;
    const uid = cq.from.id;

    if (data.startsWith("book:get:")) {
      const [, , id, fmt] = data.split(":");
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⏳ 正在取书…",
      });
      try {
        const book = await getBook(id);
        const url = book && pickFormats(book)[fmt];
        if (!url) throw new Error("这本书没有该格式");
        let size;
        try {
          const h = await fetch(url, { method: "HEAD" });
          size = Number(h.headers.get("content-length")) || undefined;
        } catch (e) {}
        const MB = 1024 * 1024;
        if (size && size > 50 * MB)
          return send(
            env,
            chatId,
            `📦 《${book.title}》这个文件约 ${(size / MB).toFixed(1)}MB，超过 Bot API 50MB 上限。\n直链：\n${url}`,
          );
        const r = await tg(env, "sendDocument", {
          chat_id: chatId,
          document: url,
          caption: `《${book.title}》\n来源：Project Gutenberg（公版书目）`,
        });
        if (!r.ok)
          return send(
            env,
            chatId,
            `😅 Telegram 没拉动文件，直链给你：\n${url}`,
          );
        return;
      } catch (e) {
        return send(
          env,
          chatId,
          `😵 取书失败：${String(e.message || e).slice(0, 200)}`,
        );
      }
    }

    if (data.startsWith("book:view:")) {
      const id = data.split(":")[2];
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      const book = await getBook(id).catch(() => null);
      if (!book) return send(env, chatId, "这本书的目录信息找不到了。");
      return send(env, chatId, bookCard(book), {
        reply_markup: bookKeyboard(book),
      });
    }

    if (data.startsWith("book:shelf:")) {
      const id = data.split(":")[2];
      const book = await getBook(id).catch(() => null);
      if (!book)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "没找到这本书",
          show_alert: true,
        });
      const shelf = await getShelf(env, uid);
      if (shelf.some((b) => String(b.id) === String(id)))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已经在书架上了",
        });
      shelf.push({ id: book.id, title: book.title });
      await saveShelf(env, uid, shelf);
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⭐ 已加入书架，/shelf 查看",
      });
    }

    if (data.startsWith("shelf:del:")) {
      const id = data.split(":")[2];
      const shelf = (await getShelf(env, uid)).filter(
        (b) => String(b.id) !== String(id),
      );
      await saveShelf(env, uid, shelf);
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已从书架移除",
      });
    }
    return;
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
      "📚 公版书库 Bot\n\n数据来自 Project Gutenberg（经 Gutendex 免费 API），只收录已进入公有领域的作品。\n\n/search <书名或作者> 搜书，如 /search Dickens\n/random 随机推荐一本\n/shelf 我的书架\n\n点书籍卡上的格式按钮，Bot 直接把电子书发进聊天。",
    );

  if (cmd === "/search") {
    const q = parts.slice(1).join(" ");
    if (!q)
      return send(env, chatId, "用法：/search <书名或作者>，如 /search Austen");
    try {
      const data = await gbFetch(`/books?search=${encodeURIComponent(q)}`);
      const books = (data.results || []).slice(0, 5);
      if (!books.length)
        return send(
          env,
          chatId,
          `没找到与「${q}」相关的公版书，换个关键词试试。`,
        );
      await send(
        env,
        chatId,
        `🔍 「${q}」找到 ${data.count} 本，展示前 ${books.length} 本：`,
      );
      for (const b of books)
        await send(env, chatId, bookCard(b), { reply_markup: bookKeyboard(b) });
      return;
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 检索失败：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (cmd === "/random") {
    try {
      // Gutendex 没有随机端点：随机翻一页目录取第一本，等效随机推荐
      const page = 1 + Math.floor(Math.random() * 500);
      const data = await gbFetch(`/books?page=${page}`);
      const book = (data.results || [])[0];
      if (!book)
        return send(env, chatId, "今天手气不好，没抽到书，再发一次 /random。");
      return send(env, chatId, "🎲 随机推荐\n\n" + bookCard(book), {
        reply_markup: bookKeyboard(book),
      });
    } catch (e) {
      return send(
        env,
        chatId,
        `😵 抽书失败：${String(e.message || e).slice(0, 150)}`,
      );
    }
  }

  if (cmd === "/shelf") {
    const shelf = await getShelf(env, uid);
    if (!shelf.length)
      return send(
        env,
        chatId,
        "📭 书架还是空的。搜到喜欢的书，点卡片上的「⭐ 加入书架」。",
      );
    for (const b of shelf) {
      await send(env, chatId, `⭐ 《${b.title}》`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📖 取这本", callback_data: `book:view:${b.id}` },
              { text: "🗑 移除", callback_data: `shelf:del:${b.id}` },
            ],
          ],
        },
      });
    }
    return;
  }

  if (cmd === "/gbstats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const list = await env.BOT_KV.list({ prefix: "shelf:", limit: 1000 });
    return send(env, chatId, `📊 有书架的用户：${list.keys.length} 人`);
  }
}
