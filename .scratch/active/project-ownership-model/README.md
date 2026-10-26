# Project 与具名 Owner

> 本工作项是 Channel → Project 的重设计容器：把“参与派生注意力”改成“责任派生注意力”。它不定义当前产品行为——行为以 `packages/` 源码、测试与 `docs/` 双语对为准。

**状态**：01–09 已完成；2026-10-26 复核修复与文档同步已完成，保留 dev profile 试用观察。

**最后核对日期**：2026-10-26

## 入口

- [`spec.md`](spec.md)：最终决策快照，唯一的设计入口。
- [`materials/2026-10-25-final-v2-decisions.md`](materials/2026-10-25-final-v2-decisions.md)：08/09 实施前补充决定；最终只有规则版本 2，不保留中间 v3/v4。
- [`materials/2026-10-22-durable-contract.md`](materials/2026-10-22-durable-contract.md)：operation kinds、投影、Remote 与 tool 形状、replay 不变量；其 v3/v4 分批表述由上面的补充决定取代。
- [`materials/2026-10-22-convergence-agenda.md`](materials/2026-10-22-convergence-agenda.md)：四轮讨论的逐项结论与理由。
- 其余 `materials/` 与 [`review-notes.md`](review-notes.md) 是历史过程材料，与 `spec.md` 冲突时以 `spec.md` 为准。

## 当前前沿

- 01–09 均已完成，正式文档双语对、`CHANGELOG.md` 与发布 runbook 已同步。未提交、未推送；后续 commit/push 需 Human 明确要求。
- 2026-10-26 复核后落地两项行为修复：新 reopen 用始终存在的 `refollowedMembers`（可为空）记录恢复 accountable 的当前 Thread follow，排除操作者与已 following 者；旧 reopen 缺失字段时仍按 marker-only 重放，不提升 rules version。提醒在读取源头按当前 durable 条件过滤，进展、转交、新 episode 等旧提醒不再进入 Inbox、唤醒计划或剩余未读；不改写 ledger、不重查运行时 idle，suspend 保留。
- Agent 待验收的 `idle >= 30min` 与 error 清 idle 保持设计，继续试用观察。统计脚本 `scripts/team-trial-metrics.ts` 要求显式传入 SQLite 副本，复用账本投影统计 §11 指标；输出的是候选通知事实而非实测唤醒，失效提醒只供人工复查误报。`scripts/check-team-trial-metrics.ts` 覆盖空账本、非法输入、回复、UTC 自然日及提醒失效/消费。
- 真实账本仅以在线备份副本验证，原文件未写入。2026-10-26 副本 24625 条 operation 全量重放通过；18 条 reopen 全为 legacy，0 条新判别形状。试用范围为 sequence 24534–24625（2026-10-24T14:27:31.110Z 至 2026-10-26T01:45:36.931Z）：Agent 回复 11 条，Agent 间回复 0 条；accept/close 4 次均由 Human 执行；非 owner Main stream 发言 0 条；提醒 5 条（待验收 2、停滞 3），4 条已消费、1 条未读且仍有效，无失效未读。样本未覆盖完整一周，继续观察。
- 本轮验证：浏览器 8/8；UI parity 0 errors / 0 warnings；桌面与 390×844 截图已核对。最终全量检查见本次交付记录。
- 01 已完成（`feat: read the project spelling of stored channel records`），等待发布到稳定 profile。
- 02 已完成（`refactor: rename channel to project across the bundle`），等待 Human 在本地 dev profile 用真实 `agent_team.sqlite` 副本验收。发布顺序：先发布含 01、不含 02 的版本并装到稳定 profile，再让开发 profile 使用 02。
- 03 已完成（`feat: record rules version adoption in the team ledger`）。04 已完成（`feat: add project owners to the team ledger behind rules version 2`）。05 已完成（`feat: add the main stream and owner-only thread start behind rules version 2` 及 Client 的 `feat: show the project main stream with thread cards behind rules version 2`）。
- 06 已完成：通知按角色投递（owner 的 Main stream 消息与新讨论立即通知其他 owners；owner 的普通 Thread 消息按每 Member × 每 Thread 累计 5 条汇总，其余 follower 的普通消息立即通知）、Inbox 的 Main stream 行、persona 与 `team-domain-model` skill，`AGENT_TEAM_RULES_VERSION` 升到 2，Client 删除版本 1 的旧 feed、`@all` 与邀请确认；Host 侧版本 1 写路径仅为 replay 校验保留。预览开关 `DSH_AGENT_TEAM_PREVIEW_RULES` 一并删除。
- 07 已完成：`taskBoard` 投影与 Remote 方法、`team_task` board 读取、`team_claim` 并入 `team_task`、`team_view` 不再返回 active task threads，Human 项目看板与全局看板均直接读取 Host 投影。
- 08 全量验证：1253 单测、typecheck/build/lint、UI 审计基线、浏览器 8/8。真实 `agent_team.sqlite` 已由 dev profile 在 08 构建上续用；≤0.2.5 的稳定 profile 仍会拒绝打开带版本 2 标记的账本，发布时按升级说明同步所有 profile。
- 08 发布前的两次重放修复：legacy 读取快照按写入时代的 direct 规则校验（mention-only）；06/07 未发布 dev 形状（Task 创建无活动、Claim 转换无责任 marker）按当时写入的样子重放。真实开发账本因此无需重建，此前的「中间 v2 账本重建」口径由这两项容忍取代；10-25 曾误截掉 32 条真实使用（owner 指派与主对话消息），已从备份完整恢复，教训是截断真实账本前必须按 occurredAt 与用户核对数据归属。
- `spec.md` §13 三项探针：DM 的 Workspace 边界已在 Host `sendDm` 校验；旧 accept 缺 `acceptedClaimRefs` 时已有回退，03 补测试；规则标记与启动恢复的写入顺序已在 03 查清并由 `initialize()` 保证。
- 版本 2 的规则在 04–06 间逐步落地；预览开关 `DSH_AGENT_TEAM_PREVIEW_RULES` 已移除，版本 2 是默认规则，无需任何环境变量。
- 08 已完成：Task 带 `accountable` 与不可变 `sourceThreadRefs`（仅同 Project 无 Task 讨论）；Agent 仅可验收 `in_review` 且从未持有该 Task 任何 Claim（含 released），执行过的 accountable 只能 close/reopen/transfer；close/reopen/transfer 限 Human 或当前 accountable，已结束 Task 仅 Human 可转交；owner 撤销/离开/归档/删除在同一 operation 把 open Task 原子转回 Human 并记公开 transfer 活动（Project 归档对全部 owner 生效，suspend 保留）；责任事件按角色进 Inbox direct 级（activity marker 计入 direct，投递一律 immediate）；看板带 `relation: 'accountable'` 与 `needsAcceptance`；来源 Task 不进 Main stream，来源讨论以只读卡片投影显示（不改 revision、不产生未读）；`team_task` 增加 accept/close/reopen/transfer，`team_message.start` 支持 accountable 与来源；persona 与 skill 同步。遗留：suspend 的「负责人已暂停」界面提示、Agent 侧 `team_thread` 渲染来源讨论派生 Task 卡（Host 已返回 `taskCards`）归入 09。Human 项目看板与全局看板已显示负责人（你负责/负责人 X）与「待你验收」徽标（Host 条目带 `accountableOwner`）。
- 09 已完成：事件评估的待验收/停滞提醒（durable episode 跨重启去重、私有 marker 仅 Task Thread read 消费、无 timer、Agent idle 仅进程内可确认观测、写入边界防交错、生命周期清理补齐）；来源讨论 Agent Task 卡与「负责人已暂停」显示同批交付。最终验证 1279 单测通过、1 跳过，真实 Web 8/8，真实账本 24565 条全量重放通过。首次历史数据有 4 个 Human-time 候选，后续只在 Team 事件评估点写入，不主动定时补发。
- 08/09 的补充决定：Agent 仅在 `in_review` 验收；已结束 Task 不在 owner 失效时批量转交，reopen 前必须显式修正失效 accountable；同一事项已有未读责任通知时不追加超时提醒。最终只有 v2，开发中间 v2 账本不承担公开迁移承诺。

