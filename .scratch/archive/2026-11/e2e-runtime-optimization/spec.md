# E2E 全量运行成本优化规格

## 目标与成功标准

目标不是为了达到某个固定秒数而删除真实接缝，而是降低完整 assembled-Web 验收的时间和人工等待，同时保持测试能发现跨表面回归。

成功标准：

- 能解释全量运行时间主要花在哪里；
- 优化后不共享可变场景状态，不降低每个 lane 的真实契约；
- 全量运行的平均耗时有可重复改善，且失败、清理和截图证据仍然可靠；
- 如果收益不足以抵消复杂度，明确停止继续优化。

## 当前基线

- 基线提交：`8911169b`；
- 9 条 lane、21 个测试、200 张截图；
- 最近三次全量：`192.38s`、`195.44s`、`192.94s`，均值 `193.58s`；
- 现有 Runner 已复用一个只读 bundle template 和一个 Chromium 进程；每个 scenario 仍建立独立 HOME、WebScaffold、BrowserContext 和页面；
- 证据校验阶段耗时很小，主要时间位于 browser Vitest 阶段。
- 当前实验显示全量文件并行会触发重 lane 的 hook 超时；截图采样不降低 journey 耗时。默认继续保持串行和完整视觉证据。
- 已确认安全调度：`team-journey` 与 `team-manager` 串行运行，其余 7 条 lane 使用最多两个 Worker；完整运行三次均通过且均值约 `151.51s`。

## 约束

- 真实 Harness、Slot、Preset、assembled Web、CSS/布局、多页面和普通 DSH 恢复仍由 E2E 负责；
- 每个 scenario 的 Workspace、profile、HOME、数据库、日志、Member memory、Worker artifacts 和页面状态必须隔离；
- 不以共享可变 fixture、关闭清理、减少必要视口或弱化截图门禁换取表面速度；
- 不默认把 browser lane 加入 CI，除非本次测量证明发布门或 Agent 日常反馈已经成为实际瓶颈；
- Runner 的 summary 只记录运行事实，不成为第二份 lane 行为权威。

## 待验证方案

1. **测量优先：** 按 scenario 记录 bundle 安装、Harness 启动、Chromium/context/page、Workspace 连接、页面行为和清理耗时。
2. **只读环境复用：** 评估是否能在场景之间复用只读 bundle 或已构建 Web 资源；已有 bundle template 复用是当前基线。
3. **安全并行：** 评估按 lane 或 scenario 并行时的临时目录、端口、profile 和 artifact 隔离，确认机器资源不会导致不稳定。
4. **状态复用：** 默认拒绝；只有在能证明重置完整、成本收益明显时才做小范围实验。

## 已否定方案

- **直接开启 Vitest 文件并行：** 两条 lane 的受控实验通过，但全量 `maxWorkers=2` 让 `team-journey` 和 Manager 清理 hook 超时，不能作为默认优化。
- **关闭大部分截图：** `team-journey` 依赖其中一张截图作为上传 fixture；保留该 fixture 后的采样实验没有收益，不能把截图写盘视为主瓶颈。

## 已采纳方案

- 无过滤的完整运行按两个批次执行：先串行重 lane，再运行轻 lane 的有界并行批次。
- 定向运行保持原有单批次行为；`DSH_E2E_SCHEDULING=serial` 可在资源受限环境强制全量串行，`DSH_E2E_MAX_WORKERS` 调整轻批次上限。
- 不复用可变 Harness、Workspace、HOME、Storage 或页面状态；每个 Vitest 批次仍保留原有场景隔离和清理。

## 决策门

- 如果主要成本确实来自环境启动，且可安全并行或复用能带来稳定收益，再实施代码优化；
- 如果完整验收只在发布或人工验收时运行，且当前约三分钟不影响交付，保留现状并停止结构性改造；
- 如果优化只减少截图数量、断言或真实接缝覆盖，而没有降低环境成本，拒绝该方案。
