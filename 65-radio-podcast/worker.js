// ============================================================
// 65 电台 / 播客 Bot（单文件 · Cloudflare Workers + 需绑定 KV + Cron）
// 功能：
// 电台：/radio 出电台表（CONFIG 里配流地址），点按钮拿收听链接。
// 播客：/podcast add <RSS地址> 订阅播客，Cron 轮询发现新单集后
// 推到私聊（能直发音频就 sendAudio，不行退回链接消息）。
// ⚠️ 平台边界：Telegram 聊天里不能内嵌播放直播电台流，电台只能
// 给流地址链接（用浏览器/播放器打开，或部分客户端点开可播）；
// 播客单集是普通音频文件，可以正常发进聊天。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 需要 KV：Bindings 添加 KV，变量名 BOT_KV（存播客订阅 pod:<用户ID>）。
// ⚠️ 播客更新推送要给 Worker 加 Cron Trigger（如 */30 * * * *）；
// 不配 Cron 时订阅只存不推（命令里会提醒）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 15（RSS 抓取解析）+ 模块 09（Cron）+ 模块 01（骨架）
// ============================================================

// ============================================================
// 电台表（CONFIG）
// name 显示名、url 直播流地址（mp3/aac 流）、desc 一句介绍。
// 增删电台改这张表即可；默认给的是 SomaFM 的公开流（免费电台）。
// ============================================================
const RADIOS = [
  {
    name: "🥗 Groove Salad",
    url: "https://ice1.somafm.com/groovesalad-128-mp3",
    desc: "SomaFM · 环境/ chill 经典台",
  },
  {
    name: "🌙 Drone Zone",
    url: "https://ice1.somafm.com/dronezone-128-mp3",
    desc: "SomaFM · 深空氛围，适合专注/睡眠",
  },
  {
    name: "🌸 Lush",
    url: "https://ice1.somafm.com/lush-128-mp3",
    desc: "SomaFM · 女声慢歌",
  },
  {
    name: "🕵️ Secret Agent",
    url: "https://ice1.somafm.com/secretagent-128-mp3",
    desc: "SomaFM · 特工电影配乐风",
  },
  {
    name: "🚀 Mission Control",
    url: "https://ice1.somafm.com/missioncontrol-128-mp3",
    desc: "SomaFM · NASA 通话 + 环境电子",
  },
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

// ============================================================
// RSS 解析（复用模块 15 的正则解析姿势）
// 只取每条 item 的标题/链接/guid/音频 enclosure；XML 实体做最小编码还原。
// 播客 feed 结构比新闻 RSS 多一个 enclosure（单集音频直链），多抓这一个字段。
// ============================================================
function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}
function tagOf(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : "";
}
function parsePodcast(xml) {
  const title = tagOf(xml.split(/<item[\s>]/)[0], "title");
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 5) {
    const b = m[1];
    const enc = b.match(/<enclosure[^>]*url="([^"]+)"/);
    items.push({
      title: tagOf(b, "title") || "(无标题单集)",
      link: tagOf(b, "link"),
      id: tagOf(b, "guid") || tagOf(b, "link") || (enc ? enc[1] : ""),
      audio: enc ? enc[1] : "",
    });
  }
  return { title, items };
}
async function fetchPodcast(url) {
  const r = await fetch(url, {
    headers: { "user-agent": "tgbots-radio-podcast/1.0" },
  });
  if (!r.ok) throw new Error(`RSS 拉取失败 HTTP ${r.status}`);
  return parsePodcast(await r.text());
}

