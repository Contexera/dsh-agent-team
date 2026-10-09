# 初始审查：状态机、数据请求与诊断日志

## 基线与范围

- 日期：2026-10-09；仓库基线：`8b4a066c`；审查开始时工作区干净。
- 来源：本轮只读代码审查、已有测试、实际 Ledger 调用、Host 故障注入、Client 交错响应实验和 logger exporter 捕获。
- 范围：Team 账本与派生状态、Member 配置及生命周期、Client 变化订阅与读取、提交后通知及运行诊断。
- 未修改生产代码，未访问生产账本或调用付费模型，未执行真实浏览器验收。规模数据是合成样本，不能当成生产延迟或容量承诺。

## 已有设计中应保留的部分

- 账本是业务事实的唯一来源；Task 状态由 Claim 与人工 resolution 推导。
- Member 持久状态与运行状态分开；生命周期与 Session 转换已经具备部分重启补做能力。
- Host 保有权限、revision 与请求幂等检查；提交后通知失败不伪装成业务回滚。
- Session 投影已增量维护；相同范围的变化订阅共享传输，presence 不唤醒共享 Inbox。
- 空 Thread 读取不提交，当前读取记录保存进度回执，而非复制整份 Thread 内容。早期审查中的胖读取记录问题不能继续列为待办。

## 发现与证据

| 编号 | 问题 | 观察结果 | 证据状态 | 对应 ticket |
| --- | --- | --- | --- | --- |
| S1 | 配置提交与实际应用没有统一的完成判断 | 能力配置提交后，注入一次工具限制应用失败；同 requestId 重试未再次应用，仍返回 `active`、无 diagnostic，实际可见工具与新配置不一致 | 故障注入复现 | 01 |
| S2 | 全局生命周期队列包含 Member 的长时等待 | A 的能力编辑等待回合结束时，B 的暂停也未执行；释放 A 后两者才完成 | 并发实验复现；现有串行约定，不是偶发竞态 | 02 |
| D1 | `view` 的分页不限制附带目录 | `limit: 1` 仍返回全部可见 Task、Thread、Claim 与活跃任务；这是当前接口语义，但不符合只需目录或一页消息的调用成本 | 真实 Ledger 合成样本 | 04 |
| D2 | 活跃任务逐个扫描全局 Claim | 100 / 1,000 个活跃任务时，仅按 Task 获取 Claim 的元素检查数为 10,100 / 1,001,000 | 代码核对与计数实验；未包含其他扫描成本 | 04 |
| D3 | 范围订阅共享，但后续读取仍分散 | 打开 Thread 后一次 presence 通知产生 2 次 `members` 和 1 次 `view`；Inbox、history 和 readThread 不变 | Client 组件实验复现 | 03、04 |
| D4 | 成员列表读取缺少过期响应保护 | 第二次请求的新结果先显示；第一次请求随后返回，旧列表覆盖了新列表 | Client 交错响应实验复现 | 03 |
| L1 | 提交后失败日志缺少业务关联标识 | exporter 捕获到阶段与错误文字，但没有该操作已知的 requestId / operationId | 实际日志捕获 | 01、05 |
| V1 | 测试通过并不代表渲染没有异常 | 312 项定向测试通过，但输出中出现 34 次 Harness renderer `WeakMap` TypeError | 原因未查明；不是生产 UI 故障定论 | 03、06 |

### 代码定位

以下行号仅对应上述基线；接续时以当前源码为准。

