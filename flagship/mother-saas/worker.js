// ============================================================
// 旗舰 · 母体 SaaS（单文件 · Cloudflare Workers + 需绑定 KV）
// 一个平台（母体）+ 一份目录（tgbots 82 个模板）——不是 82 个母体。
// ⚠️⚠️⚠️ 风险提示（部署前必读）⚠️⚠️⚠️
// 本 Bot 会代管「别人 Bot 的 Token」——Token = 那个 Bot 的全部权限。
// · 子 Bot Token 一律 AES-GCM 加密后才存 KV，密钥 TOKEN_ENC_KEY 只放 Secret；
// · 任何界面/日志/面板/API 都不回显 Token 原文、密文和租户 secret_token；
// · 入驻即告知用户：把 Token 交给母体意味着什么、随时可去 @BotFather
// 用 /revoke 让托管立即失效（这是用户的安全阀）；
// · 只建议自用或熟人小圈子部署，别拿它公开招揽陌生人 Token。
// 功能：
// · Web 面板：GET / 平台总览（统计/内核目录/82 模板三档目录/租户列表脱敏）
// · JSON API：GET /api/stats、GET /api/tenants（脱敏）
// · 入驻向导（FSM）：选内核 → 发 Token → getMe 验真 → 确认 → 加密存储 →
// 母体代设 Webhook 到 /w/<slug>（随机 slug + 独立 secret_token）→ 子 Bot 上线。
// · v1 真实可入驻内核 4 个：客服 support、签到 checkin、菜单FAQ menu-faq、
// 文件仓库Lite file-store-lite。其余 78 个模板按三档诚实标注，见 CATALOG。
// 必填变量：
// BOT_TOKEN 母体 Bot Token（Secret）
// BOT_KV KV 绑定名（必须叫 BOT_KV）
// TOKEN_ENC_KEY 加密密钥：32 字节随机数的 base64（Secret）
// ADMIN_ID 平台管理员数字 ID，多个英文逗号隔开
// 选填：
// WEBHOOK_SECRET 母体 Webhook 密钥（Secret 推荐）
// WORKER_BASE_URL Worker 公网地址，如 https://xxx.workers.dev（不填用请求来源）
// TZ_OFFSET 子 Bot 签到时区，默认 8
// 键设计：bot:<slug> 租户记录；fsm:<聊天>:<用户> 入驻向导状态；
// t:<子BotID>: 租户数据前缀（scopedKV 自动加，内核无感知）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：32-mother-bot + 模块 21/20/07/16 + 07-menu-faq + 06-file-store
// ============================================================

// ============================================================
// 【核心模块】Telegram Bot API 通信层 — 统一封装 tg()，母体与子 Bot 共用，靠 env.BOT_TOKEN 区分身份
// ============================================================
async function tg(env, method, payload) {
const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
method: "POST",
headers: { "content-type": "application/json"},
body: JSON.stringify(payload),
});
return r.json().catch(() => ({}));
}
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text,...extra});
const admins = (env) => String(env.ADMIN_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const who = (u) => `${u.first_name || ""}${u.username? " (@" + u.username + ")": ""}`;
const randHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
const esc = (s) => String(s?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const baseOrigin = (env, fallback) => String(env.WORKER_BASE_URL || fallback || "").replace(/\/+$/, "");

// ============================================================
// 【核心模块】租户 Token 加解密 — AES-GCM 加密存 KV，密钥只放 Secret TOKEN_ENC_KEY，绝不回显明文/密文
// ============================================================
async function importKey(env) {
const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (c) => c.charCodeAt(0));
return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encToken(env, token) {
const key = await importKey(env);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv}, key, new TextEncoder().encode(token));
const pack = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
return pack(iv.buffer) + "." + pack(ct);
}
async function decToken(env, enc) {
const [ivB, ctB] = enc.split(".");
const un = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const key = await importKey(env);
const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: un(ivB)}, key, un(ctB));
return new TextDecoder().decode(pt);
}
const maskToken = (t) => (t? t.slice(0, 4) + "…" + t.slice(-4): "");

// ============================================================
// 【核心模块】租户 KV 隔离 — scopedKV 自动加 t:<子BotID>: 前缀，内核照常读写、租户之间天然隔离
// ============================================================
function scopedKV(kv, prefix) {
return {
get: (k, t) => kv.get(prefix + k, t),
put: (k, v, o) => kv.put(prefix + k, v, o),
delete: (k) => kv.delete(prefix + k),
list: async (o = {}) => {
const r = await kv.list({...o, prefix: prefix + (o.prefix || "")});
return { keys: r.keys.map((k) => ({...k, name: k.name.slice(prefix.length)})), list_complete: r.list_complete, cursor: r.cursor};
},
};
}

