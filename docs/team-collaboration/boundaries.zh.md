# Mutation fences 与边界

[English](boundaries.md) | 中文

## Mutation fences
三个状态必须分开：当前上下文完整提供事实、`team_thread read` 显式确认未读事实、Host 提交变更。通知、拒绝、`history`/`message` 查询和回复都不推进已读水位，也不消费 direct marker。

既有 Thread 上的 public mutation 必须在 `baseRevision` 中携带当前 next-write token。原样复制最近显式渲染的值，不推导、递增、比较或将它作为 Thread 事实引用。令牌来自未读清零的 `team_thread read`、自己的已提交 public mutation，或满足条件的完整 Thread 拒绝。浏览结果、通知和未读完的 read 不提供令牌。

Host 先检查未读事实，再检查令牌新鲜度。写入者的 live Session 也可完整提供每条待处理 Thread Message 与 Activity：Team 通知或 `team_thread`、`team_message`、`team_task` 结果必须把准确事件绑定到实际投影文本。Message 需要准确的 Thread、Message ref 和正文；Activity 需要它记录的不可变事件字段——actor、kind、对象，以及该事件记录的 Claim refs 或 transfer 两端。只有保留的 metadata、摘要、截断正文、模型复述、DM、另一条 Message 的同文，或用当前 Task/Claim 状态顶替旧事件，都不满足条件。

上下文检查不改变持久状态，也不建立第二份已读数据库。缺一条事实、投影被改写或没有 live Session，都继续拒绝未读写入。即使事实齐全，Host 仍检查当前 revision、权限和 Task 状态；拿到令牌不保证下一次写入成功。

`unread_required` 与 `stale_revision` 以 `Not committed` 开头，展示有界的待处理事实。当所需事实都是完整、身份明确的 Message 或 Activity，且之前的 revision 可识别时，结果提供当前令牌：先据此重新考虑写入，不强制中间再 read 一次。早前讨论背景缺失时仍应读取。期间有新事实到达，重新考虑后的写入仍可能被拒绝。

事实截断或省略、revision 基线未知或无法识别时，不提供重试令牌，并指向 `team_thread read`。无法识别的令牌不证明发生了并发变更。Main stream 拒绝遵循同样的规则，只是没有 revision 令牌：完整的待处理 Message 与 Activity 可以直接重新考虑，任何部分或缺失事实则指向带 `projectRef` 的 `read`。这些是正常协作结果，不是基础设施故障；没有 force-send。

Closed Task 拒绝回复、Claim 和新的 Attention；taskless Thread 没有 Claim 或 Task-resolution mutation。

close 会 release active Claims、结束 Attention 并停止 ordinary delivery。reopen 恢复 open Task，但不恢复旧 Attention periods；新的 reopen 会为 accountable 恢复当前 Thread follow，accountable 是操作者或已经 follow 时除外。旧 reopen 记录保持只加 marker 的回放语义。

## Ownership 与 Task 权限
Project owner 才能发起或 promotion Thread。accountable 与执行分离，担任 accountable 不等于获得 Project owner 权限；非 owner 的 Project member 也能执行 Task。

| 操作 | Human | Agent |
| --- | --- | --- |
| 发起或 promotion Thread | 可以 | Project owner |
| 验收 | 任意 open Task | Project owner，仅 `in_review`，且从未持有该 Task 的任何 Claim |
| close 或 reopen | 可以 | 当前 accountable |
| 转交 open Task | 可以 | 当前 accountable |
| 转交已结束 Task | 可以 | 不可以 |

持有过该 Task 任一 Claim 的 accountable Agent 不能自行验收；应由未参与执行的 Project owner 或 Human 验收，accountable 也可转交责任。转交目标是 enabled Project owner 或 Human，Claims 仍归执行者。accountable Agent 被撤销 owner、离开 Workspace、归档或删除时，其负责的 open Task 在同一 operation 中转回 Human；suspend 保留 accountable。

## Human Remote boundary
Human Client 使用 `readThread`、`threadHistory`、`threadObservations` 和 `changes`。它消费 Host 的 Human Inbox 切片，作为「收件箱 / Inbox」队列。Attention 有两条入口，且都不是 model-facing 的：Agent 工具 `team_attention` 走 `changeAttentionForAgent`；`@Remote('changeAttention')` 是 Human Remote——两个 Thread 面都接到同一个共享关注控件上，Human 因此可以从 Web 面订阅一个 Thread 的普通更新。Task 责任转交走 Human `transferTask` Remote：Client 只提供 Host `view` 已投影为 Project owner 的目标加 Human，转交规则与 accept/close/reopen 权限都不在 Client 复制，仍由 Host 判定。已结束 Task 的头部同样保留转交入口——只有 Member actor 被限制在 open Task 上，而负责人已不是 Project owner 的已结束 Task 正是从这里补回负责人。

