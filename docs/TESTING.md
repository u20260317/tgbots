# 测试记录（TESTING）

本文件记录 tgbots 全部模板的实测结果。**规则：每测完一个 Bot 就更新本文件**（本地改完同步推送 GitHub），不攒到最后一次性补——记录与测试同步发生，结论才可信。

## 测试环境
- 测试 Bot：@dododotest_bot（同一个 Bot 轮流承载被测模板，测完一个覆盖部署下一个；这是用户定的省事模式）
- 部署工具：`~/workspace/tgbots-deploy/deploy_bot.py`（Secret 绑定部署 + 开 workers.dev + 挂 webhook）
- 承载：Cloudflare Workers 免费版；需要 KV 的 Bot 绑定测试命名空间
- 测试管理员 ID：全量测试统一用模拟管理员 700000001（避免给真人发测试消息）；真人管理员 5959093280 只用于已上线的 08/13

## 测试分级（诚实口径）
| 级别 | 含义 |
|------|------|
| L1 | 语法检查通过（node --check） |
| L2 | 部署成功 + 健康检查 200 + webhook 挂载成功 |
| L3 | 模拟更新被正确处理（webhook 200、错密钥 403） |
| L4 | 关键副作用验证（如 KV 写入可读回、接口返回结构正确）——证明业务逻辑真的跑通，不只是没崩 |
| L5 | 真人实测（真人在 Telegram 里操作并收到正确回复） |

模拟更新说明：用 curl 向 Worker 的 /webhook 发构造的 Telegram 更新（带正确 secret 头），chat/user 用模拟 ID，因此 Telegram 侧的「发消息」动作会因 chat 不存在而失败——这是预期的，不影响判定；判定依据是 Worker 处理结果与 KV 等可观测副作用。L4 以下不能证明真人交互体验，所以关键 Bot 仍建议 L5 抽测。

