# 第一轮研究合并

**检查日期：** 2026-10-28

**研究范围：** 启动与加载、Team tool call、成员协作流程、基准与观测。

**当前代码口径：** 研究最初以 `c3a9704` 开始，当前主工作区已推进到 `HEAD` `bf777c3`。当前工作树存在 `packages/agent-team/src/ledger.ts`、两个测试和 `scripts/team-ui.ui-preview.ts` 的未提交改动；这些改动属于用户正在进行的工作，本研究没有触碰。性能数字必须在固定 commit 和固定工作树状态下重新跑。

## 已确认的背景

上一轮 `team-perf` 已在 2026-09 完成一批 ledger、读取和 Client 渲染优化：启动重复校验、空读落盘、投影游标、胖 read 记录、读路径索引/COW、Thread 行渲染隔离均已有历史实现和验证。Session fold 增量仍是未完成项。新工作不重新打开这些已关闭票，除非当前基线证明它们回归。

本轮新增的结构性事实如下：

```text
Host 冷启动
  storage open → ledger load/sort/normalize/replay/validate
  → persisted Session inventory → workspace sweep
  → enabled Member 逐个 transition/activation
  → Host ready

模型 tool call
  model args → parse/snapshot/schema → Team handler
  → Host resolve/authorize → ledger query 或 operationTail
  → projection / commit / post-commit fan-out
  → output validation/snapshot/render → Session history

成员协作
  A commit ack → affected-member fan-out → B notice queued
  → B wake/steer/followup → B read gate → B reply/claim
  → B idle 或下一轮继续
```

## 研究结论

### 启动与加载

- Host ledger 冷启动仍然是随 operation 数增长的全量路径：存储读回、schema 解析、排序、legacy normalize、独立验证和 live projection apply 都发生在服务初始化附近。
- enabled Member 的 activation 循环是串行的。共享 preset tree 只挂载一次，但每个 Member 仍会执行自己的 Session 恢复/创建、工具策略绑定、preset audit、私有 skill provider 和 Workspace attach。
- Team Client 会进入普通 Web 的应用加载链；Team 数据请求本身大多按需启动，但 Client bundle、Remote mount、slot 注册和服务等待会进入全局 boot 临界路径。
- 研究报告给出的 bundle、Typert 和当前 profile 数字存在压缩级别或输入 profile 差异，不能直接比较。当前只把“需要测 parse/evaluate、Remote mount、Member activation 分段耗时”列为事实性缺口。

### Tool call

- 七个 Team tools 都没有 concurrency classifier。Harness 的默认执行模式是 exclusive，因此同一模型回复中的多个 Team call 当前按顺序执行。
- Team durable write 经过单一 operation tail；延后的 invariant replay 不阻塞当前 commit 返回，但会在同一 Host event loop 上占用 CPU，并影响随后 call 的排队时间。
- 工具结果有两类固定成本：handler 内部的身份/Workspace/Thread/Task 派生，以及结果进入 Harness 后的 schema 校验、快照、render 和 Session 历史保存。
- 主要的规模风险是重复扫描和上下文膨胀：Thread unread、visible Team surface、Task/Claim、Inbox/Main 派生会随规模增长；unread/stale rejection 可能把大批 facts 一次返回给模型。
- 静态结果大小可以测量，但当前没有可信的各工具 p50/p95、queue wait、Host 分段、事件循环阻塞和 provider token 数据。因此不能先把“减少 JSON”当成真实端到端收益。

### 协作流程

- “发送工具返回”“通知入队”“接收 Member 取得通知”“读取提交”“回复提交”“Member idle”是不同完成点，当前日志和代码没有统一 trace 把它们串起来。
- 受影响 Member 的 post-commit fan-out 在发送方 Host 操作返回前执行；成员逐个处理，且通知计算会重复派生 Inbox、unread、delivery plan 和 Main unread。
- running Member 的多个更新最终可以合并成一个 hint，但合并不消除每次 commit 的候选成员筛选、unread 计算和通知路径工作。
- idle/cold Member 可能进入上下文计量、Session recycle、旧 Session archive、新 Session activation 和 carried input replay；这些成本与单次 ledger 写入需要分开测量。
- 当前没有真实两成员协作链路的 p50/p95/p99，也没有证明 fan-out、cold wake 或多页 read 谁是端到端主因。

### 基准与观测

