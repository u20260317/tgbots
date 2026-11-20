# 设计文档（DESIGN）

tgbots 的整体设计：30 个单文件 Telegram Bot 模板 + 3 个拼装组合，全部跑在 Cloudflare Workers 上，零依赖、零服务器。

## 1. 单文件地基（所有模板共享）
每个 worker.js 都是同一副骨架，这是能「像积木一样拼装」的前提：
1. **配置层**：全部走环境变量——BOT_TOKEN（Secret）、WEBHOOK_SECRET、ADMIN_ID、业务变量（频道 ID、KV 绑定名 BOT_KV 等）；少数内容型配置（如 07 的菜单、14 的套餐、26 的题库）放代码顶部 CONFIG 区，改完重新部署即生效。
2. **通信层**【核心模块】：唯一的 tg() 函数封装 Bot API 的 POST JSON 调用，全文件所有 Telegram 请求都走它。
3. **入口路由**【核心模块】：fetch 处理 `/`（健康检查）、`/setWebhook?key=`（一键挂载，密钥校验；同时调 setMyCommands 把该 Bot 的 COMMANDS 命令表注册到输入框官方菜单，部署即生效）、`/webhook`（校验 secret_token 头后 ctx.waitUntil 异步处理，立即回 200）；需要定时的 Bot 另有 scheduled() 入口。每个模板顶部都有自己的命令表（只列代码里真实存在的命令），这是模板标配，不需要部署者再去 BotFather 手工设置。命令表分两级（模块名「管理员白名单与分级命令菜单」，注释里有详细说明）：COMMANDS_USER 默认 scope 所有人可见；COMMANDS_ADMIN 只对 ADMIN_ID 白名单里的管理员用 scope=chat 单独注册，非管理员的菜单里看不到——但隐藏只是体验层，真正的拦截仍靠业务里的 isAdmin 校验，两层缺一不可。
4. **业务主流程**【核心模块】：handle() 按更新类型分发——私聊命令 / 群消息 / callback_query 按钮 / chat_join_request / chat_member，各 Bot 在这一层差异化。

## 2. 模块化与拼装规则
- 每个核心模块用中文横幅注释标注（【核心模块】模块名 + 作用说明），可整段拆出复用。
- **回调前缀注册制**：每个模块的按钮 callback_data 用独立前缀（pub:、ok:/no:、jr:、lj:、vote:、join:、quiz: 等），拼装时不冲突；完整清单与合并步骤见 ASSEMBLY.md。
- **KV 键前缀注册制**：f:/subs/index/rss_state/pts:/lot:/poll:/chain:/ledger: 等按 Bot 分区，拼装共用一个 KV 时互不覆盖。
- 拼装的已知冲突点（同名 helper、多个 /start、私聊默认处理打架）及解法在 ASSEMBLY.md 里逐条列明，3 个 combos/ 就是按它拼出来的范例。

## 3. 数据与状态
- 无服务器数据库：状态只用 Cloudflare KV（最终一致、读多写少，正好匹配 Bot 的配置/账本/索引类数据）。
- 文件本体不进 KV：06/10 把文件转存到 Telegram 私有频道，KV 只存 file_id 索引——借 Telegram 当无限硬盘。
- 按天分键 + TTL（如 22 的统计键 35 天过期）控制 KV 体积；免费版额度下小规模运营足够。

## 4. 安全模型
- BOT_TOKEN 只以 Worker Secret 存在，不进代码、不进仓库、不进聊天记录（部署时经 stdin 一次性注入）。
- Webhook 用 secret_token 头校验 + /setWebhook 的 key 口令，未授权请求 403。
- 管理员权限一律按数字 ID 白名单（ADMIN_ID）判断，不靠用户名（可改名、可冒充）。
- 涉及钱的模板（14/15）采用「人工确认收款」模式：Bot 不经手资金，只管订单状态与权限发放，资金风险留在人这一侧。

## 5. 定时任务
- Cron Triggers 唤醒 scheduled()：11 抓 RSS、14 巡检到期会员、21 到点播报、23 巡检价格提醒。
- 省流设计：抓取类默认低频（11 的部署建议 30 分钟、21 用 */5 检查时间戳而非每分钟跑业务），照顾 Workers 免费额度。

## 6. 平台限制（设计时已绕开或注明）
- Bot 不能主动私聊没点过 /start 的用户（12 答题模式、29 信箱都受此限，README 有说明）。
- 群里要收全部消息必须关 Group Privacy（04/22 已注明）。
- Worker 单次子请求与 CPU 有免费版上限：RSS 解析用零依赖正则、行情巡检按币种去重抓价，都是为此做的取舍。
- Telegram 单条消息 4096 字符、按钮 callback_data 64 字节：长内容分页（如 10 的 /list）、回调只编码短 ID。

## 7. 部署模型
- 标准：一 Bot 一 Worker，变量/KV/Cron 在部署时配齐（见 DEPLOY.md）。
- 测试模式（当前在用）：一个测试 Bot 轮流承载各模板，覆盖部署逐个验证，结果记入 TESTING.md；正式使用时再按需拆成独立 Bot。
