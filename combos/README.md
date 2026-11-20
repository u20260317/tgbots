# combos · 拼装组合 Bot

把单体 Bot 按 [docs/ASSEMBLY.md](../docs/ASSEMBLY.md) 的规范拼成的成品组合，**依然是每个组合一个单文件 `worker.js`**，部署方法和单体完全一样（BotFather 拿 Token → 粘贴部署 → 填变量 → /setWebhook）。

| 组合 | 子目录 | 拼了哪些 | 适合 |
|------|--------|----------|------|
| 频道运营全家桶 | [combo-channel-ops](combo-channel-ops/) | 01 发帖面板 + 05 投稿审核 + 02 双向客服 | 一个 Bot 管一个频道：自己发稿、粉丝投稿、读者留言全齐 |
| 社群守卫 | [combo-group-guard](combo-group-guard/) | 03 强制订阅 + 04 群管理 | 群防广告+涨粉：没订频道不能发言，进群先真人验证 |
| 强订网盘 | [combo-drive-gate](combo-drive-gate/) | 03 强制订阅 + 10 网盘 | 资源分发涨粉：领文件必须先订阅指定频道 |

每个子目录有自己的 README（变量清单是所拼模块的并集 + 分流规则说明）。
