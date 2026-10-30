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

## 已归档工作项

| 月 | 工作项 | 一句话结论 | 链接 |
| --- | --- | --- | --- |
| 2026-08 | agent-team-quality-audit | 只读简化与可维护性审查；发现已实施或记为保留/延后，政策结论进架构与开发文档。 | [README](archive/2026-08/agent-team-quality-audit/README.md) |
| 2026-08 | agent-team-storage-architecture | 设计操作账本持久化（v7→v8 事故后），0.1.0 发布 01+02，03/04/05 延后。 | [README](archive/2026-08/agent-team-storage-architecture/README.md) |
| 2026-08 | community-outreach | 社区外联操作；发布节奏与产品链接归 root README 与开发文档。 | [README](archive/2026-08/community-outreach/README.md) |
| 2026-08 | m1 | 首版 Agent Team（M1）的领域设计、实施票与机制验证快照。 | [README](archive/2026-08/m1/README.md) |
| 2026-08 | m2-ui | 第一版 Team mode UI（M2 第一阶段）的闭环设计快照与实施记录。 | [README](archive/2026-08/m2-ui/README.md) |
| 2026-08 | member-compaction-diagnosis | Member 自动压缩 unavailable 复发诊断；修复 2aa5130 经日常使用验收。 | [README](archive/2026-08/member-compaction-diagnosis/README.md) |
| 2026-08 | readme-positioning | README value-first 定位落地到中英 README 与 package.json（0.1.0）。 | [README](archive/2026-08/readme-positioning/README.md) |
| 2026-08 | session-log-repair | 会话日志 seq 撞号损坏的诊断与修复工具；损坏日志全部修复并验证。 | [README](archive/2026-08/session-log-repair/README.md) |
| 2026-08 | team-client-ui-round2 | Client UI 第二轮：消息时间戳、排版统一、任务卡重设计。 | [README](archive/2026-08/team-client-ui-round2/README.md) |
| 2026-08 | team-client-ui-round3 | Client UI 第三轮：messageRun、mention chip、排版刻度和五态状态点。 | [README](archive/2026-08/team-client-ui-round3/README.md) |
| 2026-08 | team-conversation-page-design | Channel/Thread 顶层页面设计优化（header 减负、返回路径等）。 | [README](archive/2026-08/team-conversation-page-design/README.md) |
| 2026-08 | team-sidebar-sections | 侧栏分区化：工作区列表加「频道」「Agents」两个分区替代双 tab。 | [README](archive/2026-08/team-sidebar-sections/README.md) |
| 2026-08 | team-ui-loading-investigation | Team UI loading 调查：按 scope 唤醒、增量投影、共享 long-poll 等性能修复。 | [README](archive/2026-08/team-ui-loading-investigation/README.md) |
| 2026-08 | thermo-round2-cleanup | 第二轮质量清理（thermo）：hygiene sweep 加 Host/Client 审查，六提交合入。 | [README](archive/2026-08/thermo-round2-cleanup/README.md) |
| 2026-08 | thread-inbox | Thread Attention、durable Inbox、五工具与 Member context 的初版方案与实施票。 | [README](archive/2026-08/thread-inbox/README.md) |
| 2026-08 | ui-redesign | Client presentation 的 native-feel 重做，不动 Host/ledger/Remote。 | [README](archive/2026-08/ui-redesign/README.md) |
| 2026-09 | agent-team-architecture | 文件与包结构审计；交付为 Client panel 去中间层、纠正「三包独立」错误表述。 | [README](archive/2026-09/agent-team-architecture/README.md) |
| 2026-09 | agent-team-simplification-audit | 全仓简化审查（机械→消融→语义）加消融仪器；8 月审计裁决逐条复核维持。 | [README](archive/2026-09/agent-team-simplification-audit/README.md) |
| 2026-09 | claim-panel-ux | Claim 面板与 Thread/Channel 顶层栏走查；真因是顶栏过高，压高度并给分区留距。 | [README](archive/2026-09/claim-panel-ux/README.md) |
| 2026-09 | context-continuity | Context 引擎抽为独立插件并接入；检索阶梯经 Human 决定撤回，Team 只发八工具。 | [README](archive/2026-09/context-continuity/README.md) |
| 2026-09 | context-self-management | Context 自管理（rollover/checkpoint/fold/压力）四票完成并验收。 | [README](archive/2026-09/context-self-management/README.md) |
| 2026-09 | dsh-0.1.5-rc.1-compatibility | DSH 0.1.5-rc.1 差异评估与认证：peer 移到 `>=0.1.5-rc.1 <0.2.0`，七处断裂适配。 | [README](archive/2026-09/dsh-0.1.5-rc.1-compatibility/README.md) |
| 2026-09 | dsh-adaptation-playbook | DSH 版本适配 playbook（扫描→认证→评审→合并→发布），供下次发版复用。 | [README](archive/2026-09/dsh-adaptation-playbook/README.md) |
| 2026-09 | global-agent-architecture | 全局 Agent Member：拆开身份与参与集合，Workspace 是地址不是位置（PR #26）。 | [README](archive/2026-09/global-agent-architecture/README.md) |
| 2026-09 | host-file-split | Host 大文件拆分：index/types 瘦身加 MemberRuntime 提取，零测试改动。 | [README](archive/2026-09/host-file-split/README.md) |
| 2026-09 | human-mention-inbox | Human「提到我」Inbox 与 mention prompt（PR #20 加跨 Workspace 全局降序）。 | [README](archive/2026-09/human-mention-inbox/README.md) |
| 2026-09 | human-profile-settings | Human 可配置项（avatar/name/版本脚注）接口落地，UI 交 Iris。 | [README](archive/2026-09/human-profile-settings/README.md) |
| 2026-09 | inbox-model | Inbox 模型统一：human/agent 同一套订阅与投递，改造「提到我」为收件箱。 | [README](archive/2026-09/inbox-model/README.md) |
| 2026-09 | member-memory-dir-drift | Member 私有目录 colon/拼写漂移修复（issue #7），真实数据回收孪生目录。 | [README](archive/2026-09/member-memory-dir-drift/README.md) |
| 2026-09 | member-runtime-architecture | Member Runtime Phase 1：持久 capabilities、tools/skills 双接缝、九人技能装配。 | [README](archive/2026-09/member-runtime-architecture/README.md) |
| 2026-09 | member-session-architecture | Member Session：统一读取 seam、历史召回与安全回返的设计与 ticket 03–05。 | [README](archive/2026-09/member-session-architecture/README.md) |
| 2026-09 | member-time-awareness | Member 时间感知：固定 UTC+8 formatter、per-step 时钟快照、事实携带事件时刻。 | [README](archive/2026-09/member-time-awareness/README.md) |
| 2026-09 | multi-web-support | 多 Web 页面支持第一阶段：Host changes/Client 改流式 Remote，多页面可并发（PR #25）。 | [README](archive/2026-09/multi-web-support/README.md) |
| 2026-09 | polish-0.1.11 | 0.1.11 打磨简化审计：A 桶 01–07 与 B 桶 5 条实施，3 条裁定保留。 | [README](archive/2026-09/polish-0.1.11/README.md) |
| 2026-09 | progress-nudge | 进度可见性 nudge：无 claim/message 时按 tool_call 阈值注入提示。 | [README](archive/2026-09/progress-nudge/README.md) |
| 2026-09 | render-ia | Team tools 渲染信息架构：team_view/thread/message 的呈现契约与 render 测试。 | [README](archive/2026-09/render-ia/README.md) |
| 2026-09 | session-fold-incremental | Session fold 增量（team-perf 07 续作）：增量折叠替代逐事件，Vera 验收 bf4c172。 | [README](archive/2026-09/session-fold-incremental/README.md) |
| 2026-09 | session-trace-analysis | Session trace context 分析；产出 scripts/session-trace.ts 离线评测工具。 | [README](archive/2026-09/session-trace-analysis/README.md) |
| 2026-09 | team-perf | Team 性能 01–06：削减账本 replay、读与 Thread 渲染成本，07 另立。 | [README](archive/2026-09/team-perf/README.md) |
| 2026-09 | ui-parity-0.1.7 | 0.1.7 UI 设计语言再基线：重锚 audit needles、B 类可读性与半径分档。 | [README](archive/2026-09/ui-parity-0.1.7/README.md) |
| 2026-09 | windows-e2e-validation | Windows 原生 e2e 排查：#7 回归与 Windows 路径语义，F1–F11 归因并修复 F11。 | [README](archive/2026-09/windows-e2e-validation/README.md) |
| 2026-10 | agent-maintainability-review | 可维护性与检查有效性两轮只读审查：边界检查改读语法树，非 owner accept 无断言另开票，200 字符规则不装。 | [README](archive/2026-10/agent-maintainability-review/README.md) |
| 2026-10 | attention-delivery-model | Attention 决定普通更新的未读与唤醒资格：身份只建立默认关注，删 owner 阈值，Main stream 并入同一体系，工具结果说明 follow 来源。 | [README](archive/2026-10/attention-delivery-model/README.md) |
| 2026-10 | auto-compaction-migration | 自动压缩迁移：改用 DSH 默认压缩引擎与模板，删 Team 摘要副本与旧写入口。 | [README](archive/2026-10/auto-compaction-migration/README.md) |
| 2026-10 | channel-page-redesign | Channel 页面分流重设计：切片 1–3 合入，看板归属由 project-ownership-model 取代。 | [README](archive/2026-10/channel-page-redesign/README.md) |
| 2026-10 | comment-audit | 全量注释审查：删 1145 行复述代码的注释，A/B/C 档处理。 | [README](archive/2026-10/comment-audit/README.md) |
| 2026-10 | context-relevant-turn-reduction | Context 管理三动作（压缩/换代/回退）与状态面；机制落 continuity，本仓零机制代码。 | [README](archive/2026-10/context-relevant-turn-reduction/README.md) |
| 2026-10 | inbox-write-gate-redesign | Inbox 写入门重设计：两票落地、Reeve 通过、human 定规矩，结论进 boundaries。 | [README](archive/2026-10/inbox-write-gate-redesign/README.md) |
| 2026-10 | issue-43-triage | Issue #43 逐条复现判定：10+2 条中 5 成立/2 部分/3 不成立，按批准工单实施。 | [README](archive/2026-10/issue-43-triage/README.md) |
| 2026-10 | member-channel-participation-redesign | Member 参与 Channel 逻辑重设计：五票落码（放宽/复用/删管理面），待 Reeve 统一验收。 | [README](archive/2026-10/member-channel-participation-redesign/README.md) |
| 2026-10 | member-tool-surface-control | Member 工具面控制权：按 preset 限工具并拦截未声明工具；不隔离 prompt（用户接受边界）。 | [README](archive/2026-10/member-tool-surface-control/README.md) |
| 2026-10 | project-ownership-model | Project 与具名 Owner：参与派生改责任派生、规则版本 2、Task board 投影等 01–09。 | [README](archive/2026-10/project-ownership-model/README.md) |
| 2026-10 | quality-improvement | 质量改进：研究收敛为 spec 加七张依赖排序票（context 续期、lifecycle、附件幂等）。 | [README](archive/2026-10/quality-improvement/README.md) |
| 2026-10 | state-requests-diagnostics | 状态机/数据请求/诊断日志 6 票完成：成员隔离、共享读取、有界投影、规模与故障验收。 | [README](archive/2026-10/state-requests-diagnostics/README.md) |
| 2026-10 | team-performance-optimization | 单次通知读取与计划复用、按 Member 保序派发；真实工具协作与固定版本评测完成，分别报告提交收益和总派发代价。 | [README](archive/2026-10/team-performance-optimization/README.md) |
| 2026-10 | team-tools-model-eval | Team 工具 × gpt-6.1-sol 系统评测：两层 harness 加语料加修复 a03c0a0，Task #4 accept。 | [README](archive/2026-10/team-tools-model-eval/README.md) |
| 2026-10 | thread-quoting-and-mentions | Thread 引用与 mention 语义：读侧引用、「提到了你」、开 Thread 落点、引用送达作者。 | [README](archive/2026-10/thread-quoting-and-mentions/README.md) |

## 临时材料和 UI 证据

`.scratch/local/`、`.scratch/active/`、`artifacts/` 和 `artifacts/browser/` 被 Git 忽略。临时日志、agent handoff、下载物、调试截图和日常 browser test 输出放在那里，不进入归档。工作项结束时从 `active/` 移入 `archive/YYYY-MM/<work>/`，归档结果进入 Git 历史。

UI 改动需要真实浏览器自检时，`npm run test:browser` 会把本次截图写入 `artifacts/browser/`。它们用于审查本次改动，不是自动视觉回归基线，也不会改动 Git 工作区。只有人工确认能说明已完成工作项验收结论的少量代表图，才复制进对应归档的 `archive/YYYY-MM/<work>/validation/`；每张图都必须在同目录 README 中说明证明的验收点和复跑命令。一个浏览器 journey 跨多个 UI ticket 时，可以像本仓库一样集中保存。

详细 UI 改动检查和证据选择规则见 [`../docs/development/generated-and-seams.zh.md`](../docs/development/generated-and-seams.zh.md)。
