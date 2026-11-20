// ============================================================
// 51 游戏平台 Bot（单文件 · Cloudflare Workers · 排行榜需 KV）
// 功能：
// Worker 自托管两个 HTML5 小游戏（贪吃蛇 / 2048 精简版，路由
// /game/<name>），Bot 用 sendGame 发游戏卡片，用户点 Play 后在
// 回调里按人生成带签名令牌的游戏 URL，游戏结束页面把分数 POST
// 到 /api/score，Worker 验签后 setGameScore 写回卡片排行榜，
// 另存一份 KV 总榜（gscore:）供 /top 跨聊天查看。
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
// 选填：
// WEBHOOK_SECRET Webhook 密钥
// ADMIN_ID 本 Bot 无管理员命令，可不填
// ⚠️ 游戏 short_name 必须先在 @BotFather 用 /newgame 注册，且与
// 下方 GAMES 注册表一字不差（snake / g2048），否则 sendGame 报错。
// ⚠️ 身份注入：游戏页没有 initData，身份靠回调时拼进 URL 的签名
// 令牌（HMAC，密钥由 BOT_TOKEN 派生）；分数是客户端报的，签名只
// 证明「是谁这局报的」，证明不了分数真实——休闲榜够用（模块 45）。
// 部署后访问 https://你的Worker地址/setWebhook?key=你的WEBHOOK_SECRET
// 拼装来源：模块 45（HTML5 游戏平台）+ 模块 28（验签思路）+ 模块 01（骨架）
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
// 游戏注册表
// short 是 BotFather /newgame 注册名（必须一字不差）；page 是本
// Worker 的页面路由后缀；title 只用于 Bot 内的文案。
// ============================================================
const GAMES = {
  snake: { short: "snake", page: "snake", title: "🐍 贪吃蛇" },
  g2048: { short: "g2048", page: "g2048", title: "🔢 2048" },
};
const gameByPage = (page) => Object.values(GAMES).find((g) => g.page === page);

