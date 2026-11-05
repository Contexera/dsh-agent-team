# 工程核对与旧方案替代关系

日期：2026-10-29。Team HEAD 为 `3d16926`；工作副本中 `package.json`、Host `index.ts` 和性能基准脚本有其他工作项改动，本轮没有修改。Harness 相邻源码的 package 版本为 `0.2.1-rc.2`，与 Team 声明的范围相符；未运行安装或构建，不能据此声称已认证全部运行时能力。

本文记录设计阶段查到的事实和实施顺序，不是已实现方案。行为决定以 [spec](../spec.md) 为准。

## 1. 已核对的公开能力

| 需求 | 当前能力与证据 | 实施结论 |
| --- | --- | --- |
| 获取当前模型可见内容 | Harness `Session.surface.nodes`、`snapshotEvents`、`deriveEventMessage`；`packages/core/session/src/index.ts` | 从当前 surface 派生，读取应用了投影的消息；不扫描全日志当成当前上下文 |
| 识别 Team 通知 | Team `context-source.ts`、`member-context.ts`、`surface-visibility.ts`；Harness `MessageSourceMap` 可扩展 | 复用 producer attribution；如需附事实标识，放在 Team 自有声明中，不修改 Harness |
| 核对工具返回 | Harness `tool/result` 有最终 `message` 与可选 `meta`；调用由 callId 关联 `tool/call` | canonical value 不持久化，不能假设能从日志读回原始 structured result |
| 工具输出阶段 | Harness `ToolOutputDefinition.render/presentationMeta`，`projectContent/finalizeContent` | 输出内容与 metadata 不等同于最终模型看到的内容；不用展示 metadata 单独证明完整性 |
| 裁剪后的事实识别 | `compaction-tool-result-pruner` 重写 content，但复制原事件其余字段 | meta 保留不表示正文保留；当前投影文本与具体事实均须对应 |
| pre-step 注入 | `PreStepDecision` 提供 `messages: UserMessage[]`，不提供 producer-local replace 指令 | 采用分类增量注入；不把“每步替换原块”写成已经验证的能力 |
| Thread 已读提交 | Team `prepareReadReceiptFrom` 与 `validateThreadReadReceipt` 当前重放同一批次规则 | 不能直接修改固定批次导致旧 receipt 重放不一致；新 Agent 选择要有可持久重放的精确范围 |
| Main 已读提交 | Team `readMainStream` 支持 readThroughSequence，默认未读分批；`mainReadPage` 提供最近页和被消费旧标记 | Agent 展示策略不能先确认后裁剪；保留 Human Remote 现有读取行为 |
| 单消息读取 | `AgentTeamReadMessageRequest` 仅接受身份，无片段游标；`readMessage` 返回完整 body | 分段续读不是现成能力；在现有 `team_thread` 内补窄 interface，不新建第八个工具 |

关键源码入口（均按函数名定位，避免依赖后续漂移的行号）：

- Team：`packages/agent-team/src/member-context.ts`、`surface-visibility.ts`、`ledger.ts` 的 `prepareReadReceiptFrom`、`prepareReadFrom`、`mainReadPage`、`deferredThreadWrite`；`packages/tool-agent-team/src/index.ts` 的 `rejectionLines` 与 `teamThread`。
- Harness：`packages/core/session/src/types.ts` 的 `tool/result`；`packages/core/session/src/index.ts` 的 `deriveEventMessage`；`packages/core/tools/src/index.ts` 的 `ToolOutputDefinition` 和 `ToolExecutionSuccess`；`packages/compaction/compaction-tool-result-pruner/src/index.ts` 的 `pruneSession`；`packages/core/agent/src/runtime-types.ts` 的 `PreStepDecision`。

## 2. 采用的实现方向

### 2.1 当前可见事实

扩展已有 surface visibility module 的内部 interface，而不是创建单独的“已读事实数据库”。一次操作读取当前 surface 并复用结果，不为每条事实重扫整段会话。

对工具结果，使用 Team 工具身份、已持久化的内容及具体事实身份核对。对通知，复用 Team producer 和结构化来源。只有完整的、可对应的内容才供阅读检查和省略正文使用；模型自己写的文本不参与。

