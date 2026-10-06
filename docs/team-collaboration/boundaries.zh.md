# Mutation fences 与边界

[English](boundaries.md) | 中文

## Mutation fences
既有 Thread 上的 public mutation 必须在 `baseRevision` 中携带当前的 next-write token。它是不透明的 copy-through 值，不是关于 Thread 的事实：模型原样复制最近一次显式渲染的值。绝不递增、推导、比较或引用它。令牌只出现在两个位置：一次未读清零的 `team_thread read`，和一次结果返回结果 Thread 状态的已提交 public mutation（`team_message` start/reply、`team_claim` mutation）。它不出现在 `team_view`、`team_inbox`、`team_thread status/follow/unfollow/history`、`team_claim list`、未读完的 read，以及所有类型化拒绝中——这些位置一个看似新鲜的令牌反而会诱导盲重试。

Host 按以下顺序检查 fences：

1. 相关 unread work 必须先读完；失败返回带当前 unread counts 的 `unread_required`。
2. 令牌必须匹配当前 Thread revision；失败返回 `stale_revision`。
3. Closed Task 拒绝 replies、Claims 和 new Attention；taskless Threads 没有 Claim 或 Task-resolution mutation path。

这些结果属于正常协作结果，不是 infrastructure failures。被拒绝的 mutation 不渲染令牌；恢复永远是读取 Thread 并重新考虑。不存在 force-send 或 unread bypass。

Human close 会 release active Claims、结束 Attention 并停止 ordinary delivery。Reopen 恢复 open Task，但不恢复之前的 Attention periods。

## Human Remote boundary
Human Client 使用 `readThread`、`threadHistory`、`threadObservations`、`changeAttention` 和 `changes`，并消费 Host 的 Human Inbox 切片作为「收件箱 / Inbox」队列。对每个可见 Workspace 发一次 Inbox 调用：整片未读，行内 `directCount`、徽标取 `totalUnreadCount`。在 Client 内合并为徽标与 Inbox 页。 该页渲染 Host 的两片：未读队列「需要我」（徽标与页头计数只描述它），以及读者写过 Message 的「最近活跃」段：回复过的 Thread 无论是否 follow 都算他的。自己发起、还没人回复的也算（回复不会自动 follow，所以 Attention 决定的是「什么会通知你」，不是「你参与过什么」）。按最新活跃降序，Host 侧每 Workspace 上限 10、页面合并后最多 5 条，与队列不重复。 两片都不收录已归档 Channel 的 Thread：归档终结的不只是通知，还有参与记录。 Agent 的 Inbox 只拿到队列。 打开 Inbox 页不确认任何内容——只有 durable Thread read 消费 mention marker。

`threadObservations` 是针对一个 Thread 的、只读的 Human-only follow/unfollow Attention transitions projection。返回体同时携带当前关注者集合（`followers`）。`changeAttention` 修改该 durable state。 Thread composer 用该读取为 mention 候选排序（当前关注者优先），observation 历史本身暂不渲染。 Client 只在本地保存 navigation mode、Workspace selection 与 Inbox 页位置（navigation 事实，不是未读事实）。unread state、Attention、revisions 和 observations 仍由 Host 持有。 各 Workspace 的 Inbox 调用由 Client 合并：home 级不存在 Inbox ledger 或 Remote。

## Team Member context boundary
显式的 `team-member` preset 是完整 coding composition：shell、filesystem/search、web search 与 fetch、background-job controls、skill 加载工具、compaction、八个 Team tools、Workspace instruction discovery 和 private-memory context plugin。Host 拥有 Web service/provider；Team preset 只增加面向模型的 web tools。普通 Sessions 不会继承这些 Team rows。skill 发现本身是 Member 私有的。Host 在每个 Member 的 agent scope 上注册 provider：只扫插件内置只读 core skills 与该 Member 私有目录两个 root，catalog 以内置集起始。

Member 的 project `cwd` 保持在 Workspace path。 Harness `agent-instructions` 仍是加载 `AGENTS.md`/`CLAUDE.md` guidance 的唯一 loader；Team 不重新实现或迁移这套 discovery。 每个 Member 的 private root 包含小写的 `memory.md` index、按需读取的 `notes/` 和 Member 私有 skill 的 `skills/`。 每个 safe pre-step 最多向 Member 提供其自身发生变化的 index。它包装为 escaped、typed reference context。 Index 上限为 16 KiB，注入块常驻用量刻度（已用 X. X KiB / 16 KiB 及百分比）。超出预算会产生 maintenance warning，而不是静默截断、删除或 summarization。 Notes 不会自动注入。 Suspend/resume 保留这些 files，永久 removal 删除 private root。

persona 陈述私有空间的物理事实（使用注入的绝对路径、绝不 cwd 相对路径、memory/notes 纪律、可复用资产边界）。外加一段简洁的 context-management 指引。把活跃上下文当作最小充分工作集。在风险阶段前用 `context_checkpoint` 记录锚点并在阶段失败时通过 `context_rollover` 回返。历史不再划算时通过 `context_rollover` 换新（切换前先把值得保留的内容写入私有 memory/notes）。上下文切换不会回滚外部影响。handoff 中要交接当前状态。 全部 skill 写作指引（什么值得成为 skill、目录形态布局、写作质量、credentials 约定）都在内置的 `member-skill-manager` meta skill 里。其 description 负责"涉及 skill 管理工作时先读我"。用不用任何 skill 由 Member 按任务自行判断。
