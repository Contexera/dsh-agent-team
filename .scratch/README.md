# 工作资料目录索引

`.scratch/` 保存跨会话工作项的设计快照、研究、实施 tickets、原型和可复查的里程碑证据。它不定义当前产品行为、公开 API、稳定维护流程或架构边界；这些以 `packages/`、测试、package README 和 `../docs/` 为准。

**怎么在这里工作（工作项结构、ticket 骨架、Team 流程对接、生命周期）见 [AGENTS.md](AGENTS.md)。**

## 目录

```text
.scratch/
├── active/                 # 尚未结束的工作项（Git 忽略）
├── archive/YYYY-MM/<work>/ # 已完成工作项的历史资料（进 Git）
└── local/                  # Git 忽略的私人草稿和临时输出
```

## 当前工作项入口

未结束的工作项位于 `active/<work>/`（Git 忽略，不随仓库分发），本索引不列其中的本地条目；工作项结束时移入 `archive/YYYY-MM/`，其 README 会被追加到下面的已归档清单。

已归档：[Project 与具名 Owner](archive/2026-10/project-ownership-model/README.md)（2026-10-28 归档：01–09 全部交付——读懂 Project 写法的发布、全仓 Channel → Project 改名、规则版本 2、owner 与 member 派生、Main stream 与开 Thread 权限、按责任投递与 Inbox、Host Task board 投影、Task 负责人与验收限制、事件评估的待验收与停滞提醒；真实账本全量重放通过。dev profile 试用复盘与 Attention 模型后续调整转交 `attention-delivery-model`）、[Channel 页面分流重设计](archive/2026-10/channel-page-redesign/README.md)（2026-10-28 归档：页签式看板入口、已完成 Task 瘦成脚注、无 Task 讨论的右面板三项合入 master；看板的数据源与归属判定为 Task 的独立视图，由 project-ownership-model 的 Host Task board 投影交付；B-4 的 read/drain 抽取未做，不再跟踪）、[Team Member 工具面控制权](archive/2026-10/member-tool-surface-control/README.md)（2026-10-23 归档：默认按 preset 限制工具，过滤其他插件注入的未声明工具并拦截执行；prompt 不过滤，公开接口不支持完整提示隔离；用户接受该边界，上游改造和完整共存不在本轮范围）、[自动压缩迁移收尾](archive/2026-10/auto-compaction-migration/README.md)（2026-10-21 归档：直接使用 DSH 默认压缩引擎与默认模板，删除 Team 摘要副本、无消费者状态与旧写入口；唤醒换代用 maintenance 与 ledger 输入边界保住提交期间输入，退役后从原始日志恢复；保留旧日志解码与必要恢复。1056 passed + 1 skipped，typecheck、lint、docs、browser 5 passed、build、artifact 通过；真实模型摘要质量与成本未测）、[全量注释审查](archive/2026-10/comment-audit/README.md)（2026-10-19 归档：删 1145 行复述代码的注释；A 档 12 条缺陷、B 档 80 行改名与抽函数、C 档 6 条公开类型收窄全部落地；C 档 4 条经复核跳过，`tools.allow` 保留。合入 master `23385f99`）、[Thread 的引用与 mention 语义](archive/2026-10/thread-quoting-and-mentions/README.md)（2026-10-10 归档：消息行 hover 的层次与时间座位、右侧动作卡（复制 / 引用）、「提到了你」、打开 Thread 命中第一条未读点名消息、引用可直接送达发出者；读侧引用与 Host 侧 `replyToMessageRef` 一并落地，回合分隔线最终不带时刻。durable 结论见 `docs/frontend-design/thread-and-composer.md` 等双语对与 CHANGELOG）、[Issue #43 逐条复现与判定](archive/2026-10/issue-43-triage/README.md)（2026-10-10 归档：10 条 + 2 条附注逐条复现，5 条成立、2 条部分成立、3 条不成立；按批准的工单实施 02/03/05/06/07，01 关闭，04 取做法 A。对外回复草稿见该归档的 `reply.md`）、[状态机、数据请求与诊断日志](archive/2026-10/state-requests-diagnostics/README.md)（task:60eadddc #113，2026-10-09 归档：6 票全部完成——成员执行隔离、共享读取与过期响应保护、有界投影、通知与恢复追踪、规模与故障整体验收）、[Context 管理：三个动作与一个状态面](archive/2026-10/context-relevant-turn-reduction/README.md)（task:1e3b9e0f #45 → 实现 #6，2026-10-04 归档）、[质量改进审计](archive/2026-10/quality-improvement/README.md)（task:e33c4efd #105，2026-10-01 归档）、[0.1.7 UI 设计语言再基线](archive/2026-09/ui-parity-0.1.7/README.md)（task:d3ec167b，2026-09-24 归档）、[Member Session 架构](archive/2026-09/member-session-architecture/README.md)、[Context continuity](archive/2026-09/context-continuity/README.md)。

## 临时材料和 UI 证据

`.scratch/local/`、`.scratch/active/`、`artifacts/` 和 `artifacts/browser/` 被 Git 忽略。临时日志、agent handoff、下载物、调试截图和日常 browser test 输出放在那里，不进入归档。工作项结束时从 `active/` 移入 `archive/YYYY-MM/<work>/`，归档结果进入 Git 历史。

UI 改动需要真实浏览器自检时，`npm run test:browser` 会把本次截图写入 `artifacts/browser/`。它们用于审查本次改动，不是自动视觉回归基线，也不会改动 Git 工作区。只有人工确认能说明已完成工作项验收结论的少量代表图，才复制进对应归档的 `archive/YYYY-MM/<work>/validation/`；每张图都必须在同目录 README 中说明证明的验收点和复跑命令。一个浏览器 journey 跨多个 UI ticket 时，可以像本仓库一样集中保存。

详细 UI 改动检查和证据选择规则见 [`../docs/development/generated-and-seams.zh.md`](../docs/development/generated-and-seams.zh.md)。
