// ============================================================
// 77 相亲交友 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// /profile 走 FSM 建卡（18+ 确认 → 性别 → 想找 → 年龄 → 城市 →
// 介绍 → 照片）；/browse 滑动浏览匹配的卡片（喜欢/跳过/举报）；
// 双向喜欢即配对成功，互推联系方式按钮；/matches 看配对。
//
// 1. 未成年禁入：建卡第一步必须点「我已满 18 岁」确认，未确认
// 连表单都进不去；年龄填写 <18 直接拒绝并清状态。
// 2. 举报自动封禁：每张卡带举报按钮，被不同用户举报达阈值
// （DATE_REPORT_LIMIT，默认 3）自动封禁下架并通知管理员。
// 3. 敏感词过滤：介绍/城市过 CONFIG 敏感词表，命中直接打回。
// 4. 媒体可关：DATE_MEDIA_OFF=1 时全站禁用照片（建卡跳过照片步、
// 卡片纯文字），适合先文字版冷启动。
// 5. 联系方式只在双向喜欢后才互推，且只推 Telegram 公开用户名
// 链接——Bot 不存、不转交任何人的手机号等私密信息。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// DATE_REPORT_LIMIT 举报封禁阈值，默认 3
// DATE_MEDIA_OFF =1 禁用照片
// ADMIN_ID 管理员数字 ID（封禁通知、/datestats、/dateban 用）
// WEBHOOK_SECRET Webhook 密钥
// ⚠️ 需要 KV：变量名 BOT_KV。
// 键设计：date:prof:<uid> 档案；date:step:<uid> FSM 状态；
// date:like:<uid> 我喜欢的人；date:seen:<uid> 我看过的卡；
// date:rep:<uid> 举报者名单；date:ban:<uid> 封禁标记。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 50（匹配队列/举报封禁骨架）+ 模块 20（FSM）+ 01/02
// ============================================================

// ============================================================
// 敏感词表（CONFIG）
// 建卡的介绍与城市字段过这张表：命中即打回重填。词表故意只放
// 最明显的引流/诈骗/色情招揽词——过滤是第一道闸，真正的防线是
// 举报封禁与管理员巡查，别指望词表拦住所有变体。
// ============================================================
const BAD_WORDS = [
  "加微信",
  "加我微信",
  "vx",
  "威信",
  "代充",
  "刷单",
  "博彩",
  "贷款",
  "裸聊",
  "约炮",
  "外围",
  "上门服务",
  "投资群",
  "带你赚钱",
];
function hasBadWord(s) {
  const t = String(s || "").toLowerCase();
  return BAD_WORDS.some((w) => t.includes(w.toLowerCase()));
}

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

async function kvGet(env, key, fallback) {
  const raw = await env.BOT_KV.get(key);
  return raw ? JSON.parse(raw) : fallback;
}
const kvPut = (env, key, val) => env.BOT_KV.put(key, JSON.stringify(val));
const isBanned = async (env, uid) =>
  Boolean(await env.BOT_KV.get("date:ban:" + uid));

