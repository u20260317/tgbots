# 30 · 语音转文字模块

> 用户发一段语音，Bot 自动转成文字回出来：靠 getFile 下载语音文件，再调 Whisper 类转写接口。私聊随发随转，群里可开「自动转写」当会议记录。

## 原理

语音消息里带的是 `voice.file_id`，文件本体要两步拿：先 `getFile` 换出 `file_path`，再拼 `https://api.telegram.org/file/bot<TOKEN>/<file_path>` 下载二进制。拿到音频后用 multipart 表单 POST 给转写接口（OpenAI 的 `/audio/transcriptions` 是事实标准格式，model 填 whisper-1，很多兼容服务都吃这套），返回 JSON 里的 `text` 就是转写结果。Telegram 的语音是 ogg/opus 格式，这个接口可以直接吃，不用转码。

## 代码

```js
// ============================================================
// 【核心模块】语音转文字（ASR）
// 流程：getFile 换路径 → 下载音频 → multipart 上传转写接口。
// 时长护栏：超过 ASR_MAX_SEC 的语音直接拒收——转写按时长计费，
// 也防有人拿几小时的录音刷爆你的额度。getFile 下载上限 20MB。
// ============================================================
async function transcribeVoice(env, voice) {
  if (voice.duration > (Number(env.ASR_MAX_SEC) || 120))
    return { ok: false, text: "语音太长啦，超过 " + (env.ASR_MAX_SEC || 120) + " 秒的我不转。" };
  const gf = await tg(env, "getFile", { file_id: voice.file_id });
  if (!gf.ok) return { ok: false, text: "没取到语音文件，再发一次试试。" };
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
  const audio = await (await fetch(fileUrl)).blob();
  const form = new FormData();
  form.append("file", audio, "voice.ogg");
  form.append("model", env.ASR_MODEL || "whisper-1");
  const r = await fetch(env.ASR_BASE + "/audio/transcriptions", {
    method: "POST",
    headers: { authorization: "Bearer " + env.ASR_KEY },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!data.text) return { ok: false, text: "这段语音没听清，再说一次？" };
  return { ok: true, text: data.text };
}

// ============================================================
// 【核心模块】语音消息入口（私聊 + 群自动转写开关）
// 群里的开关存 KV stt:<群ID> = "1"/"0"，管理员 /stt on|off 切换；
// 没开的群里不自动转（语音是隐私内容，默认关，见注意点）。
// 转写结果用「回复原语音」的方式发，群里一眼能对上是哪段话。
// ============================================================
async function handleVoice(env, msg) {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "private") {
    const on = env.BOT_KV && (await env.BOT_KV.get("stt:" + chatId)) === "1";
    if (!on) return;
  }
  const r = await transcribeVoice(env, msg.voice);
  return send(env, chatId, r.ok ? "📝 " + r.text : r.text, {
    reply_to_message_id: msg.message_id,
  });
}
async function handleSttSwitch(env, msg, arg) {
  if (!isAdmin(env, msg.from.id))
    return send(env, msg.chat.id, "⛔ 只有管理员能开关自动转写。");
  await env.BOT_KV.put("stt:" + msg.chat.id, arg === "on" ? "1" : "0");
  return send(env, msg.chat.id, arg === "on" ? "✅ 本群语音自动转写已开。" : "🔇 本群语音自动转写已关。");
}
```

## 接入步骤

1. 环境变量：`ASR_BASE`（转写接口地址，如 `https://api.openai.com/v1` 或兼容服务）、`ASR_KEY`（Secret）、`ASR_MODEL`、`ASR_MAX_SEC`（默认 120）。
2. handle() 消息分支里加：`if (msg.voice) return handleVoice(env, msg);`
3. 群自动转写再加命令 `/stt on|off` 并注册进命令表；开关状态需要 KV 绑定 `BOT_KV`。

## 注意点

- 语音是高度隐私的内容：群里默认不开自动转写，开之前在群里明示，转写文本也别再往别处转发或长期存档。
- `file_path` 有时效（约 1 小时），拿到就立刻下载，别存下来慢慢用；要留音频存 file_id 就够（见 08 号模块）。
- 转写质量取决于口音和环境噪音，方言、嘈杂场合错误率明显上升，文案上别承诺「精准转写」。
- 和 31 号翻译进阶拼起来就是语音翻译：先本模块转文字，再走翻译，最后回出译文。
