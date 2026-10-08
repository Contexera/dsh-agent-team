# 03 — 消息上的「回复」入口与引用块

**What to build:** Thread 时间线里，每条消息都有一个可键盘到达的「回复」操作；一条回复消息在自己的气泡内部顶部显示引用块（作者 + 摘要），点击跳到原文并短暂高亮。

**Blocked by:** 02

**Status:** complete

- [x] 操作条按 shipped 约定：整体在 `@media (hover: hover)` 内隐藏，`:hover` 与 `:focus-within` 显示；触屏常显
- [x] 操作条不挤压正文、不为 hover 预留额外高度；同人续行（昵称行隐藏）也能到达
- [x] 引用块一行截断，长原文不重贴
- [x] 点击引用块跳到父消息并短暂高亮；键盘 Enter/Space 等效
- [x] 父消息不可解析时引用块不假装可跳转
- [x] 仅 Thread 页；Channel feed 不出现该入口