// ============================================================
// 播客订阅存储与更新推送（KV + Cron）
// pod:<用户ID> = [{url, title, lastId}]；首次订阅只记最新单集不补推
// 历史（防刷屏）；Cron 每轮比对第一条单集 id，变了才推并更新标记。
// 单集有音频直链时先试 sendAudio（Telegram 侧拉取，太大/失败自动
// 退回成带链接按钮的消息，不让用户空等）。
// ============================================================
async function getSubs(env, uid) {
  const raw = await env.BOT_KV.get("pod:" + uid);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, uid, subs) {
  await env.BOT_KV.put("pod:" + uid, JSON.stringify(subs));
}
async function pushEpisode(env, chatId, podTitle, ep) {
  if (ep.audio) {
    const r = await tg(env, "sendAudio", {
      chat_id: chatId,
      audio: ep.audio,
      title: ep.title.slice(0, 60),
      caption: `🎙️ ${podTitle} 更新：${ep.title}`,
    });
    if (r.ok) return;
  }
  const kb = [];
  if (ep.audio) kb.push({ text: "▶️ 收听单集", url: ep.audio });
  if (ep.link) kb.push({ text: "📄 单集页面", url: ep.link });
  await send(
    env,
    chatId,
    `🎙️ ${podTitle} 更新：\n${ep.title}`,
    kb.length ? { reply_markup: { inline_keyboard: [kb] } } : {},
  );
}
async function pollPodcasts(env) {
  const list = await env.BOT_KV.list({ prefix: "pod:", limit: 1000 });
  for (const k of list.keys) {
    const uid = k.name.slice(4);
    const subs = await getSubs(env, uid);
    let changed = false;
    for (const sub of subs) {
      try {
        const feed = await fetchPodcast(sub.url);
        const latest = feed.items[0];
        if (!latest) continue;
        if (!sub.lastId) {
          sub.lastId = latest.id;
          changed = true;
          continue;
        }
        if (latest.id !== sub.lastId) {
          // 可能积压多集：把比 lastId 新的都推（最多 3 集防刷屏）
          const fresh = [];
          for (const ep of feed.items) {
            if (ep.id === sub.lastId) break;
            fresh.push(ep);
          }
          for (const ep of fresh.slice(0, 3).reverse())
            await pushEpisode(env, Number(uid), sub.title, ep);
          sub.lastId = latest.id;
          changed = true;
        }
      } catch (e) {
        // 单个源失败不中断整轮
      }
    }
    if (changed) await saveSubs(env, uid, subs);
  }
}

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 没有管理员命令，COMMANDS_ADMIN 留空——模块照常保留，
// 以后要加管理员命令时：命令写进 COMMANDS_ADMIN + 业务里加 isAdmin 校验。
// （完整原理见其他模板的同名模块注释。）
// ============================================================
const COMMANDS_USER = [
  { command: "radio", description: "电台列表" },
  { command: "podcast", description: "播客订阅管理，如 /podcast add 地址" },
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
      return new Response("radio-podcast bot is running.", {
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
    if (env.BOT_KV) ctx.waitUntil(pollPodcasts(env));
  },
};

// ============================================================
// 业务主流程
// /radio 电台表（按钮给流地址）；/podcast add|list|del 订阅管理。
// radio:<序号> 回调只做介绍 + 链接按钮（流不能在聊天里内嵌播放）。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq) {
    const data = String(cq.data || "");
    if (data.startsWith("radio:")) {
      const r = RADIOS[Number(data.slice(6))];
      if (r) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
        await send(
          env,
          cq.message.chat.id,
          `📻 ${r.name}\n${r.desc}\n\n点下面按钮打开直播流（Telegram 内不能直接播放直播流，请用浏览器/播放器打开；部分客户端点开 mp3 流可直接播）。`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: "▶️ 打开直播流", url: r.url }]],
            },
          },
        );
        return;
      }
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = text.split(/\s+/)[0].split("@")[0];
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "📻 电台 / 播客 Bot\n\n/radio 电台列表（拿直播流链接）\n/podcast add <RSS地址> 订阅播客，新单集自动推送\n/podcast 查看订阅 · /podcast del 序号 退订\n\n播客 RSS 地址一般在节目官网/平台页面的「RSS」入口。",
    );

  if (cmd === "/radio") {
    return send(env, chatId, "📻 电台列表（点电台看介绍与收听链接）：", {
      reply_markup: {
        inline_keyboard: RADIOS.map((r, i) => [
          { text: r.name, callback_data: `radio:${i}` },
        ]),
      },
    });
  }

  if (cmd === "/podcast") {
    if (!env.BOT_KV)
      return send(
        env,
        chatId,
        "⚠️ 播客订阅需要先绑定 KV（变量名 BOT_KV）。电台 /radio 不受影响。",
      );
    const parts = text.split(/\s+/);
    const sub = (parts[1] || "list").toLowerCase();
    const subs = await getSubs(env, uid);
    if (sub === "add") {
      const url = parts[2];
      if (!url || !/^https?:\/\//.test(url))
        return send(env, chatId, "用法：/podcast add <RSS地址>");
      if (subs.some((s) => s.url === url))
        return send(env, chatId, "已经订阅过这个播客了。");
      try {
        const feed = await fetchPodcast(url);
        if (!feed.items.length)
          return send(
            env,
            chatId,
            "🤔 这个地址拉到了内容但没解析出单集，确认是播客 RSS 地址？",
          );
        subs.push({ url, title: feed.title || url, lastId: feed.items[0].id });
        await saveSubs(env, uid, subs);
        return send(
          env,
          chatId,
          `✅ 已订阅《${feed.title || url}》，最新一集是「${feed.items[0].title}」。之后有新单集会自动推给你（需 Worker 配了 Cron）。`,
        );
      } catch (e) {
        return send(
          env,
          chatId,
          `😵 订阅失败：${String(e.message || e).slice(0, 150)}`,
        );
      }
    }
    if (sub === "del") {
      const n = Number(parts[2]);
      if (!n || n < 1 || n > subs.length)
        return send(
          env,
          chatId,
          "用法：/podcast del 序号（序号见 /podcast 列表）",
        );
      const [gone] = subs.splice(n - 1, 1);
      await saveSubs(env, uid, subs);
      return send(env, chatId, `🔕 已退订《${gone.title}》。`);
    }
    if (!subs.length)
      return send(
        env,
        chatId,
        "你还没有播客订阅。/podcast add <RSS地址> 订一个。",
      );
    return send(
      env,
      chatId,
      "🎙️ 我的播客订阅：\n" +
        subs.map((s, i) => `${i + 1}. 《${s.title}》`).join("\n") +
        "\n\n退订：/podcast del 序号",
    );
  }
}
