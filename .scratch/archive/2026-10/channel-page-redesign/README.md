# Channel 页面分流重设计

> 本工作项是 Channel 页「一条时间线两种读法」的设计与实施容器：分流决策、工单、原型资料与验收证据都归这里。它不定义当前产品行为——行为以 `packages/` 源码、测试与 `docs/frontend-design/` 双语对为准。

**状态**：2026-10-28 归档。切片 1–3 已实施并合入 master（2026-10-15 起，10 个 commit，tip `f35675b3`）。看板的归属与数据源（[issue 04](issues/04-board-data-source.md)）已被 [`project-ownership-model`](../project-ownership-model/README.md) 整体取代，由该工作项的 issue 07 交付。

**最后核对日期**：2026-10-28

**决策快照**：见同目录 [`spec.md`](spec.md)（分流方向、看板入口、布局实测、移动端、未采用的草图内容）。

## 当前前沿

- **无进行中工作。** 实施部分全部完成；issue 04 的裁决（看板是 Task 的独立视图）已由 `project-ownership-model` 实施。
- **@Iris / @Reeve 已交棒**（Human 定：本次重构 Iris 不再参与）。Iris 产出 v1 草图，Reeve 产出 v2 草图；两者的取舍进入 [`spec.md`](spec.md)，原始文件在 [`materials/`](materials/)。
- **issue 04 已交棒**：归属问题由 [`project-ownership-model`](../project-ownership-model/spec.md) 回答——看板是 Task 实体的人类主视图，不再从 feed 已加载窗口派生。实施跟随该工作项的第二批。
- **后续事项（B-4，来自 #17 清理审查，Reeve 拍板「不随下一版做」）**：`TeamChannelPanel.tsx` 与 `TeamThreadPage.tsx` 的 read/drain 编排重复——`readCurrent` 差 `onRead(threadRef)` 一行、`drainUnread` 逐字节相同，可抽核心 **31 行**（Cole 原报 250，Reeve 逐函数复核后订正为 31：`refreshPassiveFacts` 已分叉出 `timeline.isPinned()` jump hint、`refreshAfterFence` 多一行 `refreshSupplemental`，都不是重复）。抽成 `useThreadFeed()` 意味着 `sequenceRef`+`projectionRef`+`mountedRef` 时序协议合并，写错表现为**静默陈旧渲染**，红测试保不住。**重评时机：issue 04 定后、分流整体稳定一轮**；届时由 @Tars 定。`f5e9df1b` 已先做掉 fact 合并的那一半。

## 完成条件

- [x] Human 对分流方向、看板入口、布局模式的结论（见 [`spec.md`](spec.md)）
- [x] 切片 1（页签 + 看板）实施并合入 master —— [issue 01](issues/01-channel-tabs-and-board.md)
- [x] 切片 2（已完成 Task 瘦成脚注）实施并合入 master —— [issue 02](issues/02-resolved-task-footnote.md)
- [x] 切片 3（讨论右面板）实施并合入 master —— [issue 03](issues/03-taskless-discussion-panel.md)
- [x] 看板的数据源与归属有结论并按其实施 —— [issue 04](issues/04-board-data-source.md) 判定为 Task 的独立视图，实施转 [`project-ownership-model`](../project-ownership-model/issues/07-task-board.md)
- [x] durable 结论进 `docs/frontend-design/` 双语对（`components` / `layout-and-typography` / `thread-and-composer` / `refresh-copy-accessibility`）与 `CHANGELOG.md`

## 正式文档出口

`docs/frontend-design/` 双语对 + `CHANGELOG.md`。2026-10-28 移入 `.scratch/archive/2026-10/`；交付它的 commit 已在 master 历史中，移动单独记入 `docs:` 提交。

**归档范围**：B-4 的 `useThreadFeed()` 抽取（见「当前前沿」最后一条）未做，随本工作项关闭不再跟踪；如仍需要，另开工作项。「看板从 feed 已加载窗口派生」的实现已被 `project-ownership-model` 的 Host Task board 投影替换。

## 交付记录

| commit | 内容 |
| --- | --- |
| `8602e18d` | 页签 + 看板（issue 01） |
| `d0172889` | 已完成 Task 瘦成脚注（issue 02） |
| `facfd734` | 讨论右面板（issue 03） |
| `5236138f` | 看板改读 feed 已加载窗口，不开第二条管线 |
| `f5e9df1b` | Thread fact 合并逻辑收成一个 owner（面板与 Thread 页共享） |
| `209eaa50` | 窄栏下看板列可读 |
| `bdf85daf` | 真实浏览器验收（页签 / 看板 / 面板） |
| `40fbf764` | 面板的注释收回到已审查的预算内 |
| `e113cade` | 页头取 shipped session 页头的形状 |
| `f35675b3` | 页头改回面板 chrome、贴面板左缘 |

注：以上是重做后的提交。最初的三个 commit 在分支 `backup/channel-ui-3commits`（tip `bdbd497e`），已在重做时被替换。
