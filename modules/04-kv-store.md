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

`f:` 文件分享（06）· `index` 网盘目录（10）· `subs` 订阅者（09）· `pts:` 积分（13）· `lot:` 抽奖（13）· `order:`/`sub:` 订单与会员（14/15）· `prod:` 商品（15）· `ref:`/`refdone:` 邀请（16）· `task:`/`done:`/`claim:`/`exch:` 任务（17）· `dir:` 频道目录（18）· `poll:` 投票（19）· `jobs` 定时任务（21）· `stats:` 群统计（22）· `alerts` 价格提醒（23）· `chain:` 接龙（24）· `ledger:` 账本（25）· `quiz:`/`quizpts:` 竞答（26）· `msgmap:`/`boxsess:` 匿名信箱（29）· `ticket:`/`userticket:`/`tmap:` 工单（30）· `rss_state` RSS 去重（11） · `fsm:` 向导状态（20） · `bot:` 租户记录（21） · `t:<botId>:` 租户数据前缀（21） · `cart:` 购物车（22） · `paid:` Stars 支付幂等（24） · `ai:` AI 对话上下文/用量（25） · `lang:` 语言覆盖（29） · `stt:` 群转写开关（30） · `autotr:` 群自动翻译（31） · `fban:` 联邦封禁（33） · `note:` 群笔记（33） · `filter:` 群过滤器（33） · `rem:` 个人提醒（34） · `todo:` 待办清单（34） · `wolf:`/`wolfp:`/`wolfn:`/`wolfv:`/`wolfroom:` 狼人杀对局（35，41 落地为按人拆键） · `npoll:`/`qpts:`/`react:` 原生投票计分与反应（38） · `topic:` 工单话题映射（39） · `gh:` GitHub 通知去重/绑定（41/模板39） · `ping:` 存活打卡（41） · `media:`/`own:` 付费媒体与购买关系（42） · `dl:` 下载任务与用量（模板34） · `stk:` 贴纸待办与贴纸包（模板37） · `wx:` 天气订阅（模板38） · `mall:` 商城总部货源（模板33） · `mini:` Mini App 留言（模板42） · `ocr:` OCR 用量（模板43） · `pdf:` PDF 收集会话与计数（模板49） · `mus:` 音乐用量（模板50） · `gscore:` 游戏总榜（模板51） · `ach:`/`ban:` 匿名聊天与封禁（模板52） · `biz:` Business 连接（53） · `mgb:` Managed 待认领（54） · `aimg:` 绘图用量（55） · `course:`/`learn:` 课程与进度（56） · `book:` 预约占用（57） · `card:` 闪卡（58/模块47） · `snap:` 网页快照（60/模块48） · `gw:` 抽奖活动（61） · `cpinv:`/`cppaid:` Crypto Pay 发票（62） · `stat:` 频道采样（63） · `pod:` 播客订阅（65） · `live:` 直播订阅（66） · `parcel:` 快递（67） · `trip:` 行程（68） · `job:` 职位（69） · `estate:` 房源（70） · `astro:`/`tarot:` 运势塔罗（71） · `verse:` 经文订阅（72） · `shelf:` 书架（73） · `dao:` DAO 订阅（74） · `nft:` NFT 订阅（75） · `price:` 比价（76） · `date:` 交友档案（77） · `vpn:` VPN 订阅（78） · `habit:`/`pomo:` 习惯番茄（79） · `ask:` 提问墙（80） · `dom:` 域名监控（81） · `avatar:` 头像（82） · `matchq:`/`match:` 匹配队列（模块50）

## 注意点

- KV 是最终一致：刚写完立刻读，偶尔读到旧值（全球同步约需几秒）。像「付款确认」这种关键路径，模板里都是先落 KV 再回复，个别时序问题在测试记录里有标注。
- 免费版 KV 有每日写入次数上限，高频写（如群统计）要攒批或接受采样，22 的实现是按天聚合一键一条。
- 可以给键设 `expirationTtl` 自动过期：22 的统计键 35 天自删、12 的待审申请都会这么用，省得手动清理。
- 一个 Bot 一个 KV 命名空间最省心；拼装多个模块共用一个命名空间时，靠上面的前缀注册表隔离。
