# 测试体系全面治理与底座充血规格说明 (`spec.md`)

- **状态：** 已收敛（Human 于 2026-11-14 确认全部设计树决策）
- **依据材料：** [01-test-suite-audit.md](materials/01-test-suite-audit.md)、[02-rich-foundation-analysis.md](materials/02-rich-foundation-analysis.md)

---

## 1. 问题与目标

自 2026-11-02 上一次测试精简（[2026-11/test-ablation](../../archive/2026-11/test-ablation/README.md)，141 个 spec / 1,568 项测试）以来，测试体系规模已扩张至 **208 个 Vitest spec**（`agent-team` 138、`tool-agent-team` 14、`client-agent-team` 56）+ **26 个浏览器 E2E** + **1 个性能基准 E2E**（测试目录共 247 个文件、69,457 行），暴露出六类系统性问题：

1. **清理与环境隔离散落且脆弱：** 52 处 `const cleanups` 手动数组、13 个文件曾漏写排空（PR #96 止血）、3 处双重 dispose 并发删目录竞态、4 个 Client spec 漏调 `runtime.dispose()`、初始化中途失败与清理步骤缺 `try / finally`、以及 `process.env.DSH_HOME` 被 harness 覆写后不恢复。
2. **底座贫血导致大量仪式噪音：** 单条 `realHarness` 测试的 Given 阶段往往需要 15–20 行底层 RPC/revision 样板代码；全局账本自检仅靠少数测试手写 `validateLedger()`。
3. **测试替身冗余且缺少类型约束：** 测试目录 `jscpd` 检出 125 处克隆（1,788 行）。Host 层 43 个文件内联 `new Context()`；`surface-harness.ts` 与 `host-harness.ts` 重复；Tool 层 5 份手写无类型 `fakeHost()` 存在签名漂移风险；Client `harness.tsx` 膨胀到 958 行。
4. **超时策略与配置契约漂移：** [vitest.config.ts](../../../vitest.config.ts) 注释规定超时集中管理，但 43 个文件顶部散落 `vi.setConfig({ testTimeout })`，且快测与慢测混在同一 project。
5. **增量测试未经第二轮消融：** 11-02 之后新增的 67 个 spec 存在重复片段与弱断言隐患。
6. **E2E staging 效率与 CI 门禁缺口：** `installLocalBundle()` 每跑一个场景都删光并重拷共享 `HOME`（26 次全量拷贝，强耦合 `fileParallelism: false`）；CI 尚未跑 `lint`、`check:artifact` 与 `audit-ui-parity`。

**目标：** 将测试体系升级为**生命周期零样板、领域底座充血、契约强类型、执行分层清晰、E2E/CI 门禁完备**的工程架构。

---

## 2. 已确认的架构决策

### D1 — PR #96 基线与增量收口
- PR #96 已合入；本次核查基线为 `26cf8ce11e197fcca3da89d5e5969e1a69a38215`，无需再执行合并。
- PR #96 遗留的同类缺口纳入 **Ticket 01** 一并收尾：`closeScenario()` 补 `try / finally`、`team-worker-subscription.e2e.ts` 的 `replayDir` 迁入 `scenarioTempDir()`、`member-memory-dirs.spec.ts` 删除未使用的 `mkdtemp` 导入、模块顶层 `mkdtempSync` 补 `process.once('exit')` 兜底。

### D2 — 生命周期自托管与全局不变量守卫
- 所有共享底座（`openTestLedger`、`host-harness` 的 `harness()`/`sqliteHarness()`、`realHarness()`、`mountTeamMemberHost()`、`createClientBench()`/`runtimeWithTeam()`）在**资源创建第一时间**通过 Vitest `onTestFinished`（若用于 `beforeAll` 共享启动则通过显式 `afterAll` 适配）注册自己的释放逻辑：
  - 全部清理动作包裹在 `try / finally` 中，确保 `fiber.dispose()` / `facility.closeAll()` / `backend.close()` / `runtime.dispose()` 即使失败也不会跳过 `rm(root)` 与状态恢复；
  - 覆写 `process.env.DSH_HOME` 前保存旧值并在清理中恢复；
  - Host/Ledger 底座在清理前默认自动执行 `validateLedger()`（对故意测试损坏账本恢复的场景保留 `{ validateLedger: false }` 显式退出开关）；
  - Client 底座在 `onTestFinished` 自动执行 `slotCrashes` 归零断言、`cleanup()`、`runtime.dispose()` 与 `localStorage.clear()`。
