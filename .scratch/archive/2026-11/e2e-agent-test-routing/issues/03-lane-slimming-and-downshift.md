# 03 — E2E lane 收缩与低层下沉

**What to deliver:** 在不降低真实 assembled-Web 覆盖的前提下，缩短核心旅程、移出没有浏览器价值的用例、收缩重复表面流程。
**Blocked by:** 01
**Status:** complete
**Required context:** [spec.md](../spec.md) D4、[`scripts/e2e/`](../../../../scripts/e2e/)、[`scripts/run-browser-test.mjs`](../../../../scripts/run-browser-test.mjs)（`laneAliases`）、[`packages/agent-team/tests/harness-lifecycle.spec.ts`](../../../../packages/agent-team/tests/harness-lifecycle.spec.ts)、[`packages/client-agent-team/tests/team-settings.client.spec.tsx`](../../../../packages/client-agent-team/tests/team-settings.client.spec.tsx)、[`packages/client-agent-team/tests/environment-check.client.spec.tsx`](../../../../packages/client-agent-team/tests/environment-check.client.spec.tsx)、[`docs/development/e2e-lanes.md`](../../../../docs/development/e2e-lanes.md) 与 `.zh.md`、[materials/current-audit.md](../materials/current-audit.md) §4
**Background:** `.scratch/archive/2026-11/test-suite-slimming/spec.md` D5–D6 和其 review；当前 source/tests 优先于历史记录。
**Boundaries:** 先核对并补齐低层等价断言，再移动或删除 E2E；不共享可变 Scaffold/Workspace；不以截图数量目标代替覆盖证明。

- [x] 核查 `team-journey` 内部断言：其 `UI01`–`UI06` 携带大量真实 CSS/几何/DOM 不变量（jsdom 不加载 CSS），按 `spec.md` §3 不删除无等价低层覆盖的回归断言，保留完整核心旅程。
- [x] 将 `team-timeline-and-shell` 的 bundle toggle 对应的 Host 卸载/重装持久化移到 `packages/agent-team/tests/harness-lifecycle.spec.ts`。
- [x] 核对现有 `team-settings.client.spec.tsx` 与 `environment-check.client.spec.tsx` 的覆盖；下沉 `team-settings-and-tools` 中纯 SVG/文案重复检查，将窄屏 `[data-environment]` 容器宽度断言并入 `configures the Team page identity from Settings in real Web`。
- [x] 保持 Main/Board、Settings、Inbox 表面 lane 与 `team-journey` 的真实接缝不重删。
- [x] 保留 Manager、Inbox/recovery、Timeline/multi-page、Worker、Subscription 的真实浏览器契约。
- [x] 同步更新 `docs/development/e2e-lanes.md` 与 `.zh.md`（9 files / 21 tests / 200 screenshots）。
- [x] 对每个下沉行为运行对应 Host/Client/integration spec，并运行 `npm run check:docs` 与 `npm run check:e2e-docs`。

**Evidence to return:** 下沉映射表、变更后的 lane 统计、相关低层测试输出、targeted browser evidence、覆盖缺口和保留的风险。
