// ============================================================
// 56 课程 / LMS Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：把课时序列装进 Bot 里卖课/带学：
// 管理员 /addcourse 建课、/addlesson 逐课加内容（可带一道小测验）；
// 学员 /courses 选课 → 按顺序学，每课的测验答对才解锁下一课；
// 付费课走人工确认收款（15 号式 payok/payno），进度存 learn: 键。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 管理员数字 ID（逗号分隔）：建课、加课时、确认收款
// PAY_INFO 付费课的收款说明（收款码链接/账号），学员点「我已付款」前展示
// 键设计：course:<课程ID> 课程与课时；learn:<uid>:<课程ID> 学员进度；
// fsm:<uid> 管理员建课向导状态。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 20（FSM）+ 模块 18（竞答）+ 模块 13（支付确认）+ 模块 01
// ============================================================

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

// ============================================================
// 课程与进度存储（KV）
// course:<cid> = { id, title, price, lessons: [{ title, text, quiz}]}
// quiz = null 或 { q, options: [], answer: 正确项下标}
// learn:<uid>:<cid> = { idx: 已解锁到的课时序号, paid, done}
// idx 的含义是「当前能学到第几课」：答对测验/点学完 → idx+1；
// idx 达到课时总数即结课。学员永远看不到 idx 之后的课时内容。
// ============================================================
async function getCourse(env, cid) {
  const raw = await env.BOT_KV.get("course:" + cid);
  return raw ? JSON.parse(raw) : null;
}
async function saveCourse(env, c) {
  await env.BOT_KV.put("course:" + c.id, JSON.stringify(c));
}
async function listCourses(env) {
  const list = await env.BOT_KV.list({ prefix: "course:", limit: 200 });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}
async function getProgress(env, uid, cid) {
  const raw = await env.BOT_KV.get(`learn:${uid}:${cid}`);
  return raw ? JSON.parse(raw) : { idx: 0, paid: false, done: false };
}
async function saveProgress(env, uid, cid, p) {
  await env.BOT_KV.put(`learn:${uid}:${cid}`, JSON.stringify(p));
}

// ============================================================
// 课时渲染与解锁推进
// 一课一屏：标题 + 正文；有测验就把选项做成按钮（lesson:q:），
// 答对才推进；没测验给「学完，下一课」按钮（lesson:next:）。
// 推进逻辑只此一份，按钮回调和命令都走它，避免两处口径不一致。
// ============================================================
async function showLesson(env, chatId, uid, cid) {
  const c = await getCourse(env, cid);
  if (!c) return send(env, chatId, "课程不存在了。");
  const p = await getProgress(env, uid, cid);
  if (c.price > 0 && !p.paid) return showPaywall(env, chatId, uid, c);
  if (p.idx >= c.lessons.length) {
    if (!p.done) {
      p.done = true;
      await saveProgress(env, uid, cid, p);
    }
    return send(
      env,
      chatId,
      `🎉 《${c.title}》全部 ${c.lessons.length} 课已学完，恭喜结课！`,
    );
  }
  const i = p.idx;
  const les = c.lessons[i];
  const head = `📖 《${c.title}》 · 第 ${i + 1}/${c.lessons.length} 课\n\n\n${les.text}`;
  if (les.quiz) {
    const kb = les.quiz.options.map((op, oi) => [
      { text: op, callback_data: `lesson:q:${cid}:${i}:${oi}` },
    ]);
    return send(
      env,
      chatId,
      `${head}\n\n❓ 小测验：${les.quiz.q}\n答对才能解锁下一课。`,
      {
        reply_markup: { inline_keyboard: kb },
      },
    );
  }
  return send(env, chatId, head, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ 学完，下一课", callback_data: `lesson:next:${cid}` }],
      ],
    },
  });
}
async function showPaywall(env, chatId, uid, c) {
  return send(
    env,
    chatId,
    `🔒 《${c.title}》是付费课（${c.price} 元，共 ${c.lessons.length} 课）。\n${env.PAY_INFO || "请联系管理员获取收款方式，付款后点下方按钮。"}\n付款后点「我已付款」，管理员确认收款后自动解锁。`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 我已付款", callback_data: `lesson:paid:${c.id}` }],
        ],
      },
    },
  );
}

