# 贴纸制作 Bot

发图 → 选 emoji → 自动建贴纸包 / 往已有包加贴纸，回 t.me/addstickers 链接。

## 部署要点
同单体三步部署，变量：BOT_TOKEN*、STICKER_RESIZER（外部图片规格处理服务地址，可选，见下）、BOT_USERNAME（本 Bot 用户名，可选，不填自动 getMe）、WEBHOOK_SECRET ＋ 必须绑定 KV 变量名 BOT_KV。

## 规格与处理链（先读这段）
Telegram 静态贴纸硬规格：**PNG 或 WEBP、512×512**（一边 512、另一边 ≤512），不合规 createNewStickerSet 直接报错。本 Bot 的处理分工：
- 发 **PNG/WEBP 文件**（以「文件」形式发送，不是照片）→ file_id 直接建包，最稳，零外部依赖；
- 发**普通照片**（JPEG）→ Workers 里没有图像处理库，必须外置：配了 STICKER_RESIZER 就自动转（约定：`POST {url: 原图直链}` → 返回 `{url: 512 PNG 直链}`，可用任意图像处理小服务/云函数实现）；没配则 Bot 明确提示改发 PNG 文件，不假装能转。

## 玩法说明
- 私聊发图 → Bot 收下 → 点按钮选 emoji（或直接发一个 emoji 文本）→ 首次自动建包（包名 stk_<你的ID>_<随机>_by_<Bot用户名>，Telegram 强制 _by_ 后缀），之后发图默认往同一个包里加。
- /newpack 下一张图另开新包；/mypack 看当前包链接与张数。
- 待选状态存 stk:pend:（30 分钟过期），当前包存 stk:set:。

## 注意事项
- 贴纸包归属在「发图的用户」名下（createNewStickerSet 的 user_id 是用户本人），Bot 只是代操作；包建好后用户在任何客户端都能管理。
- 一个包最多 120 张贴纸（Telegram 上限），满了用 /newpack 开新包。
- 表情图源请用自己有权使用的图片；别拿他人受版权保护的图批量做包商用。

## 拼装来源
模块 36（贴纸制作）+ 模块 01（骨架）+ 模块 02（分级菜单）。
