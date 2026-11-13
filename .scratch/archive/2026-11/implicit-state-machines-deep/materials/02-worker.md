# Worker 委派：状态、权威与开放问题

Worker 是第一轮审计之后新增的最大状态面。它在 `7076dbd` 时完全不存在；当前由 4 个 `agent-team` 源文件、`tool-agent-team` 的 `team_worker` 动作、Client 的 Worker 运行窗口和 5 个 e2e 场景组成。维护文档已经写了它的产品契约（[Host 权威](../../../../../docs/architecture/host-authority.zh.md) 的「Worker 委派」一节），但第一轮的审计材料没有它的状态/事件/守卫地图。

本材料只做地图和开放问题，不宣称已经复现缺陷。

## 范围

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `packages/agent-team/src/worker-service.ts` | 1,424 | 运行注册表、start/stop/steer/continue、dispose、列表窗口 |
| `packages/agent-team/src/worker-runtime.ts` | 864 | OAR provider、原生会话、steer 投递、失败分类 |
| `packages/agent-team/src/worker-inspection.ts` | 498 | 原生记录的有界只读、锚点校验、凭据隐藏 |
| `packages/agent-team/src/worker-settings.ts` | 37 | 引擎枚举、sandbox 模式、文本上限 |
| `packages/tool-agent-team/src/index.ts` | — | `team_worker` 的 start/steer/stop/inspect 动作与拒绝渲染 |
| `packages/client-agent-team/src/client/TeamMemberEditor.tsx` | — | 五行运行窗口、停止、诊断入口 |
| `packages/client-agent-team/src/client/worker-copy.ts` | 22 | 引擎显示名 |

测试锚点：`worker-delegation.spec.ts`、`worker-steer.spec.ts`、`worker-steer-runtime.spec.ts`、`worker-stop.spec.ts`、`worker-stop-notice.spec.ts`、`worker-thread.spec.ts`、`worker-host-thread.spec.ts`、`worker-inspection.spec.ts`、`worker-inspect.spec.ts`、`worker-anchors.spec.ts`、`worker-provider.spec.ts`、`worker-sandbox.spec.ts`、`worker-composition.spec.ts`、`worker-catalog-continuation.spec.ts`；Client `team-member-workers.client.spec.tsx`、`team-worker-panel.client.spec.tsx`、`team-worker-settings.client.spec.tsx`、`team-worker-thread.client.spec.tsx`；e2e `team-worker-*.e2e.ts`。

## 权威分层

| 层 | 保存什么 | 不是什么 |
| --- | --- | --- |
| ledger 操作 `team/worker-started` / `team/worker-settled` | 绑定的执行记录：workerRef、Project/Thread/Task、引擎、任务、cwd、发起 Member、开始/结束时间、终态、失败 stage、原生锚点、私有答案 | 不是原生进程的实时状态 |
| Thread 公开事实 `worker_started` / `worker_settled` | 执行发生与结束、引擎、终态、失败/停止原因 | 不公开 Worker 的答案 |
| 发起 Member 的 Inbox notice | 私有答案、任务正文、cwd、原生 session、完整 diagnostic | 不是 Thread 事实，不是普通消息 |
| `WorkerRegistry`（进程内） | 当前 Host 持有的运行、启动窗口、steer 投递、原生会话句柄 | 不是 durable 权威；重启不恢复 |
| `worker-inspection.ts` | 从原生记录读出的有界片段 | 不是 Team 的副本，不写回 |

关键区别：**started 记录先于进程**；**一个执行只有一条终态事实**；**stop 只在引擎确认清理后写终态**；**答案私有，执行公开**。

## 持久状态

```text
(no record)
   │ start: recordStarted
   ▼
running ── completed
   │   ├─ failed
   │   └─ stopped
   │
   └─ (Host released before an ending) → record stays running
                                          read as unconfirmed
```

- `unconfirmed` 不是 ledger 里的状态，而是读取时对「记录仍为 `running`、但本 Host 没有活跃句柄」的投影（`index.ts:2562-2571`、`workerInspectionOf`）。
- 一个执行只有一条终态写入，`settleRequestId = <requestId>:settled`。
- `settle` 先改进程内视图，再写 ledger；写失败时 ledger 仍为 `running`，下一次读取报 `unconfirmed`（`worker-service.ts:1297-1345`）。
- `sealed` 表示 Host 在截止时间内没有等到结束，释放了运行；迟到的结束不得在存储关闭后写入（`worker-service.ts:1173-1186`）。