// ============================================================
// 管理员白名单与分级命令菜单
// ============================================================
const COMMANDS_USER = [
  { command: "courses", description: "课程列表" },
  { command: "myprogress", description: "我的学习进度" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "addcourse", description: "新建课程" },
  { command: "addlesson", description: "加课时 /addlesson <课程ID>" },
  { command: "delcourse", description: "删课程 /delcourse <课程ID>" },
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
      return new Response("course-lms bot is running.", {
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
// 回调分三家：lesson: 学员学习；payok:/payno: 管理员确认收款（模块 13 约定）。
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

    if (data.startsWith("payok:") || data.startsWith("payno:")) {
      if (!isAdmin(env, uid))
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "只有管理员能确认收款",
          show_alert: true,
        });
      const [, cid, buyer] = data.split(":");
      const c = await getCourse(env, cid);
      if (data.startsWith("payok:")) {
        const p = await getProgress(env, Number(buyer), cid);
        p.paid = true;
        await saveProgress(env, Number(buyer), cid, p);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "✅ 已确认，学员已解锁",
        });
        await send(
          env,
          Number(buyer),
          `✅ 管理员已确认收款，《${c?.title || cid}》已解锁，回到课程里继续学吧：/courses`,
        );
      } else {
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已拒绝",
        });
        await send(
          env,
          Number(buyer),
          `⚠️ 《${c?.title || cid}》的付款未被确认，请核对付款信息或联系管理员。`,
        );
      }
      return;
    }

    if (!data.startsWith("lesson:")) return;
    const parts = data.split(":");
    const act = parts[1];
    if (act === "open") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return showLesson(env, chatId, uid, parts[2]);
    }
    if (act === "paid") {
      const c = await getCourse(env, parts[2]);
      if (!c)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "课程不存在了",
          show_alert: true,
        });
      const admins = String(env.ADMIN_ID || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (!admins.length)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "未配置管理员，无法确认收款",
          show_alert: true,
        });
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "已通知管理员确认，请稍候",
      });
      for (const a of admins) {
        await send(
          env,
          a,
          `💰 付费课收款待确认\n课程：《${c.title}》（${c.price} 元）\n学员：${cq.from.first_name || ""}（ID ${uid}）\n确认已收到款再点通过。`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ 已收款，解锁",
                    callback_data: `payok:${c.id}:${uid}`,
                  },
                  { text: "❌ 未收到", callback_data: `payno:${c.id}:${uid}` },
                ],
              ],
            },
          },
        );
      }
      return;
    }
    if (act === "next") {
      const cid = parts[2];
      const p = await getProgress(env, uid, cid);
      p.idx += 1;
      await saveProgress(env, uid, cid, p);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 已解锁下一课",
      });
      return showLesson(env, chatId, uid, cid);
    }
    if (act === "q") {
      const cid = parts[2];
      const li = Number(parts[3]);
      const oi = Number(parts[4]);
      const c = await getCourse(env, cid);
      const p = await getProgress(env, uid, cid);
      const les = c?.lessons?.[li];
      if (!les?.quiz || p.idx !== li)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "这道题已过期，回到当前课时",
          show_alert: true,
        });
      if (oi !== les.quiz.answer)
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "❌ 答错了，再想想（可以重答）",
          show_alert: true,
        });
      p.idx = li + 1;
      await saveProgress(env, uid, cid, p);
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ 答对了，下一课已解锁",
      });
      return showLesson(env, chatId, uid, cid);
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
      "🎓 课程 Bot\n\n/courses 看课程列表，点课程按顺序学：每课学完（有测验的要答对）才解锁下一课。\n/myprogress 查我的进度。",
    );

  if (cmd === "/courses") {
    const rows = await listCourses(env);
    if (!rows.length) return send(env, chatId, "还没有课程，敬请期待。");
    const kb = [];
    const lines = rows.map((c, i) => {
      kb.push([
        { text: `📖 ${c.title}`, callback_data: `lesson:open:${c.id}` },
      ]);
      return `${i + 1}. 《${c.title}》 · ${c.lessons.length} 课 · ${c.price > 0 ? c.price + " 元" : "免费"}`;
    });
    return send(env, chatId, "🎓 课程列表\n\n" + lines.join("\n"), {
      reply_markup: { inline_keyboard: kb },
    });
  }

  if (cmd === "/myprogress") {
    const list = await env.BOT_KV.list({ prefix: `learn:${uid}:`, limit: 200 });
    if (!list.keys.length)
      return send(env, chatId, "你还没开始任何课程。/courses 选一门吧。");
    const lines = [];
    for (const k of list.keys) {
      const cid = k.name.split(":")[2];
      const c = await getCourse(env, cid);
      const p = JSON.parse((await env.BOT_KV.get(k.name)) || "{}");
      if (!c) continue;
      lines.push(
        `《${c.title}》：${p.done ? "✅ 已结课" : `学到第 ${Math.min(p.idx + 1, c.lessons.length)}/${c.lessons.length} 课`}${c.price > 0 && !p.paid ? "（未解锁）" : ""}`,
      );
    }
    return send(
      env,
      chatId,
      "📊 我的进度\n\n" + (lines.join("\n") || "暂无记录"),
    );
  }

  // ---------- 管理员建课向导 ----------
  if (isAdmin(env, uid)) {
    if (cmd === "/addcourse") {
      await env.BOT_KV.put(
        "fsm:" + uid,
        JSON.stringify({ step: "c_title", at: Date.now() }),
        { expirationTtl: 3600 },
      );
      return send(env, chatId, "新建课程：先发课程标题。");
    }
    if (cmd === "/addlesson") {
      const cid = text.split(/ +/)[1];
      const c = cid && (await getCourse(env, cid));
      if (!c)
        return send(
          env,
          chatId,
          "用法：/addlesson <课程ID>（课程 ID 在建课成功时回给你，也能在 /courses 的按钮数据里看）。",
        );
      await env.BOT_KV.put(
        "fsm:" + uid,
        JSON.stringify({ step: "l_title", cid, at: Date.now() }),
        { expirationTtl: 3600 },
      );
      return send(env, chatId, `给《${c.title}》加课时：先发课时标题。`);
    }
    if (cmd === "/delcourse") {
      const cid = text.split(/ +/)[1];
      if (!cid) return send(env, chatId, "用法：/delcourse <课程ID>");
      await env.BOT_KV.delete("course:" + cid);
      return send(env, chatId, "🗑 课程已删除（学员进度记录保留但不再展示）。");
    }
  }

  // 向导消息（非命令才进）
  const fsmRaw = await env.BOT_KV.get("fsm:" + uid);
  if (fsmRaw && isAdmin(env, uid) && !cmd.startsWith("/")) {
    const st = JSON.parse(fsmRaw);
    const put = (next) =>
      env.BOT_KV.put(
        "fsm:" + uid,
        JSON.stringify({ ...st, ...next, at: Date.now() }),
        { expirationTtl: 3600 },
      );
    if (st.step === "c_title") {
      await put({ step: "c_price", title: text.slice(0, 100) });
      return send(env, chatId, "发课程价格：0 = 免费；付费课发数字（如 99）。");
    }
    if (st.step === "c_price") {
      const price = Number(text);
      if (Number.isNaN(price) || price < 0)
        return send(env, chatId, "价格要是数字（0 表示免费），重发。");
      const c = { id: newId(), title: st.title, price, lessons: [] };
      await saveCourse(env, c);
      await env.BOT_KV.delete("fsm:" + uid);
      return send(
        env,
        chatId,
        `✅ 课程《${c.title}》已创建，课程 ID：${c.id}\n用 /addlesson ${c.id} 逐课加内容。`,
      );
    }
    if (st.step === "l_title") {
      await put({ step: "l_text", ltitle: text.slice(0, 100) });
      return send(
        env,
        chatId,
        "发课时正文（纯文本，一条消息发完；长内容可拆成多课时）。",
      );
    }
    if (st.step === "l_text") {
      await put({ step: "l_quiz", ltext: text.slice(0, 3800) });
      return send(
        env,
        chatId,
        "加一道小测验？发「跳过」表示不加；要加就按格式发：\n问题|选项1|选项2|选项3|正确序号\n例：水的化学式是？|H2O|CO2|O2|1",
      );
    }
    if (st.step === "l_quiz") {
      const c = await getCourse(env, st.cid);
      if (!c) {
        await env.BOT_KV.delete("fsm:" + uid);
        return send(env, chatId, "课程不存在了，向导结束。");
      }
      let quiz = null;
      if (text !== "跳过") {
        const parts = text.split("|").map((x) => x.trim());
        const ans = Number(parts[parts.length - 1]);
        if (
          parts.length < 4 ||
          Number.isNaN(ans) ||
          ans < 1 ||
          ans > parts.length - 2
        )
          return send(
            env,
            chatId,
            "格式不对：问题|选项1|选项2|…|正确序号，或发「跳过」。",
          );
        quiz = { q: parts[0], options: parts.slice(1, -1), answer: ans - 1 };
      }
      c.lessons.push({ title: st.ltitle, text: st.ltext, quiz });
      await saveCourse(env, c);
      await env.BOT_KV.delete("fsm:" + uid);
      return send(
        env,
        chatId,
        `✅ 已加第 ${c.lessons.length} 课《${st.ltitle}》${quiz ? "（带测验）" : ""}。继续 /addlesson ${c.id} 加下一课。`,
      );
    }
  }
}