事实标识如何与片段绑定由实施者在票 02 的真实 Session 测试里收敛。优先现有日志字段；确有需要时只添加窄的 Team 自有记录。不可用工具展示 metadata 或正文模糊包含代替完整性，也不加入 durable mirror 或恢复兼容分支。摘要不视为原文。

### 2.2 注入和缺失背景

分类识别当前可见的 identity、ownership、Workspace、memory 基线及后续更新。用现有 source 的 Team-owned 字段或当前块识别，不先建设通用 context registry。memory 提示与完整基线是两类事件；提示残留不能证明基线仍在。

压缩与恢复使用当前 surface，因此无须维护独立的跨会话“曾读过”状态。已有持久已读不因上下文被压缩而回退。

### 2.3 读取选择和确认

保留 Host 权威。读取先选择可完整交付的批次与片段，再提交相应阅读范围；Agent 结果根据同一选择渲染。已在当前上下文完整提供的内容可被计入确认范围但省略正文。额外背景不主动改变未读。

Thread 当前读 receipt 的重放按固定规则重新推导；改变批次必须同时设计新记录的确定性表示和重放测试，不能把 Session surface 写进 replay 依赖。保留既有历史记录的含义，不引入双套运行时读取策略。Main 复用已有序列上界，不因方便而修改 Human Client 的默认页。

### 2.4 长消息续读

复用 `team_thread` 的 read/message，使用系统给出的续读值推进不可变消息正文。默认普通消息仍全文，超长才分段。具体游标形式、单位和额度由实施者决定，不暴露 offset 与 limit 等多套等价选择。

读到末段不自动证明前段仍完整可见；缺段时明确补读，不误确认。正常连续续读必须有进展。若单条大到无法在模型容量内完整提供，应明确报出这个实际限制和读取入口，不声称“已完整读取”；不得为极端长度预建通用大文件或事务框架。

## 3. 旧方案替代关系

旧提案、度量脚本和契约盘点保留为历史证据；原五张票已原样移至 [旧票据目录](2026-10-29-superseded-tickets/01-memory-injection-strategy.md)。它们的 ready/complete 是当时状态，不是当前前沿。

| 原项目 | 新决定 |
| --- | --- |
| 01 两类摘要、非 memory 变化重发整块、保留备用策略 | 分类更新；不随 ownership 重发 memory；不保留另一套注入策略 |
| 02 “render 已落、gate 未落，因此不是设计取舍” | 确认行为变化：来源明确且完整的事实可满足阅读条件；不保证重试提交，跨 Thread/Main/Activity 一致 |
| 03 仅改 Main Agent renderer、只返未读与主题行 | 改为读取选择与确认一致，同时补讨论恢复背景；不得先确认后裁剪 |
| 04 逐工具盘点已 complete | 保留为历史清单，不能作为新行为验收完成 |
| 05 每条规则只出现一次 | 单一规则定义，允许必要位置短提醒；通过实际模型调用验证 |
| memory 累计字符下降至少 80% | 不再是整体完成门槛；同场景测量重复减少，同时以行为正确为先 |
| 先建共享语义层 | 不建；只提取已存在真实调用者的共享完整性/渲染逻辑 |

原始 [SCOPE](../SCOPE.md) 已标为历史；[旧提案](2026-10-28-baseline-and-proposal.md)及[契约盘点](2026-10-29-seven-tools-contract-inventory.md)正文不重写。

## 4. 验证约束

设计阶段只检查文档、链接、票据依赖及引用事实，不把它算作运行验收。实现先跑窄的 Host/tool/Session 组合测试，再按影响面跑类型、正式文档和构建检查；涉及 Remote 或 assembled Web 时必须 browser 验证。

旧语料是滚动增长的历史日志，累计字符不是单次上下文占用或真实费用。复跑需要固定输入窗口、区分 session 与日志文件、读取 surface 替换与压缩。原脚本保留不表示测量方法已支持新注入/分段格式。

参考成熟工具实践：[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)。采用其有意义结果、分页、可执行恢复和真实场景评测原则，不把示例 token 节省率当成本项目收益。