## 进程内状态

| 状态 | 来源 | 说明 |
| --- | --- | --- |
| `running` | `entry.run.state === 'running'` 且 `held(entry)` | 本 Host 持有句柄 |
| `stopping` | `entry.stopping` | 已请求停止、尚未确认终态；不写 ledger |
| `sealed` | `entry.sealed` | Host 已释放，迟到结束被丢弃 |
| `cleanupUnconfirmed` | `entry.cleanupUnconfirmed` | 引擎没有确认清理；终态只能是 `failed`，不能是 `stopped` |
| `starting` | `this.starting` map | 同一 requestId 的并发重送加入同一次打开 |
| `continuations` / `continuationOpenings` | 按原生会话/新执行 | 同一原生会话至多一条运行中执行、每条执行至多一个直接后继 |
| `sessions` | 按原生 sessionId | 只有本 Host 能到达的 steer 投递控制 |

## 协议

### Start

1. 同一 requestId 的并发重送加入 `starting`；已打开的重送按 `DelegationShape` 比较，换任务/目标/引擎/成员即 `worker_request_conflict`。
2. 拒绝先于任何写入：开关、Project 存在、当前 owner、引擎、任务非空、绝对 cwd、subagent 服务。
3. `attempts` 先分配 workerRef；`recordStarted` 持久化后才打开引擎。
4. 打开期间 Host 开始卸载：`seal`，不打开引擎，记录留 `running` 供以后读成 `unconfirmed`。
5. 激活发布后，`entry.sessionId` 与 steer 控制才可用；结果处理器接 `activation.result`。

### Stop

1. 只有发起 Member 或 Human 可以停止；开关、owner 变更、Task 转移都不重新检查（这是刻意的：停止不该被启动条件卡住）。
2. 一个 `stop` 事务由重复请求加入；先 abort 启动信号，再 dispose 已发布的 activation，最后等 `entry.terminated`。
3. 10 秒内没有确认：`worker_stop_pending`，运行仍 `stopping`。
4. 清理被拒绝：终态 `failed`，带 `dispose` stage 和「无法确认已停止」的 diagnostic；不写 `stopped`。
5. 终态写入失败：`worker_stop_unrecorded`，Thread 读成 `unconfirmed`。

### Steer

1. 只有发起 Member 可以 steer；Human 没有 steer 入口。
2. 先查 requestId 的幂等回执（内存或 ledger），再查状态；同一 id 换指令/成员/Worker 即冲突。
3. 同一执行、同一发起人、同一文本的并发请求合并为一次原生投递；不同 requestId 可登记为 durable alias，不再次触达引擎。
4. 顺序是 **durable admission → 原生投递 → durable outcome**；outcome 写失败报 `worker_steer_unconfirmed`，不自动重发。
5. 结果三态：`submitted`（引擎说已投递，`landed` 为 steered/queued/prompted）、`refused`（明确拒绝，可用新 id 重试）、`ambiguous`（可能已投递，不可自动重发）。
6. 运行已结束、正在停止、没有原生会话、没有活跃 turn 都各有明确拒绝码，不投递。

### Continuation

1. 只有干净结束、且原生记录可读的执行可以续跑；`running`（本 Host 无句柄）、`dispose` 失败、清理未确认都拒绝。
2. 重新检查当前 Worker 开关、引擎开关、Project 存在/active、发起 Member enabled、当前 owner；不沿用旧授权。
3. 同一原生会话至多一条运行中执行；并发续跑加入已建立的执行，不分叉。
4. 续跑产生新的 workerRef 和 `continuedFrom`；旧执行不变。
5. 续跑本身也先写 steer admission，再打开新执行，最后写 `submitted` 或 `ambiguous`。

### Dispose

1. `stopped = true`，拒绝新 start/steer。
2. 等待所有启动、续跑、steer 调用最多 5 秒。
3. 关闭 steer 持久化；此后不再开始 admission/outcome 写入。
4. 对每个仍 `running` 的运行请求停止，等 `terminated` 最多 5 秒；超时 `seal`。
5. 等所有 durable 写入；释放 provider；清空 sessions。

## 读取与诊断

