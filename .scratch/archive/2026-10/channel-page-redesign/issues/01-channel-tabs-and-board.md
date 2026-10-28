# 01 — Channel 时间线可按「频道 | 看板」两种读法打开

**What to build:** Channel 页头下方一条「频道 | 看板」页签行，压在页头的收口线上，说 shipped session 页页签的语言。`频道` 是 feed（既有时间线 + composer），`看板` 把同一份投影按四种 Task 状态分成四列。页签是整片切换，看板激活时 composer 退位。看板只读 feed 已加载的那个窗口。

**Blocked by:** None — can start immediately

**Status:** complete（2026-10-15，commit `8602e18d`；`5236138f` 把看板从「翻页到 hasMore 为假」改为「只读 feed 已加载窗口」）

- [x] 页签行渲染在页头收口线上，激活态用 business 蓝文字 + 下划线，未激活灰色；两条页签的页签语言与 shipped 会话页一致。
- [x] 点「看板」→ 四列出现（待处理 / 进行中 / 待验收 / 已完成），种子 Task 的卡片在自己的列里；composer 不在。
- [x] 「已完成」列折叠 `done` 与 `closed` 两种状态。已完成的卡片降透明度而不隐藏。
- [x] 空列在列头写自己的 `0`，不画占位行。
- [x] 点卡片 → 走既有 Thread 页层级（非新窗口）；返回后频道页重新出现。
- [x] 页签是复合控件：`role="tablist"` + 两个 `role="tab"`，整组一个 tab stop，Left/Right/Home/End 同时移动选中与焦点。
- [x] 看板是 Client 里唯一允许超出 880px 阅读列的表面（上限 1240px）；四列各自不足 220px 时改为横向滚动，而不是把标题挤成每行一个字。

**实现偏离（相对原 spec）：** 原设计让看板在激活时后台翻页直到 `hasMore` 为假。实测这会做成一次无界读取，并把频道全部顶层消息并进时间线、废掉 feed 自己的分页。改为只读 feed 已加载窗口，`加载更早消息` 成为两者共用的取更早工作的入口（见 [issue 04](04-board-data-source.md)：该入口在看板里的呈现仍有问题）。原 spec 的 `boardEmptyColumn`（每列「（空）」）与 `boardLoading` 两个 key 未落地：列头已有计数，占位行是把同一件事说两遍；改用一个整面空状态 `boardEmpty`。

**实现偏离：** 原 spec 用负 margin 把页签下划线抬到页头底边上。改为伪元素 `::after` 伸出盒底 1px，不依赖页头盒高的巧合。
