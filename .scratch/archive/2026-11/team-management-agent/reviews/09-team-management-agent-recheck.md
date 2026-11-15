# Review 09 — team-management-agent

**Conclusion:** Changes needed
**Work item:** `.scratch/archive/2026-11/team-management-agent`
**Ticket:** Whole work item (`01`–`08`)
**Compared:** `20033498..HEAD` (`617d8847`)
**Commits:** `5bbe0fd0`, `ab28e08d`, `27a06604`, `22d9b264`, `617d8847`
**Reviewed:** 2026-11-15

## Findings

### Medium — `activateMember` 在写回 `handles` 前仅检查 `archived`，并发暂停或移除后仍会留下活句柄

**Location:** `packages/agent-team/src/index.ts:4107-4113` (`AgentTeam.activateMember`)
**Evidence:** `addMemberInternal`（`packages/agent-team/src/index.ts:1762-1793`）在 `enqueueAddition(request.requestId, ...)` 中串行化，而 `suspendMember` 与 `removeMember` 在 `enqueueLifecycle(memberId, ...)` 中串行化。`ledger.addMember` 提交后，`addMemberInternal` 会 await `activateMember(stored, workspace.path)`（内含 `agents.create` 与 `workspace.attachSession`）。`activateMember` 在写入 `this.handles.set(member.memberId, created)` 前只检查 `if (current === undefined || current.state === 'archived')`（第 4108 行）。
**Impact:** 若在 `activateMember` await 期间，并发的 `suspendMember` 或 `removeMember` 先提交了 `state: 'suspended'` 或 `'inactive'` 并完成了 `convergeMemberEffects`（此时 `this.handles` 尚无条目），`activateMember` 恢复后仍会通过第 4108 行的检查并写入 `this.handles`，导致已暂停或已移除的 Member 保留活 `AgentHandle`。
**Basis:** `issues/04-staff-a-project.md:20`（防止激活途中并发状态变更留下活句柄）与 Host 运行态/账本一致性原则。
**Suggested fix:** 将第 4108 行改为 `if (current === undefined || current.state !== 'enabled')`，并在日志中记录实际的 `current.state`。

### Medium — `latestOrdinarySessionId` 失败会阻断 `openResolvedManagerSessionImpl` 提交 `managerSessionId`

**Location:** `packages/client-agent-team/src/client/index.ts:108-123`（`latestOrdinarySessionId`）与 `packages/client-agent-team/src/client/index.ts:248-280`（`openResolvedManagerSessionImpl`）
**Evidence:** 冷恢复打开或新建替换管理会话时，`openResolvedManagerSessionImpl` 先在第 266 行调用 `ctx.uiWorkspace.openSession(sessionId)` 切换主区，随后在第 279 行 await `latestOrdinarySessionId(ctx, workspaceId)` 计算返回普通会话的兜底目标。`latestOrdinarySessionId` 在 `!response.ok` 时直接 `throw new Error(response.error.message)`（第 120 行）。
**Impact:** 当 `ctx.remote.agentTeam.sessionOwnership` 失败或拒绝时，`openResolvedManagerSessionImpl` 在 `resolveManagerSession(sessionId, returnTo)` 调用之前抛错退出，导致主区已切换到 `sessionId`，但 `navigation.getSnapshot().managerSessionId` 仍为 `undefined`（使 `TeamManagerGate` 错误遮罩停留在已打开的会话之上）或卡在旧的 `expectedSessionId`（隐藏 `TeamManagerSessionAction` 并使会话恢复追踪过期 id）。
**Basis:** `issues/02-owner-session-entry.md:14-15` 与 `spec.md:40-41`（切换状态与 UI 表现必须与当前已打开会话一致）。
**Suggested fix:** 在 `openResolvedManagerSessionImpl` 中将 `latestOrdinarySessionId(ctx, workspaceId)` 视为 best-effort：捕获其异常并回退为 `undefined`，确保 `resolveManagerSession(sessionId, undefined)` 仍能提交。

### Medium — `managerDirectory` 在传入 `projectRef` 时未校验成员所属 Workspace 参与关系