// ============================================================
// 管理员白名单与分级命令菜单
// ADMIN_ID 填数字 ID（逗号隔开），菜单分级与 isAdmin 校验都认它。
// 默认 scope 注册 COMMANDS_USER；管理员再用 scope=chat 注册全集。
// 菜单隐藏只是体验层，真正拦截靠业务里管理员命令的 isAdmin 判断。
// ============================================================
const COMMANDS_USER = [
  { command: "start", description: "使用说明与安全须知" },
  { command: "profile", description: "建卡 / 看我的卡" },
  { command: "browse", description: "浏览卡片" },
  { command: "matches", description: "我的配对" },
  { command: "delprofile", description: "删除我的卡" },
];
const COMMANDS_ADMIN = [
  { command: "datestats", description: "交友统计（管理员）" },
  { command: "dateban", description: "手动封禁 /dateban <uid>（管理员）" },
  { command: "dateunban", description: "解封 /dateunban <uid>（管理员）" },
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
      return new Response("dating-match bot is running.", {
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
// 档案卡渲染与候选挑选
// 卡片 = 照片（未关媒体且有照片时 sendPhoto）+ 文案（性别/年龄/
// 城市/介绍）+ 按钮行（喜欢/跳过/举报，回调 date: 前缀）。
// 候选挑选：性别互配（我的 seek 对上对方 gender 且反之）、
// 排除自己/已封禁/已看过（seen，含喜欢与跳过）。名单从
// date:prof: 前缀全量扫——千级档案内没问题，再大要加索引。
// ============================================================
function cardText(p) {
  const g = p.gender === "M" ? "♂️ 男" : "♀️ 女";
  return `${g} · ${p.age} 岁 · ${p.city}\n\n${p.bio}`;
}
function cardKeyboard(targetUid) {
  return {
    inline_keyboard: [
      [
        { text: "❤️ 喜欢", callback_data: `date:like:${targetUid}` },
        { text: "⏭ 跳过", callback_data: `date:pass:${targetUid}` },
        { text: "🚩 举报", callback_data: `date:report:${targetUid}` },
      ],
    ],
  };
}
async function showCard(env, chatId, targetUid, prof) {
  const mediaOff = env.DATE_MEDIA_OFF === "1";
  if (!mediaOff && prof.photo) {
    const r = await tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: prof.photo,
      caption: cardText(prof),
      reply_markup: cardKeyboard(targetUid),
    });
    if (r.ok) return;
  }
  return send(env, chatId, cardText(prof), {
    reply_markup: cardKeyboard(targetUid),
  });
}
async function nextCandidate(env, uid, myProf) {
  const seen = await kvGet(env, "date:seen:" + uid, []);
  const seenSet = new Set(seen.map(String));
  const list = await env.BOT_KV.list({ prefix: "date:prof:", limit: 1000 });
  for (const k of list.keys) {
    const other = k.name.slice("date:prof:".length);
    if (other === String(uid) || seenSet.has(other)) continue;
    if (await isBanned(env, other)) continue;
    const p = await kvGet(env, k.name, null);
    if (!p) continue;
    const genderFit =
      (myProf.seek === "A" || myProf.seek === p.gender) &&
      (p.seek === "A" || p.seek === myProf.gender);
    if (genderFit) return { uid: other, prof: p };
  }
  return null;
}
async function markSeen(env, uid, targetUid) {
  const seen = await kvGet(env, "date:seen:" + uid, []);
  if (!seen.map(String).includes(String(targetUid))) {
    seen.push(targetUid);
    await kvPut(env, "date:seen:" + uid, seen.slice(-500));
  }
}

// ============================================================
// 举报与自动封禁
// 举报按「不同举报者」计数（同一人重复点不叠加）；达阈值
// （DATE_REPORT_LIMIT 默认 3）→ 写 date:ban 标记 + 删档案下架
// + 通知全部管理员。管理员可用 /dateunban 解封（档案需重建）。
// ============================================================
async function reportUser(env, reporterId, targetUid) {
  const reps = await kvGet(env, "date:rep:" + targetUid, []);
  if (!reps.map(String).includes(String(reporterId))) reps.push(reporterId);
  await kvPut(env, "date:rep:" + targetUid, reps);
  const limit = Number(env.DATE_REPORT_LIMIT) || 3;
  if (reps.length >= limit && !(await isBanned(env, targetUid))) {
    await env.BOT_KV.put("date:ban:" + targetUid, "1");
    await env.BOT_KV.delete("date:prof:" + targetUid);
    await env.BOT_KV.delete("date:step:" + targetUid);
    for (const a of admins(env))
      await send(
        env,
        a,
        `🚨 用户 ${targetUid} 被 ${reps.length} 名不同用户举报，已自动封禁并下架档案。解封：/dateunban ${targetUid}`,
      );
    return true;
  }
  return false;
}

// ============================================================
// 建卡 FSM
// 步骤存 date:step:<uid> = {step, data}：
// age（按钮确认 18+）→ gender（按钮）→ seek（按钮）→
// ageNum（文本，校验 18-99）→ city（文本）→ bio（文本，过敏感词）
// → photo（照片消息或按钮跳过；媒体关闭时自动跳过）→ 落 date:prof。
// 每一步都可 /profile 重新开始；被封禁者全程拦截。
// ============================================================
async function startFsm(env, chatId, uid) {
  await kvPut(env, "date:step:" + uid, { step: "age", data: {} });
  return send(
    env,
    chatId,
    "🔞 安全确认（必须）\n\n本 Bot 仅限 18 岁以上成年人使用。未成年人禁止建卡与浏览，冒充成年人建卡一经举报立即封禁。",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 我已满 18 岁", callback_data: "date:age:yes" },
            { text: "❌ 我未满 18 岁", callback_data: "date:age:no" },
          ],
        ],
      },
    },
  );
}
async function finishProfile(env, chatId, uid, from, data) {
  const prof = {
    gender: data.gender,
    seek: data.seek,
    age: data.age,
    city: data.city,
    bio: data.bio,
    photo: data.photo || null,
    name: from.first_name || "",
    username: from.username || "",
    t: Date.now(),
  };
  await kvPut(env, "date:prof:" + uid, prof);
  await env.BOT_KV.delete("date:step:" + uid);
  await send(env, chatId, "🎉 建卡成功！你的卡片长这样：");
  return showCard(env, chatId, uid, prof);
}

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
    if (!data.startsWith("date:")) return;
    const uid = cq.from.id;
    const chatId = cq.message.chat.id;
    if (await isBanned(env, uid))
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "你的账号已被封禁",
        show_alert: true,
      });
    const [, act, arg] = data.split(":");

    // —— FSM 按钮步 ——
    const st = await kvGet(env, "date:step:" + uid, null);
    if (act === "age" && st?.step === "age") {
      if (arg === "no") {
        await env.BOT_KV.delete("date:step:" + uid);
        return tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "未满 18 岁不能使用本 Bot",
          show_alert: true,
        });
      }
      st.step = "gender";
      await kvPut(env, "date:step:" + uid, st);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(env, chatId, "你的性别是？", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "♂️ 男", callback_data: "date:g:M" },
              { text: "♀️ 女", callback_data: "date:g:F" },
            ],
          ],
        },
      });
    }
    if (act === "g" && st?.step === "gender") {
      st.data.gender = arg;
      st.step = "seek";
      await kvPut(env, "date:step:" + uid, st);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(env, chatId, "你想找？", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "♂️ 男生", callback_data: "date:s:M" },
              { text: "♀️ 女生", callback_data: "date:s:F" },
              { text: "🌈 都可以", callback_data: "date:s:A" },
            ],
          ],
        },
      });
    }
    if (act === "s" && st?.step === "seek") {
      st.data.seek = arg;
      st.step = "ageNum";
      await kvPut(env, "date:step:" + uid, st);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return send(env, chatId, "你今年多少岁？直接发数字（如 26）。");
    }
    if (act === "photo" && arg === "skip" && st?.step === "photo") {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return finishProfile(env, chatId, uid, cq.from, st.data);
    }

    // —— 浏览动作 ——
    if (act === "like" || act === "pass" || act === "report") {
      const target = arg;
      // 喜欢/跳过必须先有自己的卡片：没建卡的账号点喜欢会污染对方的 like 列表、造出幽灵配对（举报不设此限）
      if (act !== "report") {
        const myProf = await kvGet(env, "date:prof:" + uid, null);
        if (!myProf) {
          await tg(env, "answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "先建好你的卡片（/profile）再来哦",
            show_alert: true,
          });
          return;
        }
      }
      await markSeen(env, uid, target);
      if (act === "report") {
        const banned = await reportUser(env, uid, target);
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: banned ? "已举报，该用户已被自动封禁" : "已举报，感谢反馈",
        });
      } else if (act === "like") {
        const likes = await kvGet(env, "date:like:" + uid, []);
        if (!likes.map(String).includes(String(target))) {
          likes.push(target);
          await kvPut(env, "date:like:" + uid, likes);
        }
        await tg(env, "answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "❤️ 已喜欢",
        });
        const theirLikes = await kvGet(env, "date:like:" + target, []);
        if (theirLikes.map(String).includes(String(uid))) {
          // 双向喜欢 → 配对：给双方推联系方式按钮
          const me = await kvGet(env, "date:prof:" + uid, null);
          const them = await kvGet(env, "date:prof:" + target, null);
          await notifyMatch(env, uid, them);
          await notifyMatch(env, target, me);
        }
      } else {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      }
      // 自动翻到下一张
      const myProf = await kvGet(env, "date:prof:" + uid, null);
      if (!myProf) return;
      const next = await nextCandidate(env, uid, myProf);
      if (next) return showCard(env, chatId, next.uid, next.prof);
      return send(env, chatId, "暂时没有更多卡片了，过段时间再来 /browse。");
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

  if ((await isBanned(env, uid)) && !isAdmin(env, uid))
    return send(
      env,
      chatId,
      "🚫 你的账号已被封禁（多次被举报或违反规则），无法使用本 Bot。",
    );

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "💘 相亲交友 Bot\n\n/profile 建卡（需 18+ 确认）\n/browse 浏览卡片，喜欢/跳过/举报\n双向喜欢即配对，配对后互推联系方式\n/matches 我的配对 · /delprofile 删卡\n\n🛡️ 安全须知：仅限成年人；不要在介绍里留微信/电话等联系方式（会被敏感词拦）；不要给任何人转账——以恋爱为名索要钱财、投资、代充的都是诈骗，发现请点卡片上的🚩举报。",
    );

  if (cmd === "/dateban" || cmd === "/dateunban") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能用。");
    const target = parts[1];
    if (!target) return send(env, chatId, `用法：${cmd} <用户ID>`);
    if (cmd === "/dateban") {
      await env.BOT_KV.put("date:ban:" + target, "1");
      await env.BOT_KV.delete("date:prof:" + target);
      return send(env, chatId, `已封禁 ${target} 并下架其档案。`);
    }
    await env.BOT_KV.delete("date:ban:" + target);
    return send(env, chatId, `已解封 ${target}（档案需对方重新建卡）。`);
  }

  if (cmd === "/datestats") {
    if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有管理员能看统计。");
    const profs = await env.BOT_KV.list({ prefix: "date:prof:", limit: 1000 });
    const bans = await env.BOT_KV.list({ prefix: "date:ban:", limit: 1000 });
    return send(
      env,
      chatId,
      `📊 档案 ${profs.keys.length} 张 · 已封禁 ${bans.keys.length} 人`,
    );
  }

  if (cmd === "/delprofile") {
    await env.BOT_KV.delete("date:prof:" + uid);
    await env.BOT_KV.delete("date:step:" + uid);
    return send(env, chatId, "已删除你的卡片。/profile 可重新建卡。");
  }

  if (cmd === "/profile") {
    const prof = await kvGet(env, "date:prof:" + uid, null);
    if (prof) {
      await send(
        env,
        chatId,
        "你的卡片（重新建卡直接再发一次 /profile 开始）：",
      );
      return showCard(env, chatId, uid, prof);
    }
    return startFsm(env, chatId, uid);
  }

  if (cmd === "/matches") {
    const likes = await kvGet(env, "date:like:" + uid, []);
    const matched = [];
    for (const t of likes) {
      const their = await kvGet(env, "date:like:" + t, []);
      if (their.map(String).includes(String(uid))) matched.push(t);
    }
    if (!matched.length)
      return send(
        env,
        chatId,
        "还没有配对。去 /browse 多看看，互相喜欢才会配对。",
      );
    for (const t of matched) {
      const p = await kvGet(env, "date:prof:" + t, null);
      if (p) await notifyMatch(env, chatId, p, true);
    }
    return;
  }

  if (cmd === "/browse") {
    const prof = await kvGet(env, "date:prof:" + uid, null);
    if (!prof) return send(env, chatId, "先建卡才能浏览：发 /profile。");
    const next = await nextCandidate(env, uid, prof);
    if (!next)
      return send(
        env,
        chatId,
        "暂时没有符合的卡片了（都看过了或人数还少），过段时间再来。",
      );
    return showCard(env, chatId, next.uid, next.prof);
  }

  // —— FSM 文本/照片步 ——
  const st = await kvGet(env, "date:step:" + uid, null);
  if (st) {
    if (st.step === "ageNum") {
      const age = Number(text);
      if (!Number.isInteger(age) || age < 18 || age > 99) {
        if (Number.isInteger(age) && age < 18) {
          await env.BOT_KV.delete("date:step:" + uid);
          return send(env, chatId, "🚫 未满 18 岁不能使用本 Bot，建卡已取消。");
        }
        return send(env, chatId, "发一个 18-99 的数字就行，如 26。");
      }
      st.data.age = age;
      st.step = "city";
      await kvPut(env, "date:step:" + uid, st);
      return send(env, chatId, "你在哪个城市？如：上海");
    }
    if (st.step === "city") {
      if (!text || hasBadWord(text))
        return send(
          env,
          chatId,
          "城市名不对（不能为空或含违规词），重新发一个。",
        );
      st.data.city = text.slice(0, 20);
      st.step = "bio";
      await kvPut(env, "date:step:" + uid, st);
      return send(env, chatId, "写一句自我介绍（别留微信/电话，会被拦）：");
    }
    if (st.step === "bio") {
      if (!text) return send(env, chatId, "介绍不能为空，发一句话介绍自己。");
      if (hasBadWord(text))
        return send(
          env,
          chatId,
          "🚫 介绍里有违规词（联系方式/招揽类），换一句干净的。",
        );
      st.data.bio = text.slice(0, 200);
      if (env.DATE_MEDIA_OFF === "1")
        return finishProfile(env, chatId, uid, msg.from, st.data);
      st.step = "photo";
      await kvPut(env, "date:step:" + uid, st);
      return send(env, chatId, "发一张你的照片当头像，或点按钮跳过：", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⏭ 跳过照片", callback_data: "date:photo:skip" }],
          ],
        },
      });
    }
    if (st.step === "photo") {
      const photo = msg.photo?.[msg.photo.length - 1];
      if (!photo)
        return send(env, chatId, "发一张照片，或点上面的「⏭ 跳过照片」。");
      st.data.photo = photo.file_id;
      return finishProfile(env, chatId, uid, msg.from, st.data);
    }
  }
}

// 配对通知：只推 Telegram 公开用户名链接，不经手任何私密联系方式
async function notifyMatch(env, chatId, otherProf, quiet) {
  if (!otherProf) return;
  const kb = otherProf.username
    ? {
        inline_keyboard: [
          [
            {
              text: "💬 去打个招呼",
              url: `https://t.me/${otherProf.username}`,
            },
          ],
        ],
      }
    : undefined;
  return send(
    env,
    chatId,
    `💘 配对成功！\n\n${cardText(otherProf)}${otherProf.username ? "" : "\n（对方没有公开用户名，暂时无法直接联系）"}`,
    kb ? { reply_markup: kb } : {},
  );
}
