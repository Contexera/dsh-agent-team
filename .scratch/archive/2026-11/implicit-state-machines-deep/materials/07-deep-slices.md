# 全域深入切片

第一轮的 68 组是索引，不是结论。这一轮按六条线重新扫整个应用；每条线都可以独立成为一个工作切片，不需要一次做完。

切片的产出不是“又一张状态表”，而是：**每个发现都有证据等级；需要修的进入 ticket；不需要修的写清理由。**

## 切片 1：失败可见性

**问题：** 每个 `catch`、`warn`、`log`、`allSettled`、`AggregateError`：谁需要知道这个失败？Human、Agent、operator，还是只有日志？

**范围：** `packages/agent-team/src`、`packages/tool-agent-team/src`、`packages/client-agent-team/src` 的全部错误路径。

**方法：**

1. 枚举 `logger.warn`、`logger.info`、`catch`、`.catch(`、`allSettled`、`AggregateError`。
2. 每条归类：用户可见结果 / operator 可见诊断 / 刻意吞掉（有理由）。
3. 对“只有日志”的路径，问：用户下一步能做什么？Agent 能从工具结果知道吗？operator 能在哪里看到？

**候选发现（当前代码）：**

| 路径 | 当前信号 | 可能的缺口 |
| --- | --- | --- |
| grant 安装失败（`member-runtime.ts:333`） | Host warning | 设置页仍显示已保存；roster 可能仍 `applied` |
| grant 刷新失败（`index.ts:3153-3156`） | Host warning + 拒绝该步 | roster 无诊断；Human 不知道 Member 被卡住 |
| reminder 消费重试耗尽（`index.ts:5574`） | Host warning | occurrence 留 owed，等下一个 Team fact；可能永远不来 |
| 私有记忆清理部分失败（`member-runtime.ts:536`） | `AggregateError` 进生命周期链 | 没有用户可见状态；下次启动重试 |
| 附件 GC 跳过无 meta 目录（`attachments.ts:290-310`） | 无 | 永久泄漏，无诊断 |
| 更新检查失败（`human-update-check.ts`） | “无已知更新” | 与“确实没有更新”不可区分 |
| 订阅 late-result 被终态门禁丢弃 | 日志 | 操作者可能不知道一次运行的结果被丢弃 |
| Worker 结算写失败（`worker-service.ts:1297-1345`） | Host warning；Thread/列表读 `unconfirmed` | `unconfirmed` 不区分“上一个 Host”与“本 Host 没记下” |
| sidebar order 保存失败（client） | 本地缓存继续服务 | 没有“未同步”提示 |
| 模型目录重验证失败 | 错误横幅 + 缓存行 | 已可见，但可能过于吵 |

**产出：** 一张“失败 → 谁需要知道 → 当前信号 → 缺口 → 建议”的表。只对确认的缺口开票。

## 切片 2：重启与恢复

**问题：** 每个 durable 记录：读路径是什么？每个内存 map：重启后怎么重建？每个 `unconfirmed`：用户看到什么？

**范围：** ledger 操作与投影、Session 绑定/过渡/continuation、订阅 admission/checkpoint/delivery/replay、Worker 运行、附件/头像文件、Inbox coverage、reminder occurrence、context cursor、sidebar order 缓存、草稿/导航。

**方法：**

1. 对每个 durable 写入，找它的读取路径和启动恢复路径。
2. 对每个内存 map，找它的重建路径；没有重建的，明确写“重启丢失”。
3. 对每个 `unconfirmed`/`pending`/`unknown`，写用户看到的文案和可执行动作。

**候选发现：**

| 事实 | 重启后 | 用户看到 | 缺口 |
| --- | --- | --- | --- |
| Worker `running` 记录 | 无 live handle → `unconfirmed` | Thread/列表显示未确认 | 原生进程可能仍在跑；无清理入口 |
| Worker 结算写失败 | ledger 仍 `running` | `unconfirmed` | live 终态不展示；原因不区分 |
| 订阅 admission | 从 `queued`/`retrying`/`exhausted` 续作 | 失败列表/重放 | 耗尽收尾的三个断点已由 01/09 覆盖 |
| Session 换代 | 从 transition 记录重建 | 名册/Thread | 旧入口 replay-only |
| 附件缓存 | 从文件扫描 + ledger 引用 | 过期/不可用 | 无 meta 目录不可见 |
| 头像 | 文件仍在，settings 引用 | 首字/图片 | 旧文件不回收 |
| Inbox coverage | 从 durable 欠账重建 | 未读/提醒 | 消费重试耗尽后等下一个 fact |
| sidebar order | Host row + localStorage | 顺序 | 写失败无“未同步”提示 |
| Client 草稿/导航 | localStorage | 恢复位置 | 过期/损坏降级 |