## 结果总表
| # | 模板 | 日期 | 级别 | 结果 | 证据 / 备注 |
|---|------|------|:---:|:---:|------|
| 08 | ID 查询 | 2026-11-20 | L5 | ✅ | 真人截图确认：/start 回复用户 ID 5959093280；webhook 对密钥 200 / 错密钥 403 |
| 13 | 签到积分/抽奖 | 2026-11-20 | L4 | ✅ | 模拟 /qd 后读回 KV：pts:111 = {p:10, streak:1, last:2026-11-20}，签到逻辑与日期（UTC+8）均正确；待真人 /qd 抽测升 L5 |
| 01 | 频道发帖面板 | 2026-11-20 | L4 | ✅ | 部署/健康/setWebhook 全过；admin /start、发稿、pub: 发布回调均 200，错密钥 403；GET /panel 返回 200 面板 HTML（口令发布流需真实频道验到底） |
| 02 | 双向客服 | 2026-11-20 | L3 | ✅ | 用户 /start、用户留言转发、管理员 /reply 回复均 200，错密钥 403；注：部署后首个请求曾返回 500（传播期抖动），复测同更新 200，非代码问题 |
| 03 | 强制订阅 | 2026-11-20 | L3 | ✅ | 私聊门禁 /start、check 验证回调、守卫群消息拦截路径均 200，错密钥 403；首请求曾 404（传播期抖动），复测 200；真实订阅校验需真实频道成员关系 |
| 04 | 群管理 | 2026-11-20 | L3 | ✅ | 入群验证码触发、cap: 回调、违禁词消息、/rules 均 200，错密钥 403；踢/禁等动作对模拟群必然失败，仅验处理路径 |
| 05 | 投稿审核 | 2026-11-20 | L3 | ✅ | 用户 /start、投稿、ok: 审核回调均 200，错密钥 403；审核消息 ID 由 Telegram 运行时生成，回调用构造 ID 模拟，搬运到目标频道需真实 chat 验到底 |
| 06 | 文件分享 | 2026-11-20 | L4 | ✅ | 管理员发文件后 KV 出现 f:34uzeq 映射；用该短码发 /start f_34uzeq 深链取件处理 200；错密钥 403 |
| 07 | 菜单/FAQ | 2026-11-20 | L3 | ✅ | /start 开菜单、pg:about 翻页回调、关键词「多少钱」自动回复均 200，错密钥 403 |
| 09 | 订阅群发 | 2026-11-20 | L4 | ✅ | 两用户 /start 后补测读回 subs=[800000209] 证明订阅落盘；主测中广播后 subs 被清为空是「失效订阅自动清理」按设计触发（模拟用户 chat not found 被判失效），非 bug |
| 10 | 网盘（私有频道） | 2026-11-20 | L3 | ✅ | /start、发文件、/list、/stats 均 200，错密钥 403；边界：转存需 copyMessage 到真实存储频道成功才写索引，模拟频道下 index 未落盘（读回 404），属环境限制 |
| 11 | RSS/定时推送 | 2026-11-20 | L4 | ✅ | GET /push 返回 {pushed:0, seeded:1, errors:0}，KV rss_state 读回真实 HN 条目完成播种；/status 200，错密钥 403；Cron 路径以 /push 手动口替代（见限制说明） |
| 12 | 入群申请审核 | 2026-11-20 | L4 | ✅ | question 模式：chat_join_request 后 KV 读回 pending:800000112 内容正确，答题转发与 jr:ok 回调均 200，错密钥 403；边界：approveChatJoinRequest 对模拟群无法真正生效 |
| 14 | 付费会员 | 2026-11-20 | L4 | ✅ | 选 plan:m1 后 KV 出现 order:vpyrs，paid: 后状态变 waitconfirm（读回验证）；边界：payok 后开发邀请链接需真实目标群，模拟群下开通失败、订单停在 waitconfirm（按设计），该步待真实群验 |
| 15 | 数字商品售货 | 2026-11-20 | L4 | ✅ | 全链读回验证：/addproduct 建 prod:r9a8b → /addstock 库存 1 → buy: 建单 → paid: 待确认 → payok: 后库存变 [] 且订单 status=done、delivered=CARD-001-TEST；注：首次 payok 与 paid 的 KV 写入撞车被状态校验拦下，补发后成功，属测试时序问题 |
| 16 | 邀请引流统计 | 2026-11-20 | L4 | ✅ | 深链 /start ref_ 后读回 refdone:800000116=800000016、ref:800000016={count:1}；/invite、/topinv 均 200；注：首个更新曾遇传播期 404，复测通过 |
| 17 | 任务赚钱 | 2026-11-20 | L4 | ✅ | /addtask 建 task 两条；verify: 对不存在频道正确不发分；submit: 生成 claim:，claimok: 后 pts 读回 +50；🐛 发现并修复 bug：claimok 发分时积分档案 name 被重复拼「· ID」（claim 存的已是格式化名又过一次 who()），已存原始 fname/uname 修复，推送 commit 1b8bf6e，复测 name 只出现一次 ID、+30 正确 |
| 18 | 频道导航/互推 | 2026-11-20 | L4 | ✅ | /submit @telegram 后 KV 读回 dir:telegram（标题 Telegram News、成员 9085502、status=pending，均为真实 TG 数据），管理员 dirok: 后 status 变 ok；错密钥 403 |
| 19 | 投票问卷 | 2026-11-20 | L4 | ✅ | /poll 建 poll:vrak，另一用户 vote: 后 KV 读回 votes={800000119:0} 计票正确；错密钥 403 |
| 20 | 消息推送 API | 2026-11-20 | L4 | ✅ | GET /push 错 key 回 403「key 不对」，对 key 回 502 且 body 带 Telegram 原始错误 chat not found（证明请求已达 TG）；/start、/id 200（首请求 500 与错密钥 404 均为传播期抖动，复测分别 200/403） |
| 21 | 定时播报 | 2026-11-20 | L4 | ✅ | /add 后 KV jobs 读回任务（09:30 daily、目标群、nextRun 计算正确）；/jobs 200，错密钥 403；Cron 实际发送路径无法 HTTP 触发，以任务落盘+nextRun 验代（见限制说明） |
| 22 | 群活跃统计 | 2026-11-20 | L4 | ✅ | 群消息后 KV 读回 stats:…:2026-11-20 = {msgs:3, users:{800000022:3}}，计数与实际送达数一致（另 1 条模拟消息遇传播期 404 未达 Worker，不计入属正确）；setWebhook 首次 1042 重试成功 |
| 23 | 行情播报 | 2026-11-20 | L4 | ✅ | /alert 后 KV 读回 alerts=[{BTC > 100000}]；/p BTC、/alerts 复测 200（首轮 404 为传播期抖动）；错密钥 403；Cron 巡检路径无法 HTTP 触发，以提醒落盘替代验证 |
| 24 | 接龙报名 | 2026-11-20 | L4 | ✅ | /jielong 建 chain:hrsj，join: 报名后 KV 读回 entries 含报名者；错密钥复测 403（首轮更新遇传播期 404 丢失，复测全过） |
| 25 | 记账 | 2026-11-20 | L4 | ✅ | 两笔记账后 KV 读回 ledger:800000025:2026-11，条目 [-25 午餐, +8000 工资] 金额/备注/记录人全对；/账单 200，错密钥 403 |
| 26 | 竞答游戏 | 2026-11-20 | L4 | ✅ | /quiz 建场次；答对后读回 scores={800000126:10} 且 idx 推进，/stopquiz 结算后 quizpts:800000126={pts:10}、场次已删；注：答题有 msgId 防旧题校验，模拟环境题目消息发不出去（msgId=0），用 message_id=0 的回调才对得上，真实环境无此问题 |
| 27 | 翻译 | 2026-11-20 | L3 | ✅ | 私聊自动互译、/fy en 两条路径均 200，错密钥复测 403（首次 500 为传播期抖动）；译文内容发往模拟 chat 不可观测，只验处理路径 |
| 28 | 工具箱 | 2026-11-20 | L3 | ✅ | /start、/hash、/uuid、/pick 均 200，错密钥 403；计算结果发往模拟 chat 不可观测，只验处理路径 |
| 29 | 匿名信箱 | 2026-11-20 | L4 | ✅ | 访客 /start box_<箱主> 后 KV 读回 boxsess:800000129="800000029"，会话建立正确；留言投递的 msgmap 在投递成功时才写，模拟 chat 不可达未落盘（边界） |
| 30 | 客服工单 | 2026-11-20 | L3 | ✅ | /ticket、追加消息、/tickets 均 200，错密钥 403；边界：建单按设计需先把工单卡发到客服会话成功才落盘，模拟客服群不可达时不建单（用户侧有失败提示），ticket/userticket 未写入属预期 |
| C1 | 组合·频道运营全家桶 | 2026-11-20 | L4 | ✅ | admin /start、用户内容触发分流、pick:sub 投稿选择均 200，错密钥 403；GET /panel 返回 200 面板 HTML |
| C2 | 组合·社群守卫 | 2026-11-20 | L3 | ✅ | 入群事件（复测 200，首轮遇传播期 404）、cap: 验证码、gcheck 订阅复查、私聊 check 均处理正常，错密钥 403 |
| C3 | 组合·网盘门禁 | 2026-11-20 | L3 | ✅ | 主人 /start、粉丝 /start d_ 深链领件走门禁、gatecheck 验证均 200，错密钥 403；边界同 10：转存依赖真实存储频道 |
| 31 | AI 聊天 | 2026-11-20 | L4 | ✅ | 无 Key 部署：私聊提问走友好报错路径 200；/persona set 后回调 ai:毒舌，KV 读回 ai:700000031={persona:毒舌,msgs:[]}；/me、管理员 /aistats 200，错密钥 403。真对话链路经本地 harness 以同一 worker.js + 免费端点（Pollinations 匿名口）实测跑通：真实回复落盘（msgs 含 user+assistant）、ai:usage=1；线上复测时该免费端点对 CF 共享出口 IP 限流（探针 Worker 直测回 402 FREE_LIMIT），线上实时回复未完成，属环境限制非代码问题，配正式 Key 走同一代码路径 |
| 32 | 母体 Bot | 2026-11-20 | L4 | ✅ | 入驻向导全程 200：/new → mb:type:checkin → 发测试 Bot 自身 Token（getMe 验真）→ mb:go 开通；KV 读回 bot:<slug> 记录，tokenEnc 为 AES-GCM 密文（iv.ct 格式、不含明文），botId/type/owner 正确；子 Bot 分发：带租户 secret 向 /w/<slug> 发 /qd，租户前缀键 t:9010372669:pts:700000132 读回 {p:10, streak:1, last:2026-11-20}，签到内核与 KV 隔离均生效；错租户密钥 403；错母体密钥 403 |
| 33 | 商城 Bot | 2026-11-20 | L4 | ✅ | 全链读回验证：总部 /hqadd 上架 mall:prod（批发 50）；开店向导（选模式→Token 验真→店名→mall:go）生成 bot: 店铺记录（tokenEnc 密文、店名/模式/加价 20% 正确）；子店店主 /addprod+/addstock 落租户 prod（stock=[CARD-MALL-001]）；买家购物车读回 {hq:1, own:1}，结账订单 total=90（总部货源店面价 60=批发×1.2）、status=waitconfirm；店主 payok 后订单 done 且库存弹空 []。注：开店装配与库存扣减的 KV 读回各出现一次长延迟（约 2 分钟才可见），复读后无误，属 KV 传播慢非 bug |
| 34 | 视频解析下载 | 2026-11-20 | L4 | ✅ | 未配 RESOLVER_API（演示模式）：/start、发链接后 KV 读回任务 dl:ra37（含 url/uid、10 分钟过期）；点画质按钮 dl:v: 走演示模式解析失败提示路径 200（按设计不计次、不删任务）；点取消 dl:x: 后缀 dl: 读回为空，任务已删；管理员 /dlstats 200，错密钥 403。真实解析需自备 cobalt 兼容服务，属部署配置项 |
| 35 | 语音转文字 | 2026-11-20 | L4 | ✅ | 未配 STT_API_KEY：私聊发语音（假 file_id）走「未配置转写服务」报错分支 200；群内管理员 /stt on 后 KV 读回 stt:on:-1000000000035 = 1，开着的群内语音同样走无 Key 分支 200；/stt off 后该键读回 404（已删）；错密钥 403。真实转写需配 Groq/OpenAI Key，属部署配置项 |
| 36 | 个人提醒/待办 | 2026-11-20 | L4 | ✅（修 1 bug） | 时间解析读回验证：「10分钟后 交房租」at≈当前+600s、「明天 9:00 开会」at 精确等于次日 09:00 CST，均落 rem:<uid>:<id>；待办 /todo 落 todo: 数组；回调按设计语义验证（rem: 前缀统管待办与提醒）：rem:done:<待办ID> 勾选后读回 done=true、rem:delrem:<提醒ID> 删除后读回 404；/reminders 200、错密钥 403。Cron 到点推送无法经 HTTP 触发（已知限制）。**bug**：parseWhen 相对时间三分支（分钟后/小时后/天后）rest 未 trim，提醒文本带前导空格（其余分支均 trim）；已修（三处补 .trim()，commit 54e52b7），重新部署复测落盘文本为「交房租」无空格 |
| 37 | 贴纸制作 | 2026-11-20 | L4 | ✅ | 以「文件」发 PNG（假 file_id）后 KV 读回 stk:pend:700000037={source:FAKE_PNG_FILE_ID} 并弹 emoji 键盘；发普通照片走未配 STICKER_RESIZER 的规格提示分支 200；选 emoji 回调真实调用 createNewStickerSet，因假用户/假 file_id 在 Telegram 侧必然失败、按设计走失败提示分支且 pend 保留（读回仍在）；stk:cancel 后 pend 读回 404 已删；错密钥 403。真实建包需真人真图，属环境边界 |
| 38 | 天气预报 | 2026-11-20 | L4 | ✅ | 真调 Open-Meteo 成功：/sub 北京 后 KV 读回 wx:sub:700000038 = {name:北京 · 北京市 · 中国, lat:39.9075, lon:116.39723, tz:Asia/Shanghai}，坐标为地理编码接口真实返回（落库前先验城市存在）；/tq 北京、/mysub 均 200；/unsub 后订阅键读回 404 已删；错密钥 403 |
| 39 | GitHub 通知 | 2026-11-20 | L4 | ✅ | /ghbind 后 KV 读回 gh:700000039 绑定（含 secret/by/at）；用绑定密钥对模拟 push 载荷做 HMAC-SHA256 签名 POST /github/700000039 → 200 ok（格式化推送被调用，发往模拟聊天在 TG 侧静默失败）；错签名同载荷 → 401 bad signature；ping 事件好签名 → 200。验签用原始字节 + 常量时间比较，与 GitHub 规范一致 |
| 40 | Inline 工具箱 | 2026-11-20 | L4 | ✅ | 线上部署/健康/setWebhook（allowed_updates 带 inline_query）+ 模拟 inline_query 更新 200、错密钥 403；answerInlineQuery 载荷经本地 harness（同一 worker.js、打桩 api.telegram.org）捕获验证：`1+2*3` → 「🧮 1+2*3 = 7」、`10 km mi` → 「10 km = 6.21371192 mi」、「webhook」命中内置词库 2 条、`ts` 返回当前时间戳，结果结构与数值均正确 |
| 41 | 狼人杀主持人 | 2026-11-20 | L4 | ✅（修 1 bug） | 🐛 **发现并修复并发丢数据 bug**：初测快速连点报名时一名玩家被回调告知「报名成功」却不在名单——整局状态单 JSON「读-改-写」被后到的报名覆盖（KV 最终一致下必现）。已改为按人拆键（wolf: 元信息 / wolfp:<群>:<uid> 玩家 / wolfn: 夜晚 / wolfv: 公投一人一键），复测 5 人快速报名全部落盘；又发现自动结算依赖 list 读票会被 list 边缘缓存延迟卡住，改为按玩家逐键直读 votes/acted 后自动结算恢复（commit 6064fa9、8362bf7）。修复后全流程读回验证：开房→5 人报名→房主开局，身份牌私发给模拟用户必然失败→自动剔除→不足 4 人整局取消且 wolf:/wolfp:/wolfroom: 全部清净；另以预置夜晚局验完整链：狼人首刀 wolfn:kill、预言家查验、acted 标记均落盘，房主 wolf:force 强制天亮结算（刀口玩家 alive=false、夜晚键清空），白天 4 票齐投后自动 tally 放逐狼人→好人胜→clearGame 全清；错密钥 403。注：重部署后短时间内新旧版本 isolate 并存，旧版处理新格式状态会静默失败，属部署传播期现象，等传播完成复测全过 |
| 42 | Mini App 三件套 | 2026-11-20 | L4 | ✅ | GET /app 返回 200 自包含 HTML（含官方 WebApp SDK）；用 Bot Token 按官方算法（HMAC(key=WebAppData) 派生密钥）构造合法 initData：POST /api/verify → 200 回显用户，篡改 user.id 不重签 → 403 拒绝（代码口径为一律 403）；POST /api/message 验签后留言落 KV，mini:700000042 读回 [{text, at}] 正确，篡改签名同接口 → 403；Bot 侧 /app、/mymsgs 均 200，错密钥 403 |
| 43 | 图片处理/OCR | 2026-11-20 | L4 | ✅ | 线上：/start、假 file_id 私聊发图（getFile 失败走优雅报错分支）、/resize 回复假图（处理失败分支）、/quote 未配 QUOTE_API 的明确提示分支均 200，错密钥 403。OCR 成功路径经本地 harness（同一 worker.js、打桩 getFile 与 OCR.space）验证：未配 OCR_API_KEY 时 apikey 头确为演示 key helloworld、回复含识别文本与演示额度注记、计数键 ocr:cnt:700000043:2026-11-20 读回 =1；线上真图 OCR 需真实照片 file_id，属环境边界 |
| 44 | URL 上传转存 | 2026-11-20 | L4 | ✅ | 线上：127.0.0.1 / 192.168.x / localhost 三种内网链接与真实 favicon 链接均处理 200、无多余 f: 记录产生，错密钥 403。成功链经本地 harness（同一 worker.js、打桩 TG 与源站）验证：SSRF 链接被明确拒绝且 Worker 未对内网地址发出任何请求；小文件走 TG 直抓路（sendDocument 填 URL）成功后 f:<码> 记录读回 {kind:document, id, name:favicon.ico} 正确、取件链接已回；/start f_<码> 领取按存档 file_id 调用 sendDocument 无误。线上真转存成功需可达 chat，属环境边界 |