**Location:** `packages/agent-team/src/ledger.ts:4886-4890` (`AgentTeamLedger.managerDirectory`)
**Evidence:** `managerDirectory(workspaceId, projectRef)` 在筛选 `projects` 时校验了 `project.workspaceId === workspaceId`，但在计算 `memberIds` 时（第 4887-4889 行）仅在 `projectRef === undefined` 时调用 `this.participatesIn(member.memberId, workspaceId)`，而在 `projectRef !== undefined` 时只检查 `this.isProjectMember(projectRef, member.memberId)`。
**Impact:** 若 `project1` 属于 `ws1` 且成员 `m1` 不参与 `ws2`，调用 `team_overview({ workspaceId: 'ws2', projectRef: 'project1' })` 或跨 Workspace 传入 `projectRef` 时，`ws2` 会返回 `projects: []`（`projectCount: 0`），却把 `m1` 计入 `ws2` 的 `members` 与 `memberCount` 中，将其他 Workspace 的成员泄漏到无关 Workspace 视图。
**Basis:** `issues/03-owner-reads-team.md:15`（多 Workspace 与范围查询返回准确可区分的目录结果）。
**Suggested fix:** 当 `projectRef !== undefined` 时，在 `memberIds` 过滤中同时要求 `this.participatesIn(member.memberId, workspaceId)`。

### Low — 管理写操作缺少关联管理 `sessionId`、`requestId` 与 `operationId` 的 Host 日志

**Location:** `packages/agent-team/src/index.ts:3343-3654`（`manager*ForAgent` 写方法与 `commitManagerWrite`）
**Evidence:** 检查 `commitManagerWrite` 及 `managerCreateMemberForAgent`、`managerCreateProjectForAgent`、`managerChangeProjectOwnerForAgent`、`managerUpdateProjectForAgent`、`managerUpdateMemberForAgent`、`managerSetMemberStateForAgent`、`managerChangeMemberWorkspaceForAgent`，均未调用 `this.ctx.logger` 记录管理会话 `agent.id`、`requestId` 与 `receipt.operationId` 的关联日志。
**Impact:** 排查管理会话提交与回执时无法从 Host 日志直接把管理 `sessionId`、`requestId` 和 `operationId` 关联起来。
**Basis:** `spec.md:47`（“Host 日志以 Session id、requestId、operationId 关联工具和已提交操作，便于排查，不记录完整工具输入、私有文件或提问答案。”）与 `issues/04-staff-a-project.md:19`。
**Suggested fix:** 在 `commitManagerWrite`（或传入 `agent.id` 的统一辅助方法中）记录只含 `sessionId`、`requestId` 与 `operationId` 的结构化 info/debug 日志，不记录完整入参或私有内容。

### Low — `ManagerSessionRuntime` 中指针解析与会话读取分支存在三处重复

**Location:** `packages/agent-team/src/manager-session.ts:118-140` (`preRestore`)、`235-258` (`openLocked`)、`267-300` (`currentStatusLocked`)
**Evidence:** 三个方法重复了完全相同的 ~25 行指针解析逻辑（检查 `this.current?.agent.id`、`isArchived`、`liveOutsideManager`、`this.deps.reader.read` 的 `missing` 与 `readFailure`、`resumeLocked`），仅在 `archived` 与 `missing` 的返回动作上存在差异。
**Impact:** 后续修改预恢复校验或诊断口径时需同步维护三处分支。
**Basis:** `AGENTS.md` / 代码简洁性原则（避免重复控制流）。
**Suggested fix:** 在 `ManagerSessionRuntime` 内提取私有辅助方法 `resolveStoredPointer(pointer, { onArchived, onMissing })`，由三处共同调用。

### Low — `packages/tool-agent-team` 中 `Config.only` 的 JSDoc 注释与实际配置不一致