// ============================================================
// 【核心模块】82 模板目录与三档分类 — 母体是 1 个平台、82 个模板是目录；live=已可入驻 / adapt=可适配 / no=不适合托管
// ============================================================
// 每行：[编号, 名称, 档位, 一句话说明]。档位数字以本表为准，面板/README 同源。
const CATALOG = [
[1,"频道发帖面板","adapt","状态在 KV、配置可改租户 config，可适配"],
[2,"双向客服","live","已实现 support 内核（简化版）"],
[3,"强制订阅","no","需子 Bot 在目标频道/群任管理员才能验订阅"],
[4,"群管理","no","需群管理员权限与群事件处理"],
[5,"投稿审核","adapt","审核流状态在 KV、配置可改租户 config，可适配"],
[6,"文件存储分享","live","已实现 file-store-lite 内核（只存 file_id）"],
[7,"菜单导航/关键词回复","live","已实现 menu-faq 内核（租户可配问答）"],
[8,"ID 查询工具","adapt","无状态查询、改租户配置即可，可适配"],
[9,"订阅群发","adapt","订阅名单改 scopedKV、由店主手动触发可适配（不做定时群发版）"],
[10,"网盘（私有频道存储）","adapt","需租户自备私有频道 ID 作 config，可适配"],
[11,"RSS/定时推送","no","需独立 Cron 定时抓取"],
[12,"入群申请审核","no","需群管理员审批权限"],
[13,"签到积分/抽奖","live","已实现 checkin 内核（签到/积分/排行，抽奖未含）"],
[14,"付费会员","no","涉及支付与到期 Cron 续期"],
[15,"数字商品自动售货","no","涉及支付确认与自动发货"],
[16,"邀请引流统计","adapt","归因数据改 scopedKV 即可，可适配"],
[17,"任务赚钱","no","涉及奖励结算与防刷/支付风控"],
[18,"频道导航/互推","adapt","目录数据改租户 config/KV 即可，可适配"],
[19,"投票问卷","adapt","票数改 scopedKV 即可，可适配"],
[20,"消息推送 API","no","需独立外部推送密钥与 HTTP 鉴权入口"],
[21,"定时播报","no","需独立 Cron 定时触发"],
[22,"群活跃统计","adapt","群消息计数改 scopedKV 可适配（需子 Bot 进群）"],
[23,"行情播报","adapt","按需查询版可适配（定时播报版需 Cron，不含）"],
[24,"接龙报名","adapt","名单改 scopedKV 即可，可适配"],
[25,"记账","adapt","账本改 scopedKV 即可，可适配"],
[26,"竞答游戏","adapt","会话改 scopedKV/FSM 即可，可适配"],
[27,"翻译","no","需外部翻译 API 密钥"],
[28,"工具箱","adapt","无状态工具、改租户配置即可，可适配"],
[29,"匿名信箱","adapt","转发映射改 scopedKV 即可，可适配"],
[30,"客服工单","adapt","工单状态改 scopedKV 即可，可适配"],
[31,"AI 聊天","no","需外部 AI API 密钥"],
[32,"母体 Bot","no","母体本身，不能被母体递归托管"],
[33,"商城连锁母体","no","商城母体本身，含总部货源体系"],
[34,"视频解析下载","no","需外部解析服务配置/密钥"],
[35,"语音转文字","no","需外部语音识别 API 密钥"],
[36,"个人提醒/待办","no","需 Cron 定时提醒"],
[37,"贴纸制作","adapt","无外部密钥、处理逻辑可直接搬，可适配"],
[38,"天气","adapt","免 key 天气源、改租户默认城市即可，可适配"],
[39,"GitHub 通知","no","需独立 Webhook 密钥对接各自仓库"],
[40,"Inline 工具","adapt","Inline 查询改租户配置即可，可适配"],
[41,"狼人杀主持人","adapt","对局状态改 scopedKV/FSM 即可，可适配"],
[42,"Mini App 三件套","no","需独立托管 Web App 页面"],
[43,"图片处理/OCR","no","需外部 OCR API 密钥"],
[44,"URL 上传转存","adapt","转存映射改 scopedKV 即可，可适配"],
[45,"论坛话题工单","no","需论坛群管理员与话题权限"],
[46,"原生 Poll/Quiz 与反应","adapt","票数/反应改 scopedKV 即可，可适配"],
[47,"翻译进阶","no","需外部翻译 API 密钥"],
[48,"联邦群管","no","需多群管理员与联邦封禁权限"],
[49,"PDF 工具","adapt","文件 file_id 流转、无外部密钥，可适配"],
[50,"音乐下载/识曲","no","需外部识曲/下载服务"],
[51,"游戏平台","no","需独立托管 HTML5 游戏页面"],
[52,"匿名随机聊天","adapt","匹配队列改平台级/租户级 KV 需专门设计，可适配但要改匹配域"],
[53,"Business 代答","no","需 Telegram Business 连接授权"],
[54,"Managed Bots 母体","no","Managed Bots 母体本身，不能递归托管"],
[55,"AI 绘图","no","需外部绘图 API 密钥"],
[56,"课程/LMS","adapt","课时状态改 scopedKV 可适配（付费解锁部分不含）"],
[57,"预约/订位","adapt","时段占用改 scopedKV 即可，可适配"],
[58,"闪卡记忆","adapt","卡组与复习状态改 scopedKV 即可，可适配"],
[59,"长文/频道总结","no","需外部 AI API 密钥"],
[60,"网站更新监控","no","需 Cron 定时巡检"],
[61,"活动抽奖","adapt","参与名单改 scopedKV、手动开奖可适配"],
[62,"加密支付收款","no","需 Crypto Pay 支付密钥"],
[63,"频道数据分析","no","需频道管理员权限读取统计"],
[64,"TTS 语音合成","no","需外部 TTS 服务"],
[65,"电台/播客","no","需 Cron 抓取播客更新"],
[66,"直播开播提醒","no","需 Cron 轮询开播状态"],
[67,"包裹追踪","no","需外部快递查询 API 密钥"],
[68,"机票/旅行助手","adapt","查询改租户配置即可，可适配"],
[69,"求职招聘","adapt","职位数据改 scopedKV/config 即可，可适配"],
[70,"房产租售提醒","adapt","按需查询版可适配（定时提醒版需 Cron，不含）"],
[71,"星座运势/塔罗","adapt","内容生成无外部密钥，可适配"],
[72,"每日经文","no","需 Cron 每日推送"],
[73,"公版书库","adapt","免 key 书库源、书签改 scopedKV，可适配"],
[74,"DAO 治理提醒","no","需 Cron 与外部链上数据源"],
[75,"NFT 动态提醒","no","需外部数据源密钥与 Cron 轮询"],
[76,"电商比价追踪","no","需 Cron 定时比价"],
[77,"相亲交友","adapt","资料卡改 scopedKV 可适配（需另加安全/举报设计）"],
[78,"VPN 面板交付","no","需独立服务器面板密钥与支付"],
[79,"习惯打卡/番茄钟","no","需 Cron 计时提醒"],
[80,"匿名提问墙","adapt","提问墙数据改 scopedKV 即可，可适配"],
[81,"域名/SSL 监控","no","需 Cron 定时巡检"],
[82,"AI 头像/证件照","no","需外部 AI 绘图 API 密钥"],
];
const catalogCounts = () => ({
total: CATALOG.length,
live: CATALOG.filter((c) => c[2] === "live").length,
adapt: CATALOG.filter((c) => c[2] === "adapt").length,
no: CATALOG.filter((c) => c[2] === "no").length,
});

