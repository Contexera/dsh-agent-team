# 02 — 升级 E2E Runner 单 Lane 过滤校验、共享浏览器实例与按需截图目录

**What to deliver:** 让 Agent 与开发者能够通过 `npm run test:browser -- <lane>` 在 ~10s 内独立 Staging、运行并校对单个 E2E Surface Lane，并在同一个 Worker 内复用 Chromium `Browser`（每次场景仅创建隔离 `BrowserContext`），同时移除 `installLocalBundle()` 预创建全部 16 个截图目录的阻塞。
**Blocked by:** None — no ticket blockers
**Status:** complete
**Required context:**
- Work-item entry: [README.md](../README.md)
- Binding decision `D4` and Boundaries in [spec.md](../spec.md)
- Scripts & harness:
  - `scripts/run-browser-test.mjs`
  - `scripts/browser-evidence.mjs`
  - `scripts/e2e/support.ts`
  - `packages/agent-team/` / `scripts/` typecheck config (`tsconfig.scripts.json`)
**Background:**
- Agent self-verification blockage details in [01-baseline-diagnosis.md](../materials/01-baseline-diagnosis.md) §4.
**Boundaries:**
- Included:
  - `scripts/e2e/support.ts`：
    - 将 Chromium 进程启动从“每次 `openTeamPage()` 执行 `chromium.launch`”改为同 Worker 进程懒初始化复用，每个场景调用 `sharedBrowser.newContext({ viewport, locale, deviceScaleFactor })` 获得全新无状态上下文，并在 `closeScenario()` 中清理 `page`/`context`、`WebScaffold` 及临时目录；进程结束或显式清理 hook 时关闭共享 `Browser`（`page.addInitScript` 等每页行为保持兼容，原生 `chromium` 仍可由测试按需单开以应对多页面/异常测试）；
    - 移除 `installLocalBundle()`（当前 lines 621–624）预创建全部 16 个 `*_SHOTS` 目录的逻辑；在截图目录按需 `mkdir(..., { recursive: true })` 创建（可提供统一的截图写入 helper 或更新支撑逻辑），保证未跑到的 Lane 不会遗留空目录。
  - `scripts/run-browser-test.mjs` 与 `scripts/browser-evidence.mjs`：
    - 当 CLI 传入文件名/子串过滤参数（如 `npm run test:browser -- team-manager`）时，仅筛选、staging 并向 `vitest run` 传递匹配的 `__external-agent-team-*.e2e.ts`（连同 `__external-agent-team-support.ts`）；若传入 `-t` 等 Vitest option flag 则按约定透传；
    - 缩窄运行时对其实际产出的截图执行 PNG 头/尾签名检查与“非空目录”验证（不要求未跑到的表面目录存在，亦不因只有单一表面宽度的截图而误报）；无任何过滤参数的全量验收运行，继续严格执行完整的 `UI01..UI08` 与 `[1440, 390]` 双宽度及零空目录门禁；
    - 执行 `pnpm` 时若系统 PATH 未软链 `corepack`，自动降级直接调用 `pnpm`（保持 Windows `.cmd` / `shell: true` 兼容）；
    - 继续保证 `finally` 块彻底清除 `../deepseek-harness/apps/web/tests/__external-agent-team-*` 与临时 staging 目录。
- Excluded: 不修改 `../deepseek-harness`；暂不删除或合并具体的 28 个 `.e2e.ts` 业务文件（由票据 `03` 负责）。

## Acceptance Criteria

- [ ] `npm run test:browser -- team-settings-nav-icon`（或任意单个轻量 E2E 过滤词）仅执行匹配到的 1 个 `.e2e.ts` 文件，实际只生成对应的截图目录并运行局部截图完整性校验，端到端完成且不报错，单跑耗时显著低于全量基线（目标 ~10s 量级，不含首次 `npm run build` 视实际记录）。
- [ ] 多用例同一进程运行时，Worker 内只启动一次 Chromium 实例，每个 `openTeamPage()` 仍拥有相互隔离的 `BrowserContext`（Cookie/`localStorage` 无串扰）。
- [ ] 无过滤运行全量 `npm run test:browser` 时，严格执行 `assertScreenshotEvidence(artifacts, [1440, 390])` 并全部通过，`../deepseek-harness` 工作区在结束后无残留临时文件。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:docs`、`npm run check:scratch` 全部通过。

**Evidence to return:** changes, checks and observed results (single-lane command + full `test:browser` timing & screenshot count), unverified scope, and deviations
