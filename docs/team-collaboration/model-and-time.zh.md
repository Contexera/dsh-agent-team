# 协作模型与时间感知

[English](model-and-time.md) | 中文

## 协作模型
Channel 顶层 Message 会创建一个 Thread 及其 anchor。新的 model-facing start 默认创建 taskless Thread。传入明确的 task intent 会在同一个 atomic operation 中创建 Task overlay。省略字段则为 released Clients 保留 taskful 行为。Human 可以随后 promotion 一个 taskless Thread。一个 atomic operation 创建 Task overlay，并记录会通知当前 followers 的结构化 `promote` Task activity：promotion 不写 prose Message。Reply 会向既有 Thread 添加 immutable Messages。公开 Thread facts 包括 Messages，以及仅在存在 Task overlay 时才有的 Claim changes、Human Task resolution changes 和 promotion。它们的 global operation sequence 决定 chronology 与当前 Thread revision。

Agent 只能读取或修改其已参与 Workspace 中的 Channels，且仍需是 Channel Member。Team tools 从确切的 live Agent 解析 actor，模型不能选择 actor。`workspace` 选择器必须指向一个已参与的 Workspace：单一参与时可省略；多参与时在 `team_view`、`team_thread`、`team_message`、`team_claim` 上必填，拒绝信息列出可选 Workspace id。`team_inbox` 则默认合并全部参与，`workspace` 仅作为排序与截断前的可选过滤。Inbox 行与通知详情标注来源 Workspace；`team_thread` 在结果行前渲染 Workspace/Channel 来源。多 Workspace 引导提供路径、绝对路径规则与每个 checkout 的 `AGENTS.md` 指针。加入不改变 Session cwd。

## Member 时间感知
所有 agent-facing 协作表面都携带绝对事件时刻。sequence 与 revision（绝非 wall-clock 时间）仍是唯一的顺序与并发 authority。Ledger 存储在每个 operation 上保留 UTC ISO 的 `occurredAt`。渲染通过唯一的固定偏移 formatter 换算为 Team 协调时区 UTC+8 并带显式偏移（`2026-09-08T17:00:00+08:00`）。固定偏移没有夏令时分量，因此同一存储时刻在任何重读路径（read、history 翻页、compaction 后重建、旧 ledger replay）中渲染完全一致——即 context-cache 不变量。只渲染绝对 timestamp；durable facts 中绝不出现相对时间文案（「3 小时前」）。未来的配置层可以让时区可配置；在那之前，每个存储时刻对应一个确定性 formatter 就是合同，Web Client 保持自己的浏览器本地渲染。

- `team_thread` read/history 的 facts 与 anchor 在 fact envelope 上携带其提交 operation 的时刻。Message 与 Activity 一致：Activity 自身没有时刻，从承载 operation 投影。fact 行渲染为 `sequence 时刻 [sender] 正文`；anchor 渲染为 `Anchor sequence 时刻 [sender]`。
- `team_inbox` 行携带 `newestOccurredAt`——最新 unread fact 的时刻，与 `newestSequence` 取自同一快照。
- `team_view` 的 Thread 行携带 `lastActivityAt`，从该 Thread 的尾部 fact 投影。
- 自动通知在 direct mention 与 activity 上给出 `Occurred at:`，无正文路由给出最新 ordinary unread 时刻。
- DM relay 给出发送时刻；prior-DM 上下文行引用那条 DM 的时刻。
- 已提交的变更（`team_message` start/reply/dm、`team_claim`）从 operation receipt 渲染 `Committed at:`。Client 的乐观合并读取同一 receipt 时刻。
- fact envelope 时刻出现之前写入的 ledgers 在 replay 时 normalize。时刻从提交 operation 重新派生，绝不凭空制造。

除事件时刻外，每个符合条件的 Team Member turn 的首个 model step 会收到一条 durable clock snapshot（`member-time-context` preset row）：UTC+8 的当前时刻、距上一个 model-visible event 的 elapsed，以及 ordering-authority 说明。 同一 turn 的后续 step 默认保持安静，只有距上一条落盘 snapshot 已超过 refresh interval 才再注入一条：快速 step 的 tool-dense turn 恰好产出一行，超出 interval 的 turn 仍能显示真实跨度。被跳过的 step 绝不回填，其时间跨度折叠进下一条 snapshot 的 elapsed。 默认 interval 为 30 分钟，可通过 preset row 的 plugin config 覆盖，留给未来的配置层接管。 baseline 从该 Member Session 自身事件折叠而来。因此 restart、resume 和 compaction 无需第二存储即可派生出相同值。rollover 开启全新日志，elapsed 渲染为 `unavailable` 而不是跨代猜测。wall-clock 回拨将 elapsed 夹为 `0s` 而不改写历史。

内置的 `@deepseek-ai/dsh-time-context` 保持不挂载，因为其 browser-zone 策略会让后台唤醒的 Member 向不存在的用户确认日期。 时间绝不驱动自动行为：不存在 deadline、reminder、scheduler、SLA 或按陈旧度的状态变更。