**产出：** 一张“事实 → durable? → 读路径 → 重启行为 → 用户可见状态 → 缺口”的表。

## 切片 3：生产者/消费者完整性

**问题：** 每个 enum/union/状态字段：谁写它？谁读它？如果它出现，读方会怎样？

**范围：** `types/entities.ts`、`types/operations.ts`、`types/requests-results.ts`、`spec.ts`、`subscription-admissions.ts`、`subscription-runs.ts`、`worker-service.ts`、`worker-settings.ts`。

**方法：**

1. 枚举每个 union/enum 的成员。
2. 对每个成员 grep 写入点（`state: 'x'`、`kind: 'x'`、`type: 'x'`）和读取点。
3. 分类：live、replay-only、legacy、dead、read-time projection。

**候选发现：**

| 状态 | 写入点 | 读取点 | 判定 |
| --- | --- | --- | --- |
| admission `running` | 无 | `dueAdmissions` 排除 | dead；v5 未发布可删 |
| `team/member-session-restarted` | 无 | replay validator | replay-only；已注明 |
| `team/member-context-cleared` | 无 | replay validator | replay-only；已注明 |
| 旧 read snapshot | 无（新读只写 receipt） | schema 接受 | legacy；旧账本需要 |
| `AgentTeamWorkerRunViewState` | 无（读取投影） | Client | read-time projection |
| `AgentTeamWorkerState` 的 `running` | start | Thread/列表 | live |
| `AgentTeamWorkerState` 的 `unconfirmed` | 无（投影） | Thread/列表 | read-time projection |
| `invalid-utf8` run category | 无（旧持久行） | 兼容读 | legacy |
| `AgentTeamMemberState` 的 `inactive` | remove | 生命周期 | live |
| `AgentTeamSubscriptionState` 的 `deleted` | delete | 终态门禁 | live |

**产出：** 一张“状态 → 写入 → 读取 → 判定 → 建议”的表。dead 状态要么删，要么写清为什么保留。

## 切片 4：跨 surface 一致性

**问题：** 同一个事实，Thread、Inbox、名册、设置页、工具结果、Client 列表会不会读出不同结果？

**范围：** Worker 状态、grant 生效、unread/read、订阅状态、Member presence/capability、Task 状态。

**方法：**

1. 选一个事实，列出所有读取方。
2. 对每个读取方，记录它读的是 ledger、live registry、settings 还是本地缓存。
3. 比较同一时刻的投影；找“两个 surface 可以同时为真但含义不同”的组合。

**候选发现：**

| 事实 | surfaces | 当前关系 | 缺口 |
| --- | --- | --- | --- |
| Worker 运行状态 | Thread `workerStates`、Human `workerRuns`、`team_worker inspect`、Inbox notice | 都读 ledger；live 只用于 `stopping`/`unconfirmed` | 结算写失败时 live 终态不展示 |
| grant 生效 | 设置页 committed、roster `capabilityState`、Member schema、prompt 段 | 设置页读 Host row；roster 读 capabilities；schema 读冻结 grants | roster 可能显示 applied 而 grant 未生效 |
| unread | Thread read、Inbox badge、Main stream、surface 豁免 | 都读 ledger；豁免不写水位 | 需要确认没有第二条“已读”路径 |
| 订阅状态 | 卡片 state、run history、failed delivery、trigger/webhook | 卡片读 projection；run/delivery 读私有表 | paused 与“撤 trigger”/“禁用入口”的文案区分 |
| Member 可用性 | roster presence、Session binding、capabilityState | presence 读 live handle；binding 读 ledger | rollover 窗口的 `unavailable` |
| Task 状态 | status、resolution、claims、activity | status 派生；resolution 权威 | 已由 10 统一 |

**产出：** 一张“事实 → surfaces → 当前关系 → 缺口”的表。优先修“两个 surface 同时显示不同结论”的组合。

## 切片 5：取消与晚到结果

**问题：** 每个 await 跨过了哪个状态变化？回来之后有没有重读权威？晚到结果会不会覆盖更新的状态？

**范围：** Worker start/stop/steer/continue/dispose、压缩主/备用摘要、有界读取容量、Client query/change stream/thread controller/timeline、订阅 publish/retry/replay、生命周期链/turn boundary/inbox delivery。

