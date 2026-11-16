# E2E 测试选择、Agent 反馈与文档入口

- **Status:** `complete`
- **Last checked:** 2026-11-16
- **Default acceptance owner:** Coordinator / Lead Agent
- **Scope:** 测试选择入口、E2E lane 目录、Runner 反馈、lane 必要性收缩与验证闭环

## 目标

让 Agent 从仓库根入口开始，就能回答四个问题：

1. 当前改动属于 Host、Client、assembled Web 还是完整跨表面流程；
2. 本次改动必须运行哪一个最窄的检查；
3. 哪些 E2E lane 只验证真实 Harness、slot、preset、浏览器几何或多页面接缝；
4. 测试失败后应查看哪一个阶段、哪一份截图和哪一个低层测试。

工作项采用“入口规则、维护目录、运行反馈、测试结构”四层分工：

- 根 `AGENTS.md` 只保存稳定的测试选择规则和维护文档入口；
- `docs/development/e2e-lanes.md` 与 `.zh.md` 保存完整的 lane 契约和触发映射；
- `scripts/README.md` 只描述脚本目录与入口，不再维护第二份过时的 lane 清单；
- Runner 输出 selected lane、测试、阶段、耗时、截图和 artifact 路径，帮助 Agent 闭环；
- E2E 只保留低层测试无法证明的真实接缝，重复的状态机和纯 Host 组装下沉。

## 当前 frontier

- 已完成当前 E2E 盘点：9 条 lane、24 个测试、约 204 张 PNG；全量 E2E 历史记录为 197.55 秒，单 lane 记录为 12.42 秒。
- 已确认当前文档问题：`scripts/README.md` 仍列旧 lane，维护指南只有两个 lane 示例，Runner 主要只输出截图总数。
- 已确认 lane 方向：保留 Manager、Inbox/恢复、时间线/多页面、Worker、订阅的真实组装接缝；缩短 `team-journey`；移出不启动浏览器的 bundle toggle；下沉 Settings 导航图标和环境版本检查等低收益断言。
- 已完成设计审查并收口：修正 `CHROME_PATH`（macOS `/Applications/Google Chrome.app`）环境事实，明确 Runner 外层阶段与场景子阶段边界、`contract` 单一来源、`check:docs`（`BLOCK_CHARACTER_CEILINGS` / `docs/README*.md` / `docs/development/README*.md`）联动，以及 `team-settings.client.spec.tsx` / `environment-check.client.spec.tsx` 既有覆盖。
- **Issue 01–04 全部完成（`complete`）：**
  - **01（入口与目录）：** 根 `AGENTS.md` 新增 `Test selection`；新增中英文 [docs/development/e2e-lanes.md](../../../../docs/development/e2e-lanes.md) / `.zh.md` 并登记到 `docs/README*.md`、`docs/development/README*.md`、`start-and-checks*.md` 与 `scripts/check-docs.mjs`；清理 `scripts/README.md` 旧清单；新增 `npm run check:e2e-docs` 并接入 `npm test`。
  - **02（Runner 反馈）：** 新增 `scripts/browser-runner.mjs`（`.d.mts`）与 `packages/agent-team/tests/browser-runner.spec.ts`；`run-browser-test.mjs` 支持 `--list`、从 `e2e-lanes.md` 读取 `contract`、外层阶段（`preflight`/`staging`/`vitest`/`evidence`/`cleanup`）+ `support.ts` 场景子阶段标记（`harness-boot`/`page-action`）及 `artifacts/browser/summary.json`。
  - **03（下沉与收缩）：** `bundle toggle` 持久化下沉至 `packages/agent-team/tests/harness-lifecycle.spec.ts`；`team-settings-and-tools.e2e.ts` 移除与 `team-settings.client.spec.tsx` / `environment-check.client.spec.tsx` 重复的两条测试并合并窄屏 `[data-environment]` 断言（24→21 tests，204→200 screenshots）；`team-journey.e2e.ts` 保留完整真实 CSS/几何/DOM 不变量。
  - **04（三次复测与验收）：** `npm test`（220 files / 2849 tests）、`typecheck`、`oxlint` 全绿；三次定向 `team-inbox-and-recovery`（`15.17s`、`14.26s`、`13.89s`，均值 `14.44s`）与三次无过滤全量 `npm run test:browser`（`192.38s`、`195.44s`、`192.94s`，均值 `193.58s`，9 files / 21 tests / 200 screenshots）全部通过。

## 工作项结构

- [spec.md](spec.md) — 当前确认的目标、决策、边界和验收条件
- [issues/01-test-selection-entry-and-lane-catalog.md](issues/01-test-selection-entry-and-lane-catalog.md) — 根入口与 lane 维护目录
- [issues/02-runner-feedback.md](issues/02-runner-feedback.md) — Runner 的 lane 列表、阶段反馈和结构化 summary
- [issues/03-lane-slimming-and-downshift.md](issues/03-lane-slimming-and-downshift.md) — E2E 收缩、下沉和真实接缝保留
- [issues/04-acceptance-and-measurement.md](issues/04-acceptance-and-measurement.md) — 全量验证、耗时复测和收口
- [materials/current-audit.md](materials/current-audit.md) — 当前实现证据、成本数据和审查依据

## 完成条件

1. 根 `AGENTS.md` 能从改动接缝路由到最窄测试，并明确 targeted lane 与完整 browser acceptance 的关系。
2. 中英文 lane 目录覆盖当前实际存在的 E2E 文件、每条 lane 的唯一契约、低层测试、触发条件和证据。
3. `scripts/README.md` 不再列过时的 lane；新增机械检查能发现 lane 文件、alias 和文档不一致。
4. Runner 能列出当前可用 lane，并在成功或失败时输出 lane、测试、阶段、耗时、截图和 artifact 路径。
5. `team-journey` 的核心冒烟与局部 UI 断言分开；没有浏览器行为的 bundle toggle 不再运行在 browser suite 中。
6. 下沉的每个 E2E 行为都有对应的 Host/Client/integration 断言；保留的 E2E 仍覆盖真实安装、slot/preset、浏览器行为或普通 DSH 恢复。
7. 有 Chrome 的环境完成 targeted lane、全量 E2E、截图门禁和人工视觉检查；没有 Chrome 的环境明确记录未验证范围，不把低层测试通过当作浏览器通过。
8. `check:docs`、`check:scratch`、新增的 E2E 文档一致性检查、typecheck、相关 Vitest 和适用的 browser checks 通过。

## Maintained-document exit

- Planned maintained-document exit: [`docs/development/e2e-lanes.md`](../../../../docs/development/e2e-lanes.md) / [`e2e-lanes.zh.md`](../../../../docs/development/e2e-lanes.zh.md)
- [`docs/development/start-and-checks.md`](../../../../docs/development/start-and-checks.md) / [`start-and-checks.zh.md`](../../../../docs/development/start-and-checks.zh.md)
- [`scripts/README.md`](../../../../scripts/README.md)
- 根 [`AGENTS.md`](../../../../AGENTS.md)

`.scratch` 只保存设计、实施票和证据；当前行为仍以源代码、测试和维护文档为准。
