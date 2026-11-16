# Review 01 — test-suite-slimming

**Conclusion:** Changes needed
**Work item:** `.scratch/archive/2026-11/test-suite-slimming`
**Ticket:** Whole work item
**Compared:** `617d8847..32eb5fee`
**Commits:** `32eb5fee perf: slim test suite and consolidate e2e surface lanes`
**Reviewed:** 2026-11-15

## Findings

### 中 — Skill 监听竞态仍靠放宽断言超时掩盖

**Location:** `packages/agent-team/tests/manager-skills.spec.ts:100-110`; `packages/agent-team/tests/member-skills.spec.ts:110-112`
**Evidence:** 交付把这些监听断言的 `vi.waitFor` 从默认 1 秒改为 5 秒，并没有改变 `FileSystemSkillProvider` 的缓存失效或文件监听收敛路径。`spec.md` 的 D1 和 ticket 01 的 Boundaries 明确要求避免通过放大测试等待掩盖性能问题。
**Impact:** 监听链路超过 5 秒时测试才会失败，真正的监听回归会被延迟暴露；每次失败还会额外占用最多 4 秒。当前三轮全量 Vitest 通过只能说明本次运行在 5 秒内收敛，不能证明原先的并发竞态已被根治。
**Basis:** `.scratch/archive/2026-11/test-suite-slimming/spec.md` §D1；`issues/01-vitest-flake-and-fast-path.md` 的 Boundaries 与 Acceptance Criteria。
**Suggested fix:** 保留生产监听默认值，改测试夹具或测试入口使写入后的缓存失效可确定收敛（例如避免写入前预热无意义缓存，或注入仅用于测试的 watcher 参数），再恢复合理的等待预算，并保留一次真实并发回归测试。

### 中 — 归档的单 Lane 示例在当前 Runner 中直接失败

**Location:** `scripts/run-browser-test.mjs:47-52`; `.scratch/archive/2026-11/test-suite-slimming/issues/02-e2e-runner-and-single-lane.md:30`
**Evidence:** 当前 `scripts/e2e/` 已删除 `team-settings-nav-icon.e2e.ts`，并将它合入 `team-settings-and-tools.e2e.ts`。实际运行 `npm run test:browser -- team-settings-nav-icon` 在构建完成后报 `No E2E lane matched filter`。
**Impact:** ticket 02 的验收命令不能使用，维护记录中的旧 lane 名称也会让开发者无法完成目标 Surface 的快速自检。Runner 的子串过滤本身按现有 lane 文件工作，但没有为被合并的旧名称提供迁移映射，也没有同步验收材料。
**Basis:** ticket 02 的 Acceptance Criteria 要求该命令端到端完成；D6 将 `team-settings-nav-icon` 合并到 `team-settings-and-tools`。
**Suggested fix:** 将验收示例和相关说明改为 `team-settings-and-tools`，或在 Runner 中明确维护旧名称到目标 lane 的映射并为映射加测试；选择一种后同步中英文维护文档和归档 ticket。

### 中 — 即时 Webhook pump 没有被测试真正断言

**Location:** `packages/agent-team/tests/subscription-host.spec.ts:834-837,891-895,1361-1366,1523-1527`; `packages/agent-team/tests/webhook-entry.spec.ts:170-176`
**Evidence:** 这些新增代码都用 spy 替换 `pumpWebhookAdmissions()` 为已 resolved 的 mock，随后恢复 spy，但没有任何 `toHaveBeenCalled` 或调用时序断言。它们因此主动阻断了刚加入的即时 pump，测试只继续验证队列数据和后续手工 `pump()` 的行为。
**Impact:** `intakeWebhookDelivery()` 中的 `void this.pumpWebhookAdmissions()` 即使被删除、放错位置或没有在 queued 写入完成后调用，这些测试仍可通过；ticket 01 的“提交后立即处理”核心回归没有自动保护。
**Basis:** `packages/agent-team/src/index.ts:5438` 与 ticket 01 Acceptance Criteria 的“提交后可立即触发”要求。
**Suggested fix:** 增加一个不依赖 5 秒 timer 的断言：在 queued 返回前后记录 pump 调用，验证 queued 写入完成后立即调用；需要隔离后续副作用时只控制 pump 内部的执行 promise，同时保留对 spy 调用次数和顺序的断言。

### 中 — 共享 Manager Harness 破坏 ticket 明确要求的测试隔离