// ============================================================
// 【核心模块】租户记录与脱敏 — 内部记录含密文/secret，对外（面板/API/列表）一律走 sanitizeTenant 脱敏
// ============================================================
async function getTenant(env, slug) {
if (!env.BOT_KV) return null;
const raw = await env.BOT_KV.get("bot:" + slug);
return raw? JSON.parse(raw): null;
}
async function listTenantsRaw(env, ownerId) {
if (!env.BOT_KV) return [];
const list = await env.BOT_KV.list({ prefix: "bot:", limit: 1000});
const out = [];
for (const k of list.keys) {
const raw = await env.BOT_KV.get(k.name);
if (!raw) continue;
let rec; try { rec = JSON.parse(raw);} catch { continue;}
if (ownerId && rec.owner!== ownerId) continue;
out.push({ slug: k.name.slice(4),...rec});
}
return out;
}
// 对外脱敏：只留可展示字段，绝不带 tokenEnc / secret / 任何 Token
function sanitizeTenant(rec) {
return {
slug: rec.slug, username: rec.username || "", botId: rec.botId || null,
type: rec.type, kernel: KERNELS_META[rec.type]?.name || rec.type,
owner: rec.owner, stopped:!!rec.stopped, at: rec.at || null,
};
}
async function platformStats(env) {
const tenants = (await listTenantsRaw(env, null)).map(sanitizeTenant);
const byType = {};
for (const t of tenants) byType[t.type] = (byType[t.type] || 0) + 1;
return {
ok: true,
health: {
kv:!!env.BOT_KV,
botTokenConfigured:!!env.BOT_TOKEN,
encKeyConfigured:!!env.TOKEN_ENC_KEY,
webhookSecretConfigured:!!env.WEBHOOK_SECRET,
status: env.BOT_KV && env.BOT_TOKEN && env.TOKEN_ENC_KEY? "running": "degraded",
},
tenantsTotal: tenants.length,
tenantsRunning: tenants.filter((t) =>!t.stopped).length,
tenantsStopped: tenants.filter((t) => t.stopped).length,
byType,
kernels: Object.entries(KERNELS_META).map(([key, v]) => ({ key,...v})),
catalog: catalogCounts(),
generatedAt: Date.now(),
};
}

// ============================================================
// 【核心模块】FSM 状态机 — 入驻向导状态存 fsm:<chat>:<user>，1 小时过期，完成/取消即清
// ============================================================
// ⚠️ 向导进行中 data 里会短暂存用户刚发的 Token 明文（等验真后加密落库），
// 完成/取消即清；KV 权限等同密钥权限，别把 KV 导出给任何人。
async function fsmGet(env, chatId, userId) {
const raw = await env.BOT_KV.get(`fsm:${chatId}:${userId}`);
return raw? JSON.parse(raw): null;
}
async function fsmSet(env, chatId, userId, step, data = {}) {
await env.BOT_KV.put(`fsm:${chatId}:${userId}`, JSON.stringify({ step, data, updatedAt: Date.now()}), { expirationTtl: 3600});
}
async function fsmClear(env, chatId, userId) { await env.BOT_KV.delete(`fsm:${chatId}:${userId}`);}

// ============================================================
// 【核心模块】内核元数据注册表 — 面板目录与入驻菜单的单一数据源，新增内核先在这里登记
// ============================================================
const KERNELS_META = {
support: { name: "客服 Bot", templateNo: 2, desc: "用户消息转发店主，店主回复即回达"},
checkin: { name: "签到 Bot", templateNo: 13, desc: "/qd 签到、/me 积分、/top 排行（连签加成）"},
"menu-faq": { name: "菜单 FAQ Bot", templateNo: 7, desc: "按钮菜单 + 可配置问答，点题出答案"},
"file-store-lite": { name: "文件仓库 Lite", templateNo: 6, desc: "店主存 file_id 发取件码，访客凭码取文件"},
};

// ============================================================
// 【核心模块】子模板内核 · 客服 — 用户消息转发店主、店主回复转发即回达，映射存租户 KV supmap:
// ============================================================
const supportKernel = {
commands: [{ command: "start", description: "开始咨询"}],
async handle(env, update, rec) {
const msg = update.message;
if (!msg ||!msg.from) return;
const chatId = msg.chat.id;
const owner = rec.owner;
if (msg.from.id === owner) {
const reply = msg.reply_to_message;
if (reply) {
const target = await env.BOT_KV.get("supmap:" + reply.message_id);
if (target) {
await tg(env, "copyMessage", { chat_id: Number(target), from_chat_id: chatId, message_id: msg.message_id});
return send(env, chatId, "↩️ 已回给对方。");
}
}
return send(env, chatId, "你是本 Bot 的店主：用户消息会转到这里，你「回复」任意一条转发消息即可回达对方。");
}
const text = (msg.text || "").trim();
if (text.startsWith("/start")) return send(env, chatId, "👋 你好！直接发消息就能联系店主，店主回复后我会转达给你。");
let r = await tg(env, "forwardMessage", { chat_id: owner, from_chat_id: chatId, message_id: msg.message_id});
if (!r.ok) r = await tg(env, "copyMessage", { chat_id: owner, from_chat_id: chatId, message_id: msg.message_id});
if (r.ok) {
await env.BOT_KV.put("supmap:" + r.result.message_id, String(msg.from.id));
return send(env, chatId, "✅ 已转达店主，请等回复。");
}
return send(env, chatId, "😵 转达失败，稍后再试。");
},
};

