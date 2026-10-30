# 02 — 合并单次通知投递的重复派生

**What to build:** 一次通知投递只派生一次该 Member 的 Thread/Main unread 材料和 delivery plan，文本渲染、identity、coverage 和投递复用同一份只读结果，同时保持当前通知内容、顺序、attempt 和失败语义。
**Blocked by:** 01
**Status:** complete

2026-10-30：旧新八检查点差分及 generation/失败交错验收完成，最终交付检查通过。

- [x] `deliverInboxNotice` 复用本次已经生成的 delivery plan，去掉 `notificationText` 的重复 plan 计算
- [x] `notificationFacts` 在一次同步读取中复用 `memberInbox` 已派生的 unread facts；返回结构和 durable authority 不变
- [x] `running` 快速跳过已撤回：旧新差分发现部分读取后会漏掉一次应有重试，保留原有重新派生与投递判断。回归断言 attempt 和通知数均增加。
- [x] Thread/Main unread、delivery plan 和文本渲染不再对同一投递重复扫描同一批 facts
- [x] 1/20/100 unread Thread 和 1/8/32 follower 的矩阵调用计数已记录；per-member fan-out 仍是 O(follower × unread Thread) 候选
- [x] notice text、covered、undelivered、attempt 和 steer/followup 顺序与旧路径逐项一致：八个检查点全等，仅归一化自动生成ID及发生时间
- [x] wake、recovery、generation swap、通知派生失败和 steer 失败保持隔离；额外验证延迟八人batch里一人替换、一人失败不影响其他Member，后续重试成功
- [x] 相关 Host、ledger、delivery 和 tool 回归通过；最终检查见 reviews/04-team-performance-optimization-recheck.md

## 当前实现

当前保留短生命周期 read set 与单次plan复用，撤回无效的running快速返回：`notificationText` 接收当前 delivery plan，`notificationFacts` 在一次调用内复用 `memberInbox` 的 unread facts，`notificationSnapshot` 让 Thread/Main unread 在一次通知投递内共享 `memberInbox` 已算出的结果，`running` 的 coverage 快速返回已在 2026-10-30 完整差分中撤回；已有 coverage 不能证明读取后无需重新派生。没有把 facts、plan 或 projection 放入长期缓存，也没有改变 ledger 的读取接口。32 follower 样本确认每个受影响 Member 的 facts、plan 和文本派生保持一次，`mainUnreadFrom` 从 66 次降为 33 次；达到 fan-out 阈值后，通知 effect 在 durable commit 和 Client invalidation 后进入按 Member 保序的队列，关闭开始后未执行的通知取消并由下次 activation 重派。失败重试、关闭取消、顺序和 Client invalidation 的语义探针均通过。
