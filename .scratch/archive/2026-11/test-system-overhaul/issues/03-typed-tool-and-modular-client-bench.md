# 03 — Tool 强类型契约底座与 Client 分域 Bench 重构

**What to deliver:** 为 `packages/tool-agent-team/tests/` 建立强类型 `TestToolHost` 替换 5 份无类型 `fakeHost()`；将 958 行的 `packages/client-agent-team/tests/harness.tsx` 拆分为模块化、强类型的 `ClientTestBench`（自带 `onTestFinished` 自动清理与 `localStorage.clear()`），补齐 4 个 Client spec 遗漏的 `runtime.dispose()` 并消除 Client spec 克隆。
**Blocked by:** None — no ticket blockers
**Status:** complete
**Required context:**
- Binding review constraints: [spec.md §5](../spec.md#5-设计审查补充约束2026-11-14)（按本票编号适用）。
- Work-item entry: [README.md](../README.md)
- Binding decisions D2, D3 (Tool & Client sections + 4 guardrails), and D4 in [spec.md](../spec.md)
- Current harnesses & specs: `packages/tool-agent-team/tests/render-text.ts`, `packages/tool-agent-team/tests/team-*-actions.spec.ts`, `packages/tool-agent-team/tests/team-thread-task-cards.spec.ts`, `packages/client-agent-team/tests/harness.tsx`
**Background:**
- Audit details in [01-test-suite-audit.md](../materials/01-test-suite-audit.md) §3.7 and §4.2–4.3, and design rationale in [02-rich-foundation-analysis.md](../materials/02-rich-foundation-analysis.md) §2.3–2.4.
**Boundaries:**
- Included:
  - **Tool 层：** 在 `packages/tool-agent-team/tests/` 提取共享 `TestToolHost`（使用 TypeScript `satisfies` 校验 `AgentTeam` `*ForAgent` 方法签名）、标准 committed 回执工厂以及共享 `callTool()` / `renderTool()`，迁走 `team-task-actions.spec.ts`、`team-subscription-actions.spec.ts`、`team-thread-task-cards.spec.ts`、`team-reminder-actions.spec.ts`、`team-worker-actions.spec.ts` 里的本地 `fakeHost()`；
  - **Client 层：** 将 `harness.tsx` 拆分为职责清晰的小模块（核心 runtime 装配、各域强类型 seed 工厂与 `ClientTestBench` 包装、`failNext`/`holdNext` 故障注入与 `openTeam`/`openProject`/`openTask` 导航辅助）；
  - **Client 自动生命周期：** `createClientBench` / `runtimeWithTeam` 内部通过 `onTestFinished` 自动执行 `slotCrashes` 校验、`cleanup()`、`runtime.dispose()` 与 `localStorage.clear()`；补全 `human-profile-seats.client.spec.tsx`、`main-panel.client.spec.tsx`、`team-loading-surface.client.spec.tsx`、`team-task-board-page.client.spec.tsx` 及另外 16 个文件里重复的手动清理/dispose；
  - 消除 `team-composer-mention*`、`team-config`/`team-worker-settings`、`drafts`/`navigation` 等 Client spec 的重复测试设置代码。
- Excluded: 不修改 `packages/*/src/`；不删除 `runtimeWithTeam()` 兼容出口（保持存量 spec 平滑兼容）；不改变任何 UI 行为或测试断言语义。

## Acceptance Criteria

- [x] `packages/tool-agent-team/tests/` 中不再存在 5 份各自复制的无类型 `fakeHost()`，共享 `TestToolHost` 受 `AgentTeam` 接口类型约束，故意改错一个 `*ForAgent` 签名能被 `tsc` 拦截。
- [x] `packages/client-agent-team/tests/harness.tsx`（958 行单体）已拆分为清晰的分域辅助模块，提供强类型 seed 构建器与语义化故障/延迟注入器，且继续导出向后兼容的 `runtimeWithTeam()`。
- [x] 所有使用 `runtimeWithTeam()` / `createClientBench()` 的 20 个 Client spec 均由底座在 `onTestFinished` 中自动完成 `slotCrashes` 检查、`cleanup()`、`runtime.dispose()` 与 `localStorage.clear()`（包括此前遗漏的 4 个文件）。
- [x] `packages/tool-agent-team/tests/` 与 `packages/client-agent-team/tests/` 间的显式重复夹具块已收口，`npm run typecheck`、`npm test`、`npm run lint` 全绿。

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
