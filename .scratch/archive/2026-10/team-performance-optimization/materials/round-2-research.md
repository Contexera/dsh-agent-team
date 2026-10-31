# 第二轮研究合并

**检查日期：** 2026-10-28

**当前工作区：** `HEAD` `bf777c3`。工作树另有 `packages/agent-team/src/ledger.ts`、两个测试和 `scripts/team-ui.ui-preview.ts` 的未提交改动。报告中涉及性能数字的地方仍以“未测量”为准。

## 1. 观测边界

现有 Harness 事件、Browser fixture 和 DOM 可以直接测总时长：Host boot、tool call、通知领取、成员回复、Client usable。要准确拆出 ledger queue wait、replay/validate、同步 fan-out、通知派生和 Remote/render，需要增加默认关闭的结构化 hook。

推荐的两个端到端指标：

```text
team.handoff:
  A tool/call → A commit ack → B notice queued → B notice claimed → B tool/call reply → B tool/result

collaboration.e2e:
  A turn start → A send → B wake/read → B reply committed
```

`Agent status = idle` 只作为收尾信息，不能当作单条消息已处理。每条样本至少关联：模型 `callId`、Team `requestId`、ledger `operationId`、通知消息 id、接收方 turn/claim 标识。不得用时间窗口猜因果。

正式 baseline 建议每个核心配置 400 个有效样本；100 个可用于趋势和 p50，不能稳定支撑 p95。第一版 11 个基础格足够：冷启动、Client usable、单次 read、单次 write、fan-out、warm wake、cold wake、Thread read/reply、DM、Task claim、并发只读 batch。规模扩展采用单因素分支，不做完整笛卡尔积。

## 2. 通知路径的低风险优化

当前一次提交后的通知路径存在确定性的重复派生：

1. `notificationFacts()` 先为候选 Thread 算 unread，选出结果后再为选中的 Thread 重算 unread。
2. `memberInbox()` 为总数派生 Main unread，但通知路径丢弃该中间结果，随后 `mainNotificationFacts()` 再算一次。
3. `deliverInboxNotice()` 计算一次 delivery plan，`notificationText()` 为取得 Thread role 又计算一次。
4. recycle 的空判断先派生通知材料，真正投递时再次派生。
5. Main recipient 派生会扫描全体 Main Attention 行。

推荐的内部 seam 是一次性的 `NotificationReadSet`：

```text
一次通知投递
  → Ledger 从当前 projection 派生 Thread + Main 材料
  → Host 用同一材料计算 plan、identity、text
  → beginInboxDelivery
  → steer/followup
```

它的边界是：Ledger 负责从 projection 派生只读材料，Host 继续负责 coverage、attempt、notice 替换、wake gate、steer/followup 和失败重试。read set 只在单次 `emitCommitted`/通知调用内存在，不做长期缓存，不建立第二个 durable authority。

这个方向的验证重点是旧路径与新路径在同一 projection revision 下逐项相同：notice 文本、covered、undelivered、attempt、steer/followup 次序和失败隔离。跨 commit debounce、长期缓存、只生成前 8 个 Thread、并行 cold wake 都会改变时序或 attempt 语义，先不混入这个切片。

## 3. Tool 并发候选

Harness 的执行分类是 fail-closed：只有 `isConcurrencySafe(args)` 精确返回 `true` 才会进入 parallel pool；未声明、非法、抛错都进入 exclusive barrier。并行只重叠 tool body，结果仍按模型调用顺序写入 Session；不同 Agent 的调用不共享这个 barrier。

按当前副作用审查：

| action | 当前判断 |
| --- | --- |
| `team_attention status` | 纯投影读取，可候选 parallel |
| `team_thread history` | 纯投影读取，可候选 parallel |
| `team_thread message` | 纯投影读取，可候选 parallel |
| `team_task board` | 纯投影读取，可候选 parallel |
| `team_task list` | 纯投影读取，可候选 parallel |
| `team_view` | 纯投影/成员状态读取，可候选 parallel |
| `team_inbox` | 会启动 Task reminder evaluation，暂保留 exclusive |
| `team_thread read` | 可能写 read receipt，并可能触发 acceptance reminder/compaction，必须 exclusive |
| 所有 post/reply/start、DM、Attention write、Task mutation | durable write + post-commit effects，必须 exclusive |