**全量测试完成（2026-11-20）**：30 个单体 + 3 个组合全部实测完毕。共发现并修复模板 bug 1 个（17 号 name 重复拼 ID，commit 1b8bf6e）。测试中多次出现的部署后首请求 404/500 与 setWebhook 1042 均为 Cloudflare 传播期抖动，复测均通过，已在各行备注中区分记录，未计为模板问题。


**第二轮全量测试完成（2026-11-20）**：新模板 31-40 全部实测完毕，10 个全部达到 L4。共发现并修复模板 bug 1 个（36 号相对时间分支提醒文本未 trim，commit 54e52b7）。本轮验证深度进一步加强：32/33 的母体/商城走通了「入驻加密落盘 → 子 Bot 按租户密钥分发 → 租户前缀 KV 隔离」的完整多租户链；39 用真实 HMAC 签名验了 GitHub 入口的好签名 200 / 错签名 401；31 在本地 harness 以免费端点跑通真对话与上下文落盘（线上免费端点对 CF 共享出口 IP 限流，属外部限制，已在备注注明）；38 的订阅记录含地理编码真实坐标。本轮另观察到 KV 个别键读回延迟可达约 2 分钟（33），复读无误后才下结论，未误判为 bug。

## 已知测试限制
- scheduled()（Cron 触发）无法通过 HTTP 直接调用，11/14/21/23 的定时路径用其手动触发口（如 /push、/sweep、/pushnow）或命令路径替代验证，并在备注里注明。
- 涉及「给频道/群发消息」的流程，模拟环境里目标 chat 为模拟 ID，Telegram 侧必然报错；判定看 Worker 侧处理与状态落盘。

