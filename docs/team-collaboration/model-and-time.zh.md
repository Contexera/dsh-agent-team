# 协作模型与时间感知

[English](model-and-time.md) | 中文

## 协作模型

先选择协作范围，再选择工具：

| 需要 | 范围与动作 |
| --- | --- |
| 尚未形成固定议题的问题或更新 | Main stream：`team_message` 的 `action: 'post'` |
| 持久的讨论 | Thread：Project owner 使用 `action: 'start'`，默认 `kind: 'discussion'` |
| 需要负责人与验收的工作 | Task 层：owner 以 `kind: 'task'` 创建，或使用 `team_task promote` |
| 继续讨论 | 在既有 Thread 内使用 `team_message reply` |

工具默认创建 taskless Thread；Host 为省略 kind 的旧 Client 保留同时创建 Task 的默认行为。提升在同一个原子操作中建立 Task 并记录结构化的 `promote` Activity，不额外写散文 Message。

Task 的 resolution 由显式操作决定，status 按下表投影：

| Resolution | Claim 情况 | Status |
| --- | --- | --- |
| `open` | 有 active Claim | `in_progress` |
| `open` | 没有 active Claim，至少有一个 done Claim | `in_review` |
| `open` | 既无 active 也无 done Claim | `todo` |
| `accepted` | 不影响 status | `done` |
| `closed` | 不影响 status | `closed` |

release 不等于完成。done Claim 说明持有者完成了工作，不说明 Task 已验收。Human 验收可以原子地完成 active Claim；close 则释放它们。reopen 移除终态 resolution，再从保留的 Claim 推导 status。操作权限见 [Task 权限](boundaries.zh.md#ownership-与-task-权限)。

Message 不可变。公开 Thread 时间线包含 Message、存在 Task 时的 Task/Claim Activity，以及绑定 Worker 的开始／结束事实。全局 operation sequence 决定顺序；Thread revision 只随改变状态的写入推进。因此 Worker 事实可以晚于 revision，却不提供更新的写入令牌。

现行规则下，参与 Workspace 即可读取 Project，enabled 的参与者可以协作。发起／提升 Thread 和管理订阅额外要求 owner 身份，回复或认领不要求。Host 从确切的 live Agent 解析 actor，工具不能选择其他 actor。

`workspace` 选择器接受已参与 Workspace 的完整 id，或至少 6 位十六进制的唯一前缀；前缀不唯一时拒绝并列出候选。参与多个 Workspace 时，大部分工具要求选择器；`team_inbox` 则默认合并，指定过滤条件时先过滤，再排序和截断。

Inbox 行与通知标明来源 Workspace，Thread 读取标明 Workspace/Project。加入不会改变 Session cwd，也不会加载该 checkout 的指令。用 `working_directory({cd})` 进入已加入的 checkout；切换目录本身不授予 Team 权限。各动作的地址与选择器规则见[工具契约](tools.zh.md)。

## Member 时间感知

事件时刻说明事实何时发生；排序与并发仍以 sequence 和 revision 为准。ledger operation 存储 UTC ISO 格式的 `occurredAt`。模型侧协作输出用固定 UTC+8 与显式偏移渲染，例如 `2026-09-08T17:00:00+08:00`。翻页、压缩或回放后，同一时刻的渲染不变。Client 的普通事件显示使用浏览器本地时间。

各视图的时间字段含义不同：

- Thread 事实与 anchor 携带提交 operation 的时刻；Activity 从事实封套取得该时刻。
- Inbox 行的 `newestOccurredAt` 与 `newestSequence` 来自同一快照；目录 Thread 行携带 `lastActivityAt`。
- direct 通知携带事件时刻，普通摘要携带最新未读时刻。
- DM 转发携带发送时刻；公开变更提交结果的 `Committed at:` 来自回执。

每个符合条件的 Member turn，其第一个模型 step 还会收到 `member-time-context` 的持久时钟快照：当前 UTC+8 时刻、经过时长与排序说明。后续 step 仅在距上次快照满 30 分钟后刷新；该 preset 行的 `refreshIntervalMs` 可配置。这是在模型 step 采样，不是启动 turn 的定时器。

首个 step 从上一条模型可见事件计算时长，刷新则从上一快照计算。基线来自该 Session 自己的事件。新一代没有基线时显示 `unavailable`；时钟回拨时把时长限制为 `0s`。Member preset 不挂载 Harness 使用浏览器时区的 `dsh-time-context`。

Task 提醒在 Team 事件发生时检查，不由截止时间调度器触发。安静的 Team 不会仅因跨过以下阈值而唤醒：

| Task 条件 | 收件人与阈值 |
| --- | --- |
| `in_review` | 有资格的验收者：Agent 已被观测为空闲至少 30 分钟；Human 则为进入 review 后 30 分钟 |
| `in_progress` 且无公开进展 | accountable：距最新公开 Thread 事实超过 24 小时 |
| `in_progress` 且执行者空闲 | accountable：某个 active Claim 的 owner 已被观测为空闲超过 24 小时 |

Agent idle 仅在进程内保存，换代后保留。Host 重启后，未知的 idle 区间直接跳过，不从旧 Session 日志推断。已有未读责任事件会抑制重复提醒，但不消耗该提醒周期。

每条 `team/reminder-raised` 都是私有事实，按 Task、kind、收件人与条件基线标识。不改变 Thread revision 或进展基线，读取该 Task 的 Thread 才消费。读取时会过滤持久 status、收件人、可见性或基线已不匹配的 marker；不删除存储记录，也不再要求运行时 idle 条件。转交不会把旧 marker 移给新 accountable。

这些 Task 提醒不同于 `team_reminder`：Member 自己设置的日程会启动 Host 定时器，停机时错过的到期 occurrence 会在恢复后补一次。日程与消费规则见[提醒工具](tools.zh.md#team_reminder)。