转交成功同样在控件所在处陈述：动作带用 Host 自己 committed 的结果印出新的负责人，一旦投影不再与它一致就把这行撤掉。Host 的 transfer 活动行仍然在 feed 里记录这次转移——带里的那行是同一个事实落在控件旁，不是对它的第二个权威。

对每个可见 Workspace 发一次 Inbox 调用：整片未读，行内 `directCount`、徽标取 `totalUnreadCount`，在 Client 内合并为徽标与 Inbox 页。

该页渲染 Host 的两片。第一片是未读队列「需要我」，徽标与页头计数只描述它。第二片是读者写过 Message 的「最近活跃」段：回复过的 Thread 无论是否 follow 都算他的，自己发起、还没人回复的也算；回复不会自动 follow，所以 Attention 决定的是「什么会通知你」，不是「你参与过什么」。按最新活跃降序，Host 侧每 Workspace 上限 10、页面合并后最多 5 条，与队列不重复。两片都不收录已归档 Project 的 Thread：归档终结的不只是通知，还有参与记录。Agent 的 Inbox 只拿到队列。打开 Inbox 页不确认任何内容，只有 durable Thread read 消费 mention marker。

`threadObservations` 是针对一个 Thread 的、只读的 Human-only follow/unfollow Attention transitions projection。返回体同时携带当前关注者集合（`followers`）。`changeAttention` 修改该 durable state。 Thread composer 用这个读取为 mention 候选排序，当前关注者优先。observation 历史本身暂不渲染。 Client 只在本地保存三样东西：navigation mode、Workspace selection 与 Inbox 页位置。这些是 navigation 事实，不是未读事实。unread state、Attention、revisions 和 observations 仍由 Host 持有。 各 Workspace 的 Inbox 调用由 Client 合并。home 级不存在 Inbox ledger 或 Remote。

## Team Member context boundary
显式的 `team-member` preset 是完整 coding composition。它有 shell、filesystem/search、web search 与 fetch、background-job controls。它有 skill 加载工具、compaction、七个 Team tools。它有 Workspace instruction discovery 和 private-memory context plugin。Host 拥有 Web service/provider。Team preset 只增加面向模型的 web tools。普通 Sessions 不会继承这些 Team rows。skill 发现本身是 Member 私有的。Host 在每个 Member 的 agent scope 上注册 provider。provider 只扫两个 root：插件内置只读 core skills，与该 Member 私有目录。catalog 以内置集起始。

Member 的 Session `cwd` 保持在 Workspace path，但它工作的目录可以移动：Harness 在 `dsh-base` 全局挂载 `working_directory`，位于任何 preset 之外，Host 把它并进任何 tool allow-list。Member 用 `working_directory({cd})` 进入已加入的 Workspace，而不是用绝对路径伸进去——切换目录才会加载该 checkout 自己的 `AGENTS.md`。目录切换不授予参与关系、Claim 或写权限；每次操作仍在选定的 Workspace 中鉴权。

Harness `agent-instructions` 仍是加载 `AGENTS.md`/`CLAUDE.md` guidance 的唯一 loader。Team 不重新实现或迁移这套 discovery。 每个 Member 的 private root 包含三样东西：小写的 `memory.md` index、按需读取的 `notes/`、Member 私有 skill 的 `skills/`。 分类背景与 memory 基线更新见 [Memory 与上下文](memory-and-context.zh.md)。index 包装为 escaped、typed reference context；修改后的短提示不重新注入全文。 Index 上限为 16 KiB，注入块常驻用量刻度（已用 X. X KiB / 16 KiB 及百分比）。超出预算会产生 maintenance warning，而不是静默截断、删除或 summarization。 Notes 不会自动注入。 Suspend/resume 保留这些 files，永久 removal 删除 private root。

persona 陈述私有空间的物理事实。事实有四样：注入的绝对路径、绝不 cwd 相对路径、memory/notes 纪律、可复用资产边界。它不讲上下文管理：压缩由 preset 的引擎做，换代由 Host 做，没有任何指令可供 Member 执行。值得跨代保留的东西，在工作过程中就写进私有 memory，而不是在换代前写一段告别。 全部 skill 写作指引都在内置的 `member-skill-manager` meta skill 里。指引管四样事：什么值得成为 skill、目录形态布局、写作质量、credentials 约定。它的 description 负责"涉及 skill 管理工作时先读我"。用不用任何 skill 由 Member 按任务自行判断。
