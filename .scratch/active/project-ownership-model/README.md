# Project 与具名 Owner

> 本工作项是 Channel → Project 的重设计容器：把“参与派生注意力”改成“责任派生注意力”。它不定义当前产品行为——行为以 `packages/` 源码、测试与 `docs/` 双语对为准。

**状态**：设计已收敛（产品决策与 durable contract 草案均完成），尚未实施；实施未获授权。

**最后核对日期**：2026-10-22

## 入口

- [`spec.md`](spec.md)：最终决策快照，唯一的设计入口。
- [`materials/2026-10-22-durable-contract.md`](materials/2026-10-22-durable-contract.md)：operation kinds、规则版本标记、投影、Remote 与 tool 形状、replay 不变量。
- [`materials/2026-10-22-convergence-agenda.md`](materials/2026-10-22-convergence-agenda.md)：四轮讨论的逐项结论与理由。
- 其余 `materials/` 与 [`review-notes.md`](review-notes.md) 是历史过程材料，与 `spec.md` 冲突时以 `spec.md` 为准。

## 当前前沿

- 工单 [`01`](issues/01-project-rename-and-model-adoption.md) 为 `ready`，等待 Human 授权实施；02–04 依次被前一张阻塞。
- `spec.md` §13 列出实施前需探针确认的三项，在 01 开工时先做。
- 无需要 Human 拍板的未决产品问题。

## 完成条件

- [ ] 01 全仓改名（不改变行为）
- [ ] 02 Owner、Main stream 与按责任投递；完成后 Human 在 dev profile 试用一周，按 `spec.md` §11 的指标复盘再继续
- [ ] 03 Task 责任与任务看板
- [ ] 04 事件评估的提醒
- [ ] durable 结论进入正式文档双语对与 `CHANGELOG.md`
- [ ] 面向外部使用者的升级说明：升级后所有项目只有 Human owner，需重新指定 Agent owner；先备份 `agent_team.sqlite`；不承诺降级

## 正式文档出口

`docs/domain-model.zh.md`（Project、Project member、owner、accountable、Main stream）、`docs/team-collaboration/boundaries.zh.md`（权限与 fence）、`docs/team-collaboration/attention-and-messaging.zh.md`（Inbox、投递等级、mention 与回复）、`docs/team-collaboration/tools.zh.md`（七工具，含 `team_task`）、`docs/team-collaboration/model-and-time.zh.md`（事件评估的时间条件）、`docs/architecture/tools-and-preset.zh.md`（persona 与 core skill）、`docs/frontend-design/components.zh.md`（composer、卡片、看板）的双语对，以及 `CHANGELOG.md`。四张工单交付后，本目录移入 `.scratch/archive/<完成月份>/`，并按 `.scratch/AGENTS.md` 把该移动 amend 进交付它的 commit。

## 调研证据

- 真实 ledger 60 天使用审计（24293 条 operation）与 22 个未归档 Channel 的参与度统计，摘要见 `spec.md` §0、§14。统计脚本与原始报告在 `/tmp/team-audit/`、`/tmp/channel-participation/`（临时产物，未入库）。
- Raft 的 11 篇一手 blog：pull-based inbox、构造初始 context、builder ≠ verifier。

## 与其它工作项的关系

`channel-page-redesign` 的 issue 04（看板的数据源与归属）由本模型取代：看板改读 Host 的 Task board 投影（工单 03）。该工作项其余三张票已合入 master，作为本模型的 UI 前提保留。
