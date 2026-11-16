# E2E 全量运行成本优化

- **Status:** `complete`
- **Last checked:** 2026-11-16
- **Default acceptance owner:** Coordinator / Lead Agent
- **Scope:** 全量 browser E2E 的耗时拆解、环境启动复用或安全并行，以及优化后的隔离性与稳定性验收

## 目标

在保留真实 Harness、assembled Web、浏览器布局、多页面和普通 DSH 恢复接缝的前提下，确认全量 E2E 的主要成本，并只实施有证据支持的低风险优化。

当前基线：9 条 lane、21 个测试、200 张截图；最近三次全量运行均通过，耗时为 `192.38s`、`195.44s`、`192.94s`，均值 `193.58s`。

本工作项关注的是完整验收成本，不重新讨论已经完成的测试分级、lane 契约和 Agent 测试路由。

## 当前 frontier

- 已确认 Runner 的证据校验不是瓶颈，主要耗时集中在 browser Vitest 阶段。
- 已确认每个场景仍会建立自己的 HOME、WebScaffold、BrowserContext 和页面；Chromium 进程按 Worker 复用。
- 已完成串行基线、lane 消融、截图成本实验和并行调度实验；简单全量并行会超时，资源分组并行稳定通过。
- 已采用重 lane 串行、轻 lane 两 Worker 的完整 Runner 调度，并保留 serial 回退。
- 三次完整运行均通过，下一步只剩代码级检查、提交和归档。
- 在没有证据证明状态可安全复用前，不共享可变 Harness、Workspace、HOME、Storage 或页面状态。

## 完成条件

1. 有至少三次可比较的全量基线，能按 lane 或 scenario 识别主要耗时。
2. 明确继续优化、保持现状或仅做一次受控实验的决策，并记录理由。
3. 若实施优化，保留每个场景的状态隔离、截图门禁、普通 DSH 恢复和失败清理行为。
4. 优化前后分别完成 targeted lane、全量 browser、相关 Vitest、typecheck、lint 和文档/ scratch 检查。
5. 没有达到安全收益或成本收益的方案不进入生产代码；稳定结论移入维护文档后再归档工作项。

## 结果

- 三次默认完整运行：`149.461s`、`153.810s`、`151.248s`，均值 `151.506s`。
- 每次均为 9 个文件、21 个测试、200 张截图通过；重 lane 串行，轻 lane 两 Worker。
- 相对当前串行基线 `193.353s`，均值下降约 `21.6%`。

## Maintained-document exit

- [`docs/development/e2e-lanes.md`](../../../../docs/development/e2e-lanes.md)
- [`docs/development/start-and-checks.md`](../../../../docs/development/start-and-checks.md)
- 根 [`AGENTS.md`](../../../../AGENTS.md)

`.scratch` 记录测量、决策和验收证据；当前测试行为仍以源码、测试和维护文档为准。
