# 01 — 为 Project owner 关系加入责任说明

**What to deliver:** Project owner 关系带一个有界的 `responsibility` 字段，从账本回放、Host 投影、成员 `team_view`、ownership context 到 Web 授权入口一致可见；旧记录安全回放为「未说明」，可由现有 Web 入口或后续管理工具补齐。`project_owner update` 使用的只追加账本操作和 Host 入口也在本票定义，供 06 调用。

**Blocked by:** None — no ticket blockers

**Status:** ready

**Required context:** [设计快照](../spec.md) 的「产品原则与首版定位」和「工具和权限」中 `project_owner` 行；[产品与现状](../materials/facts.md) 的 owner 行；`docs/domain-model.md`；源码 `packages/agent-team/src/types/{entities,operations,requests-results}.ts`、`ledger.ts` 的 `AGENT_TEAM_RULES_VERSION` / `changeProjectOwner` / `projectOwnerChangeProblem`、`member-context.ts`、`packages/tool-agent-team/src/index.ts` 的 `team_view` 输出，以及 Client 的 `packages/client-agent-team/src/client/TeamProjectOwners.tsx`。

**Background:** [定位与责任原则](../materials/product-principles.md) 第 4、7 节解释 Member description、Project description 和 owner responsibility 为什么分层。

**Boundaries:** 不新增 Domain 实体；不改账本 actor；不引入 DM；不重写旧记录；不改 Project 共同目标字段；`responsibility` 是单一有界文本，不做结构化职责树；不新增独立管理页面；不实现 `team_overview`（03 读取本票投影）。

- [ ] `team/project-owner-added` 携带可选 `responsibility`；新增只追加的 `team/project-owner-responsibility-updated` 操作并定义回放，`project_owner update` 不通过 remove+add 模拟。账本 `AGENT_TEAM_RULES_VERSION` 从 7 升到 8 并 gate 新操作；旧记录缺少字段时回放为未说明，不阻止读取。写入前 trim，空串表示未说明，上限 2,000 字符。
- [ ] 新增 `AgentTeamProjectOwnerUpdateRequest`（requestId、workspaceId、projectRef、memberId、responsibility）、Host `updateProjectOwner` 和对应 Remote；更新沿用 `projectOwnerChangeProblem` 的 Project 存在、未归档、非 Human、已是 owner 和 Workspace 参与检查，并定义 requestId 幂等与同 id 不同参数的冲突语义。
- [ ] `team_view`、ownership context 和 Human 的 Project owner 界面显示同一份责任文本；更新后旧文本被一致替换，不出现两份权威。`team_overview` 的展示由 03 验收。
- [ ] Web 现有 owner 授权入口（`TeamProjectOwners.tsx`）可填写/编辑责任；允许留空并显示「未说明」，管理工具的 `project_owner add` 在 04 中要求责任。补一个组件测试覆盖留空、编辑和提交。
- [ ] 责任更新复用 owner Activity / Main 标记路径通知该成员：`AgentTeamOwnerActivity.kind` 增加 `owner-responsibility-updated`，Main stream 的 owner Activity 渲染覆盖新 kind，不新增通知机制；通知未送达不改变已提交的责任。
- [ ] 账本回放、投影和组件测试覆盖新增、更新、旧记录、归档 Project、非 owner 和 owner 移除；更新 `docs/domain-model.md`、`docs/team-collaboration/tools.md`、相关包 README 和升级说明（rules version 8 的账本兼容性）。

**Evidence to return:** 变更文件、账本/投影/组件测试命令与结果、旧记录回放证据、rules version 升级说明、未验证范围。
