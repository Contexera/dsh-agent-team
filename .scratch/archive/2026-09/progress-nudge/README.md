# 进度可见性 nudge（progress nudge）

状态：**已完成并归档**。生产实现已落地（`packages/agent-team/src/progress-nudge.ts`、ledger `progressNudgeTargets`、Host 接线与测试），行为同步至 `docs/architecture(.zh).md` 与 `docs/team-collaboration(.zh).md`。
最后核对日期：2026-09-05
源头：Roadmap channel thread（task:f6971666-2b73-4e07-b10d-2ffa39e38993）；生产实现 task:cd2a886a-07a7-4dd9-a94f-d34ce33a88ca
当前去向：实现细节以源码与测试为准；本目录保留决策快照与设计过程。实现相对设计的一处修正见 spec 末尾附记（scoped listener 改为 root listener + 延迟 steer）。

## 需求快照（human 原话，rev 6464 / 6578 / 6812）

1. **Nudge-A**（原需求一）：agent 在 task 中没有任何 claim/message 回复时，每过 10 个 tool_call 额外注入 prompt 让其去对应 thread 说明。taskless thread 也算。
   - rev 6812 修订：计数阈值 20 起步，40、60 递增；触发对象 A（有 active claim 的 Member）。当时的“任意触及 thread 即重置”口径后来收窄为下表的公开沟通集合。
2. **Nudge-B**（原需求二）：task thread 中参与的 agent 如果没 claim 过 task，超过 5 个 tool call 时注入说明（避免 task 状态一直待处理）。
   - rev 6812 修订：只提醒一次；引导动作不硬（prompt 带一下即可）；只对参与讨论（已 follow）的 agent 有效。

## 已拍板决策（rev 6812）

| 决策点 | 结论 |
|---|---|
| Nudge-A 触发对象 | A：有 active Claim 的 Member |
| Nudge-A 阈值 | 20 起步，之后 40、60…递增（+20 步进） |
| 计数重置 | Member 成功提交公开沟通：message/reply/claim/done/release；read、follow/unfollow、DM 与失败调用不重置 |
| Nudge-B 频次 | 当前 Member Session 内 per-(member, thread) 只提醒一次；Host 重启与 suspend/resume 保持，Human 主动新建上下文后可重新提醒 |
| Nudge-B 对象 | 已 follow、Task 仍为 `todo`、且该 Member 从未 Claim 过该 Task |
| Nudge-B 文案 | 引导但不硬性（prompt 带一下 team_claim 即可） |
| 硬约束 | 不改 dsh 源码 ✅（session/event + tool/call 事件 + agent.steer 全是公开扩展点） |

## rev 6935 后追加锁定

| 决策点 | 结论 |
|---|---|
| 计数器粒度 | per-Member 单计数器（human 确认"可以"） |
| subagent 盲区 | 撤销——member 没有 subagent（human 确认） |
| taskless 口径 | a：taskful 按 active Claim；taskless 按当前 follower |
| 重置集 | 仅公开沟通动作 {message-sent, thread-replied, claim-created/done/released}；read、follow/unfollow 与 DM 不重置；失败调用（无 commit）不重置 |
| 多 Thread 输出 | 每 Member 每次阈值合并为一条 notice，正文逐 Thread 列出 |
| Nudge-B Task 状态 | 只催仍为 `todo` 的 Task；in_progress/in_review/done/closed 均不催 |

预期效果三场景（claim 者阶梯提醒 / 围观者一次性提醒 / channel 可见性改善）已发 human，rev 6937。

## 已核实的机制原料（2026-09-05）

- 观测：`session/event`（post-commit firehose，`packages/core/session/src/index.ts:74`）；`tool/call` 事件 `{ turn, step, callId, name, arguments }`（session types.ts:306）。
- 注入：三个既有 nudge 先例（notifyMember / steerResume / steerPreCompaction）都是 `agent.steer` + `createUserMessage` plugin notice，同族第四个。
- Task 状态根因：`deriveTaskStatus`（ledger.ts:2660）无 active claim 恒为 'todo'。
- 触发对象/关注者：`attentionByThread` + `claimsForTask` 均已在 ledger projection 中。

## 当前前沿

已完结。设计阶段的推荐方向（`ProgressNudgeCoordinator` + `emitCommitted()` 重置/校正 + ledger 只读 `progressNudgeTargets(memberId)` 查询）已按 spec 落地为生产实现（commit `32bf407` 及后续审查修复）；两处与设计稿的实证差异见 `spec.md` 末尾实现附记。

## 结束条件

- 将已确认设计交给生产实现者。✅ 已完成。
- 实现完成后把稳定 Host 行为同步到 `docs/architecture/README.md` 与 `docs/team-collaboration/README.md`（中英双份）。✅ 已完成。

## 正式文档出口

`docs/architecture(.zh).md` Host authority 节与 `docs/team-collaboration(.zh).md` Progress-visibility nudges 节已记录稳定行为；本工作项保留决策快照与实现附记。
