# 03 — 自动压缩：`auto: true` + 分路由阈值（2026-10-21 改为 DSH 默认引擎与默认模板）

**What to build:** preset 的 compaction 行挂本仓自己的引擎子类（compaction-basic 的子类，只覆盖 `summarize()` 注入移植模板），`auto: true` 让引擎自动管 between-step 压力与 request 溢出；分路由 `modelPolicies` 让自动压缩在 256K 量级触发（human 17:39 拍板）。成员会话里自动压缩真实发生（日志可见 `compaction (step pressure): shadowed …`），摘要产物是 7 节 checkpoint 结构。**这是 Team 第一次真实运行引擎自动压缩**（44 天全程 `auto: false`）。
**Blocked by:** None — can start immediately（与 01/02 并行；preset 行名切换在 04 删除 cc 后做才安全）
**Status:** complete（方案已由用户决定覆盖）

**Outcome (2026-10-21):** 用户决定直接使用 DSH 默认 `@deepseek-ai/dsh-compaction-basic` 和它的默认模板。Team 引擎子类、模板副本、模板冻结测试与对应 export 已删除；`modelPolicies` 由 DSH 默认实现处理，不再有自定义 `summarize()`。preset 保留 `thresholdRatio: 0.256`、`retainRatio: 0.08`、`headroomTokens: 65536`，`auto` 使用上游默认值。下面两项“子类/模板”工作因此被取代，不再执行。

- [x] ~~新引擎子类文件~~（被上方决定取代：改用默认引擎与默认模板）（本仓，如 `packages/agent-team/src/team-compaction-engine.ts`）：extends `@deepseek-ai/dsh-compaction-basic`，只覆盖 `summarize()`；模板文本 = cc `DEFAULT_COMPACTION_TEMPLATE` 全文（约 42 行），注释里带测量依据（133 次真实压缩：通用模板 30% 复述代码、41% 丢「谁在等我」）
- [x] preset `compaction-basic` 行：`auto` 去掉 `false`（默认 true），行名先仍指本 bundle 子路径（行名从 profile 解析的约束不变）
- [x] 阈值（256K 定案）：全局 `thresholdRatio: 0.256`（1M 族）；`modelPolicies`：1,048,576 族 `0.2441`、922K 族 `0.2779`、272K/200K 族显式认领更早触发；`retainRatio: 0.08`；provider 段按 profile 实际路由填（不猜）
- [x] 阈值配置预留接口：数值走 preset yml 可调；设置页 UI 不做（后续独立票，client 注释零余量）
- [x] 引擎测试改为 `preset-compaction.spec.ts`：真实组合下自动压缩发生、policy 生效：`summarize()` 注入的指令文本含 7 节标题、与 cc 模板逐字节一致；`resolveConfig` 层阈值按路由生效
- [ ] **真实 profile 验收**（未做：需要真实模型跑到阈值。本轮只有无密钥组合测试，不能替代摘要质量与成本验证）（`dsh web --profile web-dev` 或新档）：成员挂载成功（`never started` 静默故障不复现）、跑到阈值自动压缩发生、摘要产物为 7 节结构