**方法：**

1. 对每个异步流程，标出 await 前后的状态读取。
2. 检查 await 后是否重新读取权威（ledger、live handle、revision、signal）。
3. 检查晚到结果的守卫（mounted、generation、issuance、sealed、terminal gate）。

**候选发现：**

| 流程 | await 跨过的状态 | 回来后重读？ | 晚到守卫 | 缺口 |
| --- | --- | --- | --- | --- |
| Worker start | 开关/owner/引擎 → 打开记录 → 引擎启动 | 有 `assertAdmitted`、`sealed` | `sealed`、`stopping` | 需要确认每个 await 边界 |
| Worker stop | 启动信号 → dispose → terminated | 有 `entry.terminated` | `cleanupUnconfirmed` | 10s/5s 两个截止 |
| Worker steer | admission → 原生投递 → outcome | 有 `held`/`stopped` 检查 | `steeringByRequest`/`Text` | 需要确认卸载窗口 |
| 压缩 | primary → alternative → clamp | 有 route/abort 检查 | `aborted` | 已修 alternative cancellation |
| 有界读取 | 容量 → 预览 → 确认 | 有 `signal.throwIfAborted()` | 取消 reason | 已修 |
| Client query | 读取 → resolve | 有 issuance/generation | 晚到丢弃 | 需要确认新面 |
| 订阅 publish | accepted → 限流 → published | 有 writable 检查 | 终态门禁 | 需要确认 |
| 生命周期链 | 前序 → 当前 → 后序 | 有 tail/ALS | 失败不毒尾 | 需要确认新面 |

**产出：** 一张“流程 → await → 重读 → 守卫 → 缺口”的表。

## 切片 6：UX/AX 拒绝与列表状态

**问题：** 每个拒绝、每个列表、每个对话框：用户/Agent 能不能据此行动？

**范围：** 工具拒绝码、Remote 错误、设置冲突、订阅卡、Worker 行、Inbox/Board/Projects/Agents/Thread/Main 列表、创建/编辑/删除/停止/诊断对话框。

**方法：**

1. 枚举拒绝码（`recovery-hints.ts`、`WorkerRefusal`、Remote error codes）。
2. 检查每个是否有稳定 code、下一步、稳定 ref、可执行恢复。
3. 枚举列表，检查 loading/error/empty/partial/旧值失败。
4. 枚举对话框，检查 pending/conflict/close/focus。

**候选发现：**

| 面 | 当前 | 缺口 |
| --- | --- | --- |
| 工具拒绝 | 稳定 code + recovery hint | 新 `team_worker` 拒绝是否都覆盖？ |
| 设置冲突 | draft + latest committed + 确认 | 新 grants/Worker 设置是否复用？ |
| 订阅卡 | 单卡 pending + 失败 | paused/trigger/disabled 文案 |
| Worker 行 | 五行窗口 + 诊断入口 | `unconfirmed` 原因不区分 |
| 列表 | 多数区分 loading/error/empty | 新 Worker/grants 面是否一致？ |
| 对话框 | 公共 Menu/Modal | 新停止/诊断是否复用焦点/Escape？ |

**产出：** 一张“面 → 当前状态 → 缺口”的表。

## 执行顺序

1. **切片 4（跨 surface 一致性）+ 切片 1（失败可见性）**：UX/AX 最贵，且最容易在静态阅读中漏掉。先做这两个，能直接回答“用户看到的到底是不是真的”。
2. **切片 2（重启恢复）+ 切片 5（取消/晚到）**：恢复风险最高，但需要更多故障注入；放在第二。
3. **切片 3（生产者/消费者）**：DX 收益高、修复小；可以并行做。
4. **切片 6（拒绝/列表）**：范围最广，但多数已有测试；最后做，作为收口。

每个切片的完成标准：

- 地图覆盖该切片的全部 owner；
- 每个候选发现都有证据等级；
- 至少一个候选在真实入口验证（复现或排除）；
- 需要修的进入 ticket，不需要修的写清理由；
- 不引入新框架、不新增平行权威。

## 不建议做的事

- 不要重审第一轮的 10 张票；它们已经验收。
- 不要改写归档材料；它是历史。
- 不要因为“新面有文档”就假设它没有问题；文档描述意图，代码才是行为。
- 不要把所有发现塞进一张“大扫除”票；它们的 owner、风险和验收方式不同。
- 不要为了“更显式”把现有深 module 拆成通用 FSM/actor；第一轮的结论继续有效。