**Location:** `packages/tool-agent-team/src/index.ts:2802`（对比 `cordis.patch.yml:218-231` 与 `packages/tool-agent-team/README.md:51`）
**Evidence:** `Config.only` 的注释写着 `"Omitted registers every Team tool, which is what the Member preset mounts."`；但实际上 `cordis.patch.yml:218-231` 中 `team-member` 显式配置了 10 个 Member 工具的 `only` 列表，若省略 `only` 会注册全部 19 个工具（含 9 个管理端工具）。
**Impact:** 误导维护者以为 `team-member` 省略了 `only` 或省略 `only` 只挂载成员工具。
**Basis:** `AGENTS.md`（Scope and authority：注释不得与源码/配置真实行为矛盾）。
**Suggested fix:** 更新第 2802 行 JSDoc，说明省略 `only` 会注册全部 19 个 Team 工具，而 `team-member` 与 `team-manager` 各自显式声明 `only` 白名单。

### Low — `member-context.ts` 与 `manager-context.ts` 中 `textDigest` 的 SHA-256 计算存在轻微重复

**Location:** `packages/agent-team/src/member-context.ts:1, 118` 与 `packages/agent-team/src/manager-context.ts:81, 116-118`
**Evidence:** `private-memory.ts` 已抽取用于共享私有记忆逻辑，但 `member-context.ts:118` 仍直接调用 `createHash('sha256')`，而 `manager-context.ts:116-118` 在本地定义了 `digestOfText` 包装 `privateMemoryDigest`。
**Impact:** 相同文本摘要逻辑分散在两个消费方中。
**Basis:** 代码简洁性与单一权威辅助函数原则。
**Suggested fix:** 从 `packages/agent-team/src/private-memory.ts` 导出 `privateMemoryTextDigest(text: string): string` 并统一在两处调用。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| **01** `team/project-owner-added` 可选责任、只追加更新 op、rules v8、trim/2000 字符上限与旧记录回放 | Met | `packages/agent-team/src/types/operations.ts:168-197`、`ledger.ts:297, 327-340, 829, 2880-2913, 6769-6785`、`tests/project-owners.spec.ts` |
| **01** `AgentTeamProjectOwnerUpdateRequest`、Host `updateProjectOwner`、Remote 与幂等/冲突检查 | Met | `packages/agent-team/src/types/requests-results.ts:486-493`、`index.ts:1709-1725`、`ledger.ts:2880-2913, 2977-3005` |
| **01** `team_view`、ownership context 与 Web owner 界面一致显示且可编辑/留空 | Met | `packages/tool-agent-team/src/index.ts:1501-1554`、`member-context.ts:183-188`、`TeamProjectOwners.tsx:47-188`、`tests/team-project-owner-responsibility.client.spec.tsx` |
| **01** `owner-responsibility-updated` Activity、Main stream 渲染、测试与文档 | Met | `entities.ts:821`、`activity-view.ts:9-13`、`TeamMainStream.tsx:259-265`、`docs/domain-model.md:55-60` |
| **02** 入口（宽/窄/折叠 rail）、让出 `main` 影子、D26 Workspace 解析与空状态 | Met | `TeamWorkspaceBrowser.tsx:125, 157`、`client/index.ts:282, 442-444`、`manager-session.ts:505-526` |
| **02** 单一 Host 会话登记（`openTeamStorage`）、`manager` nav token、启动预恢复、「新开对话」CAS 与失败诊断 | Met | `navigation.ts:34-86`、`manager-session-store.ts:35-41`、`manager-session.ts:112-426`、`TeamManagerSessionAction.tsx` |
| **02** `team-manager` preset 隔离、专用工具策略、无 preset 切换、组件测试 | Met | `cordis.patch.yml:276-399`、`manager-tool-policy.ts:64-124`、`TeamManagerChrome.tsx:27-36`、`tests/team-manager.client.spec.tsx` |
| **02** 真实 Web 组装提问卡、浏览器测试与人工 dev profile 验收 | Not verified | `scripts/e2e/team-manager.e2e.ts` 存在；本轮未运行 `npm run test:browser` 与人工 dev profile 验收 |
| **03** `team_overview` 与 `team_models`：全 Workspace 目录、中性报告、分页/截断、失败隔离、Live Manager 鉴权与文档 | Met | `packages/tool-agent-team/src/index.ts:1700-1868`、`packages/agent-team/src/index.ts:3277-3332`、`manager-session.ts:187-196`、`tests/manager-reads.spec.ts` |
| **04** `member_create` / `project_create` / `project_owner add`、激活门槛、模型校验在 `!hasCommitted` 后、临界区重检与部分成功续做 | Met | `packages/tool-agent-team/src/index.ts:1901-2090`、`packages/agent-team/src/index.ts:3343-3441, 3644-3654`、`tests/manager-writes.spec.ts`（`member_create` 不带初始 Project 参数已记录于 `reviews/integration-notes.md:20`） |
| **04** Host 日志关联管理 `sessionId`、`requestId` 与 `operationId` | Missing | `packages/agent-team/src/index.ts:3343-3654` 未记录关联日志（见 Finding 4） |
| **04** 人工 dev profile 自然语言验收 | Not verified | 无法在代码评审中验证 |
| **05** `member_update` / `member_state` / `member_workspace`、局部合并、`request/header` 排队回写、模型校验顺序、`recover` 闭环与归档 | Met | `packages/agent-team/src/index.ts:892-925, 2201-2226, 3526-3633`、`packages/tool-agent-team/src/index.ts:2188-2400`、`tests/manager-member-adjust.spec.ts` |
| **05** 人工 dev profile 验收 | Not verified | 无法在代码评审中验证 |
| **06** `project_update` 局部合并与 archive 副作用、`project_owner update` / `remove` 与 Task 交回 | Met | `ledger.ts:2834-2859`、`packages/agent-team/src/index.ts:3406-3514`、`packages/tool-agent-team/src/index.ts:2029-2170`、`tests/manager-project-adjust.spec.ts` |
| **06** 人工 dev profile 验收 | Not verified | 无法在代码评审中验证 |
| **07** 独立 `manager-context`、16 KiB/转义/警告、`notes/` 按需读、独立内置与私有 `skills/` 发现及跨会话保留 | Met | `manager-context.ts:53-163`、`private-memory.ts:14-103`、`manager-session.ts:58, 487-491, 630-656`、`tests/manager-context*.spec.ts`、`tests/manager-skills.spec.ts` |
| **07** 人工 dev profile 验收 | Not verified | 无法在代码评审中验证 |
| **08** `team-management-guide` 与 `team-operations` 内容、内置优先、`check:core-skills` 与内部链接 | Met | `packages/agent-team/manager-skills/`、`scripts/check-core-skills.mjs:25` |
| **08** Human 阅读与真实模型方案判断 | Not verified | 留待交付后 Human 实际使用 |

