# 31 · 翻译进阶模块

> 27 号翻译模板的升级篇：从「打字互译」扩展到文档翻译、语音翻译、图片 OCR 翻译和群自动翻译四条管线。底层翻译调用沿用 27 号的 translateText（gtx 免费接口），换引擎只改那一个函数。

## 四条管线一览

| 管线 | 输入 | 流程 | 关键限制 |
|---|---|---|---|
| 文档翻译 | .txt 等文本文件 | 下载 → 抽文本 → 分段翻译 → 生成译文文件回传 | getFile 20MB；docx/pdf 要外部解析 |
| 语音翻译 | 语音消息 | ASR 转文字（30 号模块）→ 翻译 → 回文字（可选 TTS 回语音） | 串行两段接口，慢 |
| 图片翻译 | 带文字的图片 | OCR 接口提字 → 翻译 → 回译文 | Workers 跑不了 OCR，必须调外部接口 |
| 群自动翻译 | 群内文本消息 | 检测语言 ≠ 目标语言 → 回帖附译文 | 要管理员开开关，防刷屏 |

## 代码

```js
// ============================================================
// 【核心模块】长文本分段翻译
// 翻译接口都有单次长度上限，长文按段落切、逐段译、再拼回去；
// 切分只在空行/句末下刀，别把一句话劈成两半分开译。
// translateText 沿用 27 号模板的实现（gtx 接口），签名保持一致。
// ============================================================
function splitForTranslate(text, maxLen = 1500) {
  const parts = [];
  let buf = "";
  for (const para of text.split(/\n\s*\n/)) {
    if ((buf + "\n\n" + para).length > maxLen && buf) {
      parts.push(buf);
      buf = para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
    while (buf.length > maxLen) {
      // 单段都超长时在句号处硬切
      const cut = Math.max(
        buf.lastIndexOf("。", maxLen),
        buf.lastIndexOf(". ", maxLen),
      );
      const at = cut > 200 ? cut + 1 : maxLen;
      parts.push(buf.slice(0, at));
      buf = buf.slice(at);
    }
  }
  if (buf) parts.push(buf);
  return parts;
}
async function translateLong(env, text, target) {
  const out = [];
  for (const part of splitForTranslate(text))
    out.push(await translateText(env, part, target));
  return out.join("\n\n");
}

// ============================================================
// 【核心模块】文档翻译（以 .txt 为例）
// 下载文件 → 解码文本 → translateLong → 把译文打包成文件回传。
// 回传走 multipart 的 sendDocument（FormData 直接塞 Blob）。
// docx/pdf 的文本抽取 Workers 本地做不了：要么让用户贴纯文本，
// 要么接一个外部解析服务，接口位置在 extractText 里替换。
// ============================================================
async function handleDocTranslate(env, msg, target) {
  const chatId = msg.chat.id;
  const doc = msg.document;
  if (doc.file_size > 5 * 1024 * 1024)
    return send(env, chatId, "文件超过 5MB，先拆小一点再发。");
  const gf = await tg(env, "getFile", { file_id: doc.file_id });
  if (!gf.ok) return send(env, chatId, "文件没取到，再发一次试试。");
  const buf = await (
    await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`)
  ).arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const translated = await translateLong(env, text, target);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "document",
    new Blob([translated], { type: "text/plain;charset=utf-8" }),
    (doc.file_name || "file") + "." + target + ".txt",
  );
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
}

// ============================================================
// 【核心模块】语音翻译 + 图片翻译（管线拼装）
// 语音翻译 = 30 号模块的 transcribeVoice → translateText，两段串行。
// 图片翻译 = 外部 OCR 接口提字 → translateText；OCR 走 env.OCR_BASE，
// Workers 里没有本地 OCR 引擎，这一步不存在「自己跑」的选项。
// ============================================================
async function handleVoiceTranslate(env, msg, target) {
  const r = await transcribeVoice(env, msg.voice); // 30 号模块
  if (!r.ok) return send(env, msg.chat.id, r.text);
  const translated = await translateText(env, r.text, target);
  return send(env, msg.chat.id, "🗣️ 原文：" + r.text + "\n\n🌐 译文：" + translated, {
    reply_to_message_id: msg.message_id,
  });
}
async function handlePhotoTranslate(env, msg, target) {
  const photo = msg.photo[msg.photo.length - 1]; // 取最大尺寸那张
  const gf = await tg(env, "getFile", { file_id: photo.file_id });
  if (!gf.ok) return;
  const img = await (
    await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`)
  ).blob();
  const form = new FormData();
  form.append("file", img, "photo.jpg");
  const ocrRes = await fetch(env.OCR_BASE + "/ocr", {
    method: "POST",
    headers: { authorization: "Bearer " + env.OCR_KEY },
    body: form,
  });
  const ocr = await ocrRes.json().catch(() => ({}));
  if (!ocr.text) return send(env, msg.chat.id, "图片里没认出文字。");
  const translated = await translateText(env, ocr.text, target);
  return send(env, msg.chat.id, "🌐 " + translated, {
    reply_to_message_id: msg.message_id,
  });
}

// ============================================================
// 【核心模块】群自动翻译模式
// 开关与目标语言存 KV autotr:<群ID> = "zh"（目标语言码），空 = 关闭。
// 群里每条文本先粗判语言（含中文字符判 zh，纯 ASCII 粗判 en），
// 和目标不一致才回帖译文；细判可换接口 detect，别为每条消息都调 API。
// ============================================================
function roughLang(text) {
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[a-zA-Z]/.test(text)) return "en";
  return "";
}
async function handleAutoTranslate(env, msg) {
  if (!env.BOT_KV || !msg.text || msg.text.startsWith("/")) return;
  const target = await env.BOT_KV.get("autotr:" + msg.chat.id);
  if (!target) return;
  const src = roughLang(msg.text);
  if (!src || src === target || msg.text.length < 4) return;
  const translated = await translateText(env, msg.text, target);
  return send(env, msg.chat.id, "🌐 " + translated, {
    reply_to_message_id: msg.message_id,
  });
}
```

## 接入步骤

1. 先确保 27 号的 `translateText(env, text, target)` 已在文件里，30 号的 `transcribeVoice` 按需一起拼（语音翻译才需要）。
2. 文档/图片管线需要 KV 之外的外部服务：图片 OCR 填 `OCR_BASE`/`OCR_KEY`（Secret）。
3. handle() 里按消息类型分发：`msg.document` → 文档翻译，`msg.photo` → 图片翻译，群文本在普通消息分支末尾调 `handleAutoTranslate`。
4. 群自动翻译开关命令（如 `/autotr zh` / `/autotr off`）写 `autotr:<群ID>`，限管理员，注册进命令表。

## 注意点

- gtx 免费接口不稳定、有限流，只适合轻量场景；正经用量把 translateText 换成付费翻译 API 或 25 号模块的 AI 接口，管线其余部分不用动。
- 分段翻译会丢跨段指代（「他/它」指谁），长文档译文连贯性一般，重要文件建议人工校对。
- 群自动翻译很容易刷屏：短句、命令、纯表情都跳过（代码里已过滤），再加一层「同一人 1 分钟最多译 N 条」更稳，节流思路见 27 号模块。
- 语音翻译是两段付费接口串行，延迟和成本都是双倍，回复前先发个「翻译中…」占位再编辑，用户体验好很多。
