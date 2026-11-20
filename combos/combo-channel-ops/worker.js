// ============================================================
// 组合 · 频道运营全家桶（01 发帖面板 + 05 投稿审核 + 02 双向客服）
// 单文件 · Cloudflare Workers · 无状态免数据库
// 分流规则（拼装的关键，见 docs/ASSEMBLY.md）：
// 管理员私聊：回复转发消息=回客服用户；/post=带按钮发帖；普通消息=发帖草稿预览
// 普通用户私聊：发来内容后 Bot 弹按钮问「投稿还是留言」，点选后才分流，
// 也可直接用 /tougao 内容、/liuyan 内容 免按钮直达
// 审核：投稿转到 REVIEW_CHAT_ID（或管理员），ok:/no: 按钮通过即发频道
// 网页面板：/panel 同 01（需 PANEL_KEY）
// 必填变量：BOT_TOKEN（Secret）、ADMIN_ID、CHANNEL_ID
// 选填：REVIEW_CHAT_ID、WEBHOOK_SECRET、PANEL_KEY、WELCOME_TEXT
// 前提：Bot 是 CHANNEL_ID 频道的管理员；用投稿审核时也要在审核群里。
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
const adminInbox = (env) => admins(env)[0];
const reviewChat = (env) => env.REVIEW_CHAT_ID || adminInbox(env);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const who = (u) =>
  `${u.first_name || ""}${u.username ? " (@" + u.username + ")" : ""} · ID ${u.id}`;

