# 第一轮延后项：当前代码结论

第一轮在 `REPORT.md` 第 6 节和 `spec.md` 的「架构优化」里留了一批延后项。这里逐条对当前 HEAD（`796024fc`）复核，给出「现在收口 / 需要决定 / 需要证据 / 保持」四类结论。

## 总表

| 项 | 第一轮结论 | 当前代码 | 本轮建议 |
| --- | --- | --- | --- |
| 更新检查 `off` | 只停新请求，缓存仍显示；契约待定 | 仍然如此（`human-update-check.ts:26-29`、`:92-129`） | **需要决定** |
| admission `running` | 无生产写入点，不贸然删 | 仍然无写入点（`subscription-admissions.ts:14`、`:107`） | **现在收口**（v5 未发布） |
| 附件半写目录 | payload/meta 分写，GC 跳过不可读 sidecar | 仍然如此（`attachments.ts:221-239`、`:290-310`、`:329-341`） | **现在收口** |
| 头像不回收 | 无 TTL，跨 profile 引用，暂不清理 | 仍然如此（`human-avatar.ts:76-103`） | **保持 + 记录** |
| Webhook 队列积压 | 无实测，不预先优化 | 内存队列 + 4 槽，每 tick 扫内存（`subscription-runtime.ts`） | **需要证据** |
| C16 sidebar order | 说是 localStorage 偏好 | 已改为 Host row 设置 + 缓存 + 上迁（`sidebar-order.ts`） | **已过时，关闭** |
| C20 model catalog | 可局部命名“旧值 + 失败” | 已保留 last good value，失败仍显示错误（`TeamMemberEditor.tsx`） | **已处理，关闭** |
| C23 订阅弹层 | 可合成互斥 overlay intent | 单卡 `pending` 已互斥；无复现 | **保持** |
| `requestRecycle` 返回类型 | settled ≠ activated | 关键调用方已回读 `handles`（`index.ts:874-876`） | **保持** |
| 私有记忆清理部分失败 | 非原子，AggregateError | 仍然如此（`member-runtime.ts:524-537`） | **保持**（低） |
| reminder 消费重试耗尽 | 有界重试，occurrence 留 owed | 仍然如此（`index.ts:306`、`:5569-5586`） | **保持** |
| 旧 read receipt 形状 | 兼容旧账本 | 仍然接受（`spec.ts:556-580`） | **保持** |
| replay-only Session 过渡 | 旧入口只读 | 仍然如此，已注明（`types/operations.ts`） | **保持** |

## 现在可以收口

### 1. 订阅存储模块注释

`packages/agent-team/src/subscription-store.ts:1-7` 说：

> Deleting every row changes no domain result — the ledger's accepted and published records remain the authority for what happened.

这句话对 ledger 事实成立，但模块里还有 `admissions`：删掉它会丢失 202 已承诺的工作；删掉 `checkpoints` 会改变调度、失败计数和暂停。模块注释甚至没有列 `admissions`。

维护文档已经写对了（`docs/architecture/host-authority.zh.md:158`）。建议只改注释：列出五张表，说明哪些是诊断/可丢弃，哪些是承诺/会影响调度。不改代码，不加新状态。

### 2. 附件缓存半写目录

`writeAttachment` 先写 payload，再写 `meta.json`（`attachments.ts:221-239`）。两次写之间崩溃或 meta 写失败，会留下一个没有 meta 的目录。`scanAttachmentCache` 对这类目录返回 `undefined` 并跳过（`:290-310`），所以启动时和每天的 GC（`index.ts:1769-1777`）永远清不到。用同一个 upload id 重试会修复，但用户关掉页面后就不会再重试。

建议：GC 扫描时，对「名字是 UUID、目录在缓存根内、没有有效 meta、mtime 超过 orphan TTL」的目录也删除。不要碰非 UUID 目录和符号链接。加一个回归：payload-only 目录在 TTL 后被清；外来目录不动；重试仍收敛。

