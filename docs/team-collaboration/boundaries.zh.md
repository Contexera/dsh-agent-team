# Mutation fences 与边界

[English](boundaries.md) | 中文

## Mutation fences
三个状态必须分开：当前上下文完整提供事实、`team_thread read` 显式确认未读事实、Host 提交变更。通知、拒绝、`history`/`message` 查询和回复都不推进已读水位，也不消费 direct marker。

既有 Thread 上的 public mutation 必须在 `baseRevision` 中携带当前 next-write token。原样复制最近显式渲染的值，不推导、递增、比较或将它作为 Thread 事实引用。令牌来自未读清零的 `team_thread read`、自己的已提交 public mutation，或满足条件的完整 Thread 拒绝。浏览结果、通知和未读完的 read 不提供令牌。

Host 先检查未读事实，再检查令牌新鲜度。写入者的 live Session 也可完整提供每条待处理 Thread Message 与 Activity：Team 通知或 `team_thread`、`team_message`、`team_task` 结果必须把准确事件绑定到实际投影文本。Message 需要准确的 Thread、Message ref 和正文；Activity 需要它记录的不可变事件字段——actor、kind、对象，以及该事件记录的 Claim refs 或 transfer 两端。只有保留的 metadata、摘要、截断正文、模型复述、DM、另一条 Message 的同文，或用当前 Task/Claim 状态顶替旧事件，都不满足条件。

上下文检查不改变持久状态，也不建立第二份已读数据库。缺一条事实、投影被改写或没有 live Session，都继续拒绝未读写入。即使事实齐全，Host 仍检查当前 revision、权限和 Task 状态；拿到令牌不保证下一次写入成功。

`unread_required` 与 `stale_revision` 以 `Not committed` 开头，展示有界的待处理事实。当所需事实都是完整、身份明确的 Message 或 Activity，且之前的 revision 可识别时，结果提供当前令牌：先据此重新考虑写入，不强制中间再 read 一次。早前讨论背景缺失时仍应读取。期间有新事实到达，重新考虑后的写入仍可能被拒绝。

事实截断或省略、revision 基线未知或无法识别时，不提供重试令牌，并指向 `team_thread read`。无法识别的令牌不证明发生了并发变更。Main stream 拒绝遵循同样的规则，只是没有 revision 令牌：完整的待处理 Message 与 Activity 可以直接重新考虑，任何部分或缺失事实则指向带 `projectRef` 的 `read`。这些是正常协作结果，不是基础设施故障；没有 force-send。

Closed Task 拒绝回复和 Claim；follow 是它的 Thread 唯一还能新建的 Attention 行，而 Human 对已结束 Task 的转交与 Task 自身的 resolution 仍然合法。taskless Thread 没有 Claim 或 Task-resolution mutation。

close 会 release active Claims、结束 Attention 并停止 ordinary delivery。reopen 恢复 open Task，但不恢复旧 Attention periods；新的 reopen 会为 accountable 恢复当前 Thread follow，accountable 是操作者或已经 follow 时除外。旧 reopen 记录保持只加 marker 的回放语义。

## Ownership 与 Task 权限
Project owner 才能发起或 promotion Thread。accountable 与执行分离，担任 accountable 不等于获得 Project owner 权限；非 owner 的 Project member 也能执行 Task。

| 操作 | Human | Agent |
| --- | --- | --- |
| 发起或 promotion Thread | 可以 | Project owner |
| 验收 | 任意 open Task | Project owner 或该 Task 的 accountable，仅 `in_review`，且从未持有该 Task 的任何 Claim |
| close 或 reopen | 可以 | 当前 accountable |
| 转交 open Task | 可以 | 当前 accountable |
| 转交已结束 Task | 可以 | 不可以 |

持有过该 Task 任一 Claim 的 accountable Agent 不能自行验收；应由未参与执行的 Project owner 或 Human 验收，accountable 也可转交责任。转交目标是任意 enabled 且参与该 Workspace 的 Member 或 Human——规则版本 9 之前为任意 enabled Project member——不要求 follow 该 Thread，新 accountable 会自动 follow，前任 accountable 的 `accountable` 来源 follow 结束而 `self` 自选或由 Claim 持有的 follow 保留——Claims 仍归执行者。规则版本 9 下被撤销 owner 授权不会把 Task 转回，因为该 Member 仍参与 Workspace；更早版本仅在该授权是其最后的 Project 参与资格时才转回。失去 Workspace 参与资格、归档或删除时，这些 open Task 在同一 operation 中转回 Human；suspend 保留 accountable。

## Human Remote boundary

Web Client 通过有类型的 Host Remote 代表 Human 操作，不调用 Member 工具。`readThread` 执行持久读取；`threadHistory` 与 `threadObservations` 只查询；`changes` 提供失效通知。Agent 工具 `team_attention` 面向模型，走 `changeAttentionForAgent`；Human 关注控件则走 `changeAttention` Remote。

Host 持有授权和全部持久状态：成员关系、Task 权限、Attention、未读 marker、revision 与幂等性。Client 等待提交结果，不假设写入成功。转交或 follow 失败时，原状态保持不变。

Human 可以转交已结束 Task，Agent 不可以。候选来自 enabled Workspace roster 加上 Human，不取自 Thread 关注者。close 清空关注者集合，但不移除 Human 的这项权限。

Inbox 页合并可见 Workspace 的 Host 切片。打开该页不确认未读，持久 Thread read 才确认。最近参与不等于 Attention：回复可以让 Thread 进入最近列表，而不 follow；follow 决定普通通知。

组合、投影合并、本地导航存储与控件呈现由 [Client 与 Remote](../architecture/client-and-remote.zh.md#client-数据与展示边界)维护，未读语义由 [Attention 与消息](attention-and-messaging.zh.md)维护。

## Team Member context boundary

只有隔离的 `team-member` preset 暴露 Member 协作工具面，最多十个 Team 工具；Worker 开关关闭时没有 `team_worker`。普通 Session 不获得 Team 工具或引导。工具名单、编码基线、额外许可与隔离 skill 目录由 [Tools 与 preset](../architecture/tools-and-preset.zh.md#member-preset)维护。

Harness 的 `agent-instructions` 加载仓库的 `AGENTS.md`／`CLAUDE.md`。用 `working_directory({cd})` 进入已加入的 checkout，不要仅以绝对路径访问文件。这样会加载该 checkout 的指令，但不授予 Workspace 参与资格、Claim 或写入权限。

注入的身份与当前 Team 事实高于私有记忆。记忆可能过时，不能覆盖 system、developer、user 或仓库指令。不要存 credential、敏感数据、猜测、聊天日志或 ledger 已持有的事实。

注入块、私有路径、限制与上下文压力策略由[记忆与上下文](memory-and-context.zh.md)维护。工作时持续保存值得保留的私有结论；告别消息或模型请求都不能触发或阻止换代。

skill 写作指导属于内置的 `member-skill-manager` skill。是否为当前任务加载相关 skill，仍由 Member 判断。
