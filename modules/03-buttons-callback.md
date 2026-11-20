# 03 · 按钮与回调模块

> 内联按钮（inline keyboard）的构造、回调分发、按钮回执与原地编辑消息。抽奖报名、翻页、审核通过/拒绝、答题，全是这一套。

## 按钮怎么发

按钮挂在消息的 `reply_markup.inline_keyboard` 上：二维数组，外层是行、内层是列。按钮两种：`url` 型（点开链接）和 `callback_data` 型（点了给 Bot 发一条回调，data 最长 64 字节，用「前缀:参数」的约定区分用途）。

```js
// ============================================================
// 13 签到积分 / 抽奖 Bot（单文件 · Cloudflare Workers + 需绑定 KV）
// 功能：
// 每日签到：/qd 或 /checkin，每天一次，基础 10 分 + 连签加成（每天 +1，上限 +10）
// 积分查询：/me 我的积分、连签天数；/top 积分榜 Top 10
// 抽奖：管理员 /lottery 奖品名 在当前聊天发起（群里发就群里抽），
// 成员点消息上的「🎁 参与抽奖」按钮报名（可设参与门票积分 LOTTERY_COST），
// 管理员 /draw 抽奖ID [中奖人数] 开奖，Bot 公布并私聊通知中奖者
// 必填变量：
// BOT_TOKEN BotFather Token（Secret）
```

## 回调怎么收

按钮点击到达的是 `callback_query` 更新（webhook 的 allowed_updates 必须含 `callback_query`）。处理三件套：按 `data` 前缀分发业务；`answerCallbackQuery` 给用户一个回执（不答的话按钮会一直转圈）；需要刷新消息时用 `editMessageText` 原地改文本和按钮，不要新发一条刷屏。

```js
  const cq = update.callback_query;
  if (cq) {
    if (String(cq.data || "").startsWith("top:")) {
      if (cq.data === "top:noop")
        return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      const rows = await topRows();
      const v = topView(rows, parseInt(cq.data.slice(4), 10) || 0);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      return tg(env, "editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: v.text,
        ...(v.reply_markup ? { reply_markup: v.reply_markup } : {}),
      });
    }
    if (!String(cq.data || "").startsWith("lj:")) return;
    const lotId = cq.data.slice(3);
    const lot = await getLottery(env, lotId);
```

## 实战：排行榜翻页

每页 10 条，渲染函数同时产出文本和按钮行（上一页/页码/下一页），首页发消息时带上，后续翻页全靠 editMessageText 原地换页。页码按钮用 noop 回调（点了只回执、不动作），到头到尾自动少一个方向按钮。

```js
function topView(rows, page) {
    const pages = Math.max(1, Math.ceil(rows.length / TOP_PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const text =
      "🏆 积分榜\n\n" +
      rows
        .slice(p * TOP_PAGE, p * TOP_PAGE + TOP_PAGE)
        .map((r, i) => `${p * TOP_PAGE + i + 1}. ${r.name} — ${r.p} 分`)
        .join("\n");
    if (pages <= 1) return { text };
    const nav = [];
    if (p > 0) nav.push({ text: "⬅️ 上一页", callback_data: `top:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: "top:noop" });
    if (p < pages - 1)
      nav.push({ text: "下一页 ➡️", callback_data: `top:${p + 1}` });
    return { text, reply_markup: { inline_keyboard: [nav] } };
  }
```

## 全库回调前缀约定（拼装时防冲突）

| 前缀 | 用途 | 出处 |
|---|---|---|
| `lj:` | 抽奖报名 | 13 |
| `top:` / `topinv:` / `qtop:` | 三种排行榜翻页 | 13 / 16 / 26 |
| `jr:` | 入群申请审核 | 12 |
| `payok:` / `payno:` | 付款确认 | 14 / 15 |
| `vote:` | 投票 | 19 |
| `quiz:` | 答题 | 26 |
| `join:` | 接龙报名 | 24 |
| `check` / `gcheck` | 订阅复检 | 03 / combo-group-guard |
| `shop:` / `cart:` | 商店导航 / 购物车操作 | 22 |
| `rem:` | 待办勾选（rem:done:<id>） | 34 |
| `ai:` | AI 人设/清空类按钮（预留） | 25 |
| `wolf:` | 狼人杀行动（join/kill/check/save/poison/vote） | 35 |
| `pmedia:` | 付费媒体购买/查看（buy/view） | 42 |
| `mb:` | 母体入驻向导/租户管理 | 模板 32 |
| `mall:` | 商城开店向导/店铺管理 | 模板 33 |
| `dl:` | 下载画质选择 | 模板 34 |
| `stk:` | 贴纸 emoji 选择 | 模板 37 |
| `pdf:` | PDF 拼装/清空（make/clear） | 模板 49 |
| `report:` / `ach:` | 匿名聊天举报/确认/换人/断开 | 模板 52 |
| `mgb:` | Managed 子 Bot 管理（rotate/revoke） | 模板 54 |
| `aimg:` | 绘图重新生成 | 模板 55 |
| `lesson:` | 课程开课/测验/下一课 | 模板 56 |
| `bk:` / `bok:` / `bno:` | 预约流与管理员确认/拒绝 | 模板 57 |
| `fc:` | 闪卡翻面/评分/删卡 | 模板 58 |
| `snap:` | 监控列表删除 | 模板 60 |
| `gw:` | 抽奖参与 | 模板 61 |
| `cp:` | Crypto Pay 发票状态刷新 | 模板 62 |
| `radio:` | 电台点播 | 模板 65 |
| `jobok:` / `jobno:` | 职位审核通过/拒绝 | 模板 69 |
| `astro:` / `tarot:` | 星座选择/塔罗抽牌 | 模板 71 |
| `verse:faith:` / `book:` / `shelf:del:` | 经文选库/书库取书/书架删除 | 模板 72 / 73 |
| `dao:un:` / `nft:un:` / `price:del:` / `dom:del:` | 各类订阅退订/删除 | 模板 74 / 75 / 76 / 81 |
| `date:` | 交友建卡/喜欢/跳过/举报 | 模板 77 |
| `vpn:plan:` / `vpn:ok:` / `vpn:no:` | VPN 套餐/确认/拒绝 | 模板 78 |
| `habit:do:` / `habit:del:` / `pomo:x:` | 习惯打卡/删除、番茄取消 | 模板 79 |
| `ask:ok:` / `ask:no:` | 提问墙审核 | 模板 80 |
| `avatar:style:` / `avatar:id:` | 头像风格/证件照规格 | 模板 82 |

新拼模块时先查这张表，前缀不撞就能共存；完整拼装规则见 [docs/ASSEMBLY.md](../docs/ASSEMBLY.md)。