### 3. admission 的 `running`

`SUBSCRIPTION_ADMISSION_STATES` 从 `637be470` 引入起就包含 `running`，但生产写入点只有 `queued`、`retrying`、`exhausted`；`dueAdmissions` 只是把它排除（`subscription-admissions.ts:107`）。replay intent 的 `running` 是另一台机器（`subscription-runs.ts`），不要混。

v5 还没发布（CHANGELOG 的 Unreleased）。现在从 enum/schema/filter 里删掉 `running`，只需要改一处类型、一处 schema、一处过滤和相应测试；发布后再删就要考虑 v6 或兼容读。建议现在做，并加一个测试证明没有生产写入点。

## 需要决定

### 更新检查 `off`

当前 `DSH_AGENT_TEAM_UPDATE_CHECK=0/false/off` 只在 `refresh()` 开头判断；已经在途的请求不 abort，迟到结果仍会更新 `latestVersion`；`snapshot` 仍返回已有缓存。现有测试只覆盖初始 off 和 offline，没有覆盖“运行中关闭”。

需要先定契约：

- **网络开关**：off 只停止新的 outbound；缓存提示保留。当前行为自洽，只需补测试。
- **撤销/隐藏**：off 也作废在途结果、隐藏缓存提示。需要一个小 `enabled/settlement` gate 和测试，但不引入通用 FSM。

这是产品决定，不是 bug。没有决定前不要改。

## 需要证据

### Webhook 队列积压

调度器是内存队列 + 全局 4 槽 + 每 ref 至多 1 执行；`timerPass` 每 tick 扫内存里的订阅，`checkpoint()` 是内存 map，不读存储。没有实测积压。第一轮说“若实测积压，再区分每轮重复扫描还是逐个等待”。

建议：先在现有 run history 或日志里加队列深度/tick 耗时，观察真实部署；没有数据不动扫描逻辑。

### 头像保留

头像每次换图生成新的 UUID 目录，旧文件不回收；单张上限 10 MiB。跨 profile 或继承层可能仍引用旧文件，单 Host 看不到全貌。第一轮有意保留。

建议：先量真实增长；如果确实成为容量问题，再设计“保留最近 N 个 + 跨 profile 安全规则”，不要现在加 GC。

## 保持

- **C23 订阅弹层互斥**：单卡 `pending` 已阻止并发操作；没有复现“同时打开两个对话框”的问题。合成判别联合是类型整形，不是行为修复。
- **`requestRecycle` 返回类型**：`Promise<void>` 确实邀请误用，但关键调用方 `recycleColdGeneration` 已经在 await 后回读 `handles`；激活路径的 `return` 也是刻意的。改成结果类型是内部 API 清理，收益小于回归面。
- **私有记忆清理部分失败**：`cleanupRemovedMember` 用 `allSettled` 收集失败并抛 `AggregateError`；调用方在生命周期链里，失败不会回滚 durable `inactive`。下次启动会重新收敛。没有用户可见状态，低优先级。
- **reminder 消费重试耗尽**：3 次后停止重导，occurrence 仍 owed，等下一个 Team fact 或 activation。每次重试花一个 turn，无限重试更糟。保持。
- **旧 read receipt**：新读只写紧凑 receipt，旧完整 snapshot 仍被接受，是为了旧账本能打开。不能在没有兼容窗口的情况下删。
- **replay-only Session 过渡**：`restarted`/`context-cleared`/`renewed`/`rolled-over` 中旧入口只读，类型注释已说明。不要因为“没有 writer”就删兼容 validator。

## 结论

第一轮的延后项里，**三项现在可以小步收口**（存储注释、附件半写目录、admission `running`），**一项需要产品决定**（更新检查 off），**两项需要真实证据**（Webhook 队列、头像保留），其余保持。不要把这些混成一张“大扫除”票；它们的所有权和风险不同。