// ============================================================
// 分数令牌（HMAC 签名身份注入）
// payload = { u, c, m, inl, g, n}（用户/聊天/消息/inline/游戏/名字），
// token = base64url(UTF-8 JSON) + "." + HMAC 前 32 位 hex。
// 回调时生成、拼进游戏 URL；/api/score 验签通过才记分。
// ============================================================
const enc = new TextEncoder();
async function signToken(env, payloadObj) {
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode("game:" + env.BOT_TOKEN)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = enc.encode(JSON.stringify(payloadObj));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const body = btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return body + "." + hex.slice(0, 32);
}
async function verifyToken(env, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  let payload;
  try {
    const bin = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const expect = (await signToken(env, payload)).split(".")[1];
  return expect === sig ? payload : null;
}

// ============================================================
// 记分（setGameScore + KV 总榜）
// setGameScore 把分数写回 TG 卡片自带榜（默认只认更高分）；KV
// gscore:<游戏>:<用户ID> = { s:最高分, name} 再存一份跨聊天总榜。
// ============================================================
async function submitScore(env, payload, score) {
  const params = {
    user_id: payload.u,
    score: Math.max(0, Math.floor(score) || 0),
    disable_edit_message: false,
  };
  if (payload.inl) params.inline_message_id = payload.inl;
  else {
    params.chat_id = payload.c;
    params.message_id = payload.m;
  }
  const r = await tg(env, "setGameScore", params);
  if (env.BOT_KV) {
    const key = `gscore:${payload.g}:${payload.u}`;
    const old = JSON.parse((await env.BOT_KV.get(key)) || '{"s":0}');
    if (params.score > old.s)
      await env.BOT_KV.put(
        key,
        JSON.stringify({ s: params.score, name: payload.n || old.name || "" }),
      );
  }
  return r;
}

// ============================================================
// 游戏页：贪吃蛇（自包含 HTML）
// 键盘/滑动/按钮三套操作；吃一个 +10 分；结束自动提交一次分数。
// 页面只有普通浏览器 API（Game 环境没有 Telegram.WebApp SDK）。
// ============================================================
const SNAKE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>贪吃蛇</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;background:#111;color:#eee;margin:0;padding:12px}canvas{background:#222;border-radius:8px;touch-action:none}button{font-size:18px;padding:8px 16px;margin:3px;border-radius:8px;border:0;background:#2f9e44;color:#fff}</style>
</head><body>
<h3>🐍 贪吃蛇</h3>
<div>分数：<span id="score">0</span></div>
<canvas id="cv" width="300" height="300"></canvas>
<div><button onclick="setDir(0,-1)">⬆</button></div>
<div><button onclick="setDir(-1,0)">⬅</button><button onclick="setDir(1,0)">➡</button></div>
<div><button onclick="setDir(0,1)">⬇</button></div>
<div id="msg" style="margin-top:8px"></div>
<script>
var token = new URLSearchParams(location.search).get("s") || "";
var cv = document.getElementById("cv"), ctx = cv.getContext("2d");
var N = 15, cell = 20;
var snake = [{x:7,y:7}], dir = {x:1,y:0}, next = {x:1,y:0}, food = null, score = 0, dead = false, submitted = false;
function placeFood(){ while(true){ var f = {x:Math.floor(Math.random()*N), y:Math.floor(Math.random()*N)}; var hit = snake.some(function(p){ return p.x===f.x && p.y===f.y;}); if(!hit){ food = f; return;}}}
function setDir(x,y){ if(dir.x===-x && dir.y===-y) return; next = {x:x, y:y};}
document.addEventListener("keydown", function(e){ if(e.key==="ArrowUp") setDir(0,-1); if(e.key==="ArrowDown") setDir(0,1); if(e.key==="ArrowLeft") setDir(-1,0); if(e.key==="ArrowRight") setDir(1,0);});
var tx = 0, ty = 0;
cv.addEventListener("touchstart", function(e){ tx = e.touches[0].clientX; ty = e.touches[0].clientY;});
cv.addEventListener("touchmove", function(e){ var dx = e.touches[0].clientX - tx, dy = e.touches[0].clientY - ty; if(Math.abs(dx)<24 && Math.abs(dy)<24) return; if(Math.abs(dx)>Math.abs(dy)) setDir(dx>0?1:-1, 0); else setDir(0, dy>0?1:-1); tx = e.touches[0].clientX; ty = e.touches[0].clientY; e.preventDefault();}, { passive:false});
function step(){
if(dead) return;
dir = next;
var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y};
var crash = head.x<0 || head.y<0 || head.x>=N || head.y>=N || snake.some(function(p){ return p.x===head.x && p.y===head.y;});
if(crash){ gameOver(); return;}
snake.unshift(head);
if(food && head.x===food.x && head.y===food.y){ score += 10; document.getElementById("score").textContent = score; placeFood();} else snake.pop();
draw();
}
function draw(){ ctx.fillStyle = "#222"; ctx.fillRect(0,0,300,300); ctx.fillStyle = "#e03131"; if(food) ctx.fillRect(food.x*cell+2, food.y*cell+2, cell-4, cell-4); ctx.fillStyle = "#51cf66"; snake.forEach(function(p){ ctx.fillRect(p.x*cell+1, p.y*cell+1, cell-2, cell-2);});}
function gameOver(){
dead = true;
document.getElementById("msg").textContent = "游戏结束！得分 " + score;
if(submitted ||!token) return;
submitted = true;
fetch("/api/score", { method:"POST", headers:{ "content-type":"application/json"}, body: JSON.stringify({ s: token, score: score})})
.then(function(){ document.getElementById("msg").textContent += "（分数已提交排行榜）";})
.catch(function(){});
}
placeFood(); draw(); setInterval(step, 160);
</script></body></html>`;

// ============================================================
// 游戏页：2048 精简版（自包含 HTML）
// 4x4 合并玩法：键盘/滑动/按钮移动，合并得分累计；无路可走时
// 结束并提交分数。渲染用 div 网格，颜色按数值查表。
// ============================================================
const G2048_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>2048</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;background:#faf8ef;color:#776e65;margin:0;padding:12px}
#board{display:grid;grid-template-columns:repeat(4,64px);gap:6px;justify-content:center;margin:12px auto}
.c{width:64px;height:64px;border-radius:6px;background:#cdc1b4;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700}
button{font-size:18px;padding:8px 16px;margin:3px;border-radius:8px;border:0;background:#8f7a66;color:#fff}</style>
</head><body>
<h3>🔢 2048</h3>
<div>分数：<span id="score">0</span></div>
<div id="board"></div>
<div><button onclick="move(0,-1)">⬆</button></div>
<div><button onclick="move(-1,0)">⬅</button><button onclick="move(1,0)">➡</button></div>
<div><button onclick="move(0,1)">⬇</button></div>
<div id="msg"></div>
<script>
var token = new URLSearchParams(location.search).get("s") || "";
var grid = [], score = 0, over = false, submitted = false;
var COLORS = { 2:"#eee4da", 4:"#ede0c8", 8:"#f2b179", 16:"#f59563", 32:"#f67c5f", 64:"#f65e3b", 128:"#edcf72", 256:"#edcc61", 512:"#edc850", 1024:"#edc53f", 2048:"#edc22e"};
function addTile(){ var empty = []; grid.forEach(function(v,i){ if(!v) empty.push(i);}); if(!empty.length) return; var i = empty[Math.floor(Math.random()*empty.length)]; grid[i] = Math.random() < 0.9? 2: 4;}
function render(){
document.getElementById("score").textContent = score;
var b = document.getElementById("board"); b.innerHTML = "";
grid.forEach(function(v){ var d = document.createElement("div"); d.className = "c"; d.textContent = v || ""; d.style.background = COLORS[v] || "#cdc1b4"; d.style.color = v > 4? "#f9f6f2": "#776e65"; b.appendChild(d);});
}
function slideLine(a){
var vals = a.filter(function(v){ return v;}); var out = [], gained = 0;
for(var i=0;i<vals.length;i++){ if(vals[i]===vals[i+1]){ out.push(vals[i]*2); gained += vals[i]*2; i++;} else out.push(vals[i]);}
while(out.length<4) out.push(0);
return { arr: out, gained: gained};
}
function move(dx, dy){
if(over) return;
var changed = false;
for(var k=0;k<4;k++){
var idx = [];
for(var j=0;j<4;j++){ var x, y; if(dx!==0){ x = dx>0? 3-j: j; y = k;} else { y = dy>0? 3-j: j; x = k;} idx.push(y*4+x);}
var cur = idx.map(function(i){ return grid[i];});
var r = slideLine(cur);
score += r.gained;
r.arr.forEach(function(v,t){ if(grid[idx[t]]!==v){ grid[idx[t]] = v; changed = true;}});
}
if(!changed){ score -= 0; return;}
addTile(); render();
if(!canMove()){ over = true; document.getElementById("msg").textContent = "无路可走，游戏结束！得分 " + score; submit();}
}
function canMove(){
if(grid.some(function(v){ return!v;})) return true;
for(var y=0;y<4;y++) for(var x=0;x<4;x++){ var v = grid[y*4+x]; if(x<3 && grid[y*4+x+1]===v) return true; if(y<3 && grid[(y+1)*4+x]===v) return true;}
return false;
}
function submit(){
if(submitted ||!token) return;
submitted = true;
fetch("/api/score", { method:"POST", headers:{ "content-type":"application/json"}, body: JSON.stringify({ s: token, score: score})})
.then(function(){ document.getElementById("msg").textContent += "（分数已提交排行榜）";})
.catch(function(){});
}
document.addEventListener("keydown", function(e){ if(e.key==="ArrowUp") move(0,-1); if(e.key==="ArrowDown") move(0,1); if(e.key==="ArrowLeft") move(-1,0); if(e.key==="ArrowRight") move(1,0);});
var tx = 0, ty = 0;
document.addEventListener("touchstart", function(e){ tx = e.touches[0].clientX; ty = e.touches[0].clientY;});
document.addEventListener("touchend", function(e){ var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; if(Math.abs(dx)<24 && Math.abs(dy)<24) return; if(Math.abs(dx)>Math.abs(dy)) move(dx>0?1:-1, 0); else move(0, dy>0?1:-1);});
grid = Array.from({ length:16}, function(){ return 0;});
addTile(); addTile(); render();
</script></body></html>`;