- 从全仓删除手动 `cleanups` 数组与重复的 `afterEach` 排空样板，消除 `subscription-retry.spec.ts`、`subscription-directory.spec.ts`、`team-view-directory.spec.ts` 中的双重清理竞态。

### D3 — 测试底座充血（Deep Test Foundation）与 4 条护栏

**必须遵守的 4 条硬性护栏：**
1. **Given 充血，When / Then 显式：** 领域句柄与快捷方法只用于前置状态构造与纯净内省读取；被测动作和断言明文留在 `it(...)` 中。
2. **零平行权威：** Host/Ledger 领域动作委托真实 `ctx.agentTeam` / `AgentTeamLedger`。Client 的 Remote stub 和 Tool Spy 是契约替身，允许设置返回数据、故障和延迟，但不模拟 Host 的鉴权、revision 或状态机；`SlotTestRuntime` 仅负责真实 Client 装配。
3. **双层逃生舱：** 每个充血句柄保留 `.ctx`、`.agent`、`.memberId`、`.taskRef`、`.raw` 等底层访问点，支持异常路径、并发版本冲突、权限拒绝与竞态测试。
4. **向后兼容、渐进采用：** 新句柄/方法增量挂载到返回值上（保留原有字段解构），支持分批迁移。

**三层底座充血落点：**
- **Host / Ledger 底座（`packages/agent-team/tests/helpers/`）：**
  - 新增 `openTestLedger()`：收编纯 Ledger 测试所需的 `Context + Storage + MemoryStorageBackend + DomainFacility + AgentTeamLedger` 初始化。
  - 升级 `host-harness.ts`：为 `harness()` 增加 `prepare(ctx)` 钩子（挂载 `AgentTeam` 前注入自定义 `agents` / `subagent` / `shell` / `credentials` 等替身）；合并并移除重复的 `surface-harness.ts`；抽共享 `FakeEngines` 供 Worker Host 测试复用。
  - 充血 `TestHuman`、`TestMember`、`TestProject`、`TestTask` 领域句柄：内置自增 `requestId`、默认 `workspaceId` 与 `mock` 模型、`startTask` / `claimTask` / `acceptTask` / `reply` 等 `read -> baseRevision -> write -> assertCommitted` 快捷链条，以及 `waitForIdle()`、`queuedNotices()`、`splicedNoticeTargets()` 等内省原语。
- **Tool 底座（`packages/tool-agent-team/tests/`）：**
  - 抽取共享的**强类型契约 Spy Host 底座**（`TestToolHost`，通过 `satisfies` 校验所覆盖的 `AgentTeam` `*ForAgent` 方法签名），提供标准 committed 回执构造器及共享 `callTool()` / `renderTool()` 辅助函数，替换 5 个工具动作 spec 中各自复制的无类型 `fakeHost()`。
- **Client 底座（`packages/client-agent-team/tests/`）：**
  - 将 958 行的 `harness.tsx` 按域拆分为核心 `SlotTestRuntime` 挂载器 + 强类型领域种子工厂（`projects` / `threads` / `inbox` / `workers` / `settings`，类型严格对齐 `@contexera/dsh-agent-team/types`）+ 语义化故障/延迟注入器（`failNext` / `holdNext`）+ 高频页面操作辅助（`openTeam` / `openProject` / `openTask`）。
  - 保留 `runtimeWithTeam()` 兼容包装层，内部委托给新 `ClientTestBench`。

### D4 — 存量 Spec 定向迁移边界
- **本次直接迁移并充血精简：**
  - 43 个内联 `new Context()` 的 Host/Ledger spec（19 个纯 Ledger + 27 个 Host 启动，含重复的 `worker-host-thread.spec.ts`/`worker-stop.spec.ts`）；
  - 2 个使用 `surface-harness.ts` 的 spec；
  - 13 个 PR #96 刚补过 `afterEach` 的 `member-*.spec.ts`（删除冗余 `cleanups`/`afterEach`，高收益用例采用新句柄精简）；
  - 5 个 Tool `fakeHost` spec；
  - 4 个遗漏 `runtime.dispose()` 的 Client spec 及存在 `jscpd` 克隆的 Client fixture 块（`team-composer-mention*`、`team-config`/`team-worker-settings`、`drafts`/`navigation`）。