## 补丁记录
- 2026-11-20 命令菜单补丁：用户指出全部模板未注册 Telegram 官方命令菜单（setMyCommands）。已给 33 个 worker.js（30 单体 + 3 组合）统一加上 COMMANDS 常量与 /setWebhook 时自动注册，命令表逐个按代码里真实存在的命令核对；全部重新过 node --check。当前常驻的 13 已重新部署，其 /setWebhook 返回包含 commands 注册结果，getMyCommands 读回 6 条命令无误。此后新部署的任何模板，挂 webhook 即带菜单。

- 2026-11-20 分级菜单补丁（用户要求）：全部 33 个 worker.js 新增【核心模块】管理员白名单与分级命令菜单——用户命令默认注册，管理员命令（按各 Bot 实际由 ADMIN_ID 把关的命令划分，如 13 的 lottery/draw、15 的商品管理、21 的任务管理）只对管理员 scope 注册，普通用户菜单不可见；模块注释详细写明原理与「隐藏≠安全、handler 校验才是边界」。同时按用户要求给 13 的签到回复加日期（如「2026年11月20日 签到成功」），并清除了签到 KV 里早前模拟测试的假用户记录。全部重新过语法检查并推送；13 重新部署后实测：默认菜单 4 条、管理员私聊菜单 6 条，符合分级预期。

- 2026-11-20 排行榜分页补丁（用户问起）：13 积分榜 /top、16 邀请榜 /topinv、26 赛季榜 /quiztop 改为每页 10 条 + 上一页/下一页按钮（回调 top:/topinv:/qtop:，含页码指示按钮），单页时不显示按钮。13 已用本地 harness 以 25 个模拟用户实测三页翻页与按钮回调全部正确，并重新部署上线；16/26 同模式改造、语法通过，待真人环境复测。
