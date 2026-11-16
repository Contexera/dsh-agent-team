# 01 — 采集全量 E2E 的 lane 与 scenario 耗时

**What to deliver:** 可重复的耗时拆解，能识别全量 E2E 的主要成本来源。
**Blocked by:** None — 当前基线与 Runner 已具备运行条件。
**Status:** `complete`
**Required context:** [README.md](../README.md)、[spec.md](../spec.md)、[`scripts/run-browser-test.mjs`](../../../../scripts/run-browser-test.mjs)、[`scripts/e2e/support.ts`](../../../../scripts/e2e/support.ts)、[`docs/development/e2e-lanes.md`](../../../../docs/development/e2e-lanes.md)
**Boundaries:** 只增加测量或诊断，不改变场景隔离和行为；至少三次全量对比。

- [x] 记录三次历史全量和本次串行基线的总耗时。
- [x] 记录一次受控两 lane 并行和一次全量并行实验。
- [x] 记录每条 lane 的测试耗时，并确认 Journey 是主要重 lane。
- [x] 记录三次分组调度全量结果，确认耗时下降和稳定性。
- [ ] 区分 Harness 启动、Browser/Context、Workspace 连接、页面行为和截图证据成本。
- [ ] 将结果写入 `materials/`，给出继续优化或停止的判断依据。

**Evidence to return:** 三次全量数据、阶段占比、主要瓶颈和未测范围。
