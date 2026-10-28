# Attention 与投递：统一普通更新的自动发现

> 本工作项把「身份影响普通更新投递」改成「Attention 决定普通更新的未读与唤醒资格，身份只建立默认 Attention」，并让 Agent 在 context 中理解和管理 follow/unfollow。
> 它不定义当前产品行为——行为以 `packages/` 源码、测试与 `docs/` 双语对为准。

**状态**：2026-10-28 实施完成并归档。重新打开后的 blocker、major 和测试缺口已修复；全量门禁、浏览器验收和真实 dev-profile 账本重放均通过。Human 在 dev profile 的体感试用保留为日常运行验收，不阻塞实现归档。

**最后核对日期**：2026-10-28

## 入口

- [`DESIGN.md`](DESIGN.md)：已确认模型、迁移原则、Agent 指导和验收测试缝，是唯一设计入口。
- [`issues/`](issues/)：5 张 vertical-slice 实施票据，按依赖顺序编号，每张可独立验收。
- [`reviews/01-attention-delivery-model.md`](reviews/01-attention-delivery-model.md)：归档前的只读评审与修复记录。
- [`reviews/02-final-completeness-review.md`](reviews/02-final-completeness-review.md)：重新打开本工作项的最终完成度复核，含复现步骤、根因和修复建议。
- [`materials/2026-10-27-findings.md`](materials/2026-10-27-findings.md)：改动前的实测证据与代码调查。
- 上位工作项 [`../../archive/2026-10/project-ownership-model/spec.md`](../../archive/2026-10/project-ownership-model/spec.md)（2026-10-28 归档）：其 §1 与 §7 的 Attention 矛盾由本工作项消解，其余权限与责任结论保持。

## 当前前沿

- 已确认的领域模型不变：Thread 与 Main stream 的普通更新统一由 Attention 决定；follow 即具备立即唤醒资格；owner 的 5 条 threshold 已删除；owner 默认 follow Main stream，不默认 follow 全部或未来 Thread；@、reply、责任事件和 reminder 不依赖 Attention。
- Tickets 01–05 的领域行为已落地：`7761537`（01）、`f821206`（02）、`51f58d8`（03）、`8a27985`（04+05）。
- 评审后追加：`7558dfd`、`80a6e0d`、`fde555a`、`f4c44d4`、`23ed8ee`、`0a19c52`、`3fb6bed` 等。
- **已修复的复核问题**：legacy Thread read snapshot 不再把新增的 `Attention.source` 当作旧快照字段校验；legacy read delta 继承已有 Attention 来源；Main 普通 follower 与 owner 变化都会触发有界唤醒；模型文案、core skill、试用指标和两个测试缺口已同步。
- **明确的设计边界**：Human 的 Main stream Attention 是随 Project 派生的强制关注，不能 unfollow；Agent Member 可以显式 follow/unfollow。该边界已写入正式文档和测试。
- 已验：`npm run test:browser` 9/9 场景通过；真实 dev-profile 账本副本 25,575 条操作通过重放。后续由 Human 在 dev profile 试用并确认普通更新、unfollow 和责任通知的实际体感。

## 完成条件

- [x] `DESIGN.md` 记录已确认的形状、关键决策、理由、迁移原则与测试缝
- [x] Main stream 与 Thread 共用普通 Attention 语义，threshold 和旧身份投递分支移除
- [x] 现有 owner 的默认 Main stream 关注及未读连续性迁移（合成用例通过）
- [x] 真实 dev-profile 账本可用当前构建完整重放，Host 正常启动（25,575 条操作副本已通过）
- [x] 模型可见文案（tool description、core skill）与试用指标脚本与 Attention 模型一致
- [x] 票据 02.6 的失败重试测试真正注入失败；票据 05.3 补齐“更早内容可读”
- [x] Agent prompt、工具结果和通知覆盖 follow/unfollow 语义及已确认场景的主体部分
- [x] 双语正式文档、core skills、package README（若涉及）与 `CHANGELOG.md` 同步的主体部分
- [x] `npm run test:browser` 覆盖 assembled Web bundle 和普通 DSH restoration
- [ ] Human 在 dev profile 试用并确认普通更新、unfollow 和责任通知的实际体感（后续操作验收）

## 正式文档出口

`docs/domain-model.*`、`docs/team-collaboration/attention-and-messaging.*`、`docs/team-collaboration/tools.*`、`docs/team-collaboration/memory-and-context.*`、`docs/architecture/host-authority.*`、`docs/architecture/tools-and-preset.*`、`packages/agent-team/core-skills/team-domain-model/`、相关 package README 与 `CHANGELOG.md`。按实际改动选择 owner 文档，不在多份文档重复同一规则。

## 与其它工作项的关系

- 继承 `project-ownership-model` 的权限与责任模型，明确不恢复其已撤回的 Thread participant 层。
- [`../agent-tools-context-rendering/`](../agent-tools-context-rendering/) 负责统一审视 tool result、错误、通知和 prompt/context 的呈现机制；本工作项提供 Attention 这个首个完整用例及必须表达的语义，两个工作项不互相扩张范围。