// ============================================================
// 管理员白名单与分级命令菜单
// 本 Bot 无管理员命令，COMMANDS_ADMIN 留空，模块照常保留。
// ============================================================
const COMMANDS_USER = [
  { command: "game", description: "发游戏卡片" },
  { command: "top", description: "总排行榜：/top snake 或 g2048" },
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
    for (const id of ids)
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
  }
  return r;
}

// ============================================================
// Worker 入口与路由
// /game/<name> 出游戏页、/api/score 收分数、/webhook 走 Bot 更新。
// 游戏页就是 Worker 自己的域名，与 Bot 共用一个部署。
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN 未配置", { status: 500 });
    if (url.pathname === "/")
      return new Response("game-platform bot is running.", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    if (url.pathname.startsWith("/game/")) {
      const page = url.pathname.slice("/game/".length);
      const html =
        page === "snake" ? SNAKE_HTML : page === "g2048" ? G2048_HTML : null;
      if (!html) return new Response("game not found", { status: 404 });
      return new Response(html, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (url.pathname === "/api/score" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const payload = await verifyToken(env, body.s || "");
      if (!payload)
        return Response.json(
          { ok: false, error: "令牌验签失败" },
          { status: 403 },
        );
      await submitScore(env, payload, Number(body.score) || 0);
      return Response.json({ ok: true });
    }
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
        allowed_updates: ["message", "callback_query", "inline_query"],
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
    // 游戏页 URL 要拼令牌，得知道自己的域名：从 webhook 请求的 Host 推
    update._origin = url.origin;
    ctx.waitUntil(handle(env, update));
    return new Response("ok");
  },
};

// ============================================================
// 业务主流程
// 游戏回调（带 game_short_name）优先于普通回调分发：按人签令牌、
// 拼游戏页 URL 用 answerCallbackQuery 的 url 字段送用户进场。
// /game 发两张卡片；inline 模式也能 @ 出游戏卡（记分走 inl 分支）。
// ============================================================
async function handle(env, update) {
  const cq = update.callback_query;
  if (cq && cq.game_short_name) {
    const game = GAMES[cq.game_short_name];
    if (!game)
      return tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "游戏不存在",
      });
    const payload = {
      u: cq.from.id,
      c: cq.message?.chat?.id,
      m: cq.message?.message_id,
      inl: cq.inline_message_id || undefined,
      g: cq.game_short_name,
      n: cq.from.first_name || "",
    };
    const token = await signToken(env, payload);
    const url = `${update._origin || ""}/game/${game.page}?s=${encodeURIComponent(token)}`;
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, url });
  }
  if (cq) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (update.inline_query) {
    const results = Object.values(GAMES).map((g, i) => ({
      type: "game",
      id: String(i),
      game_short_name: g.short,
    }));
    return tg(env, "answerInlineQuery", {
      inline_query_id: update.inline_query.id,
      results,
      cache_time: 60,
    });
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].split("@")[0];

  if (cmd === "/start" || cmd === "/help")
    return send(
      env,
      chatId,
      "🎮 游戏平台 Bot\n\n/game 发游戏卡片（贪吃蛇 + 2048），点卡片上的 Play 就能玩，分数自动记到卡片排行榜。\n/top snake 或 /top g2048 看跨聊天总榜。\n在别的聊天里 @ 我也能发出游戏卡（Inline 模式）。",
    );

  if (cmd === "/game") {
    for (const g of Object.values(GAMES)) {
      const r = await tg(env, "sendGame", {
        chat_id: chatId,
        game_short_name: g.short,
      });
      if (!r.ok)
        await send(
          env,
          chatId,
          `😵 ${g.title} 发送失败：${r.description || ""}（多半是 short_name 还没在 BotFather /newgame 注册，或与代码不一致）`,
        );
    }
    return;
  }

  if (cmd === "/top") {
    if (!env.BOT_KV)
      return send(
        env,
        chatId,
        "⚠️ 未绑定 KV，没有总榜数据（卡片自带榜不受影响）。",
      );
    const arg = (text.split(/\s+/)[1] || "snake").toLowerCase();
    const game = GAMES[arg];
    if (!game) return send(env, chatId, "用法：/top snake 或 /top g2048");
    const list = await env.BOT_KV.list({
      prefix: `gscore:${game.short}:`,
      limit: 1000,
    });
    const rows = [];
    for (const k of list.keys) {
      const v = JSON.parse((await env.BOT_KV.get(k.name)) || '{"s":0}');
      rows.push({ uid: k.name.split(":")[2], name: v.name || "", score: v.s });
    }
    rows.sort((a, b) => b.score - a.score);
    if (!rows.length)
      return send(env, chatId, `${game.title} 还没有成绩，先 /game 开一局。`);
    return send(
      env,
      chatId,
      `🏆 ${game.title} 总榜\n\n` +
        rows
          .slice(0, 10)
          .map((r, i) => `${i + 1}. ${r.name || "用户 " + r.uid} — ${r.score}`)
          .join("\n"),
    );
  }
}