- **本次不逐行重写：** 其余已使用共享底座且结构清晰的存量 spec，仅删除手动 `cleanups` / `vi.setConfig` 样板，自动继承新底座的生命周期、环境恢复与 `validateLedger()` 守卫。

### D5 — Vitest 分层与超时策略收口
- 在 [vitest.config.ts](../../../vitest.config.ts) 中按执行代价划分为明确 `projects`：`unit` 默认 5s；`integration` 覆盖 `realHarness`、`mountTeamMemberHost` 与重型 `SlotTestRuntime`，默认 60s；`worker-long` 只收纳需要 120s 的 Worker 长场景；`benchmark` 只收纳通过 `DSH_BENCH_STORAGE=1` 显式启用的存储基准，预算 900s；`shared-host` 保留 `member-tool-policy.spec.ts` 的 30s test/hook 预算。所有预算写在 `vitest.config.ts`，测试文件不再自行设定。
- 移除 43 个测试文件中散落的 `vi.setConfig({ testTimeout })`，消除配置漂移；保留 `npm test` 默认全跑，同时支持 `npx vitest run --project unit` 快速本地反馈。

### D6 — 第二轮测试消融（Round 2 Ablation）
- 对 2026-11-02 `test-ablation` 之后新增的 67 个 spec 执行与上一轮同等标准的审查与故障注入验证：合并重复场景、收紧弱断言、消除空转测试，记录消融与故障验证证据。

### D7 — E2E 只读模板 Staging 与 CI 门禁补齐
- `scripts/run-browser-test.mjs` 与 `scripts/e2e/support.ts`：在整轮 `test:browser` 开始前**只 staging 一次** bundle 与依赖 Closure 至只读模板目录；每个场景按自身独立 `HOME` 克隆/软链，消除 26 次重复拷贝和与上游 `fileParallelism: false` 的隐式耦合；抽取共享 `FAKE_CODEX` 与 Worker 设置切换 helper 消除 `team-worker-inspect.e2e.ts` / `team-worker-stop.e2e.ts` 的 29 行克隆。
- `.github/workflows/ci.yml`：在 Linux lane 补齐 `npm run lint`、`npm run build && npm run check:artifact` 与 `node scripts/audit-ui-parity.mjs`。

---

## 3. 明确边界与非目标

- **禁止修改 `../deepseek-harness`**（严格遵守仓库边界规则）。
- **不改变 `packages/*/src/` 生产语义**（所有改动限定在 `packages/*/tests/`、`scripts/`、根配置文件、`ci.yml` 与对应开发文档）。
- **不把 `npm run test:browser` 塞入 GitHub CI**（遵循 `ci.yml` 现有作用域守卫，保持本地验收门禁，仅通过优化 staging 缩短本地运行耗时）。
- **不搞“为了重写而重写”的全仓 208 文件强改**（只做 D4 划定的高 ROI 定向迁移）。

---

## 4. 验证接缝

- **常规与静态门禁：** `npm run typecheck`、`npm test`、`npm run lint`、`npm run build && npm run check:artifact`、`node scripts/audit-ui-parity.mjs`。
- **代码重复度观测：** 对 `packages/*/tests` 与 `scripts/e2e` 运行 `jscpd` 核对克隆数（较基线 125 处 / 1,788 行显著下降）。
- **E2E 与证据：** Ticket 06（以及涉及 `scripts/e2e/` 的改动）必须跑通 `npm run test:browser` 并核对 `artifacts/browser/` 截图与临时目录零残留。
- **消融验证：** Ticket 05 在独立临时 worktree 对新增/精简域注入代表性生产故障，确认精简后检出率不降反升。


## 5. 设计审查补充约束（2026-11-14）

以下约束与 D1–D7 一同约束实施；它们补齐生命周期和验证边界，不扩大生产行为范围。

### 生命周期与资源归属（01、02、03）