这只是候选分类，不是实施结论。Team 的纯读大多在同一 Node event loop 上同步扫描 projection；如果没有异步等待，parallel 只可能减少 Harness 调度等待，未必减少总墙钟。必须比较同一模型回复中的 1/4/8 个纯读 call 在全 exclusive 和候选 parallel 下的 p50/p95，同时记录 event-loop lag、结果提交顺序和 projection revision。

必须补的正确性边界：

- 两个纯读可以返回不同已提交 revision，不能暗示同一快照；每个返回值内部必须一致。
- 写仍然是 barrier；写前后的 read 必须按模型顺序观察到明确的 pre/post 状态。
- 同一 Thread 的两个写使用相同 revision 时，一个提交，另一个得到确定的 unread/stale 结果。
- 相同 requestId 并发执行只产生一个 durable operation；payload collision 仍然失败。
- wake、recovery、generation swap 与并发调用交错时，durable unread 不丢，旧 Agent 不收到重复 notice。

## 4. 当前工作树的基准边界

`bf777c3` 已吸收 Attention source 和 Project/Board 相关提交。当前未提交的 `ledger.ts` 改动继续处理旧 Thread read snapshot 的缺失 Attention source，并为 read/main-stream-read 重新推导来源；这会影响旧账本重放和全量 invariant 校验成本。`post-commit-delivery.spec.ts` 的当前修改也改变了一个 wake 失败后下一次提交才重试的断言。

因此基准至少应分为：

1. `c3a9704` 或固定的上一稳定 commit：改动前基线。
2. `bf777c3` clean checkout：当前候选版本。
3. `bf777c3` 加当前工作树：只做最终冒烟，若用户要求评估未提交改动，再作为单独候选样本。
4. 旧格式 corpus 由旧版本生成、由候选版本打开：测 Attention source 修复的升级成本。
5. 新格式 corpus 在候选版本生成并打开：测稳态成本。

预览脚本会给所有 Agent 增加 Project owner，改变 Attention 行数和 preview 数据规模，不能把它产生的 profile 当成性能样本。

## 5. 第二轮需要决定的实施顺序

- 是否先实现“性能 hook + 固定 baseline runner”，把任何业务优化放在可比数据之后。
- 是否把单次通知 `NotificationReadSet` 作为第一个低风险代码切片，并用逐字段等价性验收。
- 是否把纯读 tool 的 action-sensitive concurrency 作为独立实验票，先只改候选六类 action，`team_inbox` 和 `team_thread read` 保持 exclusive。
- 是否把 Session fold 增量、Member activation 并行、跨 commit debounce 和 rejection payload 限长放到首轮之后的独立规模问题。

## 6. 实验后的收敛

- 通知规模实验确认 `NotificationReadSet` 是真实的同步热点：1/20/100 个未读 Thread 的 fan-out 核心中位数为 0.195/0.549/1.047 ms，单次 reply 中占比从 14.8% 增至 50.9%；100 个候选仍执行 151 次 `unreadFor`。
- delivery plan 复用原型删除了每个 follower 的第二次 plan 计算，相关测试通过；完整 read-set 仍需把 Thread/Main unread 中间结果一起收敛。
- 纯读 tool 调度实验覆盖真实 Harness loop 和真实 Host。4/8 calls 的当前 p50 只下降约 0.15–0.49 ms，p95 不稳定；同步 CPU projection 没有并行收益。当前不把 `isConcurrencySafe` 作为独立性能优化。
- clean `0881268` 窄回归 147 tests、tool/rejection/read/index 窄回归 301 tests、build 均通过；当前主工作区 clean。

## 6. 当前工作区验证

在当前 `bf777c3` 加未提交改动的工作区运行：

```text
npx vitest run \
  packages/agent-team/tests/agent-team-attention.spec.ts \
  packages/agent-team/tests/post-commit-delivery.spec.ts \
  packages/agent-team/tests/inbox-delivery.spec.ts \
  packages/agent-team/tests/member-lifecycle-core.spec.ts
```

结果为 4 个文件中 145/146 tests 通过。`post-commit-delivery.spec.ts` 的 `wakes a non-owner Main stream follower for ordinary updates` 失败，错误是 `assertActorForWorkspace` 收到 `undefined` actor。失败位于当前用户未提交的 ledger/test 改动范围，因此本工作项不修改它；性能基准和后续回归需要先明确使用 clean `bf777c3` 还是当前工作树。
