# 团队管理会话

- **状态：** 已收口。01–08 全部交付并 accept，功能整合到 `92db4ce`；最终工程验证、浏览器证据、真实账本备份与环境边界见 [整合记录](reviews/integration-notes.md)。Human 的自然语言实际使用仍在交付后进行，未记成已完成。
- **最后核对：** 2026-11-15（UTC+8）。Human 的决定是把剩余 scratch 一次做完，统一验证后合到本地 `master`，再由 Human 实际使用。来源：Main 的 message:2e3dfb58-ce7c-4851-acc9-880d9151701d；执行记录在 thread:4412878c-3968-422b-a3a2-c2262841476a。
- **最终边界：** 保留失败续做、并发授权、独立复核和真实 Web 组装验证；自动化证据不等于人工产品验收。两份内置 skill 按现行九工具定稿，无私下巡视、私有对话读取或新增 UI。
- **授权：** 本地合 `master` 已执行；未 push、未更新 PR、未打 tag、未发布。未重启运行中的 Host，未改写真实 Team 账本。

## 交付结果

| 票 | 状态 | 已交付或下一步 |
| --- | --- | --- |
| [01 owner 责任字段](issues/01-owner-responsibility.md) | complete | Task #150 已 accept，内容已合入功能分支。 |
| [02 管理会话入口](issues/02-owner-session-entry.md) | complete | Task #151 已 accept，含真实 Web 入口、隔离 preset、冷恢复和并发替换。 |
| [03 读取团队与模型](issues/03-owner-reads-team.md) | complete | Task #152 已 accept；`team_overview`、`team_models`。 |
| [04 建立责任](issues/04-staff-a-project.md) | complete | Task #154 已由 Human accept；[交付证据](reviews/04-delivery.md)、[实施前裁定](reviews/04-rehearsal.md)。人工使用移至最终交付，不再阻塞 05/06。 |
| [05 调整成员](issues/05-adjust-a-member.md) | complete | Task #155 已 accept；Reeve 在 `c48a721` 复验首轮阻断修正及全量门禁，[复核记录](reviews/05-review.md)。 |
| [06 调整 Project 与 owner](issues/06-adjust-a-project.md) | complete | Task #156 已 accept；两条原始独立探针在 `c48a721` 转绿，[复核记录](reviews/06-review.md)。 |
| [07 记忆与私有 skills](issues/07-owner-memory-and-skills.md) | complete | Task #153 已 accept；[交付证据](reviews/07-delivery.md)。人工使用场景留到最终交付。 |
| [08 内置 skills](issues/08-owner-guide-skills.md) | complete | Task #157 已 accept；`7303255` 通过内容/契约复核，[复核记录](reviews/08-review.md)。 |

Reeve 负责推进、独立复核与最终整合；05/06 由一个实现者端到端顺序交付，08 按实际契约定稿，未由实施者替自己作独立验收。最终检查覆盖创建→调整→故障恢复→owner 责任更新／撤回→归档，以及管理会话记忆和 skills；人工确认判断与方案质量仍由 Human 实际使用。

整合时的 persona 私有资产矛盾已在 `8d4ba29` 修正，并由 Tome 独立复核；只在 Human 当前请求内整理按 ref 查实的资产，sqlite、Session 日志、目录删除和私有内容外泄红线保持不变。

## 代码与环境

- 05/06 在 `feat/team-manager-session` 交付并于 `c48a721` 通过独立复验；08 在 `feat/team-manager-guide` 交付至 `7303255`。私有资产整合修正 `8d4ba29` 与 08 合并为功能 tip `92db4ce`，随后合入创建 checkout 的本地 `master`。
- 工作材料原本只在创建 checkout 的 active 工作项；交付者的内容评审与证据由 Reeve 纳入本记录。临时 worktree 是执行环境，不是当前代码或运行版本的权威。
- 起始基线为 Team `f8f2299` / DSH 0.2.2-rc.2，master 侧另有 `1c57e5a` 的 CI 变更。历史分支和提交见 [04](reviews/04-delivery.md)、[07](reviews/07-delivery.md) 交付记录。
- 当前 `web-dev` 的 bundle 链接指向创建 checkout，不是实施 worktree。合并代码本身不启动新构建，也不升级账本；实际启用要先构建并重启。
- 新代码支持账本 rules version 8，已发布 0.2.8 支持至 7。同一 `DSH_HOME` 下 profile 默认共用 storage，单独新建 profile 不等于隔离数据。最终上车前核实数据备份与所有相关进程的版本；需要隔离验证时使用独立数据目录。不能声称必须 npm 发布才能本地使用，也不能让旧版继续读取已升级账本。

## 完成与文档归宿

工程收口已覆盖 05/06/08、独立复核与统一验证；结论已进入维护文档并随本地合并归档。01–03 与 07 的既有验收事实保留，04 的 Task 状态与人工使用状态分开记录；真实模型下的方案质量、确认判断和自然语言续做仍待 Human 使用。

- 术语与产品定位 → [领域模型](../../../../docs/domain-model.md)、[项目 README](../../../../README.md)。
- 权限、工具与恢复 → [Host 权威](../../../../docs/architecture/host-authority.md)、[工具与 preset](../../../../docs/architecture/tools-and-preset.md)、[Workspace 和 Session](../../../../docs/architecture/workspace-session-storage.md)、[协作契约](../../../../docs/team-collaboration/)。
- 管理会话记忆与 skills → [记忆与上下文](../../../../docs/team-collaboration/memory-and-context.md)。

## 阅读顺序

先读本 README 和 [设计快照](spec.md)；决策沿革与被取代的方案见 [决策记录](materials/decisions.md)。票面列出所需 binding 参考，其他材料只作背景：[定位与责任原则](materials/product-principles.md)、[产品与现状](materials/facts.md)、[Harness 能力](materials/harness-support.md)、[领域用语](materials/vocabulary.md)、[流程与引导参考](materials/flows-and-guidance.md)。不要从整份历史重新推导已定产品决策。