// ============================================================
// 【核心模块】子模板内核 · 签到 — /qd 每日签到（基础10+连签加成）、/me、/top，数据走租户 KV pts:
// ============================================================
const checkinKernel = {
commands: [
{ command: "qd", description: "每日签到领积分"},
{ command: "me", description: "我的积分与连签"},
{ command: "top", description: "积分排行榜"},
{ command: "start", description: "使用说明"},
],
async handle(env, update, rec) {
const msg = update.message;
if (!msg ||!msg.from) return;
const text = (msg.text || "").trim();
const cmd = text.split(/\s+/)[0].split("@")[0];
const chatId = msg.chat.id;
const off = (Number(env.TZ_OFFSET) || 8) * 3600 * 1000;
const day = (ts) => new Date(ts + off).toISOString().slice(0, 10);
const getP = async (uid) => {
const raw = await env.BOT_KV.get("pts:" + uid);
return raw? JSON.parse(raw): { p: 0, last: "", streak: 0, name: ""};
};
if (cmd === "/qd" || text === "签到") {
const prof = await getP(msg.from.id);
const today = day(Date.now());
if (prof.last === today) return send(env, chatId, `今天已经签过啦。当前积分 ${prof.p}，连签 ${prof.streak} 天。`);
prof.streak = prof.last === day(Date.now() - 86400 * 1000)? prof.streak + 1: 1;
const gain = 10 + Math.min(prof.streak - 1, 10);
prof.p += gain; prof.last = today; prof.name = who(msg.from);
await env.BOT_KV.put("pts:" + msg.from.id, JSON.stringify(prof));
return send(env, chatId, `✅ ${today} 签到成功 +${gain} 分（连签 ${prof.streak} 天）\n当前积分：${prof.p}`);
}
if (cmd === "/me") {
const prof = await getP(msg.from.id);
return send(env, chatId, `🧾 ${who(msg.from)}\n积分：${prof.p}\n连签：${prof.streak} 天`);
}
if (cmd === "/top") {
const list = await env.BOT_KV.list({ prefix: "pts:", limit: 1000});
const rows = [];
for (const k of list.keys) {
const raw = await env.BOT_KV.get(k.name);
if (raw) { const p = JSON.parse(raw); rows.push({ name: p.name || k.name.slice(4), p: p.p});}
}
rows.sort((a, b) => b.p - a.p);
if (!rows.length) return send(env, chatId, "还没有人签到，发 /qd 抢榜一。");
return send(env, chatId, "🏆 积分榜 Top 10\n\n" + rows.slice(0, 10).map((r, i) => `${i + 1}. ${r.name} — ${r.p} 分`).join("\n"));
}
if (cmd === "/start" || cmd === "/help")
return send(env, chatId, "🎲 签到 Bot\n/qd 每日签到领积分（连签有加成）\n/me 我的积分\n/top 积分榜");
},
};

// ============================================================
// 【核心模块】子模板内核 · 菜单FAQ — 租户 config.faqs 配置问答（无配置用默认问答），按钮点题出答案、文字命中关键词也出答案
// ============================================================
const DEFAULT_FAQS = [
{ q: "营业时间？", a: "🕘 每天 9:00–21:00，在线客服同时间段回复。", keys: ["营业", "几点", "时间"]},
{ q: "怎么联系真人？", a: "🙋 直接在本对话留言，店主看到会回复。", keys: ["真人", "客服", "联系"]},
{ q: "在哪里看最新动态？", a: "📣 请看置顶消息和菜单里的公告，重要通知都会发在那里。", keys: ["公告", "动态", "通知"]},
];
const menuFaqKernel = {
commands: [
{ command: "start", description: "打开问答菜单"},
{ command: "menu", description: "打开问答菜单"},
{ command: "help", description: "使用说明"},
],
async handle(env, update, rec) {
const faqs = Array.isArray(rec.config?.faqs) && rec.config.faqs.length? rec.config.faqs: DEFAULT_FAQS;
const welcome = rec.config?.welcome || "👋 欢迎！点下面常见问题看答案，也可以直接打字问我。";
const kb = () => ({ inline_keyboard: faqs.map((f, i) => [{ text: "❓ " + f.q, callback_data: "faq:" + i}])});
const cq = update.callback_query;
if (cq && String(cq.data || "").startsWith("faq:")) {
const idx = Number(String(cq.data).slice(4));
const f = faqs[idx];
await tg(env, "answerCallbackQuery", { callback_query_id: cq.id});
if (f) return send(env, cq.message.chat.id, `❓ ${f.q}\n\n${f.a}`);
return;
}
const msg = update.message;
if (!msg ||!msg.from) return;
const text = (msg.text || "").trim();
const cmd = text.split(/\s+/)[0].split("@")[0];
const chatId = msg.chat.id;
if (cmd === "/start" || cmd === "/menu" || cmd === "/help" || cmd === "/faq")
return send(env, chatId, welcome, { reply_markup: kb()});
for (const f of faqs) {
const keys = Array.isArray(f.keys) && f.keys.length? f.keys: [f.q.replace(/[？?]/g, "")];
if (keys.some((k) => k && text.includes(k))) return send(env, chatId, `❓ ${f.q}\n\n${f.a}`);
}
return send(env, chatId, "🤔 没找到现成答案。发 /menu 看问答菜单，或直接留言给店主。", { reply_markup: kb()});
},
};

