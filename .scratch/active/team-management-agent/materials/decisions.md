# 决策记录

本文件保存团队管理会话的决策编号、当前状态和已取代的早期方案。当前设计以 [`../spec.md`](../spec.md) 为准；这里解释为什么这样定，以及哪些早期方案不能再实现。编号沿用 README 早期的 D1–D25，便于对照历史讨论。

## 当前决策

- **D1 表达对齐：** `materials/vocabulary.md` 的复述准确（2026-11-09）。
- **D3 职责是「团队本身」：** 在对话中带 Human 理解并实践持续责任、owner 和 Worker 的协作方式，追问和挑战尚未想清楚的目标与分工，然后直接创建和调整成员、Project、owner 责任及配置。没有 Human 发起时的自主发现与复查属于后续演进（D25）。
- **D4 信任边界：** 扩大信任或不可撤回的步骤（新建成员 = 交出 `danger-full-access`、授予 owner）由 Human 确认；它可以提方案、做准备。确认方式以 D14 为准。
- **D5 确认载体：** 不新增确认机制；使用现有 `ask_user_question`，何时提问由模型按 D14 判断。早期「由 prompt 要求在特定操作前固定确认」的方案已由 D14 取代。
- **D6 入口：** Team mode 侧栏上与「收件箱」「任务看板」并列的一项，位于 Workspace 选择器之上，即 home 级。管理所有 Workspace 的 team（由 `team_overview` 的读取范围确认）。
- **D7 入门引导：** 先配置一份文档 wiki，不做额外的引导流程。
- **D8 Team owner 的定性：** 不是 Agent Member，也不是账本实体，而是与收件箱、任务看板并列的**功能入口**。点开就是一条专用的 agent Session，单独为它配 tools、wiki、skills、prompt。它是全局的，不存在转交，也不计「几个人持有」。
- **D9 确认方式：** 在 Session 内用 ask-user 类工具让 Human 直接看到选项并选择（能力证据见 Harness 核对）。
- **D10 移除边界：** 永久移除成员（删除私有目录）不提供，Host 内部操作和 Web 都没有入口；归档是 `member_state` 的常规操作，Team owner 可以执行。早期「移除成员只交给 Human」的措辞指永久移除，不指归档。
- **D11 工具与 prompt：** 不复用 `team-member` 的十个协作工具和 persona，采用独立 preset 和 persona。
- **D12 通用工具：** bash、read 等通用工具照给，不限成只读。具体清单见设计，sandbox 模式见 D17。
- **D13 拆分专用工具：** `team_admin` 拆成较原子的工具，拆法见 D16。
- **D14 确认靠判断：** 何时用 `ask_user_question` 交给模型自己判断，prompt 给原则，不定死规则。永久移除仍不提供（D10）。
- **D15 侧栏入口文案：** 「团队管理」。
- **D16 专用工具：** 采用以下 9 个（`team_overview`、`team_models`、`member_create`、`member_update`、`member_state`［含 `recover`］、`member_workspace`、`project_create`、`project_update`［含改名/描述与 `archive`］、`project_owner`［含责任说明］）。
- **D17 sandbox 与文件边界：** sandbox 为 `danger-full-access`；它可以优化成员的 memory 与 skills。prompt 只加数据红线（不碰 sqlite、会话日志，不删除成员目录），不限制正常的文件与命令能力；「移除不提供」和模型提示不能承诺系统级隔离，设计沿用受信任本机执行前提。
- **D19 入口可见性：** 不隐藏入口，Team 入口名固定，新会话的初始标题为「团队管理」；被 Human 归档后，入口下次打开时自动新开对话。**「留在 Ungrouped、不加入 Workspace」的部分已被 D26 取代**；入口名、不隐藏和归档替换仍有效。
- **D20 首版 wiki：** 覆盖 Team 用法、持续责任与协作原则、成员管理和一条完整的责任建立/交接示例。整理其他成员的 memory/skills 保留为可按需执行的能力，不纳入首版 wiki 验收。
- **D21 管理会话目录：** 在自己的目录复用 Team 的 `memory.md`、`notes/`、`skills/` 约定。内置 wiki 和可配置的自有 skills 只挂到管理会话，换会话时保留目录。
- **D22 长期成员责任：** 每个 enabled 的长期 Agent Member 通常至少是一个 active Project 的 owner；可以在其他 Project 作为普通成员参与，但不应只作为执行人手存在。这不是 Host 硬约束，创建/撤权等过渡状态允许出现；`team_overview` 必须显示责任空缺。
- **D23 owner 责任关系：** 扩展 Project owner 关系的有界 `responsibility` 字段，与 Member 全局 `description`、Project 共同目标 `description` 分层。`team_overview`、成员 `team_view`、Member ownership context 和 Human 界面都应呈现；旧记录缺少该字段时显示未说明并可补齐。
- **D24 标准交接不依赖通用 DM：** `project_owner add/update` 携带责任说明，复用现有 owner Activity、Main 标记和提交通知；责任字段进入账本及后续上下文。首版不新增通用双向 DM 工具，也不建全员交接 Thread。未来双向 DM 需另定 Team owner 身份、回复和离线语义。
- **D25 Team owner 分阶段：** 首版就是对齐目标、建立直觉、设计并直接搭建/调整团队的 Team owner，引导只是其中一部分；它能依据我们的实践 grilling Human、读现状、提出责任结构并执行创建和授权。推后的是无需 Human 发起、像 Project owner 一样自行发现团队缺口并主动复查的机制，不是在对话中分析和经营团队的能力。
- **D26 入口 Workspace 归属：** 管理会话必须归属一个真实 Workspace。解析顺序：Harness 默认 Workspace（`workspace/initializeDefault` 按 `defaultWorkspaceId` 返回的 `<Documents>/deepseek-harness/default-workspace`，不是路径匹配）→ 没有默认 Workspace 时用 `workspaceRegistry.list()` 持久顺序的第一项 → 一个都没有时显示普通 DSH 的「选择/创建工作区」空状态。cwd 是所选 Workspace；私有 memory/skills 仍在 `$DSH_HOME/agent-team/owner/`；九个管理工具读全部 Workspace。不建专用 Workspace，也不为入口另造 Workspace 选择器。

## 已取代或否决的早期方案

保留这些方案是为了让后来者知道为什么不能实现，不需要重新讨论。

- **D2（已由 D8 取代）普通 Agent Member：** 早期把 Team owner 当作同样的身份、记忆、skills、Inbox 与账本规则，只是授予「管团队」关系。D8 改为功能入口，因为它不参与 Member 的协作、换代和账本关系。
- **D5 早期固定确认（已由 D14 取代）：** 由 prompt 要求在特定操作前向 Human 确认。D14 改为按判断提问，避免形式化确认。
- **D12 早期只读方案（已由 D12 当前版本取代）：** 曾考虑只给只读工具；当前允许通用文件与命令工具，靠数据红线约束。
- **D13 单个 `team_admin`（已由 D16 取代）：** 一个工具承载全部管理操作，参数和拒绝语义过重；改为九个较原子的工具。
- **D18 归档隐藏（已否决）：** 曾倾向用 archive 隐藏管理会话并固定命名防误删。已查实 `ArchivedSessionGate` 拒绝归档 Session 的模型步骤，归档后这条会话不能继续对话；D19 改为不隐藏、归档后自动新开。
