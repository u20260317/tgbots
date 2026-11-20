# 09 · 定时任务（Cron）模块

> 让 Bot 自己醒来干活：RSS 巡检、定时播报、到期清理、价格提醒，全靠 Worker 的 scheduled 事件 + Cloudflare Cron Triggers。

## 入口长这样（摘自 11-rss-push）

```js
async scheduled(event, env, ctx) {
    if (env.BOT_KV) ctx.waitUntil(runPush(env));
  }
```

`scheduled` 和 `fetch` 是同一个 Worker 的两个入口：前者由平台时钟唤醒，后者由 HTTP 请求唤醒。真正的活写在普通函数里，两个入口都能调（11 就留了 `/push?key=` 手动触发口，调试和补跑都方便）。

## 在模板里怎么配

部署时给 Worker 加 Cron Trigger（Cloudflare 面板 Settings → Triggers，或部署工具带上）。全库在用的节奏：

| 节奏 | Cron 表达式 | 用在哪 |
|---|---|---|
| 每 5 分钟 | `*/5 * * * *` | 21 定时播报（到点发帖） |
| 每小时 | `0 * * * *` | 11 RSS 巡检、23 价格提醒 |
| 每天凌晨 | `0 16 * * *`（UTC，即北京 0 点） | 14 到期会员清理 |

## 注意点

- Cron 用 UTC 时间，北京时间减 8 小时换算，别把早报设成半夜发。
- 免费版有子请求和 CPU 上限：一轮巡检别贪多（11 限制单轮条数、首次运行只播种不推送防刷屏），细节看各模板 README。
- 定时任务没有「用户在场」，发版前先用手动触发口把逻辑跑通，再放心交给时钟。
- 去重靠 KV 记状态（如 11 的 `rss_state` 存已推条目指纹），否则每轮都会重复推送。