// ============================================================
// 【核心模块】子模板内核 · 文件仓库Lite — 店主发文件只存 file_id 生成取件码，访客 /get <码> 取件；文件本体在 Telegram 服务器
// ============================================================
function fileOfMsg(msg) {
if (msg.document) return { kind: "document", id: msg.document.file_id, name: msg.document.file_name || "文件"};
if (msg.photo?.length) return { kind: "photo", id: msg.photo[msg.photo.length - 1].file_id, name: "图片"};
if (msg.video) return { kind: "video", id: msg.video.file_id, name: msg.video.file_name || "视频"};
if (msg.audio) return { kind: "audio", id: msg.audio.file_id, name: msg.audio.file_name || "音频"};
if (msg.voice) return { kind: "voice", id: msg.voice.file_id, name: "语音"};
if (msg.animation) return { kind: "animation", id: msg.animation.file_id, name: "动图"};
return null;
}
const sendFileByKind = (env, chat_id, f, caption) =>
tg(env, { document: "sendDocument", photo: "sendPhoto", video: "sendVideo", audio: "sendAudio", voice: "sendVoice", animation: "sendAnimation"}[f.kind] || "sendDocument",
{ chat_id, [f.kind]: f.id, caption: caption || undefined});
const fileStoreLiteKernel = {
commands: [
{ command: "start", description: "使用说明 / 深链取件"},
{ command: "get", description: "凭取件码取文件，如 /get abc123"},
{ command: "files", description: "店主：我存过的文件"},
],
async handle(env, update, rec) {
const msg = update.message;
if (!msg ||!msg.from) return;
const chatId = msg.chat.id;
const text = (msg.text || "").trim();
const isOwner = msg.from.id === rec.owner;
const deliver = async (code) => {
const raw = await env.BOT_KV.get("file:" + code);
if (!raw) return send(env, chatId, "😢 取件码不存在或已失效。");
const f = JSON.parse(raw);
await sendFileByKind(env, chatId, f, f.caption);
return send(env, chatId, `✅ 已取到「${f.name}」，取件码：${code}`);
};
const deep = text.match(/^\/start(?:@\w+)?\s+f_(\w+)/);
if (deep) return deliver(deep[1]);
const getM = text.match(/^\/get(?:@\w+)?\s+(\w+)/);
if (getM) return deliver(getM[1]);
const cmd = text.split(/\s+/)[0].split("@")[0];
if (cmd === "/files") {
if (!isOwner) return send(env, chatId, "⛔ 只有店主能看文件列表。");
const list = await env.BOT_KV.list({ prefix: "file:", limit: 100});
if (!list.keys.length) return send(env, chatId, "还没存过文件。直接把文件发给我即可存入。");
const lines = [];
for (const k of list.keys) {
const raw = await env.BOT_KV.get(k.name);
if (raw) { const f = JSON.parse(raw); lines.push(`· ${k.name.slice(5)} — ${f.name}`);}
}
return send(env, chatId, "📦 我存过的文件（取件码 — 名称）\n\n" + lines.join("\n"));
}
if (cmd === "/start" || cmd === "/help")
return send(env, chatId, isOwner
? "📦 文件仓库 Lite（店主）：直接把文件/图片/视频发给我，我回你取件码；访客发 /get <取件码> 即可取文件。/files 看清单。"
: "📦 文件仓库 Lite：发 /get <取件码> 取文件，取件码请向店主索取。");
const f = fileOfMsg(msg);
if (f) {
if (!isOwner) return send(env, chatId, "⛔ 只有店主能存文件。你可以发 /get <取件码> 取文件。");
const code = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
await env.BOT_KV.put("file:" + code, JSON.stringify({...f, caption: msg.caption || "", at: Date.now()}));
return send(env, chatId, `✅ 已保存「${f.name}」\n取件码：${code}\n访客使用：/get ${code}\n或深链：https://t.me/${rec.username}?start=f_${code}\n说明：只存了 Telegram 的 file_id 取件凭据，文件本体在 Telegram 服务器，不占 KV 空间。`);
}
return send(env, chatId, "发 /get <取件码> 取文件，或发 /start 看说明。");
},
};

// ============================================================
// 【核心模块】内核分发注册表 — 内核的单一注册点，handle 拿到的是已换 Token + scopedKV 的租户 env
// ============================================================
const KERNELS = { support: supportKernel, checkin: checkinKernel, "menu-faq": menuFaqKernel, "file-store-lite": fileStoreLiteKernel};

// ============================================================
// 【核心模块】入驻装配 — getMe 验真 → 随机 slug/租户 secret → 加密存记录 → 代设子 Webhook → 注册子 Bot 菜单；Token 绝不进 URL
// ============================================================
async function onboardBot(env, origin, { token, type, owner}) {
const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const me = await meResp.json().catch(() => ({}));
if (!me.ok) return { error: "Token 无效（getMe 验真没过），检查后重发。"};
const slug = randHex(8);
const secret = randHex(12);
const rec = { tokenEnc: await encToken(env, token), botId: me.result.id, username: me.result.username, type, owner, secret, config: {}, stopped: false, at: Date.now()};
await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
const hookResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
method: "POST", headers: { "content-type": "application/json"},
body: JSON.stringify({ url: `${baseOrigin(env, origin)}/w/${slug}`, secret_token: secret, allowed_updates: ["message", "callback_query"]}),
});
const hook = await hookResp.json().catch(() => ({}));
if (!hook.ok) return { error: "代设 Webhook 失败：" + (hook.description || "未知错误")};
await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
method: "POST", headers: { "content-type": "application/json"},
body: JSON.stringify({ commands: KERNELS[type].commands}),
}).catch(() => {});
return { slug, username: me.result.username};
}