// ============================================================
// 【核心模块】链接按钮解析（来自 01）
// 把「文字 | https://链接」文本块解析成 inline 键盘，网页面板和 /post 共用。
// ============================================================
function parseButtons(block) {
  const rows = [];
  for (const line of String(block || "").split("\n")) {
    const m = line.trim().match(/^(.+?)\s*[|｜]\s*(https?:\/\/\S+)$/);
    if (m) rows.push([{ text: m[1].trim(), url: m[2].trim() }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// ============================================================
// 【核心模块】转发来源解析（来自 02）
// 从 forward_origin / forward_from 里提取原用户 ID，是管理员回复能找对人的关键。
// ============================================================
function originUserId(m) {
  const o = m?.forward_origin;
  if (o?.type === "user") return o.sender_user?.id;
  if (m?.forward_from) return m.forward_from.id;
  return null;
}

function panelHTML() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>频道发帖面板</title><style>body{font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px;background:#111;color:#eee}
textarea,input{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:10px;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{background:#c9a227;color:#111;border:0;padding:12px 20px;border-radius:8px;font-weight:700;cursor:pointer}label{font-size:14px;color:#bbb}</style></head>
<body><h2>📣 频道发帖面板（全家桶）</h2><form method="POST" action="/panel/publish">
<label>面板口令 PANEL_KEY</label><input name="key" type="password" required>
<label>正文（支持 HTML）</label><textarea name="text" rows="8" required></textarea>
<label>链接按钮（可选，每行：按钮文字 | https://链接）</label><textarea name="buttons" rows="3"></textarea>
<label><input type="checkbox" name="pin" value="1" style="width:auto"> 发布后置顶</label><br><button type="submit">发布到频道</button>
</form></body></html>`;
}

// ============================================================
// 【核心模块】Worker 入口与路由
// 处理健康检查、/setWebhook 一键挂载、网页面板、Webhook 密钥校验，并把更新分发给业务主流程。
// ============================================================
// ---------- Bot 命令菜单（部署时 /setWebhook 自动注册到输入框菜单） ----------
const COMMANDS = [
  { command: "start", description: "开始使用" },
  { command: "post", description: "发帖到频道" },
  { command: "tougao", description: "我要投稿" },
  { command: "liuyan", description: "我要留言" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("combo-channel-ops bot is running.", {
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
      const cm = await tg(env, "setMyCommands", { commands: COMMANDS });
      return Response.json({ setWebhook: hook, telegram: r, commands: cm });
    }
    if (url.pathname === "/panel" && request.method === "GET") {
      if (!env.PANEL_KEY)
        return new Response("网页面板未开启：请先设置 PANEL_KEY", {
          status: 403,
        });
      return new Response(panelHTML(), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (url.pathname === "/panel/publish" && request.method === "POST") {
      const form = await request.formData();
      if (!env.PANEL_KEY || form.get("key") !== env.PANEL_KEY)
        return new Response("口令错误", { status: 403 });
      const r = await tg(env, "sendMessage", {
        chat_id: env.CHANNEL_ID,
        text: String(form.get("text") || ""),
        parse_mode: "HTML",
        reply_markup: parseButtons(form.get("buttons")),
      });
      if (!r.ok)
        return new Response("发布失败：" + esc(r.description || ""), {
          status: 502,
        });
      if (form.get("pin"))
        ctx.waitUntil(
          tg(env, "pinChatMessage", {
            chat_id: env.CHANNEL_ID,
            message_id: r.result.message_id,
            disable_notification: true,
          }),
        );
      return new Response("✅ 已发布，消息 ID：" + r.result.message_id, {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
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

// ---------- 子流程：投稿（来自 05） ----------
async function submitToReview(env, fromChatId, messageId, submitter) {
  await send(env, reviewChat(env), `📥 新投稿 · 来自 ${who(submitter)}`);
  const fwd = await tg(env, "forwardMessage", {
    chat_id: reviewChat(env),
    from_chat_id: fromChatId,
    message_id: messageId,
  });
  if (!fwd.ok) return send(env, fromChatId, "⚠️ 投稿转发失败，请稍后再试。");
  await tg(env, "sendMessage", {
    chat_id: reviewChat(env),
    text: "👆 审核上面这篇投稿：",
    reply_to_message_id: fwd.result.message_id,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ 通过并发布",
            callback_data: `ok:${fwd.result.message_id}:${submitter.id}`,
          },
          {
            text: "❌ 拒绝",
            callback_data: `no:${fwd.result.message_id}:${submitter.id}`,
          },
        ],
      ],
    },
  });
  return send(
    env,
    fromChatId,
    "✅ 已提交审核，通过后会发布到频道并在这里通知你。",
  );
}
// ---------- 子流程：客服留言（来自 02） ----------
async function toSupport(env, fromChatId, messageId, user) {
  await send(
    env,
    adminInbox(env),
    `💬 新留言 · 来自 ${who(user)}\n回复下面那条转发消息即可回他；认不出时用 /reply ${user.id} 内容`,
  );
  const r = await tg(env, "forwardMessage", {
    chat_id: adminInbox(env),
    from_chat_id: fromChatId,
    message_id: messageId,
  });
  return send(
    env,
    fromChatId,
    r.ok
      ? "✅ 已转达管理员，回复会直接出现在这里。"
      : "⚠️ 转达失败，请稍后再试。",
  );
}

// ============================================================
// 【核心模块】业务主流程
// 全家桶分流中枢：回调按前缀分（pub/ok/no/pick），私聊按角色分（管理员=发帖+客服，普通用户=投稿/留言二选一）。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    const parts = String(cq.data || "").split(":");
    const act = parts[0];
    // 01 发布草稿
    if ((act === "pub" || act === "pubp") && isAdmin(env, cq.from.id)) {
      const r = await tg(env, "copyMessage", {
        chat_id: env.CHANNEL_ID,
        from_chat_id: cq.message.chat.id,
        message_id: Number(parts[1]),
      });
      if (!r.ok)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "发布失败：" + (r.description || ""),
          show_alert: true,
        });
      if (act === "pubp")
        await tg(env, "pinChatMessage", {
          chat_id: env.CHANNEL_ID,
          message_id: r.result.message_id,
          disable_notification: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 已发布",
      });
      return send(env, cq.message.chat.id, "✅ 已发布到频道。");
    }
    // 05 投稿审核
    if (act === "ok" || act === "no") {
      const reviewMsgId = parts[1],
        submitterId = parts[2];
      if (act === "ok") {
        const r = await tg(env, "copyMessage", {
          chat_id: env.CHANNEL_ID,
          from_chat_id: cq.message.chat.id,
          message_id: Number(reviewMsgId),
        });
        if (!r.ok)
          return tg(env, "answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "发布失败：" + (r.description || ""),
            show_alert: true,
          });
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "✅ 已发布",
        });
        if (submitterId)
          await send(
            env,
            submitterId,
            "🎉 你的投稿已通过审核并发布到频道，感谢投稿！",
          );
      } else {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已拒绝",
        });
        if (submitterId)
          await send(
            env,
            submitterId,
            "😢 你的投稿这次未通过，欢迎修改后再投。",
          );
      }
      return tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: act === "ok" ? "✅ 已发布到频道" : "❌ 已拒绝",
                callback_data: "done",
              },
            ],
          ],
        },
      });
    }
    // 用户选流：投稿 or 留言（data: pick:sub|sup:原聊天ID:原消息ID，用户身份取 cq.from 并校验聊天归属）
    if (act === "pick") {
      const [, mode, chatId, msgId] = parts;
      if (String(cq.from.id) !== String(chatId))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这不是你的消息",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      await tg(env, "deleteMessage", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
      });
      if (mode === "sub")
        return submitToReview(env, Number(chatId), Number(msgId), cq.from);
      return toSupport(env, Number(chatId), Number(msgId), cq.from);
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const text = msg.text || msg.caption || "";
  const userIsAdmin = isAdmin(env, msg.from.id);

  // ---------- 管理员私聊 ----------
  if (userIsAdmin) {
    if (msg.reply_to_message) {
      // 回客服用户（02）
      const uid =
        originUserId(msg.reply_to_message) ||
        (msg.reply_to_message.text || "").match(/ID\s*(\d{5,})/)?.[1];
      if (uid) {
        const r = await tg(env, "copyMessage", {
          chat_id: uid,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        });
        return send(
          env,
          msg.chat.id,
          r.ok ? "✅ 已送达用户 " + uid : "发送失败：" + (r.description || ""),
        );
      }
    }
    const rm = text.match(/^\/reply\s+(\d{5,})\s+([\s\S]+)/);
    if (rm) {
      const r = await send(env, rm[1], rm[2]);
      return send(env, msg.chat.id, r.ok ? "✅ 已送达" : "发送失败");
    }
    if (text.startsWith("/start") || text.startsWith("/help"))
      return send(
        env,
        msg.chat.id,
        "🛠 管理员：\n· 直接发内容 = 发帖草稿（预览后点发布）\n· /post 带按钮直发（正文后另起一行 ---，再跟「按钮文字 | 链接」）\n· 回复用户留言的转发消息 = 回客服\n· 网页面板：Worker 地址 + /panel\n投稿会进审核队列，点按钮通过即发频道。",
      );
    if (text.startsWith("/post")) {
      const body = text.replace(/^\/post(@\w+)?\s*/, "");
      const [main, btnBlock] = body.split(/\n---\n?/);
      if (!main?.trim())
        return send(env, msg.chat.id, "正文为空，格式见 /help");
      const r = await tg(env, "sendMessage", {
        chat_id: env.CHANNEL_ID,
        text: main.trim(),
        reply_markup: parseButtons(btnBlock),
      });
      return send(
        env,
        msg.chat.id,
        r.ok ? "✅ 已发布到频道。" : "发布失败：" + (r.description || ""),
      );
    }
    if (text.startsWith("/")) return;
    // 普通消息 = 发帖草稿（01）
    return tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "👆 待发布内容，确认后点按钮：",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 发布到频道", callback_data: `pub:${msg.message_id}` },
            { text: "📌 发布并置顶", callback_data: `pubp:${msg.message_id}` },
          ],
        ],
      },
    });
  }

  // ---------- 普通用户私聊 ----------
  if (text.startsWith("/start"))
    return send(
      env,
      msg.chat.id,
      (env.WELCOME_TEXT || "👋 欢迎！") +
        "\n\n直接把内容发给我，然后选它是「投稿」还是「给管理员留言」；也可以用命令直达：\n/tougao 你的稿件（文字稿）\n/liuyan 你想说的话",
    );
  if (text.startsWith("/tougao")) {
    const body = text.replace(/^\/tougao(@\w+)?\s*/, "");
    if (!body)
      return send(
        env,
        msg.chat.id,
        "把稿件跟在命令后面，或直接发内容再点「投稿」按钮。",
      );
    return submitToReview(env, msg.chat.id, msg.message_id, msg.from);
  }
  if (text.startsWith("/liuyan")) {
    if (!text.replace(/^\/liuyan(@\w+)?\s*/, ""))
      return send(env, msg.chat.id, "把留言跟在命令后面。");
    return toSupport(env, msg.chat.id, msg.message_id, msg.from);
  }
  if (text.startsWith("/"))
    return send(
      env,
      msg.chat.id,
      "可用：/tougao 投稿、/liuyan 留言，或直接发内容再选。",
    );
  // 普通内容：弹按钮让用户选流向
  return tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: "收到啦，这条是想？",
    reply_to_message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📮 投稿到频道",
            callback_data: `pick:sub:${msg.chat.id}:${msg.message_id}`,
          },
          {
            text: "💬 给管理员留言",
            callback_data: `pick:sup:${msg.chat.id}:${msg.message_id}`,
          },
        ],
      ],
    },
  });
}
