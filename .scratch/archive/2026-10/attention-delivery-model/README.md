# Attention 与投递：统一普通更新的自动发现

> 本工作项把「身份影响普通更新投递」改成「Attention 决定普通更新的未读与唤醒资格，身份只建立默认 Attention」，并让 Agent 在 context 中理解和管理 follow/unfollow。
> 它不定义当前产品行为——行为以 `packages/` 源码、测试与 `docs/` 双语对为准。

**状态**：模型与关键取舍已获 Human 确认；5 张 tickets 全部完成，经一轮只读评审（[`reviews/01-attention-delivery-model.md`](reviews/01-attention-delivery-model.md)）修完全部 blocker 与 major，全量检查通过。唯一未完成项是 Human 在 dev profile 的体感试用——那是人工验收，不阻塞归档。

**最后核对日期**：2026-10-28

## 入口

- [`DESIGN.md`](DESIGN.md)：已确认模型、迁移原则、Agent 指导和验收测试缝，是唯一设计入口。
- [`issues/`](issues/)：5 张 vertical-slice 实施票据，按依赖顺序编号，每张可独立验收。
- [`materials/2026-10-27-findings.md`](materials/2026-10-27-findings.md)：改动前的实测证据与代码调查。
- 上位工作项 [`project-ownership-model/spec.md`](../../archive/2026-10/project-ownership-model/spec.md)（2026-10-28 归档）：其 §1 与 §7 的 Attention 矛盾由本工作项消解，其余权限与责任结论保持。

## 当前前沿

- 已确认：Thread 与 Main stream 的普通更新统一由 Attention 决定；follow 即具备立即唤醒资格；删除 owner 的 5 条 threshold。
- 已确认：owner 默认 follow Main stream，不默认 follow 全部或未来 Thread；accountable、Claim executor、Thread 作者继续自动 follow 对应 Thread。
- 已确认：@、reply、责任事件和 reminder 不依赖 Attention；有 active Claim 时不能 unfollow；身份撤销不自动收回既有 Attention。
- 已确认：persona/system prompt、自动/显式 follow 与 unfollow 的工具结果、读取和通知要帮助 Agent 理解并管理 Attention。
- Tickets 已拆为 5 张垂直切片（[`issues/`](issues/)），全部完成：01 Thread 投递改判 Attention → 02 移除 threshold 簿记 → 03 Main stream 并入 → 04 默认 Attention 与身份变化 → 05 Agent 指导。
- 提交：`7761537`（01）、`f821206`（02）、`51f58d8`（03）、`8a27985`（04+05）。
- 追加：`7558dfd` 修旧账本打不开；`80a6e0d`/`fde555a`/`f4c44d4` 修评审发现的唤醒、成员门禁、授权覆盖、通知预算等问题；`23ed8ee`/`0a19c52` 加 Attention source 字段；`3fb6bed`/`8a23163` 修 source 字段的三个 blocker。
- 未开始：Human 在 dev profile 试用并确认普通更新、unfollow 和责任通知的实际体感。

## 完成条件

- [x] `DESIGN.md` 记录已确认的形状、关键决策、理由、迁移原则与测试缝
- [x] Main stream 与 Thread 共用普通 Attention 语义，threshold 和旧身份投递分支移除
- [x] 现有 owner 的默认 Main stream 关注及未读连续性迁移并通过重放验证
- [x] Agent prompt、工具结果和通知覆盖 follow/unfollow 语义及已确认场景
- [x] 双语正式文档、core skills、package README（若涉及）与 `CHANGELOG.md` 同步
- [ ] Human 在 dev profile 试用并确认普通更新、unfollow 和责任通知的实际体感（人工验收，未完成）

## 正式文档出口

`docs/domain-model.*`、`docs/team-collaboration/attention-and-messaging.*`、`docs/team-collaboration/tools.*`、`docs/team-collaboration/memory-and-context.*`、`docs/architecture/host-authority.*`、`docs/architecture/tools-and-preset.*`、`packages/agent-team/core-skills/team-domain-model/`、相关 package README 与 `CHANGELOG.md`。按实际改动选择 owner 文档，不在多份文档重复同一规则。

## 与其它工作项的关系

- 继承 `project-ownership-model` 的权限与责任模型，明确不恢复其已撤回的 Thread participant 层。
- [`../agent-tools-context-rendering/`](../agent-tools-context-rendering/) 负责统一审视 tool result、错误、通知和 prompt/context 的呈现机制；本工作项提供 Attention 这个首个完整用例及必须表达的语义，两个工作项不互相扩张范围。