// ============================================================
// 【核心模块】子 Bot 分发与熔断 — 解密 Token 组装租户 env 跑内核；已停用租户不跑内核、只回一条熔断提示
// ============================================================
async function dispatchTenant(env, rec, update) {
const kernel = KERNELS[rec.type];
if (!kernel) return;
let token;
try { token = await decToken(env, rec.tokenEnc);} catch { return;}
const tenantEnv = {...env, BOT_TOKEN: token, BOT_KV: scopedKV(env.BOT_KV, `t:${rec.botId}:`), TENANT: rec};
await kernel.handle(tenantEnv, update, rec);
}
async function notifyStopped(env, rec, update) {
const msg = update.message;
if (!msg ||!msg.from) return;
let token;
try { token = await decToken(env, rec.tokenEnc);} catch { return;}
const tenantEnv = {...env, BOT_TOKEN: token};
await send(tenantEnv, msg.chat.id, "⏸️ 本 Bot 已被停用/熔断，暂时无法提供服务，请联系店主或平台管理员。");
}

// ============================================================
// 【核心模块】管理员白名单与分级命令菜单 — ADMIN_ID 白名单 + setMyCommands scope 分级，管理员命令只在管理员私聊菜单出现（业务里仍二次校验）
// ============================================================
const COMMANDS_USER = [
{ command: "new", description: "开通一个子 Bot"},
{ command: "mybots", description: "我的子 Bot"},
{ command: "cancel", description: "取消当前向导"},
{ command: "start", description: "使用说明"},
];
const COMMANDS_ADMIN = [
{ command: "tenants", description: "全部租户（管理员）"},
{ command: "tstop", description: "熔断/恢复租户（管理员）"},
];
async function registerCommands(env) {
const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER});
if (COMMANDS_ADMIN.length) {
const all = [...COMMANDS_USER,...COMMANDS_ADMIN];
for (const id of admins(env)) await tg(env, "setMyCommands", { commands: all, scope: { type: "chat", chat_id: Number(id)}});
}
return r;
}