**Location:** `packages/agent-team/tests/manager-member-adjust.spec.ts:65-84`
**Evidence:** `beforeAll` 创建一个可变的真实 Harness、Manager Agent 和 Workspace，前几个 `it` 直接复用 `shared`；每个测试只执行 `vi.restoreAllMocks()`，没有恢复 ledger、Member、Project、Session 或 Host 文件状态。测试会在同一实例上连续创建、修改、暂停、恢复和归档不同 Member。
**Impact:** 任一用例留下的持久状态或异步资源都能影响后续用例；改变测试顺序、单独执行某个用例或新增同名数据时，结果可能依赖前序用例。当前全量通过不能证明“绝对测试隔离”仍成立。
**Basis:** `spec.md` §D3 明确要求在减少冷启动的同时保持绝对测试隔离，ticket 01 Boundaries 也禁止跨破坏性用例泄露可变状态。
**Suggested fix:** 只共享真正不可变的启动前置，或为每个用例提供可验证的 ledger/Workspace/Agent reset；至少把会改变 Manager Session、Member 生命周期或 Host 注册表的用例恢复为独立 Harness，并用一个顺序扰动或重复执行检查证明隔离。

### 中 — 全量 E2E 性能没有达到已写入 ticket 的目标

**Location:** `.scratch/archive/2026-11/test-suite-slimming/README.md:38-40`; `.scratch/archive/2026-11/test-suite-slimming/issues/03-e2e-downshift-and-lane-consolidation.md:43`
**Evidence:** 归档 README 将基线 `217.2s` 与改造后实测 `197.55s` 并列记录；ticket 03 的验收目标是 `~75–90s`，并要求单 lane `<=20s`。实现只复用 Chromium，`openTeamPage()` 仍为每个场景启动独立 Web Scaffold、Workspace、存储和登录流程，因而没有消除主要的场景冷启动成本。
**Impact:** 交付没有实现该工作项承诺的全量提速目标；开发者仍需等待约 3 分钟跑全量 E2E，不能据此把 ticket 03 标记为完整满足。
**Basis:** ticket 03 的 What to deliver、Acceptance Criteria 和 D4/D6；归档 README 的“实测对比结果”是本次交付声明的证据。
**Suggested fix:** 先用同一基线和统一计时方式重新定位剩余成本，再决定继续复用可安全共享的 Scaffold/安装状态、减少不必要的 journey 启动，或下调目标并记录明确理由。修复后重新采集完整 E2E、单 lane 和截图数量证据。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 01：三次并发全量 Vitest 通过，Skill 无超时 | Met for observed runs | `npx vitest run` 连续 3 次通过：219 files passed / 1 skipped，2845 tests passed / 1 skipped；但 D1 的根因修复仍不充分，见 Finding 1。 |
| 01：queued 后立即触发 Webhook pump | Partial | `src/index.ts` 已加入调用，但新增测试 mock 掉 pump 且不断言调用，见 Finding 3。 |
| 01：全量 Vitest 墙钟下降且无状态污染 | Partial | 三轮墙钟约 `25.42s`、`25.96s`，与基线 `25.44s` 相比并非稳定下降；共享 Harness 的隔离风险见 Finding 4。 |
| 01：typecheck、lint、npm test | Partial | `npm test`、`npm run typecheck` 通过；`npm run lint` 因本机没有 `corepack` 失败，直接执行等价的 `pnpm dlx oxlint@1.76.0 ...` 通过并报告既有 warnings。 |
| 02：单 lane 示例只运行匹配文件并完成局部证据校验 | Missing | 归档示例 `team-settings-nav-icon` 当前无匹配文件，实跑直接报错，见 Finding 2；有效 lane 和浏览器证据因缺少浏览器未能完成。 |
| 02：同一 Worker 只启动一次 Chromium、Context 相互隔离 | Not verified | 代码提供 `sharedBrowser` 与 `newContext`；当前环境无法启动浏览器，未能观察真实 Worker 生命周期。 |
| 02：无过滤全量浏览器门禁通过且 Harness 清理 | Not verified | 本机没有 `/usr/bin/google-chrome`，也未找到可用 Playwright 浏览器。 |
| 02：typecheck、lint、docs、scratch | Partial | typecheck、check:docs、check:scratch 通过；lint 脚本受 corepack 环境阻塞，直接 oxlint 通过。 |
| 03：保留 9 条 lane、7 个场景下沉并有等价低层断言 | Partial | 当前确有 9 个 E2E 文件，相关针对性测试 7 files / 93 tests 通过；等价覆盖与浏览器截图未能在真实浏览器中复核。 |
| 03：全量浏览器、截图门禁和人工视觉检查 | Not verified | 浏览器缺失，未运行全量 `npm run test:browser`，也未审视新截图。 |
| 03：全量 E2E `~75–90s`、单 lane `<=20s` | Missing / Not verified | 归档交付自身记录全量为 `197.55s`，超出 `75–90s` 目标；单 lane 无可复现的有效浏览器运行，见 Finding 5。 |
| 03：typecheck、lint、build/artifact、UI parity | Partial | typecheck、build（由 browser 命令前置阶段完成）、`npm run check:artifact` 通过；lint 脚本受 corepack 阻塞，`node scripts/audit-ui-parity.mjs` 未运行。 |
| 04：中英文维护文档对齐、链接有效、列出 lane 用法 | Partial | `npm run check:docs` 通过，示例 `team-manager team-inbox-and-recovery` 可匹配；ticket 02 的旧 lane 示例仍失效，见 Finding 2。 |
| 04：归档、索引、ticket 状态一致 | Met mechanically | `npm run check:scratch` 通过；本 review 不替代 Human acceptance，也不接受 ticket 中与实现冲突的完成声明。 |
| 04：最终全仓门禁全部通过 | Partial | `npm test`、typecheck、docs、scratch、artifact 通过；lint 脚本失败、浏览器未验证、UI parity 未运行。 |

