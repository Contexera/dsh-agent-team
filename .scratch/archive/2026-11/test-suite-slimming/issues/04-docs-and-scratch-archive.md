# 04 — 更新开发检查文档、采集前后量化对比并完成 Scratch 归档

**What to deliver:** 将可复用的测试分层策略与 Agent 单 Lane 浏览器快速自检用法沉淀进维护文档（中英文双版同步），在工作项中补齐最终前后实测对比并完成独立复核，清理后按 `.scratch/AGENTS.md` 规范将本工作项归档到 `.scratch/archive/2026-11/test-suite-slimming/`。
**Blocked by:** 03
**Status:** complete
**Required context:**
- Work-item entry: [README.md](../README.md) & [spec.md](../spec.md)
- Maintained docs & scratch rules:
  - `AGENTS.md` & `docs/AGENTS.md`
  - `docs/development/start-and-checks.md` & `docs/development/start-and-checks.zh.md`
  - `docs/development/generated-and-seams.md` & `docs/development/generated-and-seams.zh.md`（若提及 E2E 证据或单跑门禁）
  - `.scratch/AGENTS.md` & `.scratch/README.md`
**Background:**
- Archive reference format: `.scratch/archive/2026-11/test-system-overhaul/README.md`.
**Boundaries:**
- Included:
  - 同步更新 `docs/development/start-and-checks.md` 与 `docs/development/start-and-checks.zh.md`：记录精简后的 Vitest / 9 条 E2E Surface Lanes 结构，明确说明改 UI 时应先使用 `npm run test:browser -- <lane>` 单表面快速验证（与提交/里程碑全量 `npm run test:browser` 的双层约定）；
  - 记录交付实测对比报告（`617d8847` 基线 vs 最终提交下的 Vitest 墙钟/累计、全量 E2E 耗时、各 Lane 单跑耗时、PNG 数量及连续多轮稳定性）；
  - 将票据 `01`–`04` 状态核对闭环后把 `.scratch/active/test-suite-slimming/` 移入 `.scratch/archive/2026-11/test-suite-slimming/`，删除无 provenance 价值的临时输出，并在 `.scratch/README.md` 的 Archived 清单追加一行汇总与链接（更新 `Last checked` 与状态）。
- Excluded: 不修改与测试运行/文档维护无关的源代码，不将 `.scratch/local/` 或调试临时截图提交入 Git。

## Acceptance Criteria

- [ ] `docs/development/start-and-checks.md` 与 `docs/development/start-and-checks.zh.md` 内容对齐、链接有效，清楚列出单 Lane 快速浏览器自检命令与 9 条 Lane 划分规则。
- [ ] 工作项已移至 `.scratch/archive/2026-11/test-suite-slimming/`，`.scratch/README.md` 索引已更新且所有 `issues/*.md` 状态与 `README.md` 完成记录一致。
- [ ] 全仓最终门禁（`npm run check:docs`、`npm run check:core-skills`、`npm run check:boundaries`、`npm run check:versions`、`npm run check:comments`、`npm run check:scratch`、`npm run check:facades`、`npm run typecheck`、`npm run lint`、`npm run build && npm run check:artifact`、`npm test`、`npm run test:browser`）全部通过，且 `git status` 无预期外或 Harness 侧脏文件。

**Evidence to return:** changes, final verification command outputs and quantified before/after summary table, unverified scope, and deviations
