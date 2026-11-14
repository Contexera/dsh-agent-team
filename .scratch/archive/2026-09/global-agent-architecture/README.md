# Global Agent Member — 全局身份与 Workspace 参与模型

上游诉求：wowyuarm/dsh-agent-team [issue #16](https://github.com/wowyuarm/dsh-agent-team/issues/16)「全局 Agent 成员」——多个 Workspace 是同一仓库的不同分支 checkout，并行开发；希望同一个 Agent 可跨这些 Workspace 共用，并维护同一份经验。对应 Team 工作线：thread:34600db8-38a6-4d52-8719-7e3a98f853dd / task:d00c53fb-6f19-49e4-b954-10bf63798149，当前 Claim `claim:29609c74`。

## Status

archived 2026-09-17 —— 三张 ticket 全部实施完成，设计与实现随 PR #26 提交（归档时 PR 未合并：Vera 非 UI 面已验收，Iris UI review 中）。研究证据在 [`materials/design-space-audit.md`](materials/design-space-audit.md)。正文是实施过程中的工作记录，归档即历史，不改原文；仅本节与完成条件按归档时状态订正。文中引用的 PR 分支 commit hash 是 rebase 前的，以 PR 当前头为准。

last-checked: 2026-09-17（归档；PR 已 rebase 到 master `3fad03d` 之上，`npm test` 644 通过、`test:browser` 2 passed；账本 seq 为实施当时值）。

## Goal

把「一个 Agent 身份」与「它在哪些 Workspace 协作」拆开：参与集合管授权范围（能去哪），默认 Workspace 管 Session 落点（cwd + presence）。对 Member 来说 **Workspace 是地址不是位置**——每个协作刺激自带 Workspace 路由，唯一 Session 的 cwd 只是文件相对路径的解析根。身份级资产本就 memberId 键控——「身份一份 ⇒ 经验一份」，且单一上下文使经验字面共享。

## Current frontier

1. ~~等 Human 验收 spec.md~~ **已验收**（2026-09-16，含 §9 全部分档裁决）。
2. **Ticket 01 实施完成**（PR 分支 commit `c176b7c`）：参与账本操作（`team/member-workspace-joined`/`left`，含幂等、replay 校验、释放快照）、授权全量改参与集合（ledger 12 处 + Host 5 处）、handle 唯一性改参与重叠判定（新增 4 个用例：join/leave 重放与幂等、按 workspace 撤回清理与竞态拒绝、跨参与 handle 碰撞、Host 层 join→在 B 发消息→撤回→Session 不动）。
3. **Ticket 02 实施完成**（PR 分支 commit `7bf4dde`）：协作工具 `workspace` 寻址（多参与缺省参数级拒绝并列可选集）、动态引导段（参与 >1 时注入地址+路径+AGENTS.md 指针+绝对路径规则+歧义问 @human；=1 零变化）、join/leave 提交即推通知（实测 idle Member 被唤醒读到“Session 与 cwd 未动”）、`team_inbox` 改跨参与合并（ledger `memberInbox` 统一过滤/排序/截断，每行带 `workspaceId`，`workspace` 参数降级为可选过滤）、通知 hint/DM relay 带 Workspace 来源、team_thread/team_view 输出与渲染带 Workspace/Channel 标签。对抗用例（跨参与 mention→live Session→回 B）的完整模型时序断言不稳定，已由确定性断言替代：join 通知内容（lifecycle 用例）+ 合并 inbox 来源标签 + 工具缺省拒绝。`npm test` 624 通过。
4. **Ticket 03 实施完成**（PR 分支 commit `855a1d6`，含 suspended 成员引入修复）：创建对话框内「从其他 Workspace 引入」disclosure 入口（全局名册减去已参与，含 suspended——join 不依赖可用性，与 Host 行为对齐；loading/读失败重试/真实空态；join 走持久 Remote、requestId 失败复用）；行破坏性动作分档（非创建 workspace = 撤回参与，创建 workspace = 全量归档 + 其他参与数提示）；`members` 远端支持全局查询并随行返回 `workspaceIds`，Client 不叠加过滤。组件测试 21/21（新增 3 用例：引入+重试同请求+仅此处撤回、引入三态含 suspended 行、多参与归档警告+失败保留）、`audit-ui-parity`、`test:browser` 三次通过（含 6f6989c 之后一次），桌面/390×844 截图已人工核验；`npm test` 627 全绿；domain-model / frontend-design / team-collaboration / tool-agent-team README 双语已同步；ticket 03 提交同时完成了 team-collaboration 契约的 workspace 选择器语义修订。
5. **已知边界与后续**：(a) 本轮 Member 仍只有创建 workspace 的一条 live Session——按参与切分 Session 血统（每 workspace 一条、可切换）属 spec B-full 档，未实施，等 Human 排期；引入/撤回的真实浏览器旅程目前由组件测试覆盖，E2E 只加引入空态留证（跨 workspace E2E 待后续硬化项）。(b) 贡献者 MR 评审基准：候选 commit `67234ca`/`247e6ac` 评估在 materials；按 spec 逐条核对。

## Completion conditions

- Human 接受 spec.md 方向。 **(已验收 2026-09-16)**
- 三张 ticket 全部 complete，每片端到端可验证。 **(已完成，见上；PR 未合)**
- 「全局 Member 能做什么、不能做什么」一句话可答：身份全局、参与即协作、Session 永驻默认 Workspace、跨参与文件用绝对路径、通知可达带来源。 **(spec 已写明)**
- 候选实现的任何可复用部分以新 commit 吸收，不直接合入未按 spec 放宽授权的 PR。 **(规则已写明)**

## Formal-doc exit

- Workspace Participation 词条 + Member/Workspace 修订 → `docs/domain-model.md`。**(ticket 03)**
- Host 参与生命周期表述 → `docs/architecture/README.md`。**(ticket 03)**
- 工具 workspace 寻址参数契约 → `docs/team-collaboration/README.md`。**(ticket 02)**
- 过程材料：design-space-audit 保留在 materials/（含候选 commit 评估）；spec 验收后本工作项按 `.scratch` 生命周期归档。
