# 04 — 看板的数据源与归属

**What to build:** 已被 [`project-ownership-model`](../../project-ownership-model/README.md) 整体取代，不单独实施。看板不再是消息的第二种读法，而是 Task 实体的人类主视图：有 accountable owner、来源引用，项目看板显示四列、全局看板只显示未完成三列。实施见该工作项的 [issue 02](../../project-ownership-model/issues/02-task-first-class.md)。

**Blocked by:** None — superseded

**Status:** superseded

## 裁决结果（2026-10-20）

看板是 **Task 的独立视图**（选项 A 的方向，但更大）：Host 按项目提供完整 Task 目录，看板读 Task 实体本身，不受消息分页影响，分页按钮随之消失。待定项（复用 `activeTaskThreads` 形状 vs 新增平行切片、已完成的上界、subject 格式）由新工作项在实施时确定：已完成在项目看板只显示最近 5 条可展开，全局看板不显示已完成。

---

## 以下为裁决前的记录，保留以免复述

### 现象

UI-UX-AX 频道的看板实测：

```
待处理 0    进行中 0    待验收 0    已完成 20
```

`20` 恰好等于 feed 的分页大小。看板里出现「加载更早消息」按钮。

## 原因

看板的卡片来自 feed 已加载的那段消息：`view.items` 里 `item.task !== undefined` 的项，按状态分列。`view.items` 每次读 20 条顶层消息，因此：

1. 频道还有更早历史时 `view.hasMore` 为真，而复用的分页按钮同时长在看板里；
2. 列计数只统计「最近 20 条顶层消息里出现过的 Task」。一个 30 条消息之前建立、此后无人触动的 `in_progress` Task 不在其中，于是「进行中 0」不成立。

按钮只是暴露了这个问题，不是问题本身。四个计数看起来是「频道里 Task 的现状」，实际是「已加载消息里出现过的 Task 的现状」。

## 两版实现各错一半

| 版本 | 做法 | 问题 |
| --- | --- | --- |
| 原始实现（`8602e18d`） | 看板激活时后台翻页直到 `hasMore` 为假 | 无界读取；为填四列把频道全部顶层消息并进时间线，废掉 feed 自己的分页 |
| 当前 master（`5236138f`） | 只读 feed 已加载窗口 | 有界，但看板不完整，且继承了 feed 的分页按钮 |

## 先要回答的归属问题

- **看板是消息的第二种读法，还是 Task 的独立视图？** 原 spec（[spec.md](../spec.md)）定的是「第二种**读法**，不是第二个表面——重排同一份投影」。但一个按状态分列的看板，读者预期是「这个频道里所有 Task 的现状」，与分页消息流的信息粒度不同。当前实现按 spec 走，结果就是上面这个现象。
- 若定为 Task 的独立视图：它应当有独立的读取与刷新时机，不再挂在 feed 的窗口上。
- 若坚持是消息的第二种读法：应当承认它只覆盖已加载的消息，UI 上也不能给「全量」的外观（包括列计数本身）。

## 修法的两个选项（待裁决后择一）

### A. Host 提供完整 Task 目录切片

`includeCatalog: true` 已返回该频道全部 Task / Thread / 编号 / Claim；`activeTaskThreads` 的行形状（`taskRef` / `threadRef` / `channelRef` / `taskNumber` / `status` / `subject` / `members` / `lastActivityAt`）覆盖了看板卡片需要的每一列，只是被限定为 `in_progress` / `in_review`。放开到全部状态即可让看板一次读全，分页按钮随之消失。

待定：
- 复用 `activeTaskThreads` 的形状并放开状态，还是新增一个平行的 `taskThreads` 切片？后者保住 `activeTaskThreads` 的「在飞工作雷达」语义（tool 描述与 `team_view` 都按这个语义写），代价是两个形状几乎重复。
- 已完成的 Task 随时间增长，切片需要上界（最近 N 条，还是全部）。
- `subject` 取 Thread 锚消息首行、上限 120 字符；看板卡片当前用 `formatTaskTitle(item.message.body)` 做两行截断。两者是否统一。

### B. 看板不做完整视图

保持只读已加载窗口，去掉那个分页按钮，并把覆盖范围写进页面（如「基于已加载的消息」）。代价：计数仍可能误导，与看板作为扫描面的定位冲突。

## 验收条件（裁决后据其细化）

- [ ] 看板不出现面向消息的分页控件。
- [ ] 列的计数与看板自称覆盖的范围一致——要么是真全量，要么页面上说明了它只覆盖什么。
- [ ] 有一条测试固定住这个覆盖范围，防止再次漂回另一种口径。
