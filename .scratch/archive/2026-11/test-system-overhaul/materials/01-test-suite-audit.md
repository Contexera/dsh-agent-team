# 测试体系全量盘点与实证记录

- **性质：** 当前证据（2026-11-14 对仓库源码、配置、CI 及 PR #96 diff 的直接核查）
- **基线参照：** 上一次测试精简记录见 [2026-11/test-ablation](../../../archive/2026-11/test-ablation/README.md)（2026-11-02）

---

## 1. 规模与增长趋势

自 2026-11-02 `test-ablation` 完成以来，测试文件数量快速扩张：

| 维度 | 2026-11-02 基线 | 2026-11-14 现状 | 变化 |
| --- | ---: | ---: | ---: |
| Vitest spec 文件总数 | 141 | 208 | +67（+47.5%） |
| `packages/agent-team/tests/*.spec.ts` | — | 138 | — |
| `packages/tool-agent-team/tests/*.spec.ts` | — | 14 | — |
| `packages/client-agent-team/tests/*.spec.*` | — | 56 | — |
| 浏览器 E2E (`scripts/e2e/*.e2e.ts`) | — | 26 | — |
| 性能基准 E2E (`scripts/team-performance/team-performance.e2e.ts`) | — | 1 | — |

对 `packages/*/tests` 与 `scripts/e2e` 执行 `jscpd --ignore "**/lib/**" --min-tokens 70 --min-lines 10 --mode mild --format typescript,tsx`（注：仓库根 [.jscpd.json](../../../../.jscpd.json#L11-L15) 默认忽略了 `**/tests/**`）：
- 共分析 **247 个文件（208 `.ts` + 39 `.tsx`）、69,457 行**
- 检出 **125 处克隆、1,788 行重复代码（重复率 2.57%，超过仓库源码阈值 2.0%）**

---

## 2. PR #96 覆盖范围与遗留边界

PR #96（分支 `fix/test-temp-dir-cleanup`，提交 `918dea52`）解决了三处临时目录遗留：
1. [scripts/isolate-dsh-home.setup.ts](../../../../scripts/isolate-dsh-home.setup.ts)：新增 `afterAll` 与 `process.once('exit')` 清理 `isolatedHome`（`rmSync(..., { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })`）。
2. 13 个 `packages/agent-team/tests/member-*.spec.ts` 文件：补齐 `cleanups` 导入与 `afterEach` 排空（`member-acceptance`, `member-change-domains`, `member-cold-activation`, `member-execution-isolation`, `member-lifecycle-core`, `member-memory-dirs`, `member-memory-scaffold`, `member-model-route`, `member-presence-scope`, `member-wake-input`, `member-wake-safety`, `member-wake-swap`, `member-wake-windows`）。
3. [scripts/e2e/support.ts](../../../../scripts/e2e/support.ts#L228-L242)、[team-worker-inspect.e2e.ts](../../../../scripts/e2e/team-worker-inspect.e2e.ts)、[team-worker-stop.e2e.ts](../../../../scripts/e2e/team-worker-stop.e2e.ts)：新增 `scenarioTempDir(prefix)`，由 `closeScenario()` 统一删除。

PR #96 之外仍残留的同域小缺口：
- `closeScenario()`（`scripts/e2e/support.ts:238-242`）未使用 `try / finally`：若 `browser?.close()` 或 `scaffold?.close()` 抛错，`scenarioTempDirs` 不会被删除。
- [scripts/e2e/team-worker-subscription.e2e.ts](../../../../scripts/e2e/team-worker-subscription.e2e.ts#L9-L17)（及第 83 行）仍独立维护 `replayDir` 与本地 `afterEach`，未收口到 `scenarioTempDir()`。
- [packages/agent-team/tests/member-memory-dirs.spec.ts](../../../../packages/agent-team/tests/member-memory-dirs.spec.ts#L11) 存在未使用的 `mkdtemp` 导入。

---

## 3. 生命周期、清理竞态与环境隔离缺陷

1. **隐式 `cleanups` 协议与高冗余样板**
   - 全仓测试代码中存在 **52 处** `const cleanups` 数组声明，**40 个文件**使用 `realHarness`（[packages/agent-team/tests/helpers/member-harness.ts](../../../../packages/agent-team/tests/helpers/member-harness.ts#L17)）。
   - `member-harness.ts` 将清理数组暴露给调用方自行在 `afterEach` 中排空，注册与释放脱节。
2. **初始化中途失败泄漏**
   - `realHarness()`（`member-harness.ts:218-315`）在第 218 行即创建 `mkdtemp` 目录 `root`，但直到第 310 行所有插件和 `seed()` 全部完成后才 `cleanups.push(...)`；中途异常会直接泄漏 `root` 及已启动服务。
   - `mountTeamMemberHost()`（[packages/agent-team/tests/helpers/team-host-fixture.ts](../../../../packages/agent-team/tests/helpers/team-host-fixture.ts#L82-L133)）存在同样顺序问题。
3. **清理链路缺少 `try / finally`**
   - `member-harness.ts:310-315` 与 `team-host-fixture.ts:133` 串联 `await ctx.fiber.dispose(); await facility.closeAll(); await backend?.close(); await rm(root, ...)`，前一步抛错会跳过后续目录删除。
4. **双重清理与并发删除竞态**
   - [packages/agent-team/tests/subscription-retry.spec.ts](../../../../packages/agent-team/tests/subscription-retry.spec.ts#L21-L25) 与 [subscription-directory.spec.ts](../../../../packages/agent-team/tests/subscription-directory.spec.ts#L20-L24) 在 `await realHarness(...)`（内部已向 `cleanups` 注册过完整清理）之后，又向 `cleanups` push 了一次 `await test.teamFiber.dispose(); rmSync(test.root, { recursive: true, force: true })`。`afterEach` 执行 `Promise.all(cleanups.splice(0).map(...))` 时，两个回调并发释放 fiber 并同时异步 `rm` / 同步 `rmSync` 同一个 `root`。
   - [packages/tool-agent-team/tests/team-view-directory.spec.ts](../../../../packages/tool-agent-team/tests/team-view-directory.spec.ts#L28-L29) 同样重复 push 了 `await test.teamFiber.dispose()`。
5. **`process.env.DSH_HOME` 覆写未恢复**
   - [scripts/isolate-dsh-home.setup.ts](../../../../scripts/isolate-dsh-home.setup.ts#L14) 为测试文件设置 `process.env.DSH_HOME`。
   - `member-harness.ts:222` 与 `team-host-fixture.ts:87` 直接覆写 `process.env.DSH_HOME = join(root, 'dsh-home')`，但清理时不恢复原值。同文件后续若存在不走 harness 的测试，其 `DSH_HOME` 将指向已被 `afterEach` 删除的目录。
6. **模块顶层 `mkdtempSync` 缺少异常退出兜底**
   - `subscription-retry.spec.ts:8`、`subscription-directory.spec.ts:8`、`subscription-host.spec.ts:30` 在模块顶层创建 `spillRoot` / `shellSpillRoot`，仅依赖 `afterAll` 清理，无 `process.once('exit')` 兜底。
7. **Client `runtime.dispose()` 遗漏与异常跳过**
   - [packages/client-agent-team/tests/harness.tsx](../../../../packages/client-agent-team/tests/harness.tsx#L114) 的 `runtimeWithTeam()` 被 **20 个** `.client.spec.tsx` 使用；其中 **4 个文件**（`human-profile-seats.client.spec.tsx`、`main-panel.client.spec.tsx`、`team-loading-surface.client.spec.tsx`、`team-task-board-page.client.spec.tsx`）完全未调用 `runtime.dispose()`。
   - 其余 **16 个文件**将 `await b.runtime.dispose()` 写在 `it()` 末尾且无 `try / finally`，断言失败即跳过释放；`localStorage.clear()` 也需每文件手写 `beforeEach`。

---

## 4. 测试夹具（Harness）与 Test Double 冗余

1. **Host 层 43 个文件内联 `new Context()`**
   - **19 个纯 Ledger 测试**（如 `project-owners.spec.ts`、`task-reminders.spec.ts`、`member-reminder-ledger.spec.ts`、`task-accountability.spec.ts`、`task-transfer-v3.spec.ts`、`rules-v1-replay.spec.ts`、`rules-v2-replay.spec.ts`、`main-stream.spec.ts` 等）重复手写 `Context -> Storage -> MemoryStorageBackend -> DomainFacility -> open(agentTeamDomainSpec) -> AgentTeamLedger`。
   - **27 个 Host 启动测试**（如 `surface-agreement.spec.ts`、`worker-stop.spec.ts`、`worker-host-thread.spec.ts`、`change-scopes.spec.ts`、`post-commit-delivery.spec.ts`、`update-operations.spec.ts`、`attachments.spec.ts` 等，其中 18 个额外调用 `provideQuietTokenMeter`）因为 [host-harness.ts](../../../../packages/agent-team/tests/helpers/host-harness.ts#L43-L68) 缺少挂载 `AgentTeam` 前的 `prepare(ctx)` 钩子，被迫整段复制 Host 启动代码。
   - [surface-harness.ts](../../../../packages/agent-team/tests/helpers/surface-harness.ts)（仅 2 个文件使用：`own-credential-superseded.spec.ts`、`surface-exemption.spec.ts`）几乎逐行复制 `host-harness.ts`。
   - `worker-host-thread.spec.ts` 与 `worker-stop.spec.ts` 之间存在大段 `FakeEngines`/`FakeWorker` 与 Host 启动克隆（`jscpd` 报 35 行 / 37 行连续克隆）。
2. **Tool 层无类型 `fakeHost` 拷贝**
   - `packages/tool-agent-team/tests/` 下 5 个文件（`team-task-actions.spec.ts`、`team-subscription-actions.spec.ts`、`team-thread-task-cards.spec.ts`、`team-reminder-actions.spec.ts`、`team-worker-actions.spec.ts`）各自手写未受 Host 类型约束的 `fakeHost()` 与 `call()` 包装，存在签名漂移风险。
3. **Client `harness.tsx` 单体臃肿（958 行）及用例克隆**
   - `harness.tsx` 将 `SlotTestRuntime` 引导、8 个域的 Remote stub/seeder、以及全局副作用守卫全部揉在单文件 958 行内。
   - `team-composer-mention-weight.client.spec.tsx` 与 `team-composer-mention.client.spec.tsx`、`team-config.client.spec.tsx` 与 `team-worker-settings.client.spec.tsx`、`drafts.spec.ts` 与 `navigation.spec.ts` 等存在 13–33 行的重复夹具/桩代码。
4. **E2E Worker 启动克隆**
   - `scripts/e2e/team-worker-inspect.e2e.ts:133-161` 与 `scripts/e2e/team-worker-stop.e2e.ts:69-99` 重复约 29 行 `FAKE_CODEX` 写入与设置切换逻辑。

---

## 5. 超时策略漂移与缺乏执行分层

- [vitest.config.ts](../../../../vitest.config.ts#L41-L63) 注释规定“超时策略集中在 `vitest.config.ts` 管理，不在单文件用 `vi.setConfig` 放宽预算”，并为此单独切出 `shared-host` project（`member-tool-policy.spec.ts`）。
- 但全仓已有 **43 个 spec 文件**（`agent-team` 34 个 + `client-agent-team` 9 个）在文件顶部调用 `vi.setConfig({ testTimeout: 30_000 | 60_000 })`。
- 快测（纯函数/Ledger/工具渲染，毫秒级）与慢测（多轮 `realHarness`/重型 `SlotTestRuntime`，数十秒级）混在同一个 `suite` project，无法按层快速回归。

---

## 6. E2E 机制与 CI 门禁缺口

1. **E2E staging 串行耦合与外部写入**
   - [scripts/run-browser-test.mjs](../../../../scripts/run-browser-test.mjs#L52-L73) 将模板替换后的 `.e2e.ts` 与 `support.ts` 直接写入相邻仓库 `../deepseek-harness/apps/web/tests/`，依赖 `finally` 清理；强杀（`SIGKILL`）会在外部仓库残留未跟踪文件。
   - 所有 26 个 E2E 场景共用同一个 `HOME`（`run-browser-test.mjs:18`），且每次 `openTeamPage()` 调用 `installLocalBundle()`（`scripts/e2e/support.ts:509-561`）都会先 `rm(HOME)` 再重新拷贝整个 bundle 与依赖包（26 次全量拷贝）。该做法强耦合上游 [deepseek-harness/vitest.web.config.ts](../../../../../deepseek-harness/vitest.web.config.ts#L35) 的 `fileParallelism: false`。
2. **CI 门禁未覆盖已有机械检查**
   - [.github/workflows/ci.yml](../../../../.github/workflows/ci.yml) 在 Linux + Windows 双平台仅运行 `npm run typecheck` 和 `npm test`。
   - `package.json` 中已配置的 `npm run lint`（`oxlint`）、`npm run build && npm run check:artifact`、`node scripts/audit-ui-parity.mjs` 均未进入 CI 门禁。
