# 02 · 管理员白名单与分级命令菜单模块

> 让管理员命令只出现在管理员自己的菜单里：普通用户看不见，点不到；手打发过来也会被业务里的 isAdmin 拦下。全部 33 个模板的标配模块。

## 原理

Telegram 的 `setMyCommands` 支持 scope（作用域）：默认 scope 对所有人生效；`scope={type:"chat", chat_id:某人ID}` 只对那个人与 Bot 的私聊生效。于是注册两遍——默认只放用户命令，再给每个白名单管理员单独注册「用户+管理员」全集，管理员命令就只在管理员的菜单里出现。

**菜单隐藏只是体验层，不是安全边界**：真正的拦截靠每个管理员命令在业务代码里的 `isAdmin(env, msg.from.id)` 校验。两层配合：看不见 + 用不了。

## 代码（摘自 13-checkin-lottery，含模块注释原文）

```js
// ============================================================
// 【核心模块】管理员白名单与分级命令菜单
// 白名单怎么绑：环境变量 ADMIN_ID 填管理员数字 ID（多个英文逗号
// 隔开），菜单分级和业务里的 isAdmin() 校验都认这份名单——不靠
// 用户名，用户名能改、能冒充，数字 ID 不会。
// 菜单为什么分两级：setMyCommands 支持 scope（作用域）——
//   · 默认 scope 注册 COMMANDS_USER，所有人都能看到；
//   · 再给每个管理员 ID 用 scope=chat 注册「用户+管理员」全集，
//     于是管理员命令只出现在管理员本人私聊的菜单里，普通用户
//     的菜单里根本看不到这些命令。
// 重要：菜单隐藏只是体验层，不是安全边界——普通用户手打命令
// 照样能发过来，真正的拦截靠业务主流程里每个管理员命令的
// isAdmin 校验（一直都有）。两层配合：看不见 + 用不了。
// 新增管理员命令：写进 COMMANDS_ADMIN，并在业务主流程里给它
// 加 isAdmin 判断，两处缺一不可。没有管理员命令的 Bot，
// COMMANDS_ADMIN 留空数组即可，本模块会自动只注册用户菜单。
// ============================================================
const COMMANDS_USER = [
  { command: "qd", description: "每日签到领积分" },
  { command: "me", description: "我的积分与连签" },
  { command: "top", description: "积分排行榜" },
  { command: "start", description: "使用说明" },
];
const COMMANDS_ADMIN = [
  { command: "lottery", description: "发起抽奖（管理员）" },
  { command: "draw", description: "开奖（管理员）" },
];
async function registerCommands(env) {
  // 先注册默认菜单（所有人可见的用户命令）
  const r = await tg(env, "setMyCommands", { commands: COMMANDS_USER });
  // 再给白名单里每个管理员单独注册全集菜单（只在他私聊里生效）
  if (COMMANDS_ADMIN.length) {
    const all = [...COMMANDS_USER, ...COMMANDS_ADMIN];
    const ids = String(env.ADMIN_ID || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const id of ids) {
      await tg(env, "setMyCommands", {
        commands: all,
        scope: { type: "chat", chat_id: Number(id) },
      });
    }
  }
  return r;
}
```

白名单判定本身在 01 号模块的 `admins()/isAdmin()` 里：读环境变量 `ADMIN_ID`（数字 ID、英文逗号分隔），不用用户名——用户名能改、能冒充，数字 ID 不会。

## 接入步骤

1. 命令表拆两份：普通命令进 `COMMANDS_USER`，管理员命令进 `COMMANDS_ADMIN`（没有就留空数组）。
2. `/setWebhook` 路由里把原来的 `setMyCommands` 换成 `registerCommands(env)`。
3. 每个管理员命令的业务分支开头加 `if (!isAdmin(env, msg.from.id)) return ...`。
4. 部署后访问一次 `/setWebhook?key=...` 生效；用管理员账号和普通账号各打开一次 Bot 对比菜单验证。

## 注意点

- 哪些命令算「管理员命令」按业务判定：由 ADMIN_ID 把关的才进 ADMIN 表；像群管理 Bot 的 /ban、/mute 是给**群管理员**用的，要留在普通菜单里，否则群管在群里点不到。
- 多个管理员就多个 ID，registerCommands 会逐个注册。
- 改了命令表要重新访问一次 /setWebhook 才会刷新菜单。
