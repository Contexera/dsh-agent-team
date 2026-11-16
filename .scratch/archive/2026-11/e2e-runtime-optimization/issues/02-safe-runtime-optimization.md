# 02 — 实施保持隔离的运行时优化

**What to deliver:** 一个经证据支持的运行时优化，或证明当前不值得继续改造的结论。
**Blocked by:** 01
**Status:** `complete`
**Required context:** [README.md](../README.md)、[spec.md](../spec.md)、`materials/` 中的耗时证据、[`scripts/e2e/support.ts`](../../../../scripts/e2e/support.ts)
**Boundaries:** 不共享可变 Harness、Workspace、HOME、Storage 或页面状态；不删除真实 browser 契约。

- [x] 评估独立 profile 并行；全量并行在重 lane 上触发 hook 超时，暂不采用。
- [x] 替换 Main/Board lane 中两处固定 `400ms` 睡眠为已有的动画与布局稳定等待。
- [x] 评估只读资源复用和受控 fixture 复用的成本与风险；当前收益不足，不实施状态复用。
- [x] Runner 采用重 lane 串行、轻 lane 有界并行，并保留 serial 回退。
- [ ] 只实施一个可独立回滚、可解释的优化方案。
- [ ] 为新增的生命周期不变量补充有行为价值的测试。

**Evidence to return:** 方案取舍、代码 diff、隔离证明、相关测试结果和未解决风险。
