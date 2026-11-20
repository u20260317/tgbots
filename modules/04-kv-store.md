# 04 · KV 状态存储模块

> 全库不用数据库：所有状态都放 Cloudflare KV，值统一存 JSON 字符串，键用「前缀:ID」的命名约定。这一篇是读写姿势合集。

## 基本姿势：一读一写两个函数

以 13 的用户档案为例——读不到就返回默认对象，写就整体序列化。简单、够用、不怕并发覆盖出花（单用户低频写场景完全没问题）。

```js
async function getProfile(env, userId) {
  const raw = await env.BOT_KV.get("pts:" + userId);
  return raw ? JSON.parse(raw) : { p: 0, last: "", streak: 0, name: "" };
}
async function saveProfile(env, userId, prof) {
  await env.BOT_KV.put("pts:" + userId, JSON.stringify(prof));
}
```

## 全量扫描：排行榜就是这么来的

`list({prefix})` 列出某前缀的全部键，再逐个 get、排序、切片。千级用户内毫无压力；再大就该考虑分页扫描或换 D1 了。

```js
async function topRows() {
    const list = await env.BOT_KV.list({ prefix: "pts:", limit: 1000 });
    const rows = [];
    for (const k of list.keys) {
      const raw = await env.BOT_KV.get(k.name);
      if (raw) {
        const p = JSON.parse(raw);
        rows.push({ name: p.name || k.name.slice(4), p: p.p });
      }
    }
    rows.sort((a, b) => b.p - a.p);
    return rows;
  }
```

## 键命名注册表（拼装防冲突）

`f:` 文件分享（06）· `index` 网盘目录（10）· `subs` 订阅者（09）· `pts:` 积分（13）· `lot:` 抽奖（13）· `order:`/`sub:` 订单与会员（14/15）· `prod:` 商品（15）· `ref:`/`refdone:` 邀请（16）· `task:`/`done:`/`claim:`/`exch:` 任务（17）· `dir:` 频道目录（18）· `poll:` 投票（19）· `jobs` 定时任务（21）· `stats:` 群统计（22）· `alerts` 价格提醒（23）· `chain:` 接龙（24）· `ledger:` 账本（25）· `quiz:`/`quizpts:` 竞答（26）· `msgmap:`/`boxsess:` 匿名信箱（29）· `ticket:`/`userticket:`/`tmap:` 工单（30）· `rss_state` RSS 去重（11）

## 注意点

- KV 是最终一致：刚写完立刻读，偶尔读到旧值（全球同步约需几秒）。像「付款确认」这种关键路径，模板里都是先落 KV 再回复，个别时序问题在测试记录里有标注。
- 免费版 KV 有每日写入次数上限，高频写（如群统计）要攒批或接受采样，22 的实现是按天聚合一键一条。
- 可以给键设 `expirationTtl` 自动过期：22 的统计键 35 天自删、12 的待审申请都会这么用，省得手动清理。
- 一个 Bot 一个 KV 命名空间最省心；拼装多个模块共用一个命名空间时，靠上面的前缀注册表隔离。
