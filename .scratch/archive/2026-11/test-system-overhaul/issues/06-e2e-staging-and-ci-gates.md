# 06 — E2E 只读模板 Staging 提速、Worker 夹具复用与 CI 机械门禁补齐

**What to deliver:** 消除 E2E 每次场景重复全量拷贝 bundle 与共享 `HOME` 的串行耦合，抽取 E2E `FAKE_CODEX` 共享安装 helper，并在 `.github/workflows/ci.yml` 的 Linux lane 补齐仓库已有但未接入 CI 的机械检查（`lint`、`check:artifact`、`audit-ui-parity`）。
**Blocked by:** 01
**Status:** complete
**Required context:**
- Binding review constraints: [spec.md §5](../spec.md#5-设计审查补充约束2026-11-14)（按本票编号适用）。
- Work-item entry: [README.md](../README.md)
- Binding decision D7 and Boundaries in [spec.md](../spec.md)
- Scripts & CI: `scripts/run-browser-test.mjs`, `scripts/e2e/support.ts`, `scripts/e2e/team-worker-inspect.e2e.ts`, `scripts/e2e/team-worker-stop.e2e.ts`, `.github/workflows/ci.yml`, `docs/development/start-and-checks.md`, `docs/development/start-and-checks.zh.md`
**Background:**
- Audit details in [01-test-suite-audit.md](../materials/01-test-suite-audit.md) §4.4 and §6.
**Boundaries:**
- Included:
  - 将 `installLocalBundle()` 的只读包与依赖 Tree 复制逻辑上移到 `scripts/run-browser-test.mjs` 运行前只 staging 一次至只读模板目录；每个场景启动 `openTeamPage()` 时使用独立的 per-scenario `HOME`（从模板克隆或 junction/symlink 只读部分，如使用 `scenarioTempDir` 确保随场景关闭清理），解除对上游 `fileParallelism: false` 的隐式耦合；
  - 在 `scripts/e2e/support.ts` 抽取共享 `installFakeCodex()` / Worker 设定 helper，消除 `team-worker-inspect.e2e.ts` 与 `team-worker-stop.e2e.ts` 的 29 行克隆；
  - 在 `.github/workflows/ci.yml` 的 Linux lane 增加 `npm run lint`、`npm run check:artifact`（`build` 后运行）与 `node scripts/audit-ui-parity.mjs`（先核查预存失败；无关问题返回负责人另定范围）；
  - 若运行脚本行为说明涉及文档变更，同步更新中英文 `start-and-checks` 保持 `check:docs` 通过。
- Excluded: 不得修改 `../deepseek-harness`；不把 `npm run test:browser` 放入 GitHub CI；不破坏 `run-browser-test.mjs` 的 `finally` 清理（确保外部仓库无残留 `__external-agent-team-*` 文件）。

## Acceptance Criteria

- [x] `npm run test:browser` 全量跑通，26 个 E2E 场景全部通过且 `assertScreenshotEvidence` 校验通过；单个运行周期内只准备一次共享包体/依赖模板，另行报告场景克隆的复制量与耗时，各场景使用相互隔离的 `HOME` 并在结束后无残留临时目录。
- [x] `team-worker-inspect.e2e.ts` 与 `team-worker-stop.e2e.ts` 已改用 `scripts/e2e/support.ts` 的共享 Worker setup helper，两文件间不再存在 20+ 行重复安装代码。
- [x] `.github/workflows/ci.yml` Linux lane 已包含 `npm run lint`、`npm run check:artifact`、`node scripts/audit-ui-parity.mjs` 步骤，且本地执行这三项检查全部 0 错误通过。
- [x] `npm run typecheck`、`npm test`、`npm run build && npm run check:artifact`、`npm run lint`、`node scripts/audit-ui-parity.mjs` 全部通过；`../deepseek-harness` 工作区相对运行前没有新增或修改残留。

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