## Checks run

| Command or check | Result |
| --- | --- |
| `npm run typecheck` | Passed (`generate:typert` + `tsc` across 3 packages and `tsconfig.scripts.json`) |
| `npm run check:facades` | Passed (581 Harness mappings) |
| `npm run check:docs` | Passed (29 maintained documents, 29 bilingual pairs, 476 relative links, 72 heading anchors) |
| `npm run check:core-skills` | Passed (core 4, manager 2, 6 skills, 7 references linked, 8 relative links resolved) |
| `npm run check:boundaries` | Passed (153 source files in 3 packages) |
| `npm run check:versions` | Passed (16 version spots agree on `0.2.2-rc.2`, plugin `0.2.8`) |
| `npm run check:comments` | Passed (no unresolvable references) |
| `npm run check:scratch` | Passed (69 work items across 4 months) |
| `vitest run` | Passed: 219 test files passed, 1 skipped (220); 2840 tests passed, 1 skipped (2841) |

## Unverified scope and residual risk

- `npm run lint` 未在本环境运行成功（`sh: corepack: command not found`）。
- `npm run test:browser` 未在本轮复核中重跑（`reviews/integration-notes.md` 记录其在合入时通过，但本轮未独立复跑 Chromium 浏览器测试）。
- 各票中涉及真实模型自然语言交互、方案质量与确认判断的 `dev` profile 人工验收（02、04–08）无法通过静态评审和单元测试替代，仍待 Human 实际使用验收。

## Review record

- Spec sources: `.scratch/archive/2026-11/team-management-agent/spec.md`, `README.md`, `reviews/integration-notes.md`, `issues/01`–`08`
- Standards sources: `AGENTS.md`, `docs/AGENTS.md`, `.scratch/AGENTS.md`
- Uncommitted and untracked changes included: no (working tree was clean; reviewed `20033498..HEAD`)