- S1：[`updateMember` 与能力应用](../../../../../packages/agent-team/src/index.ts#L1514)、[`MemberRuntime` 工具限制替换](../../../../../packages/agent-team/src/member-runtime.ts#L164)。提交前后的配置比较决定是否应用，无法证明上一次效果已成功。
- S2：[`enqueueLifecycle`](../../../../../packages/agent-team/src/index.ts#L3550)、[`awaitTurnBoundary`](../../../../../packages/agent-team/src/member-runtime.ts#L192)。全局队列的任务包含等待 Member 回合结束的过程。
- D1/D2：[`view`](../../../../../packages/agent-team/src/ledger.ts#L1823)、[`claimsForTaskFrom`](../../../../../packages/agent-team/src/ledger.ts#L3566)、[`activeTaskThreads`](../../../../../packages/agent-team/src/ledger.ts#L3590)。
- D3/D4：[`TeamAgentsPanel` 刷新](../../../../../packages/client-agent-team/src/client/TeamAgentsPanel.tsx#L129)、[`TeamThreadPage` supplemental 读取](../../../../../packages/client-agent-team/src/client/TeamThreadPage.tsx#L224)、[`TeamWorkspaceBrowser` Inbox 摘要读取](../../../../../packages/client-agent-team/src/client/TeamWorkspaceBrowser.tsx#L61)。范围共享本身由 [`TeamChangeStream`](../../../../../packages/client-agent-team/src/client/team-changes.ts) 提供，不能据此假定查询也已共享。
- L1：[`emitCommitted` / `afterCommit`](../../../../../packages/agent-team/src/index.ts#L3232)。另有 [`RecoveryCoordinator`](../../../../../packages/agent-team/src/recovery.ts#L130) 捕获 wake 异常后停止跟踪的路径，后续需验证能否说明停止原因。
- 规模验收还需检查 [`invariant`](../../../../../packages/agent-team/src/invariant.ts#L58)：提交合并后仍在同一进程执行全量账本校验。延后执行不是减少 CPU；是否构成目标负载瓶颈尚未确定，不据此直接删除独立校验或引入快照。

## 实验输入与结果

### 配置应用失败

建立一个只允许 `ordinary_tool` 的真实测试 Member；把新配置改为只允许 `spare_tool`，令底层 `tools.restrict` 第一次调用失败，再以原请求重试。结果：新配置已记录，但运行时仍同时暴露这两个普通工具；限制应用调用只有一次，重试返回 `active` 且无 diagnostic。Team 必需工具仍存在。

该实验验证重试漏做效果，不说明生产环境中该失败的发生频率。后续还应覆盖 skills 与其他实际具有运行效果的配置，不能仅修测试中的工具名字。

### 跨 Member 等待

以受控模型适配器保持 A 的回合运行，提交 A 的能力编辑，再请求暂停空闲 B。等待 50 ms 后 B 仍为 enabled、暂停未完成；释放 A 后编辑和 B 的暂停均完成。50 ms 只是观察窗口，不是建议的响应 SLA。

### 读取成本

通过真实 Ledger 方法构造一个 Workspace、一个 Channel、一个 Agent Member；每个 Task 有一个顶层 Message 和一个 active Claim。存储使用内存表，不包含 SQLite、HTTP、压缩、网络和 React 渲染成本。

| 活跃 Task 数 | 请求消息数 | 返回消息数 | 返回 Task / Thread / Claim / 活跃任务数（各自） | JSON 字节（压缩前） | 按 Task 取 Claim 的元素检查数 |
| --- | --- | --- | --- | --- | --- |
| 100 | 1 | 1 | 100 | 103,918 | 10,100 |
| 1,000 | 1 | 1 | 1,000 | 1,033,222 | 1,001,000 |

结果在保留到本机工作目录后重新运行一致。单次耗时易受运行环境影响，仅保留于原始输出，不作为验收阈值。尚未覆盖大量历史但少量活跃任务、多 Workspace、长 Thread 和多 Member 同时通知等负载。

### Client 与日志

- 打开一个已存在的 Thread，等待初始读取稳定，再单独发布 presence 通知；读取差量为 `members=2`、`view=1`，其余相关读取为零。
- 仅打开 Workspace 列表，通过两次 presence 通知触发成员列表读取；让新响应先返回，再返回旧响应，验证旧内容确实重新显示。
- 注册 Cordis logger exporter 和一个会抛错的提交监听者，再创建 Channel。账本返回成功回执，而日志为 `agent-team: post-commit commit listener dispatch failed: listener unavailable (probe)`；未带该回执的请求和操作标识。

## 验证范围与复跑

已有定向检查：11 个测试文件、312 项测试通过。覆盖操作协议、Member 生命周期与工具策略、提交后通知、投影索引、变化范围、恢复、Client change stream、presence、渲染隔离和对话流程。

额外实验：2 个临时测试文件、5 项实验通过；这些实验断言的是上述现状，**通过表示问题被复现，不表示缺陷已解决**。进入实现时应为目标行为建立正式回归测试，而不是直接复制现状断言。

原始脚本、JSON 和日志保存在本机 Git 忽略目录 `.scratch/local/state-requests-diagnostics/2026-10-09/`，不随工作项提交。已把原 `/tmp` 脚本的实验路径改为该本机目录，并重新运行 Ledger 样本与全部 5 项实验。

从仓库根目录本机复跑：

```sh
node --import tsx .scratch/local/state-requests-diagnostics/2026-10-09/ledger-probe.mjs
node node_modules/vitest/vitest.mjs run --config .scratch/local/state-requests-diagnostics/2026-10-09/vitest.config.mts
```

新 checkout 没有本机目录时，根据上面的输入与故障步骤重新构造实验；正式验证命令以 [开发检查指南](../../../../../docs/development/start-and-checks.md) 和仓库配置为准。V1 的原始输出在本机 `baseline-tests.log`；在原因查明并验证前，不能写“完整 UI 验收通过”。

## 设计参考与适用边界

- [Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)：借鉴期望状态、实际状态与重复执行补齐效果的分工；不引入集群控制基础设施。
- [TanStack Query — Query Keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys)：借鉴按数据参数确定查询身份；是否采用依赖尚未决定，先检查 Harness 现有能力。
- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)：借鉴稳定事件、关联字段、时间与错误数据的组织；优先复用 Cordis logger，不新增业务账本或日志平台。

以上资料在 2026-10-09 阅读，仅为方案参考，不代表项目已经采用相应产品。

## 独立复核补录（2026-10-09，两位复核者分别独立执行）

- 读数复现：本节「读取成本」表在同基线被独立复跑，103,918 / 1,033,222 字节与 10,100 / 1,001,000 元素检查一字不差；5 项现状探针重跑全绿（绿 = 现状被复现，不是缺陷已解决）。
- **新发现 A（升级 S1）：应用失败会撑宽工具面。** `reapplyMemberToolPolicy` 先释放旧限制再装新限制，新限制装失败时成员停在无限制状态——`allow=[ordinary_tool]` 收紧到 `[spare_tool]` 的应用失败后，可见工具从 10 变 11（旧、新并存），同 requestId 重试仍返回 `active` 且无 diagnostic，应用调用全程只发生 1 次。含义从「配置没生效」升级为「想收紧权限、失败反而更宽」；已落为 01 的原子应用与不得更宽验收条件。
- **新发现 B（因果与口径经判定实验更正）：线程定向读取在匹配数不足时是稳态全账走查。** `after` 方向从序列头逐条收，收满 `limit+1` 条匹配才 break；目标 Thread 的匹配事实 ≤ `limit` 时永远收不满 ⇒ **每次读都走完整本账，与命中位置无关**（判定实验：命中排在序列最前的 1 条消息 Thread 走完 103 / 1,003 条（100 / 1,000 任务样本），同位置的 2 条消息 Thread 只走 3 条）。一般式：走查成本 = 该 Thread 第 `limit+1` 条匹配事实在全局序列中的位置；不足 `limit+1` 条时 = 整本账。Thread 页补充读取正是 `limit:1`，单条开口的 Thread 每读必扫全账，这是稳态而非最坏情况。计数口径：`channelRefForThread` 有目录过滤（每 Thread 一次）与 `matches` 谓词（每事实一次）两个调用点，必须分量记账——100 / 1,000 任务下线程定向 `limit:1`（1 条消息 Thread）为目录过滤 101 / 1,001、事实走查 103 / 1,003（合计 204 / 2,004；先前报的 301 / 3,001 是另一组样本的**混合合计**，不能当分量用）。修法方向：`factsByThread` 已是随追加维护、随投影重建的按 Thread 索引（ledger.ts:2999-3018，已有三处在读），线程定向读取改走该索引即从 O(账本) 降到 O(该 Thread)，无需新索引、不引入新权威；谓词内按事实的频道判定可由已有的 `channelRefByThread`（ledger.ts:413）消去。复跑：`.scratch/local/state-requests-diagnostics/2026-10-09/vera-sparsity-probe.mjs` 与 `vera-scoped-read-probe.mjs`。已按此更正 04 的记账验收条件。
- 06 输入：提交后同进程全量账本校验 5.76 ms → 51.98 ms（任务数 ×10、耗时 ×9）。