// ============================================================
// 【核心模块】Web 面板渲染 — 米纸底/衬线/金线轻量面板，展示统计、已可入驻内核、82 模板三档目录与脱敏租户列表；无 KV 时渲染空状态
// ============================================================
function tierSection(tier, title, badge) {
const rows = CATALOG.filter((c) => c[2] === tier);
return `<h2>${esc(title)} <span class="badge">${esc(badge)}</span></h2><div class="grid">` +
rows.map((c) => `<div class="card"><b>${String(c[0]).padStart(2, "0")} · ${esc(c[1])}</b><p>${esc(c[3])}</p></div>`).join("") + `</div>`;
}
async function renderPanel(env) {
const stats = await platformStats(env).catch(() => null);
const tenants = stats? (await listTenantsRaw(env, null)).map(sanitizeTenant): [];
const cc = catalogCounts();
const health = stats?.health || { status: "degraded", kv: false, botTokenConfigured: false, encKeyConfigured: false};
const kernelCards = Object.entries(KERNELS_META).map(([key, v]) =>
`<div class="card gold"><b>${esc(v.name)}</b><span class="badge">已可入驻</span><p>源模板 ${String(v.templateNo).padStart(2, "0")} · 内核键 <code>${esc(key)}</code></p><p>${esc(v.desc)}</p></div>`).join("");
const tenantRows = tenants.length
? tenants.map((t) => `<tr><td>@${esc(t.username || "-")}</td><td>${esc(t.kernel)}</td><td>${esc(t.slug)}</td><td>${esc(String(t.owner))}</td><td>${t.stopped? "⏸️ 已停用/熔断": "✅ 运行中"}</td><td>${t.at? new Date(t.at).toISOString().slice(0, 10): "-"}</td></tr>`).join("")
: `<tr><td colspan="6" class="muted">暂无租户 — 在母体 Bot 里发 /new 完成第一个入驻后，这里会显示脱敏列表。</td></tr>`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>母体 SaaS · 平台面板</title><style>
body{margin:0;background:#f7f2e7;color:#2b2620;font-family:Georgia,"Songti SC","Noto Serif SC",serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 18px 60px}h1{font-size:28px;margin:0 0 6px}.goldline{height:2px;background:linear-gradient(90deg,#b9975b,#e5cf8f,#b9975b);margin:14px 0 20px}
.muted{color:#7a6f5f}.badge{display:inline-block;background:#efe6cf;border:1px solid #b9975b;border-radius:999px;padding:1px 9px;font-size:12px;margin-left:6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat,.card{background:#fffdf6;border:1px solid #ddd2b8;border-radius:10px;padding:14px}
.stat b{font-size:26px;display:block}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}.card p{margin:6px 0 0;color:#5c5344;font-size:14px;line-height:1.5}
.card.gold{border-color:#b9975b}table{width:100%;border-collapse:collapse;background:#fffdf6}th,td{border:1px solid #ddd2b8;padding:8px;text-align:left;font-size:14px}
code{background:#efe6cf;padding:1px 5px;border-radius:4px}a{color:#8a6d2f}
</style></head><body><div class="wrap">
<h1>🏭 母体 SaaS — 平台面板</h1>
<div class="muted">一个母体平台 · 82 个模板目录 · 状态：<b>${esc(health.status)}</b>（KV ${health.kv? "✅": "❌"} / BOT_TOKEN ${health.botTokenConfigured? "✅": "❌"} / TOKEN_ENC_KEY ${health.encKeyConfigured? "✅": "❌"}）</div>
<div class="goldline"></div>
<div class="stats">
<div class="stat"><span>租户总数</span><b>${stats? stats.tenantsTotal: 0}</b></div>
<div class="stat"><span>运行中</span><b>${stats? stats.tenantsRunning: 0}</b></div>
<div class="stat"><span>已停用/熔断</span><b>${stats? stats.tenantsStopped: 0}</b></div>
<div class="stat"><span>已可入驻内核</span><b>${cc.live}</b></div>
<div class="stat"><span>目录模板总数</span><b>${cc.total}</b></div>
</div>
<h2>已可入驻内核 <span class="badge">v1 真实可用 · ${cc.live} 个</span></h2><div class="grid">${kernelCards}</div>
<h2>租户列表 <span class="badge">已脱敏 · 不显示 Token/密文</span></h2>
<table><tr><th>子 Bot</th><th>内核</th><th>slug</th><th>店主 ID</th><th>状态</th><th>入驻日期</th></tr>${tenantRows}</table>
<p class="muted">机器接口：<a href="/api/stats">/api/stats</a> · <a href="/api/tenants">/api/tenants</a>（均脱敏）</p>
${tierSection("live", "82 模板目录 · 一档：已可入驻", cc.live + " 个")}
${tierSection("adapt", "82 模板目录 · 二档：可适配", cc.adapt + " 个 · 需 scopedKV/config 适配后才能入驻，v1 尚未上线")}
${tierSection("no", "82 模板目录 · 三档：不适合托管", cc.no + " 个 · 需独立 Cron/密钥/群管理员/支付，或母体本身")}
<p class="muted">安全：子 Bot Token 只以 AES-GCM 密文存 KV；面板与 API 永不返回 Token、密文与租户 secret。用户可随时去 @BotFather /revoke 退出托管。</p>
</div></body></html>`;
return new Response(html, { headers: { "content-type": "text/html;charset=utf-8"}});
}

// ============================================================
// 【核心模块】Worker 入口与路由 — / 面板、/api/* 脱敏接口、/healthz、/setWebhook、/webhook 母体、/w/<slug> 子 Bot 分发
// ============================================================
export default {
async fetch(request, env, ctx) {
const url = new URL(request.url);
// 面板与只读 API：缺绑定也降级渲染，不 500
if (url.pathname === "/" && request.method === "GET") return renderPanel(env);
if (url.pathname === "/api/stats" && request.method === "GET") return Response.json(await platformStats(env));
if (url.pathname === "/api/tenants" && request.method === "GET")
return Response.json({ ok: true, tenants: (await listTenantsRaw(env, null)).map(sanitizeTenant)});
if (url.pathname === "/healthz") {
const h = (await platformStats(env)).health;
return Response.json({ ok: h.status === "running", service: "mother-saas", health: h});
}
if (!env.BOT_TOKEN) return new Response("BOT_TOKEN 未配置", { status: 500});
if (url.pathname === "/setWebhook") {
if (!env.WEBHOOK_SECRET || url.searchParams.get("key")!== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403});
const hook = `${baseOrigin(env, url.origin)}/webhook`;
const r = await tg(env, "setWebhook", { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"]});
const cm = await registerCommands(env);
return Response.json({ setWebhook: hook, telegram: r, commands: cm});
}
if (url.pathname.startsWith("/w/") && request.method === "POST") {
if (!env.BOT_KV) return new Response("KV 未绑定", { status: 500});
const slug = url.pathname.slice(3);
const rec = await getTenant(env, slug);
if (!rec) return new Response("ok");
if (request.headers.get("x-telegram-bot-api-secret-token")!== rec.secret) return new Response("forbidden", { status: 403});
const update = await request.json().catch(() => ({}));
if (rec.stopped) { ctx.waitUntil(notifyStopped(env, rec, update)); return new Response("ok");}
ctx.waitUntil(dispatchTenant(env, rec, update));
return new Response("ok");
}
if (url.pathname!== "/webhook" || request.method!== "POST") return new Response("not found", { status: 404});
if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token")!== env.WEBHOOK_SECRET)
return new Response("forbidden", { status: 403});
const update = await request.json().catch(() => ({}));
update.__origin = url.origin;
ctx.waitUntil(handle(env, update));
return new Response("ok");
},
};

// ============================================================
// 【核心模块】业务主流程（母体侧） — 入驻 FSM（choose→token→confirm→go）、/mybots 管理、管理员 /tenants 与 /tstop 熔断
// ============================================================
async function handle(env, update) {
if (!env.BOT_KV) {
const m = update.message;
if (m) return send(env, m.chat.id, "⚠️ 本 Bot 需要先绑定 KV（变量名 BOT_KV），还没配置好。");
return;
}
const origin = update.__origin || "";
const cq = update.callback_query;
if (cq) {
const data = String(cq.data || "");
if (!data.startsWith("mb:")) return;
const chatId = cq.message.chat.id;
const uid = cq.from.id;
const parts = data.split(":");
const act = parts[1];
if (act === "type") {
// 回调格式 mb:type:<内核键>，内核键本身可含连字符但不含冒号
const type = parts.slice(2).join(":");
if (!KERNELS[type]) return;
await fsmSet(env, chatId, uid, "token", { type});
await tg(env, "answerCallbackQuery", { callback_query_id: cq.id});
return tg(env, "editMessageText", {
chat_id: chatId, message_id: cq.message.message_id,
text: `已选内核：${KERNELS_META[type].name}\n\n第 2 步：把你子 Bot 的 Token 发给我（从 @BotFather 拿）。\n\n⚠️ 说清楚再发：Token 交给我 = 这个 Bot 的消息由本母体托管处理；Token 会加密存储、绝不回显；你随时可以去 @BotFather 用 /revoke 让托管立即失效。\n不想继续发 /cancel。`,
});
}
if (act === "go") {
const st = await fsmGet(env, chatId, uid);
if (!st || st.step!== "confirm")
return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "向导已过期，重新 /new", show_alert: true});
await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "⏳ 正在开通…"});
const res = await onboardBot(env, origin, { token: st.data.token, type: st.data.type, owner: uid});
await fsmClear(env, chatId, uid);
if (res.error) return tg(env, "editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: `😵 开通失败：${res.error}`});
return tg(env, "editMessageText", {
chat_id: chatId, message_id: cq.message.message_id,
text: `🎉 开通成功！你的子 Bot @${res.username}（${KERNELS_META[st.data.type].name}）已上线，去和它对话试试。\n管理：/mybots（停用/恢复/删除）`,
});
}
if (act === "stop" || act === "start" || act === "del") {
const slug = parts[2];
const rec = await getTenant(env, slug);
if (!rec || (rec.owner!== uid &&!isAdmin(env, uid)))
return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "不是你的 Bot", show_alert: true});
if (act === "del") {
const token = await decToken(env, rec.tokenEnc).catch(() => null);
if (token) await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`).catch(() => {});
await env.BOT_KV.delete("bot:" + slug);
await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "🗑 已删除托管（Token 密文一并销毁）"});
} else {
rec.stopped = act === "stop";
await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: rec.stopped? "⏸️ 已停用": "▶️ 已恢复"});
}
return tg(env, "editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: "已更新。发 /mybots 看最新列表。"});
}
return tg(env, "answerCallbackQuery", { callback_query_id: cq.id});
}

