# 15 · RSS 抓取与解析模块

> 无依赖解析 RSS/Atom：不引第三方库，用正则按 `<item>`/`<entry>` 切块再逐字段抠。够用、透明、坏了好修——11-rss-push 的核心。

## 解析器（摘自 11-rss-push）

```js
function parseFeed(xml) {
  const blocks =
    xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) || [];
  const feedTitle = tagOf(xml.split(/<item|<entry/i)[0], "title");
  return {
    feedTitle,
    items: blocks
      .map((b) => ({
        title: tagOf(b, "title"),
        link: linkOf(b),
        id:
          tagOf(b, "guid") || tagOf(b, "id") || linkOf(b) || tagOf(b, "title"),
      }))
      .filter((x) => x.title && x.link),
  };
}
```

要点：先 decodeEntities 还原 `&amp;` 之类实体；标题、链接、时间逐个 tag 抠，抠不到就跳过这条，宁缺毋滥。

## 去重与推送

状态存 KV `rss_state`：每个源记一份已推条目的指纹集（链接或标题哈希）。每轮巡检只推没见过的新条目；**首次运行只播种不推送**（把现有条目全标记为已见），否则订阅一个老博客会瞬间刷屏几十条。

```js
      if (!r.ok) {
        errors++;
        continue;
      }
      const { feedTitle, items } = parseFeed(await r.text());
      if (!items.length) continue;
      const seen = state[feed];
      if (!seen) {
        // 首轮播种：只记状态不推送
        state[feed] = items.map((x) => x.id).slice(0, 30);
        seeded++;
        continue;
      }
      const fresh = items
```

## 注意点

- 触发方式是 Cron（见 09 号模块），单轮设条数上限，防某个源诈尸式更新刷屏。
- 关键词过滤在推送前做（KEYWORDS 命中才推），不同频道订不同源+词，别一锅烩。
- YouTube 频道、绝大多数博客都有官方 RSS（频道页源码里找 channel_id 拼 feed 地址），不需要爬虫；真没有 RSS 的站点才需要「网页快照对比」方案（尚未收录，见仓库待办讨论）。
- 有些源对 Cloudflare 出口 IP 不友好会 403，解析器要对非 200 直接跳过本轮，别重试轰炸。