## Checks run

| Command or check | Result |
| --- | --- |
| `npm run check:scratch` | Passed: 70 archived work items across 4 months. |
| `npm run check:docs` | Passed: 29 maintained documents and bilingual outlines/links valid. |
| `npm run typecheck` | Passed. |
| `npm test` | Passed: 219 files passed / 1 skipped; 2845 tests passed / 1 skipped; 24.71s. |
| `npx vitest run` (second and third consecutive runs) | Passed both times: 219 files passed / 1 skipped; 2845 tests passed / 1 skipped; 25.42s and 25.96s. |
| Targeted Vitest: browser evidence, Skill, subscription/Webhook, worker composition, and Client send-retry specs | Passed: 7 files, 93 tests. |
| `npm run build` (as the `test:browser` prerequisite) | Passed. |
| `npm run check:artifact` | Passed: 490 artifact entries and 143 runtime relative imports resolved. |
| `npm run lint` | Failed before oxlint because `corepack` is not installed in this environment. |
| `pnpm dlx oxlint@1.76.0 --disable-typescript-plugin packages scripts` | Passed with warnings; no errors. |
| `npm run test:browser -- team-settings-nav-icon` | Failed before browser startup: no matching current lane; this is a confirmed stale-example failure. |
| `npm run test:browser -- team-settings-and-tools` | Failed before browser startup because `/usr/bin/google-chrome` is absent. |

## Unverified scope and residual risk

- Full browser E2E, valid filtered browser E2E, PNG evidence, dual-width completeness, visual review, Context isolation, and Harness-side cleanup were not verified because this machine has no Chrome executable and no usable Playwright browser installation.
- `node scripts/audit-ui-parity.mjs` was not run; the production UI is unchanged in this delivery, but ticket 03 lists it as an acceptance check.
- The worktree contained an unrelated untracked file at `.scratch/archive/2026-11/team-management-agent/reviews/09-team-management-agent-recheck.md`; it was excluded from this review. The only file created by this review is the report itself.
- Human acceptance of archived screenshots and the decision to close the work item remain outside this implementation review.

## Review record

- Spec sources: `.scratch/archive/2026-11/test-suite-slimming/README.md`, `spec.md`, `issues/01-vitest-flake-and-fast-path.md`, `issues/02-e2e-runner-and-single-lane.md`, `issues/03-e2e-downshift-and-lane-consolidation.md`, `issues/04-docs-and-scratch-archive.md`, and `materials/01-baseline-diagnosis.md`.
- Standards sources: `AGENTS.md`, `.scratch/AGENTS.md`, `docs/AGENTS.md`, and `docs/development/start-and-checks.md`.
- Uncommitted and untracked changes included: no implementation changes; the unrelated untracked team-management review was excluded; this new review report is the only included worktree addition.
