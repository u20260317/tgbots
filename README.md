# tgbots · Telegram Bot 单文件合集（Cloudflare Workers）

10 个常用 TG Bot，**每个都是一个独立的 `worker.js` 单文件**：复制粘贴（或拖拽）到 Cloudflare Worker 即可部署，零依赖、零服务器、跑在 Workers 免费额度里。一个 Bot 用一个 Worker、一个 Bot Token，互不干扰，各从其类。

## 目录

| # | 类型 | 目录 | 一句话 | 需要 KV |
|---|------|------|--------|:---:|
| 01 | 频道发帖面板 | [01-channel-publisher](01-channel-publisher/) | 私聊发稿→预览→发布到频道，带网页面板和链接按钮 | 否 |
| 02 | 双向 Bot | [02-two-way-support](02-two-way-support/) | 用户留言转管理员，管理员回复即回达用户（客服） | 否 |
| 03 | 强制订阅 | [03-force-subscribe](03-force-subscribe/) | 未加入指定频道/群不能用 Bot、不能在群发言 | 否 |
| 04 | 群管理 | [04-group-manager](04-group-manager/) | 新人验证、欢迎、违禁词、防链接、ban/mute 命令 | 否 |
| 05 | 投稿审核 | [05-submission-review](05-submission-review/) | 用户投稿→审核群一键通过→发布到频道 | 否 |
| 06 | 文件分享 | [06-file-store](06-file-store/) | 发文件得专属链接，点链接找 Bot 领文件 | ✅ |
| 07 | 菜单/自动回复 | [07-menu-faq](07-menu-faq/) | 多级菜单 + 关键词自动回复，改配置区即改内容 | 否 |
| 08 | ID 查询工具 | [08-id-tools](08-id-tools/) | 查用户/群/频道 ID 和 file_id，配其它 Bot 用 | 否 |
| 09 | 订阅群发 | [09-broadcast](09-broadcast/) | /start 订阅、管理员 /broadcast 群发通知 | ✅ |
| 10 | 网盘（私有频道存储） | [10-cloud-drive](10-cloud-drive/) | 文件转存私有频道当硬盘，列表/搜索/标签/分享链接 | ✅ |

每个目录里都有自己的 `README.md`（变量清单 + 注意事项）。

## 快速开始

1. @BotFather 建 Bot 拿 Token → 2. Cloudflare 新建 Worker，把某个 `worker.js` 粘贴部署 → 3. 在 Worker 变量里填 `BOT_TOKEN` 等（Token 设为 Secret）→ 4. 打开 `https://Worker地址/setWebhook?key=你设的WEBHOOK_SECRET` → 5. Telegram 里测试。

手把手图文步骤、怎么查各种 ID、KV 怎么绑、常见报错：见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 代码规范（积木式模块）

- 每个 `worker.js` 的核心模块都用 `【核心模块】` 横幅注释标注（通信层、入口路由、业务主流程，以及各自的关键子模块如订阅校验、目录索引等），照着横幅就能整段拆出来复用。
- 想把几个 Bot 拼成一个：看 [docs/ASSEMBLY.md](docs/ASSEMBLY.md)（组装五步 + 已知冲突清单 + 现成组合推荐）。

## 安全须知

- **Bot Token 只填进 Cloudflare 的 Secret 变量里，不要写进代码、不要发到聊天/群里。** 泄露后去 @BotFather 用 /revoke 重置。
- `WEBHOOK_SECRET` 随便编一串长随机字符即可，它同时是 `/setWebhook` 的访问口令。
- 无状态设计：01–05、07、08 不用任何数据库（靠消息转发/按钮里编码的坐标工作）；06、09、10 需要绑定一个 KV（只存极小的映射/名单/目录索引，文件本体都在 Telegram 服务器上）。

## 组合玩法

- 频道运营套装：01 发帖 + 05 投稿 + 03 强制订阅（涨粉）+ 02 双向（读者联系）
- 社群套装：04 群管理 + 03 强制订阅守卫（进群先订频道）
- 配置任何一个之前，先部署 08 查好要用的 ID，能少踩很多坑。
