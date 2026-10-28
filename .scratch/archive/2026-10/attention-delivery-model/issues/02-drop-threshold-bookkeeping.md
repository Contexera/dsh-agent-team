# 02 — 移除 threshold 的进程内簿记

**What to build:** 取消 Thread 普通更新的 5 条 threshold 之后，Host 不再需要为「哪些普通更新已经被摘要过」保留任何进程内簿记。同一批未读在唤醒、换代、恢复和重启之后的重派生结果一致，不存在「进程内认为已投递、重放后要补发」或反过来「重复投递同一批未读」的情况。

**Blocked by:** 01 — Thread 普通更新改由 Attention 决定是否立即唤醒（已完成）

**Status:** complete

- [x] 普通 Thread 未读的投递资格只由 durable 事实决定：Attention 的水位、direct/activity/reminder marker，不含任何进程内计数
- [x] 取消 threshold 后无任何代码路径继续引用被移除的 threshold 簿记；`typecheck` 无悬空引用
- [x] 原用于记录 threshold 已投递进度的进程内结构及其读写、清理、回滚逻辑全部删除，不留空壳或注释遗迹
- [x] 相关单测重写为表达新语义，而非删除后留下一个空文件
- [x] 已存在的「同一批未读不重复唤醒」行为由 `covered` 签名单独保证，并在测试中覆盖：重复派生同一批未读不产生第二次唤醒尝试
- [x] 唤醒失败后（投递抛出、Agent 不可用、换代中）下一次相关 durable 变化能重新派生并重试同一批未读，测试锁定该重试路径
- [x] 复核 `dropInboxCoverage` 失去 `summarizedThrough` 回滚参数后，失败重试语义仍与文档一致

## 实施说明

- `summarizedThrough` 及其读写在 01 中一并摘除：判定改为单一等级后它已无数据来源。
- 新增 `post-commit-delivery` 用例覆盖**纯 ordinary 未读**（无 mention、无 marker）的唤醒、去重与重试——这是旧 `summarizedThrough` 独家负责的场景，此前只有 direct-marker 路径被测试。
- 该用例同时确认 attempt 计数按 Member 跨 commit 累计，而 notice 计数按本次基线起算，两者不是同一个量。
