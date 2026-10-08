# 04 — composer 的引用条与「正在回复」状态

**What to build:** 选中某条消息后，被选中的消息有明确落点（描边），composer 顶部出现引用条（作者 + 摘要 + 取消）；发送后引用随消息一起提交，取消则完全恢复原状。

**Blocked by:** 03

**Status:** complete

- [x] 选中态是描边而非换底色，与既有的「不按状态换底色」原则一致
- [x] 引用条与 composer 同一张卡片表面；取消必须显眼且可用键盘触发
- [x] 发送时把 `replyToMessageRef` 交给 Host；草稿仍按 Thread 保存
- [x] 切换 Thread、发送成功、取消，三种情况都不会残留选中态
- [x] 390×844 下引用条换行不溢出
