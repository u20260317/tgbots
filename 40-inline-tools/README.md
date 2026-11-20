# Inline 工具 Bot

在**任意聊天**的输入框打 `@Bot用户名 内容`，就地弹出结果卡片，点一下发进聊天：词库搜索、单位换算、计算器、时间戳四件套。无状态、不存数据。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、WEBHOOK_SECRET。不用 KV、不用 ADMIN_ID。
⚠️ **必须去 @BotFather 用 /setinline 给本 Bot 开启 Inline 模式**，并在部署后访问 /setWebhook（allowed_updates 已带 inline_query），两样缺一，@ 都不会出结果。

## 玩法说明
- 空查询：出使用提示卡 + 当前时间戳卡。
- 词库搜索：输入关键词命中内置 DICT 词库（worker.js 顶部 CONFIG，演示内容是几个 TG 开发名词）→ 点卡片发解释。**换成你自己的内容**就是商品目录/FAQ/文档索引/频道导航的 inline 分发器。
- 单位换算：`10 km mi`、`100 c f`、`1 gb mb`、`5 kg lb`、`2 h min` 等（长度/重量/数据/时长/温度，表驱动，改 UNIT_GROUPS 加单位）。
- 计算器：`1+2*3`、`(4+5)/2`、`2^10` —— 自带递归下降表达式解析，**不用 eval**，非法输入不出卡。
- 时间戳：`ts` 出当前时间戳；发 10/13 位纯数字按时间戳转北京时间。

## 注意事项
- answerInlineQuery 的 cache_time 设了 5 秒（工具类讲究实时）；结果 id 在一次回答内唯一即可。
- Inline 结果是「谁点谁发」，没有会话状态；要统计点击需开 BotFather 的 /setinlinefeedback 才有 chosen_inline_result，本模板未接（无状态定位）。
- 词库是全量线性匹配，条目上千后建议改成 KV 索引或外部搜索，结构不变。

## 拼装来源
模块 26（Inline 模式）+ 模块 01（骨架）+ 模块 02（分级菜单）。
