# 团队管理会话

- **状态：** D1–D21 的产品方向已收口；设计已对照 Team 与 Harness 源码核对，实施未开始。起点是 [issue #64](https://github.com/Contexera/dsh-agent-team/issues/64) 下「由一个 Agent 创建与管理全局 Agents」的提议。Human 将它定为常驻的团队管理入口。以[设计快照](spec.md)为准；[产品与现状](materials/facts.md)、[Harness 能力](materials/harness-support.md)和[领域用语](materials/vocabulary.md)提供依据。
- **最后核对：** 2026-11-09。
- **当前进度：** [01 会话入口](issues/01-owner-session-entry.md) 可开始。[02 读取](issues/02-owner-reads-team.md) → [03 组建](issues/03-staff-a-project.md) → [04 调整](issues/04-adjust-team.md) 依次等待前一张工单。[05 wiki、记忆与 skills](issues/05-owner-wiki-and-memory.md) 只等待 01；首版 wiki 范围已确认。
- **完成条件：** 01–05 各自通过验收；真实 Web 组装验证会话与提问卡；管理写入能解释拒绝、部分成功和撤权；dev profile 验收组建、调整和引导场景。
- **正式文档归宿：** 术语与产品定位 → [领域模型](../../../docs/domain-model.md) 和[项目 README](../../../README.md)；权限、工具与恢复 → [Host 权威](../../../docs/architecture/host-authority.md)、[工具与 preset](../../../docs/architecture/tools-and-preset.md)、[Workspace 和 Session](../../../docs/architecture/workspace-session-storage.md)及[协作契约](../../../docs/team-collaboration/)。

## 已定决策

- D1 表达对齐：`materials/vocabulary.md` 的复述准确（2026-11-09）。
- D2（已由 D8 取代）它是普通 Agent Member：同样的身份、记忆、skills、Inbox 与账本规则；「管团队」是授予的关系，不新增 Member 种类。
- D3 职责是「团队本身」：经营团队（成员名单、配置、owner 分工）、带 Human 入门、主动提出团队结构问题。不叫 onboarding，因为它是常驻的。
- D4（确认方式以 D14 为准）信任边界：扩大信任或不可撤回的步骤（新建成员 = 交出 `danger-full-access`、授予 owner）由 Human 确认；它可以提方案、做准备。
- D5 确认载体（推翻早前「提议」账本记录的方案）：不新增确认机制，由 prompt 要求它在特定操作前向 Human 确认。
- D6 入口：Team mode 侧栏上与「收件箱」「任务看板」并列的一项，位于 Workspace 选择器之上，即 home 级。倾向让它管理所有 Workspace 的 team。
- D7 入门引导：先配置一份文档 wiki，不做额外的引导流程。
- D8 Team owner 的定性（推翻 D2）：不是 Agent Member，也不是账本实体，而是与收件箱、任务看板并列的**功能入口**。点开就是一条专用的 agent Session，单独为它配 tools、wiki、skills、prompt。它是全局的，不存在转交，也不计「几个人持有」。
- D9 确认方式：在 Session 内用 ask-user 类工具让 Human 直接看到选项并选择（能力证据见 Harness 核对）。
- D10 移除成员只交给 Human，Team owner 不做。工具覆盖哪些操作按场景选定。
- D11 工具与 prompt：不复用 `team-member` 的九个工具和 persona，采用独立 preset 和 persona。
- D12 通用工具（修订早前只读方案）：bash、read 等通用工具照给，不限成只读。具体清单见设计，sandbox 模式见 D17。
- D13 拆分专用工具（修订单个 `team_admin` 的方案）：`team_admin` 拆成较原子的工具，拆法见 D16。
- D14 确认靠判断（修订「每次写操作都确认」）：何时用 `ask_user_question` 交给它自己判断，prompt 给原则，不定死规则。移除成员仍不提供（D10）。
- D15 侧栏入口文案：「团队管理」。
- D16 专用工具采用以下 8 个（`team_overview`、`team_models`、`member_create`、`member_update`、`member_state`、`member_workspace`、`project_create`、`project_owner`）。
- D17 sandbox 为 `danger-full-access`；它可以优化成员的 memory 与 skills，prompt 不加限制。
- D18 Ungrouped 可见性：Human 同意出现在 Ungrouped，倾向用 archive 隐藏并固定命名防误删。已查实 archive 不可行：`ArchivedSessionGate` 拒绝归档 Session 的模型步骤。
- D19 不隐藏，Team 入口名固定，新会话的初始标题为「团队管理」，留在 Ungrouped 下；不向 Harness 提扩展点。被 Human 归档后，入口下次打开时自动新开对话。
- D20 首版 wiki 覆盖 Team 用法、成员管理和一条完整组队示例。整理其他成员的 memory/skills 保留为可按需执行的能力，不纳入首版 wiki 验收。
- D21 管理会话在自己的目录复用 Team 的 `memory.md`、`notes/`、`skills/` 约定。内置 wiki 和可配置的自有 skills 只挂到管理会话，换会话时保留目录。
