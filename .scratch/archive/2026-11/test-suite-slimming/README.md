# 测试套件精简、提速与 Agent 自验证改造 (test-suite-slimming)

- **Status:** `complete`（`01`–`04` 全部完成并验收；已按 `.scratch/AGENTS.md` 归档至 `archive/2026-11/test-suite-slimming/`）
- **Last checked:** 2026-11-15（基线 commit `617d8847`，基于 PR #100 `50e57df5` 与 PR #101 合入后 `master`）
- **Default acceptance owner:** Coordinator / Lead Agent（最终形态与截图证据由 Human 确认）

## 问题与目标

PR #100（`50e57df5`）完成了测试生命周期自托管、Host/Client/Tool 底座充血与 Vitest 五层互斥分区，PR #101 完成了 GitHub Actions CI 分层与 Harness 编译缓存。但在 `617d8847` 基线下，本地与 CI 实际执行的测试套件仍存在两类影响开发与 Agent 自验证效率的瓶颈：

1. **Agent 单表面浏览器自检被全量门禁阻塞**：当前 `scripts/run-browser-test.mjs` 会无条件把全部 28 个 `.e2e.ts` 路径作为位置参数传给 `vitest run`（即使 CLI 传入文件名过滤也会匹配跑全量），且 `scripts/e2e/support.ts` 的 `installLocalBundle()` 每次预建全部 16 个截图目录；配合 `assertScreenshotEvidence()`“空目录即失败”的门禁，导致 Agent 修改单一 UI 后想跑目标表面自检只能耗时 **217.2s（约 3 分 37 秒）** 跑完整个浏览器套件。
2. **E2E 冷启动扇出过大且存在跨层重复 / Timer 空等 / 并发 Flake**：
   - 28 个独立 `.e2e.ts` 文件 / 31 个场景带来 31 次独立 `openTeamPage()` + Chromium 冷启动与 206 张截图（`team-journey.e2e.ts` 单个文件达 3,403 行 / 47.8s / 115 处 `screenshot(` 调用）；其中 7 个 E2E 文件属于已被低层覆盖或无 UI/纯 Host-Client 状态机的错配场景；
   - `intakeWebhookDelivery()` 提交后未立即泵送（需等待 `WEBHOOK_PUMP_INTERVAL_MS = 5_000ms`），叠加订阅调度 `TICK_MS = 1_000ms` 与高频单测每条重复 `realHarness()`/`mountTeamApp()` 启动，拖慢 `integration` 与 E2E；
   - `packages/agent-team/tests/manager-skills.spec.ts:101` 在全量高并发 `vitest run` 下偶发 1s 超时失败（Chokidar `awaitWriteFinish` 默认 `200ms + 100ms` 与 `CollectCache` 在高并发下突破 `vi.waitFor` 默认 `1000ms` 上限）。

## 预期收益（基于 `617d8847` 实测基线）

| 指标 | 基线 (`617d8847`) | 目标效果 | 说明 |
| --- | --- | --- | --- |
| **Agent 单表面浏览器自检** | **217.2s**（被迫全量运行） | **6s ~ 12s** | 支持 `npm run test:browser -- <lane>` 只 staging 与执行目标 lane 并校对其产出的截图目录 |
| **全量 Browser E2E (`npm run test:browser`)** | **217.2s 墙钟 / 208.8s 累计**<br>（28 文件、31 测试、206 PNG） | **~75s ~ 90s**<br>（9 条 Surface Lanes、~95 PNG） | 下沉 7 个 E2E、收拢 21→9 条 lane、Worker 内复用 Chromium（独立 Context 隔离）、即时泵送 Webhook、裁减冗余过程 `fullPage` 截图；保留 `UI01..UI08` 桌面与 `390×844` 窄屏全覆盖 |
| **全量 Vitest (`vitest run`)** | **25.4s 墙钟 / 119.2s 累计**<br>（220 文件、2,841 测试，含 1 处并发 flake） | **~16s ~ 18s 墙钟 / ~85s 累计**<br>（0 flake） | 根治 `manager-skills` / `member-skills` 并发时序竞争；消除 Webhook 5s 与调度 1s 空等；压缩高频 `realHarness()` / `mountTeamApp()` 重复冷启动 |