- `readWorkerHistory` 只打开结算记录里的绝对 `.jsonl` 路径，解析符号链接，要求记录第一行命名结算记录的 session；不扫描最新文件，不接受调用方给的路径。
- 读取有 8 MiB 上限、4 个片段、每片段 600 码点；超长值整条拒绝，不截断成假值。
- 看起来像凭据的片段整条隐藏并计数，不掩码。
- 运行未结束时没有锚点，报告说「未结束」；本 Host 无句柄时报「无法确认」，不猜引擎记录。

## 开放问题

按「先验证、再决定」排序。没有一条已经复现为缺陷。

1. **`unconfirmed` 把两种原因合成一个词。** 记录仍为 `running` 且本 Host 无活跃句柄，可能是上一个 Host 被替换，也可能是本 Host 观察到了结束但 `recordSettled` 写失败。当前 `workerInspectionOf` 的 summary 统一说「本 Host 不再持有句柄」，对第二种情况不准确。Human 列表和 Thread 都只读 ledger，所以都显示 `unconfirmed`；本 Host 的 live 视图其实知道终态，但不会展示。需要确认：是否要在 Human 侧区分「观察到了但没记下」与「上一个 Host 留下的」，以及是否值得为它加一条持久诊断。证据：`worker-service.ts:1297-1345`、`index.ts:4166-4205`、`workerInspectionOf`。
2. **Host 重启后原生进程可能仍在跑。** 记录读成 `unconfirmed` 是终态，不重跑、不自动重试；文档让操作者「check the engine's process」。没有启动时的孤儿进程扫描，也没有 stop 入口。需要确认这是可接受的产品边界，还是需要一条操作者可见的清理路径。证据：`worker-service.ts:1173-1186`、`host-authority.zh.md` 的「Worker 委派」。
3. **`recordSettled` 失败时，live 终态与 durable 状态分叉。** 进程内 `entry.run` 已是终态，ledger 仍是 `running`；stop 回执可能返回 live 终态，列表/Thread 返回 `unconfirmed`。这是「durable 权威」的正确结果，但需要确认 Human 不会因此误以为执行仍在跑。证据：`settle` 先改 `entry.run` 再写 ledger；`workerRunsForClient` 只把 live `running` 放进第一段，其余走 ledger。
4. **停止的 10 秒与卸载的 5 秒是两个截止。** 停止请求超时报 `pending`，运行仍 `stopping`；卸载超时直接 `seal`。需要确认这两个数字的产品含义（Human 等待、Host 关闭）不会让同一个运行在两个面上读成不同状态。证据：`WORKER_STOP_DEADLINE_MS = 10_000`、`WORKER_SETTLE_DEADLINE_MS = 5_000`。
5. **续跑权限是否覆盖 Workspace 参与。** `assertContinuationAllowed` 检查 `memberEnabled`、Project 存在/active、当前 owner、引擎开关、Worker 开关；没有单独检查 Workspace participation。离开 Workspace 会撤销 owner，所以当前 owner 检查大概率覆盖，但需要确认「仍是 owner 但已离开 Workspace」这种组合不可达。证据：`worker-service.ts:818-866`、`ledger.ts` 的 owner/participation 规则。
6. **`DEFAULT_WORKER_SANDBOX = 'danger-full-access'` 是安全敏感默认。** 文档解释了理由（嵌入式无人值守，批准提示会卡死），设置页不暴露 sandbox 字段。需要确认这是有意为之且不会在升级/迁移中被静默改写。证据：`worker-settings.ts`、`host-authority.zh.md` 的 Worker 设置段。
7. **`WORKER_NATIVE_ANCHOR_LIMIT = 128` 截断长运行的锚点。** 结算保留最新 128 个 turn/input id；续跑按最近优先找可读记录。需要确认超长运行不会因为锚点丢失而无法续跑，或至少给出明确拒绝。证据：`worker-service.ts` 的 `settle` 锚点截断、`workerResumeAnchors`。

## 建议

先做只读地图复核，不急着改代码。优先验证开放问题 1、2、3：它们都涉及「用户看到的 `unconfirmed` 到底是什么意思」，是最可能影响 UX/AX 的地方。开放问题 4–7 可以在同一轮里做静态确认，只有发现真实分叉才升级为修复票。

不要把 Worker 重写成通用 actor/FSM；它的状态已经集中在 `WorkerRegistry` 和 ledger 两个 owner 里，第一轮的「不引入框架」结论继续适用。
