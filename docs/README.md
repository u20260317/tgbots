# 文档总地图（docs/）

这个仓库的文档分散在四个地方：根目录、docs/、modules/、docs/knowledge/。这一页是**找文档的唯一入口**：先按你的意图选一条路线，路线走不通再查下面的全量清单。

## 按意图选路线

### 🌱 我是新手，想从零跑起第一个 Bot

| 顺序 | 读什么 | 解决什么 |
|---|---|---|
| 1 | [知识库 01 · 零基础入门](knowledge/01-getting-started.md) | 先建心智模型：Bot 是一套 API，不是账号 |
| 2 | [根 README 快速开始](../README.md) | 五步跑通一个 Bot 的全貌 |
| 3 | [DEPLOY.md](DEPLOY.md) | 手把手部署：建 Bot、查 ID、部署 Worker、绑 KV、挂 Webhook |
| 4 | 任一模板目录里的 README | 每个模板自己的变量清单与注意事项；建议先部署 **08-id-tools**，后面查 ID 全靠它 |
| 5 | [知识库 03/04/05](knowledge/README.md) | 更新与 Webhook、消息与媒体、键盘与交互——写代码前的基础三篇 |
| 6 | [FAQ.md](FAQ.md) | 卡住了先来这里按症状查 |

### 🧩 我要拼一个自己的 Bot

| 顺序 | 读什么 | 解决什么 |
|---|---|---|
| 1 | [DECOMPOSE.md](DECOMPOSE.md) | 把一个想法（或一个现成 Bot）拆成可复用模块的五步方法 |
| 2 | [modules/README.md](../modules/README.md) | 50 篇模块索引：挑积木的地方，每篇有原理+真实代码+接入步骤 |
| 3 | [COOKBOOK.md](COOKBOOK.md) | 10 个完整产品配方：照着配方选积木、定顺序 |
| 4 | [ASSEMBLY.md](ASSEMBLY.md) | 组装五步、回调/KV 前缀注册表、已知冲突清单；含一个付费课程频道的完整组装实战 |
| 5 | [DESIGN.md](DESIGN.md) | 单文件地基为什么长这样：拼装前先懂约定，少踩缝合处的坑 |

### 🔍 我要查问题（Bot 不工作了 / 某个词不懂）

| 读什么 | 解决什么 |
|---|---|
| [FAQ.md](FAQ.md) | 约 20 个高频问题，按部署/运行/额度/安全/群/数据分组给可操作答案 |
| [DEPLOY.md 的常见问题表](DEPLOY.md) | 部署期八大典型现象速查（没反应、403、chat not found……） |
| [知识库 11 · 调试与运维](knowledge/11-debug-ops.md) | 系统排障：四段链路定位、回放测试、灰度回滚、高频故障表 |
| [TESTING.md](TESTING.md) | 某个模板的已知边界与测试结论：先分清是 bug 还是平台/环境限制 |
| [GLOSSARY.md](GLOSSARY.md) | 术语表：约 40 条中英对照，查词顺带指向本库对应物 |

### 📐 我要看设计与记录（这个库是怎么长成这样的）

| 读什么 | 解决什么 |
|---|---|
| [DESIGN.md](DESIGN.md) | 整体设计：单文件地基、模块注册制、数据与安全模型、平台限制 |
| [SURVEY.md](SURVEY.md) | 第一轮全球盘点：48 类对照与合规排除清单 |
| [SURVEY2.md](SURVEY2.md) | 第二轮盘点：新增 30 类的查漏与出处 |
| [TESTING.md](TESTING.md) | 四轮全量实测的完整记录：85 个对象逐个的级别与证据 |
| [ROADMAP.md](ROADMAP.md) | 版本史 v1.0.0 → v1.4.0、当前状态、未来候选（未立项的会明说） |

## 全量清单

**根目录**
- [README.md](../README.md)（另有 [English](../README.en.md) / [Русский](../README.ru.md)）— 项目门面：82 个模板目录表、模块概览、组合索引、安全须知
- 每个模板目录内的 `README.md` — 该模板的变量清单、配置说明、注意事项（82 份，跟模板走）
- [combos/README.md](../combos/README.md) — 3 个现成拼装组合的索引

**docs/（本目录）**
- [README.md](README.md) — 本页，文档总地图
- [DEPLOY.md](DEPLOY.md) — 手把手部署指南，所有 Bot 通用
- [DESIGN.md](DESIGN.md) — 设计文档：地基、注册制、数据、安全、定时、平台限制
- [ASSEMBLY.md](ASSEMBLY.md) — 积木组装说明书：五步法、冲突清单、组装实战
- [DECOMPOSE.md](DECOMPOSE.md) — 拆解方法论：把任何 Bot 拆成积木的五步
- [COOKBOOK.md](COOKBOOK.md) — 实战配方集：10 个完整产品怎么拼
- [FAQ.md](FAQ.md) — 高频问题约 20 问
- [GLOSSARY.md](GLOSSARY.md) — 术语表约 40 条
- [TESTING.md](TESTING.md) — 全量测试记录（规则：每测完一个就回填）
- [SURVEY.md](SURVEY.md) / [SURVEY2.md](SURVEY2.md) — 两轮全球品类盘点
- [ROADMAP.md](ROADMAP.md) — 版本史与路线图
- [knowledge/](knowledge/README.md) — 知识库子目录（见下）

**modules/** — [索引](../modules/README.md)：50 篇模块文档，每篇 = 一句话定位 → 原理 → 真实代码块 → 接入步骤 → 注意点。模块 03 文末是回调前缀注册表、04 文末是 KV 键注册表，拼装前必查。

**docs/knowledge/** — [索引](knowledge/README.md)：11 篇知识文档，只讲原理不给代码，按零基础 / 进阶 / 专家三条学习路径组织。

## 一句话区分四类文档

- **模板 README**：这个 Bot 怎么配、怎么部署。
- **modules/**：这块能力怎么拆出来、怎么拼回去。
- **knowledge/**：这个机制为什么这样设计、边界在哪。
- **docs/**：怎么部署、怎么组装、怎么排障、这个库的来龙去脉。