- 当前已有真实 Host/SQLite、preset、tool loop、Client 和 Browser fixture，但主要用于功能回归；storage benchmark 只测裸 KV put。
- 当前没有统一的性能采样器、阶段计时、trace correlation、JSONL 原始样本和分位数汇总。
- 上游 Harness 已有可复用的 child process、固定 workload、浏览器 CDP、`results.jsonl` 和环境记录模式。Team 应复用运行方式，但使用自己的 ledger、tool 和协作 workload。
- 第一版 baseline 不应做完整笛卡尔积。先覆盖三条代表路径：冷启动、单次 tool call、两成员协作；每条同时保留小/中/大规模和冷/热/并发边界。

### 第二轮深入结果

- 精确拆解 ledger 排队、replay/validate、同步 fan-out、通知因果和 Client Remote/渲染阶段，需要默认关闭的结构化 hook；外围总时长可以先用现有 Harness 和 Browser fixture 测量。
- 协作 trace 至少需要关联 `requestId`、模型 `callId`、`operationId`、通知消息 id 和接收方 turn claim。不能按日志时间猜 A 的提交和 B 的回复是否属于同一轮。
- 当前最明确的低风险优化是单次通知投递内的 `NotificationReadSet`：Ledger 一次派生 Thread/Main 通知材料，Host 复用同一份 delivery plan 和文本输入。它不增加第二个 durable authority，也不改变通知时序。
- 候选纯读 action 是 `team_attention status`、`team_thread history/message`、`team_task board/list` 和 `team_view`。`team_inbox` 会启动提醒评估，`team_thread read` 会写已读水位并可能触发 acceptance reminder/compaction，二者暂不适合并行。
- Harness 的 `parallel` 只重叠异步 tool body；Team 当前查询大多是同一 Node event loop 上的同步 projection 扫描，所以必须先测同批串行与并行的端到端 p95，不能从分类器本身推断收益。
- 真实 `mountTeamMemberHost` 规模实验已确认通知核心随未读 Thread 数增长：1/20/100 Thread 的中位数约为 0.195/0.549/1.047 ms；100 个候选只返回 50 行，但 `unreadFor` 仍调用 151 次。一次 reply 中 fan-out 核心占比从 14.8% 上升到 50.9%。

## 需要复测的冲突

| 项目 | 报告差异 | 当前处理 |
| --- | --- | --- |
| Host 启动时间 | 一份报告给出本地 25,366 operations、约 2.14–3.21 秒；另一份没有运行 Host 计时 | 作为未确认历史样本；用固定 sanitized corpus 和当前 HEAD 重跑分段数据 |
| Client bundle 压缩体积 | 报告使用 gzip level 1、gzip level 9 和 Brotli 等不同口径 | 统一记录 raw、gzip level 1、gzip level 9、Brotli，并绑定同一次 build |
| 七工具定义体积 | 两份报告给出 19,125 与 19,342 bytes | 重新执行同一静态脚本；按 UTF-8 JSON、是否包含外层数组和工具排序明确口径 |
| 共享 preset 审计 | 研究认为共享 tree 只挂载一次，但每 Member 仍会 audit/bind | 用 1/4/8/16 Member 的激活 trace 确认调用次数和耗时占比 |
| Tool exclusive 影响 | Harness 合约确认默认 exclusive，但收益大小未测 | 先测 1/4/8 同批只读调用，再决定是否给单个 action 加 classifier |

## 第一轮推荐顺序

1. 先建立可复跑 baseline 和 trace correlation，不先改业务语义。
2. 以端到端 p95 为主判据，分开报告 handler、queue、ledger、fan-out、模型/Session 和 Client 等阶段。
3. 首轮优先验证两个低风险方向：同一次调用内复用已经解析的 actor/Workspace/Thread 状态；通知路径复用已经计算出的 Inbox/unread/delivery facts。
4. 并行测量两个可能改变设计的方向：只读 Team tools 的并发执行边界、成员 activation 的安全并行边界。
5. 拒绝结果限长、tool schema 拆分、read 批处理和 durable read model 暂不直接实施，先测完整恢复链和模型上下文成本。

## 尚未进入设计的事项

- 性能目标是以用户/模型的端到端等待为主，还是以单 Host 的吞吐和资源上限为主。
- 第一阶段是否只做观测和低风险内部复用，还是同时允许修改 tool 并发分类和结果形状。
- Member 激活并行化的允许范围，以及失败、顺序、资源上限和 Host 单线程事件循环约束。
- 协作 benchmark 的代表工作流：DM、Thread reply、Task claim，还是三者都纳入第一版。
