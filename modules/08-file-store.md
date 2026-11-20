# 08 · 文件存储模块

> 不花一分钱服务器存储：文件本体存在 Telegram 里，Bot 只在 KV 存一条索引。06 是「file_id 直存」，10 是「转存到私有频道」，两种路线都在这篇。

## 识别消息里的文件（摘自 06-file-store）

一条消息可能带 photo/document/video/audio/animation/voice/sticker，统一抽成 `{file_id, name, kind}`；photo 是数组，取最后一档（最大尺寸）。

```js
function fileOf(msg) {
  if (msg.document)
    return {
      kind: "document",
      id: msg.document.file_id,
      name: msg.document.file_name || "文件",
    };
  if (msg.photo?.length)
    return {
      kind: "photo",
      id: msg.photo[msg.photo.length - 1].file_id,
      name: "图片",
    };
  if (msg.video)
    return {
      kind: "video",
      id: msg.video.file_id,
      name: msg.video.file_name || "视频",
    };
  if (msg.audio)
    return {
      kind: "audio",
      id: msg.audio.file_id,
      name: msg.audio.file_name || "音频",
    };
  if (msg.voice) return { kind: "voice", id: msg.voice.file_id, name: "语音" };
  if (msg.animation)
    return { kind: "animation", id: msg.animation.file_id, name: "动图" };
  return null;
}
```

## 存与取

存：生成短码，KV 写 `f:<短码>` = 文件信息，回给用户一条 `?start=f_<短码>` 深链。取：任何人点深链进来，Bot 按短码查 KV，直接用 file_id 把文件发给他——文件从没离开过 Telegram，不占任何存储。

```js
  const f = fileOf(msg);
  if (f) {
    if (!admins(env).includes(String(msg.from.id)))
      return send(env, msg.chat.id, "⛔ 只有管理员能存文件。");
    const c = code();
    await env.BOT_KV.put(
      "f:" + c,
      JSON.stringify({ ...f, caption: msg.caption || "" }),
    );
    const link = `https://t.me/${env.BOT_USERNAME}?start=f_${c}`;
    return send(
      env,
      msg.chat.id,
      `✅ 已保存「${f.name}」\n\n🔗 分享链接：\n${link}\n\n任何人点开链接即可向我领取该文件。删除分享：在 KV 里删除键 f:${c}`,
    );
  }
```

## 两种路线对比

| | 06 file_id 直存 | 10 转存私有频道 |
|---|---|---|
| 原理 | 记住 file_id 直接复用 | copyMessage 到 STORAGE_CHANNEL，记消息号 |
| 优点 | 零配置、即存即用 | 文件在自己频道里留底、可人工管理 |
| 风险 | 原消息被删、Bot 被踢出原群后 file_id 可能失效 | 要建频道并拉 Bot 做管理员 |
| 适合 | 临时分享、个人用 | 长期网盘、多人协作 |

## 注意点

- file_id 与 Bot 绑定：A Bot 存的 file_id，B Bot 不能用。换 Bot 等于换仓库。
- 深链短码别用自增数字（可遍历猜测），06 用的是随机码。
