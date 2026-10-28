# 最终 v2：08/09 实施前补充决定

日期：2026-10-25。本文与 `spec.md` 一起记录已确认的实施决定；如与分批编写时的规则版本 3/4 冲突，以本文为准。

## 发布与规则版本

- 06–09 属于同一未发布的新模型，最终只采用规则版本 2，不增加版本 3/4。
- 已发布 0.2.5 的 v1 记录必须继续精确重放。开发中的中间 v2 账本不作为公开迁移承诺；升级前备份并重建开发数据。
- 08 改变同一操作种类的校验与 Inbox 期望时，只有真正的 v1 历史段走旧规则；最终 v2 只保留一套新写规则。

## Task 责任与验收

- Agent owner 创建或 promote Task 时默认自己为 accountable；Human 可指定本 Project owner 或 Human，不指定则 Human。
- `accept`：Human，或从未持有该 Task 任一 Claim 的当前 Agent Project owner。Agent 仅能在 `in_review` accept；Human 保留在 `todo`、`in_progress` 提前验收的能力。持有过包括已释放与系统释放，reopen 不清除。
- `close` / `reopen`：Human 或当前 accountable。执行过不等于可以 accept，但不妨碍 close/reopen。
- `transfer`：Human 或当前 accountable；目标为当前本 Project owner 或 Human。open Task 均可转交；已结束 Task 只有 Human 可显式转交。新 accountable 自动 follow，原 accountable 不自动 unfollow。
- Agent owner 被撤销、离开 Workspace、归档或删除时，其 open Task 在同一 operation 转回 Human；suspend 保留。已结束 Task 不批量改写。reopen 时发现 accountable 已失效，必须先显式 transfer，不暗中改写。
- 无强制 executor；accountable 负责组织执行。来源限同 Project 的 taskless discussion Thread，只在新建 Task 时写入，原地 promote 无来源；不可指向 Task Thread 或已归档 Project。
- 来源 Thread 的 Task 卡片是按 Task 创建 sequence 插入的投影，不是 fact：不产生未读、不推 revision；Human 与 Agent 的 Thread 读取/历史都显示。无来源的 Task 卡片才进 Main stream。
- Task board `mine` = accountable 或 active executor；`relation` 增加 accountable，并提供是否需要读者验收的投影。accountable 被暂停时保留身份，UI 明示。
- 责任事件使用 activity marker，不计 Attention，按 direct 级进入 Inbox 与 immediate 投递；历史 accept 的既有唤醒规则不变。

## 提醒

- 提醒是给具体收件人的私有 durable marker，不是 Thread Activity；不进入公开历史、不改变 revision 或 Thread fact 的停滞条件起点。读取所属 Task Thread 才消费提醒，`team_inbox`、board 仍不消费。
- `team/reminder-raised` 由 Host actor 写入，含 taskRef、kind、recipient、baselineSequence、occurredAt 与 Inbox delta；episode key = taskRef + kind + recipient + baselineSequence，全 ledger 唯一。
- 待验收：应验收者为 accountable；accountable 执行过则是 Human。Agent 验收者 idle ≥30min；Human 以进入 in_review ≥30min。已存在该 recipient 关于同一 Task 的未读责任事件时不追加提醒，也不消耗 episode；读过后可在后续事件触发该 episode 唯一一次提醒。
- 停滞：in_progress 且 Task Thread 24h 无 Message/公开 Activity，或 active Claim 持有者 idle >24h；接收者为 accountable。Claim/Thread 变化形成新 episode，reminder 本身不形成。
- 评估由任何 ledger 提交、activation、Inbox read、已有 wake 触发，扫所有 open Task，不设 timer。评估可随读取路径提交 reminder，但读取本身不推进水位、不消费 marker、不发 mutation token；这不改变 read-only 查询的产品语义。
- idle 是同一 Host 进程内从 turn/工作状态派生的运行时事实，跨 recycle/compaction 延续；Host 重启未知则跳过。suspended accountable 不升级为 Human。
- 责任事件与 reminder 在 Human UI 均为 direct（蓝点），但 delivery class 仍是运行时计算，不落盘。
