# 17 · 配置驱动菜单与关键词回复模块

> 不写死逻辑、只改配置：菜单树和关键词回复全写在一个 CONFIG 对象里，加页面、改文案不用动业务代码。07-menu-faq 的路线，适合 FAQ、导航、客服话术类 Bot。

## 配置长这样（摘自 07-menu-faq）

```js
const CONFIG = {
  homePage: "home",
  pages: {
    home: {
      text: "👋 欢迎！点下面菜单了解我们：",
      buttons: [
        [
          { text: "📖 关于我们", page: "about" },
          { text: "💰 价格/服务", page: "price" },
        ],
        [{ text: "❓ 常见问题", page: "faq" }],
        [
          { text: "🌐 官网", url: "https://example.com" },
          { text: "📣 频道", url: "https://t.me/telegram" },
        ],
      ],
    },
    about: {
      text: "📖 关于我们\n\n这里写介绍……",
      buttons: [[{ text: "⬅️ 返回主页", page: "home" }]],
    },
    price: {
```

## 菜单渲染

按当前页 ID 从 CONFIG 取出文本和按钮定义，按钮的回调 data 就是目标页 ID，点哪跳哪；「返回」靠每页自带 back 按钮，不用维护历史栈。

```js
function keyboard(pageId) {
  const p = CONFIG.pages[pageId];
  if (!p?.buttons?.length) return undefined;
  return {
    inline_keyboard: p.buttons.map((row) =>
      row.map((b) =>
        b.url
          ? { text: b.text, url: b.url }
          : { text: b.text, callback_data: "pg:" + b.page },
      ),
    ),
  };
}
```

## 注意点

- 内容和代码分离后，非技术的人也能改文案——把 CONFIG 段发给他改完贴回即可。
- 关键词回复是精确/包含两种匹配，顺序即优先级：把更具体的词放前面，避免被宽泛词截胡。
- 页面 ID 命名保持稳定，改名等于所有旧消息上的按钮失效（回调找不到页）。
