# 19 · 外部 API 调用与提醒模块

> Bot 不只是收发消息，还能当监控器：定时拉第三方公开接口的数据，命中条件就推送。23-crypto-price 的行情查询+价格提醒是范例，27 翻译、28 工具箱也是同一路数（调免费公开端点）。

## 查数据（摘自 23-crypto-price）

用交易所公开行情接口（免 key），fetch 后只取需要的字段，接口挂了就返回 null 让上层友好报错，别把异常抛进 webhook。

```js
async function ticker(symbol) {
  const pair = symbol.toUpperCase().replace(/USDT$/, "") + "USDT";
  const r = await fetch(
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${pair}`,
  );
  if (!r.ok) return null;
  const d = await r.json();
  return {
    pair,
    price: Number(d.lastPrice),
    change: Number(d.priceChangePercent),
    high: Number(d.highPrice),
    low: Number(d.lowPrice),
  };
}
```

## 条件提醒

提醒规则存 KV `alerts`（用户、币种、方向、目标价），Cron 每轮批量拉价逐条比对，命中就私聊推送并删除该提醒（一次性语义，防反复轰炸）。

```js
async function checkAlerts(env) {
  let alerts = await loadAlerts(env);
  if (!alerts.length) return 0;
  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  const prices = {};
  for (const s of symbols) {
    const t = await ticker(s);
    if (t) prices[s] = t.price;
  }
  const keep = [];
  let fired = 0;
  for (const a of alerts) {
    const p = prices[a.symbol];
    const hit =
      p !== undefined &&
      ((a.cond === ">" && p > a.target) || (a.cond === "<" && p < a.target));
    if (hit) {
      fired++;
      await send(
        env,
        a.user,
        `🔔 价格提醒触发！\n${a.symbol}USDT 现价 $${fmtPrice(p)}，已${a.cond === ">" ? "突破" : "跌破"}你设的 $${fmtPrice(a.target)}。`,
      ).catch(() => {});
    } else keep.push(a);
  }
  if (fired) await saveAlerts(env, keep);
  return fired;
}
```

## 注意点

- 免费公开接口都有频率限制：多条提醒查同一个币种时先合并成一次请求，别一条提醒打一次。
- 提醒是「到价通知」不是交易建议，推送文案里把数据来源和时间写上。
- 这类非官方端点（包括 27 用的翻译接口）随时可能变卦或限流，代码里必须容错，README 里也要跟使用者讲明。