const msg = update.message;
if (!msg ||!msg.from) return;
const text = (msg.text || "").trim();
const cmd = text.split(/\s+/)[0].split("@")[0];
const chatId = msg.chat.id;
const uid = msg.from.id;
if (msg.chat.type!== "private" && cmd!== "/tenants" && cmd!== "/tstop") return;

const st = await fsmGet(env, chatId, uid);
if (st && cmd!== "/cancel" && cmd!== "/start") {
if (st.step === "token") {
const token = text;
if (!/^\d{6,}:[\w-]{30,}$/.test(token))
return send(env, chatId, "这不像 Token（格式应是 数字:一串字符）。从 @BotFather 复制完整的发我，或 /cancel 退出。");
const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const me = await meResp.json().catch(() => ({}));
if (!me.ok) return send(env, chatId, "这个 Token 验真没过（getMe 失败），检查一下重发，或 /cancel 退出。");
st.data.token = token; st.data.username = me.result.username;
await fsmSet(env, chatId, uid, "confirm", st.data);
return send(env, chatId, `核对一下：\n· 子 Bot：@${me.result.username}\n· 模板：${KERNELS_META[st.data.type].name}\n· Token：${maskToken(token)}（加密存储，不回显）\n\n确认开通？`,
{ reply_markup: { inline_keyboard: [[{ text: "✅ 确认开通", callback_data: "mb:go"}]]}});
}
return send(env, chatId, "向导进行中，按提示操作，或 /cancel 退出。");
}

if (cmd === "/start" || cmd === "/help")
return send(env, chatId, "🏭 母体 SaaS\n\n把你的 Bot 托管到这里：选内核、交 Token，子 Bot 立刻上线（本母体统一跑代码、统一升级）。\n\n/new 开通子 Bot（v1 可入驻：客服、签到、菜单FAQ、文件仓库Lite）\n/mybots 管理我的子 Bot\n\n⚠️ 82 个模板不是全都能入驻：面板里有三档目录（已可入驻 4 / 可适配 35 / 不适合托管 43）。Token 会加密存储；你随时可去 @BotFather /revoke 让托管失效。");

if (cmd === "/new") {
await fsmSet(env, chatId, uid, "choose", {});
return send(env, chatId, "第 1 步：选子 Bot 内核（v1 真实可入驻的 4 个）", {
reply_markup: { inline_keyboard: [
[{ text: "💬 客服 Bot（消息转发+回复）", callback_data: "mb:type:support"}],
[{ text: "🎲 签到 Bot（签到/积分/排行）", callback_data: "mb:type:checkin"}],
[{ text: "❓ 菜单 FAQ Bot（按钮问答）", callback_data: "mb:type:menu-faq"}],
[{ text: "📦 文件仓库 Lite（取件码取文件）", callback_data: "mb:type:file-store-lite"}],
]},
});
}

if (cmd === "/cancel") { await fsmClear(env, chatId, uid); return send(env, chatId, "已取消向导。");}

if (cmd === "/mybots") {
const mine = await listTenantsRaw(env, uid);
if (!mine.length) return send(env, chatId, "你还没有子 Bot。/new 开通一个。");
for (const rec of mine) {
await send(env, chatId, `🤖 @${rec.username}（${KERNELS_META[rec.type]?.name || rec.type}）\n状态：${rec.stopped? "⏸️ 已停用": "✅ 运行中"}`, {
reply_markup: { inline_keyboard: [[
rec.stopped? { text: "▶️ 恢复", callback_data: `mb:start:${rec.slug}`}: { text: "⏸️ 停用", callback_data: `mb:stop:${rec.slug}`},
{ text: "🗑 删除托管", callback_data: `mb:del:${rec.slug}`},
]]},
});
}
return;
}

if (cmd === "/tenants") {
if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有平台管理员能看。");
const all = await listTenantsRaw(env, null);
if (!all.length) return send(env, chatId, "还没有任何租户。");
return send(env, chatId, `🏭 全部租户（${all.length}）\n\n` + all.slice(0, 30).map((r) => `· @${r.username}（${r.type}）店主 ${r.owner} ${r.stopped? "⏸️": "✅"} slug=${r.slug}`).join("\n"));
}
if (cmd === "/tstop") {
if (!isAdmin(env, uid)) return send(env, chatId, "⛔ 只有平台管理员能熔断。");
const slug = text.split(/\s+/)[1];
const rec = slug && (await getTenant(env, slug));
if (!rec) return send(env, chatId, "用法：/tstop <slug>（slug 见 /tenants）");
rec.stopped =!rec.stopped;
await env.BOT_KV.put("bot:" + slug, JSON.stringify(rec));
return send(env, chatId, `已${rec.stopped? "熔断": "恢复"} @${rec.username}。`);
}
}
