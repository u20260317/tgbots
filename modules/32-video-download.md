# 32 · 视频/媒体链接解析下载模块

> 用户贴一条视频链接（YouTube/TikTok/B站等），Bot 解析出可下载的媒体地址并把视频发回聊天。解析层做成可替换接口，因为这层最易变、也最敏感。

## 先说清边界（合规）

- 只下载**用户自己有权获取**的内容（自己上传的、无版权或已授权的）；模块和模板的说明里都要写这句，别替用户判断权属之外的灰色地带背锅。
- **不绕 DRM、不破解付费墙、不提供去水印破解类解析源**：解析接口只接返回正规直链的服务，遇到加密/付费内容直接告知用户下不了。
- 平台条款对「下载」多有限制，自用工具和公开运营是两种风险等级，公开给陌生人用之前先想清楚。

## 为什么 Workers 里跑不了 yt-dlp

yt-dlp 是 Python 程序，要 spawn 进程跑二进制、长时间解析、还要大流量中转——Cloudflare Workers 没有子进程、单次执行时长和内存（128MB）都卡死，本机路线直接排除。唯一可行的架构是**外置解析**：Worker 只负责识别链接、调第三方解析 API（或你自己在别处部署的解析服务）、拿直链发货。解析源会失效、会跑路，所以接口必须抽象成一层，换源只改一个函数。

## 代码

```js
// ============================================================
// 【核心模块】链接识别
// 先认域名再谈解析：不在支持清单里的链接直接回绝，别拿去喂解析源。
// 返回 { platform, url }，认不出返回 null。
// ============================================================
const VIDEO_HOSTS = [
  { platform: "youtube", re: /(youtube\.com\/(watch|shorts)|youtu\.be\/)/ },
  { platform: "tiktok", re: /(tiktok\.com|douyin\.com|vt\.tiktok)/ },
  { platform: "bilibili", re: /bilibili\.com|b23\.tv/ },
  { platform: "x", re: /(twitter\.com|x\.com)\// },
];
function extractVideoLink(text) {
  const m = String(text || "").match(/https?:\/\/[^\s]+/);
  if (!m) return null;
  const url = m[0];
  const hit = VIDEO_HOSTS.find((h) => h.re.test(url));
  return hit ? { platform: hit.platform, url } : null;
}

// ============================================================
// 【核心模块】解析层（可替换接口）
// 约定：resolveMedia(url) → { title, formats: [{quality, url, size}] }
// size 是字节数（拿不到就给 0）。换解析源 = 只改这个函数体，
// 环境变量 PARSER_API 指向服务地址、PARSER_KEY 走 Secret。
// 解析源返回付费/加密内容时应返回空 formats，上层统一话术拒绝。
// ============================================================
async function resolveMedia(env, url) {
  const r = await fetch(env.PARSER_API + "/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + env.PARSER_KEY,
    },
    body: JSON.stringify({ url }),
  });
  const data = await r.json().catch(() => ({}));
  return {
    title: data.title || "video",
    formats: Array.isArray(data.formats) ? data.formats : [],
  };
}

// ============================================================
// 【核心模块】发货：选档 + 发送
// Bot API 的硬上限：普通 Bot 发文件 ≤ 50MB。选档策略：在 50MB 内
// 挑画质最高的；直链短时有效，必须即取即发，不能存下来慢慢用。
// 发送两条路：
//  A. sendVideo 传 URL——Telegram 服务器自己去抓，省 Worker 流量，
//     但对方服务器抓取慢/被拒时容易失败，且实际可抓体积更小；
//  B. Worker 中转——fetch 下回来再 multipart 上传，稳但吃内存和流量，
//     只对 ≤50MB 用，且先看 content-length 再决定下不下。
// 超过 50MB 两个办法都不行：回直链让用户自取（并说明原因）。
// Telegram Bot API 不支持分片/断点续传上传，真要传大文件只能
// 自建 Local Bot API Server（上限 2GB），那是另一套部署，不在本模块内。
// ============================================================
const MAX_SEND = 50 * 1024 * 1024;
function pickFormat(formats) {
  const ok = formats
    .filter((f) => f.url && (!f.size || f.size <= MAX_SEND))
    .sort((a, b) => (b.size || 0) - (a.size || 0));
  return ok[0] || null;
}
async function handleVideoDownload(env, msg) {
  const chatId = msg.chat.id;
  const link = extractVideoLink(msg.text);
  if (!link) return send(env, chatId, "没认出这是支持的视频链接。");
  await send(env, chatId, "⏳ 正在解析，请稍候…");
  let media;
  try {
    media = await resolveMedia(env, link.url);
  } catch {
    return send(env, chatId, "解析服务暂时不可用，稍后再试。");
  }
  const fmt = pickFormat(media.formats);
  if (!fmt) {
    const big = media.formats.find((f) => f.url);
    if (big)
      return send(
        env,
        chatId,
        "这个视频超过 Bot 能发送的 50MB 上限，给你直链自己下：\n" + big.url,
      );
    return send(env, chatId, "没解析出可下载的地址（可能是付费或受限内容）。");
  }
  // 路线 A 优先：让 Telegram 自己抓直链
  const r = await tg(env, "sendVideo", {
    chat_id: chatId,
    video: fmt.url,
    caption: media.title,
  });
  if (r.ok) return r;
  // 路线 B 兜底：Worker 中转上传
  const head = await fetch(fmt.url, { method: "HEAD" }).catch(() => null);
  const len = Number(head?.headers.get("content-length") || 0);
  if (len && len > MAX_SEND)
    return send(env, chatId, "文件超过 50MB，这里只给直链：\n" + fmt.url);
  const blob = await (await fetch(fmt.url)).blob();
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", blob, "video.mp4");
  form.append("caption", media.title);
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`, {
    method: "POST",
    body: form,
  });
}
```

## 接入步骤

1. 环境变量：`PARSER_API`（解析服务地址）、`PARSER_KEY`（Secret）。没有现成解析源时，先拿一个自部署/第三方的凑合，但要接受它随时失效。
2. handle() 文本分支里：文本含链接且命中 `extractVideoLink` 就走 `handleVideoDownload`，放在普通命令分发之前或单独命令 `/dl` 触发。
3. 支持平台清单在 `VIDEO_HOSTS` 里增删，解析源不支持的平台别往里加，加了也是天天报错。

## 注意点

- 直链基本都是短时签名地址：解析完立刻发，隔几分钟就 403，别想着缓存复用。
- 中转路线 B 一条 50MB 视频就吃满 Worker 的内存和出站流量，免费额度下并发两三个就顶不住——优先走路线 A。
- 同一个链接短时间被反复贴会重复解析下载，加一层「同用户冷却 30 秒」很值，节流思路见 27 号模块。
- 再次强调：只走 Bot API 正规发送通道，不做去水印破解、不绕付费和 DRM；解析源的选择也要按这个标准筛。