## 当前推进与票据队列

| # | 标题 | 前置依赖 | Status | 链接 |
| --- | --- | --- | --- | --- |
| 01 | 修复 Skill 监听并发 Flake、消除 Webhook/Tick 空等并收敛高频 Spec 重复启动 | 无 | `complete` | [01-vitest-flake-and-fast-path.md](issues/01-vitest-flake-and-fast-path.md) |
| 02 | 升级 E2E Runner 单 Lane 过滤校验、共享浏览器实例与按需截图目录 | 无 | `complete` | [02-e2e-runner-and-single-lane.md](issues/02-e2e-runner-and-single-lane.md) |
| 03 | 7 个冗余 E2E 下沉迁移与 21→9 条 Surface Lanes 收拢 | 01, 02 | `complete` | [03-e2e-downshift-and-lane-consolidation.md](issues/03-e2e-downshift-and-lane-consolidation.md) |
| 04 | 更新开发检查文档、采集前后量化对比并完成 Scratch 归档 | 03 | `complete` | [04-docs-and-scratch-archive.md](issues/04-docs-and-scratch-archive.md) |

## 实测对比结果

| 指标 | 基线 (`617d8847`) | 改造后实测 | 说明 |
| --- | --- | --- | --- |
| **Agent 单表面浏览器自检** | **217.2s**（被迫全量运行） | **12.42s**（如 `team-inbox-and-recovery`，2 tests / 16 PNG） | 支持 `npm run test:browser -- <lane>` 仅 staging 并执行目标 lane，跳过全套 `[1440, 390]` 门禁 |
| **全量 Browser E2E (`npm run test:browser`)** | **217.2s**（28 文件、31 测试、206 PNG） | **197.55s**（9 条 Surface Lanes、24 测试、204 PNG） | 7 个 E2E 下沉到低层单测/集成测试，21→9 条 Surface Lanes，Worker 内复用 Chromium，保留全部 `[1440, 390]` 门禁 |
| **全量 Vitest (`vitest run`)** | **25.4s**（220 文件、2,841 测试，含 1 处并发 flake） | **22.24s–24.74s**（219 passed \| 1 skipped / 220 文件，2,845 passed \| 1 skipped / 2,846 测试，0 flake） | 修复 `manager-skills` / `member-skills` 并发竞态，消除 Webhook 5s 轮询空等，连续 3 轮 0 flake |

## 目录导航

- [spec.md](spec.md) — 已确认的技术决策（`D1`–`D6`）、范围边界与验证接口
- [materials/01-baseline-diagnosis.md](materials/01-baseline-diagnosis.md) — `617d8847` 基线全量数据、28 个 E2E 逐文件实测表、Vitest Top 20 慢文件及根因分析
- `issues/` — 分阶段实施票据（`01`–`04`）

## 完成条件

1. `01`–`04` 全部交付且对应验收条件逐条满足。
2. 全量 Vitest 连续运行 0 Flake，全量与单 Lane `npm run test:browser` 跑绿且 `assertScreenshotEvidence` 覆盖 `1440px` 与 `390px` 双宽度证据无丢失。
3. 不可变结论已写回维护文档，工作项从 `.scratch/active/` 清点并归档至 `.scratch/archive/2026-11/test-suite-slimming/`，`npm run check:scratch` 与全量检查通过。

## 维护文档出口

- [docs/development/start-and-checks.md](../../../../docs/development/start-and-checks.md)
- [docs/development/start-and-checks.zh.md](../../../../docs/development/start-and-checks.zh.md)
- [docs/development/generated-and-seams.md](../../../../docs/development/generated-and-seams.md) / [generated-and-seams.zh.md](../../../../docs/development/generated-and-seams.zh.md)
