# 04 — 验收、耗时复测与工作项收口

**What to deliver:** 用真实浏览器复测新 lane 结构，确认 Agent 反馈闭环和最终测试职责，并把稳定规则移入维护文档。
**Blocked by:** 02, 03
**Status:** complete
**Required context:** [README.md](../README.md)、[spec.md](../spec.md)、issues/01–03、[`docs/development/generated-and-seams.md`](../../../../docs/development/generated-and-seams.md)、[`docs/development/start-and-checks.md`](../../../../docs/development/start-and-checks.md)
**Background:** 当前历史数据和环境限制见 [materials/current-audit.md](../materials/current-audit.md)。
**Boundaries:** 没有可用 Chrome（既无 `/usr/bin/google-chrome` 也未设置可用的 `CHROME_PATH`）时不声称 browser 通过；不把单次运行当稳定基线；文档、source、tests 冲突时以 source/tests 为准并记录差异。

- [x] 运行新增文档和机械检查：`check:docs`、`check:e2e-docs`、`check:scratch`、`typecheck`、`oxlint`。
- [x] 运行 targeted lane（`team-inbox-and-recovery`、`team-settings-and-tools`、`team-timeline-and-shell`），确认 Runner summary 输出正确。
- [x] 运行全量 `npm run test:browser`，200 张截图通过 `[1440, 390]` 门禁与 Harness 清理检查。
- [x] 记录三次全量（`192.38s` / `195.44s` / `192.94s`，均值 `193.58s`）与三次定向 `team-inbox-and-recovery`（`15.17s` / `14.26s` / `13.89s`，均值 `14.44s`）的阶段耗时。
- [x] 对比当前 197.55s 历史记录：24→21 tests，204→200 screenshots，全量均值 `193.58s`（-2.0%），单 lane 相对全量快约 92.5%。
- [x] 稳定测试选择规则、lane 契约、反馈格式与命令已移入 maintained docs。
- [x] 所有验收条件满足，工作项状态改为 `complete` 并归档至 `.scratch/archive/2026-11/e2e-agent-test-routing/`。

**Evidence to return:** 完整命令和输出、耗时表、截图审查记录、未验证范围、剩余风险、维护文档出口和归档决定。