- 清理注册必须在首次异步初始化前完成；尚未分配的资源允许为空。初始化抛错时立即释放已分配资源，测试结束回调只作幂等兜底。`beforeAll` 的注册器由调用方显式传入，不能在共享启动时调用仅属于当前测试的 `onTestFinished`。
- 同一个资源只有一个释放责任方，显式 `close()` 与自动回调共用幂等释放路径。校验、DOM 卸载、runtime/fiber、facility、backend、目录删除、环境恢复中任一步失败，后续适用步骤仍须执行，并报告原始失败与清理失败；不能让 `validateLedger()` 或 `slotCrashes` 断言阻断释放。
- 多个底座嵌套覆盖 `DSH_HOME` 时按逆创建顺序释放和恢复；原值不存在时删除环境变量。禁止在同一 worker 中并发覆盖该变量；同样约束使用全局 DOM/localStorage 的 Client 测试。不要用 `Promise.all` 排空有顺序依赖的环境恢复。
- 保留重启/恢复测试中作为被测动作的 `teamFiber.dispose()`、storage 关闭和重新挂载；只删重复的最终清理。自动账本校验使用仍有效的账本句柄：Host 为当前挂载实例，纯 Ledger 为 `AgentTeamLedger.validate()`；主动卸载场景在关闭存储前校验，不能测试结束时访问已卸载服务。借用的重开 root/pool 不由每个新句柄各自删除，目录由创建者最终释放。
- 自动校验的成本计入实测运行时间，不承诺免费扩大覆盖。验证至少包括初始化中断、校验失败仍清理、多底座逆序恢复、显式关闭后自动回调、真实重启/SQLite 重开；故意损坏账本的退出开关须在用例说明原因。

### 任务范围与并行关系

- `01` 负责已有 Host/Member 生命周期和 E2E `closeScenario()`；`02` 负责新增 Ledger 底座及迁移内联生命周期；`03` 负责 Client 生命周期。删除全仓手动数组是三票合并后的结果，不能要求 `01` 提前修改 `02`、`03` 的范围。
- `06` 依赖 `01`，接续修改 `support.ts`。不扩张为清理全仓历史 lint 问题：先返回已有失败的位置和结果；无关改动另行定范围。

### Staging 的隔离与验证（06）

- “只 staging 一次”指包和依赖的准备只进行一次；场景若选择克隆仍会发生文件复制，分别报告准备次数、场景复制量和整轮耗时，不能以准备一次声称消除了所有重复 I/O。
- 共享模板仅包含安装包和依赖。profile、设置、数据库、日志、Member memory、Worker 产物等可写状态必须位于场景独立 HOME。保留 `@botiverse/oar` 当前依赖解析约束；链接方案须证明解析路径及加载的 bundle 入口仍符合安装验收目标。
- 迁移所有 `HOME` / `STAGED_BUNDLE` 调用方，覆盖同一场景关闭后再次启动、启动中途失败、设置写入及另一个场景不受影响。现有模块级 scaffold/browser 只承诺一个 worker 内串行场景；本票消除共享 HOME 冲突，不宣称整个 E2E 已支持并行。
- 不修改上游并行配置。全量浏览器验证仍走现有入口；实际检查桌面与 390×844 截图，以及关闭后的目录清理。上游工作区以运行前后差异为准，不删除原有文件或要求原本脏的工作区变干净。

### 证据口径

- 文件数净增长不能直接作为新增文件数。`05` 固定历史提交和本轮起点，分别列新增、删除、重命名及已有文件新增领域用例；67 是盘点差值，最终范围由差异清单确认。
- 消融前后使用相同生产基线、依赖、配置、故障及执行入口，区分断言检出、类型检查检出、环境/超时失败和无效故障。报告每个故障两侧的实际结果；有限故障集只能支持该集合上的检出能力结论。
- `jscpd` 使用相同版本、路径、参数和忽略配置，保留前后输出；重复率是观测项，不能以减少独特场景或隐藏被测动作来换取下降。


### 已决定：执行预算分层（04）

直接超时盘点显示 `worker-inspect.spec.ts` 有 120 秒用例和 30 秒清理钩子，`storage-bench.spec.ts` 有 900 秒手动基准。保留这些预算，但把它们迁入配置层：`worker-long` 项目固定 120s testTimeout、30s hookTimeout；`benchmark` 项目固定 900s testTimeout，并继续由 `DSH_BENCH_STORAGE=1` 显式启用。普通 `integration` 固定 60s，`unit` 固定 5s，`shared-host` 固定 30s test/hook。这样保留真实长场景所需预算，又不让普通测试获得过大的静默预算；所有测试和钩子内的直接超时参数一并迁移或删除。该决定解除原信息阻塞，`04` 仍只等待票据 `01, 02, 03` 完成。

消融删除/合并须逐项说明由哪个保留场景覆盖；若依据 E2E 覆盖，须在对应故障下实际运行替代 E2E 并记录断言检出，缺少证据则保留原测试。