## 完成条件

- [x] 01 读得懂 Project 写法的发布
- [x] 02 Channel 全仓改名为 Project（真实 ledger 验收待 Human）
- [x] 03 规则版本机制
- [x] 04 Agent owner 与 Project member 派生
- [x] 05 项目主对话与开 Thread 权限
- [x] 06 按责任投递、Inbox 与 Agent 指引；启用规则版本 2（交付后 Human 在 dev profile 试用一周，按 `spec.md` §11 的指标复盘再继续）
- [x] 07 Task board 投影与 `team_task`
- [x] 08 Task 负责人、转交与验收限制（属于最终规则版本 2；suspend 的界面提示归入 09）
- [x] 09 待验收积压与停滞提醒
- [x] durable 结论进入正式文档双语对与 `CHANGELOG.md`
- [x] 面向外部使用者的升级说明：升级后所有项目只有 Human owner，需重新指定 Agent owner；先备份 `agent_team.sqlite`；不承诺降级
- [ ] dev profile 积累完整试用周期，按 `spec.md` §11 与统计脚本复盘提醒误报和 Agent idle 条件

## 正式文档出口

`docs/domain-model.zh.md`（Project、Project member、owner、accountable、Main stream）、`docs/team-collaboration/boundaries.zh.md`（权限与 fence）、`docs/team-collaboration/attention-and-messaging.zh.md`（Inbox、投递等级、mention 与回复）、`docs/team-collaboration/tools.zh.md`（七工具，含 `team_task`）、`docs/team-collaboration/model-and-time.zh.md`（事件评估的时间条件）、`docs/architecture/tools-and-preset.zh.md`（persona 与 core skill）、`docs/frontend-design/components.zh.md`（composer、卡片、看板）的双语对，以及 `CHANGELOG.md`。九张工单交付后，本目录移入 `.scratch/archive/<完成月份>/`，并按 `.scratch/AGENTS.md` 把该移动 amend 进交付它的 commit。

## 调研证据

- 真实 ledger 60 天使用审计（24293 条 operation）与 22 个未归档 Channel 的参与度统计，摘要见 `spec.md` §0、§14。统计脚本与原始报告在 `/tmp/team-audit/`、`/tmp/channel-participation/`（临时产物，未入库）。
- Raft 的 11 篇一手 blog：pull-based inbox、构造初始 context、builder ≠ verifier。

## 与其它工作项的关系

`channel-page-redesign` 的 issue 04（看板的数据源与归属）由本模型取代：看板改读 Host 的 Task board 投影（工单 03）。该工作项其余三张票已合入 master，作为本模型的 UI 前提保留。
