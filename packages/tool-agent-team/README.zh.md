# @contexera/dsh-agent-team/tools

[English](README.md) | 中文

面向 Agent Team Member 的模型工具。本包在调用方 Agent preset scope 内注册工具，不提供或替换 Host service。它不含 context 工具：Session 由引擎就地压缩，冷下来的一代由 Host 换代，两者都不是模型的决定。

## 工具

- `team_inbox` 列出调用方 Member 的有界未读 Thread 摘要，先按 direct work、再按最近活动排序；只有 Thread 存在真实 Task overlay 时才出现 Task standing。header 给出 unread/direct 总数与展示的 Threads 数（有界列表之外仍有未读时给出截断结论）；每个条目显示精确的 unread/direct 计数、Project ref 与 Task standing。页脚把阅读指向 `team_thread read`；渲染不携带 revision 与写令牌。
- `team_thread` 读取 Thread、分页历史。`threadRef` 是主身份；`taskRef` 只对 released task-only Client 是 Host alias。三个 action 分开渲染：`read` 渲染结果、Thread 身份、导向（有 Host 提供的 background 时给 full anchor，否则给 bounded anchor subject——重新进入自己读过的 Thread 的 Member 完全没有 background，它在那里的定位就是该 subject 加本次 batch——anchor 已在 facts 中时绝不重复）、只含 active Claims、带行内 unread/direct 标记的按时间 facts、read-through/剩余未读页脚（只要这次 read 身后留有 Thread facts，页脚同时给出那些 facts 的数量）；`history` 渲染历史页（首页 full anchor、continuation 页 bounded subject，绝无当前 Claims 或上下文建议）。`read` 推进持久 watermark，是 next-write token 的读侧唯一来源——仅在未读清零时渲染；你自己的已提交 public mutation 也会回传一份新 token。一次对调用者没有未读的 read 什么都不推进、不写任何 operation，渲染也不再声称提交（`Read — no unread updates …`），画面仍来自当前 projection。Activity facts 结构化渲染——actor、Task ref，以及每条 activity claim、完成、接受或 release 的 Claim refs。确认仍为 done 状态 Task 的未读验收的那次 read，把这些事实写进 facts，且不对读取者的上下文给出任何建议：模型没有 context 工具，也没有代际选择。
- `team_attention` 只回答你是否关注某个 Thread：`status` 只报告、不改变任何东西，`follow` 与 `unfollow` 改变 Attention。三者参数完全相同——Thread 地址与路由 Workspace——并渲染一行：Thread ref、可选 Task standing 与 following 状态。Attention 不是 reading：这里没有任何 action 渲染 Thread facts、确认未读或交写令牌，读一个 Thread 也从不改变你是否关注它。
- `team_message` 在 Project 的 Main stream 发言、创建顶层 Thread、回复既有 Thread。`start` 用 `kind: 'discussion'`（默认）或 `kind: 'task'` 原子创建 Task——已移除的 `asTask` 写法会被拒绝并指回 `kind`，绝不静默丢弃。commit 的 start/reply 渲染一个 committed-verb 结果（Thread created / reply added），携带 Message、Thread 与可选 Task refs，以及恰好一个 next-write token hand-off。Reply 在检查令牌新鲜度前先拒绝未读工作。类型化拒绝以 `Not committed` 开头，保留重读与审慎重试所需的结构化 refs 与计数，不渲染数字 revision 或写令牌——恢复路径是 read-and-reconsider。
- `team_dm` 向同一 Workspace 内一个 enabled Agent Member 发送一条私有 direct message。它只接受 `memberRef` 与 `body`，别无其他——没有 Thread、没有 Task、没有写令牌、没有附件——多带的参数会被拒绝而不是被忽略。结果区分 `Delivered` 与 `Recorded, not delivered`（携带 delivery note 与禁止盲目重发的警告）；没有自动重投。Human 不能被 DM。
- `team_claim` 通过 `list`、`claim`、`done`、`release` 读取或修改调用方 Member 的 Direction Claim；它只适用于真实 Task。`list` 渲染 Task/Thread 身份与只有 active Claims 的 collision surface，且无写令牌。commit 的 mutation 点名动作（Claim created/completed/released），先渲染权威的受影响 Claim，再 hand-off 一个 next-write token。拒绝与 message 拒绝共享同一形式。Direction 互斥键执行 Unicode NFKC normalization、trim、空白压缩和确定性大小写折叠。
- `team_view` 是 address book：有界、按 membership 授权的 Project、顶层 Thread 与 Member 摘要——是当前的地址簿，不是工作队列。Threads 是唯一分页目录：newest-first 行携带 threadRef、Project ref、bounded anchor subject 与行内 Task standing（绝无第二个 Task 索引，也不渲染 revision 或消息数）。cursor 只延续 Thread 行；continuation 页只渲染 Threads，翻页可达全部获授权的顶层 Threads，包括 taskless 与不在首页的 taskful。

mention 在 Message 正文里撰写，形如 `@Handle`（`@` 必需、大小写不敏感，`@all` 触达整个 Project）；不存在收件人参数。Agent 无法静默加入未被邀请的 Member：mention 一个该 Thread 从未承载过的 Member 时 Message 照常提交，但不向其送达，并在结果里报告为未送达。Human confirmation 属于单独的 Host/Client 流程。Closed Task 在 Human reopen 前拒绝 reply、Claim 和新的 Attention；taskless Thread 没有 Claim 或 Task resolution mutation path。

所有 agent-facing 渲染都在固定的 Team 协调时区 UTC+8 下携带带显式偏移的绝对事件时刻（`2026-09-08T17:00:00+08:00`）：`team_thread` 的 fact 行与 anchor 为每条 fact 标注其提交 operation 的时刻，`team_inbox` 行携带 `newestOccurredAt`，`team_view` 的 Thread 行携带 `lastActivityAt`，通知给出 `Occurred at:`，已提交变更从 receipt 渲染 `Committed at:`。同一存储时刻在任何重读路径中渲染完全一致；只渲染绝对 timestamp，绝不出现相对时间文案，且 sequence 与 revision——而非 wall-clock 时间——仍是顺序 authority。

Canonical result 以结构化字段暴露稳定 refs、可选 Task status、Thread revision、Claim history、Attention 和未读 facts。模型可见的渲染遵循 action decision surface：写令牌出现在未读清零的 `team_thread read`、一次已提交的 public mutation，以及点名当前 revision 的类型化拒绝上；浏览类结果（`team_view`、`team_inbox`、`team_attention`、`history`、`team_claim list`）不渲染 revision 与令牌。类型化的 `unread_required` 与 `stale_revision` 结果保留重新读取和审慎重试所需的结构化字段，并渲染挡住这次写入的事实，使重试无需中间再读一次。工具执行通过准确的 live `exec.agent` 解析 actor；参数不能选择或冒充 actor，可选的 `workspace` 选择器只能在该 actor 已参与的 Workspace 中选择——接受完整 id 或至少 6 位十六进制的唯一前缀（与 branded refs 同一套容忍度），前缀匹配到多个候选时拒绝并列出全部候选。写操作的 request identity 由 sessionId 与 tool callId 派生。每个 Team tool 都把结果返回模型循环。

完整的已实现协议见 [`../../docs/team-collaboration/README.md`](../../docs/team-collaboration/README.md)。

## Composition

在 team-enabled Agent preset 内、`dsh-tools` 之后挂载本插件。插件只静态 inject `tools`；执行时从 live Agent context 读取 `agentTeam`，避免 Host 恢复 Member session 时形成依赖环。
