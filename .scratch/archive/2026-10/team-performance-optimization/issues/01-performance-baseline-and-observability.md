# 01 — 建立 Team 性能基线和分段观测

**What to build:** 一套能在固定 Team/Harness 版本和固定 workload 上运行的性能基线，输出 Host 启动、单次 tool call 和两成员协作的原始样本与分位数汇总，并能关联一次协作从 A 发出到 B 回复的各阶段。
**Blocked by:** None — can start immediately
**Status:** complete

2026-10-30：新进程冷启动、模型驱动的 Team 读取/回复闭环和固定版本对照均完成；最终交付检查见 reviews/04-team-performance-optimization-recheck.md。

- [x] 支持客户端 bundle 资产、Host 启动、新 Member activation、真实只读 Team tool sweep、真实 `team_message post` 写工具、Thread 回复到通知扇出、固定 adapter 的冷/热 Agent wake、内存 ledger 读取、SQLite 重启 replay 和真实 Chromium loading workload
- [x] 记录独立 warmup 和样本；Host boot 每个样本在全新 Node 进程启动，并单独记录已有 Member 恢复。Agent 场景通过实际工具读写并核对持久回复。
- [x] 记录 ledger reply、queue wait/service、fan-out dispatch/drain、ledger read、SQLite replay，以及独立 Session/Agent 和 Browser 场景；未暴露的关联标识仍为 `null`
- [x] 完整协作样本关联 callId、requestId、operationId、Session、通知消息 id 和领取 turn；通过既有 Agent inbox 与 tools 事件记录，不增加生产 hook。
- [x] 输出逐条 JSONL 原始样本、manifest 和包含 p50/p95/p99、有效样本数、环境、规模参数的汇总
- [x] 默认运行不产生性能 hook 输出；显式设置 `DSH_BENCH_TEAM=1` 才运行实验
- [x] 支持比较两个 run 或矩阵的 `summary.json` / `results.json`，可用 `--max-regression` 做显式回归门槛
- [x] 在独立 clean snapshot commit 上跑通14个对照case，各31样本+3 warmup；相同评测脚本覆盖旧新生产代码，不混用旧 schema。版本、命令与测量边界见最终验证材料。

## 当前运行方式

```bash
DSH_BENCH_TEAM=1 DSH_BENCH_SAMPLES=1 npm run bench:team
```

输出写入 `artifacts/team-perf/runs/<run-id>/manifest.json`、`samples.jsonl` 和 `summary.json`。评测入口集中在 `scripts/team-performance/`；场景可用 `DSH_BENCH_SCENARIOS` 选择，规模可用 `DSH_BENCH_THREADS` 和 `DSH_BENCH_FOLLOWERS` 调整。Host boot 每个样本是新进程，Agent 场景走真实Session和Team工具闭环；Browser loading独立测量。fan-out与ledger场景对实际未读、派发和Inbox数量做断言。固定版本比较使用同一套schema 2脚本，不能混用之前固定文本回合或未建立真实积压的样本。

比较两个结果：

```bash
npm run bench:team:compare -- --max-regression 20 <before-summary-or-matrix> <after-summary-or-matrix>
```

比较器只比较两边都存在的场景和 p50/p95/p99；缺失场景或指标会列出，指定门槛时会按不兼容处理，未指定门槛时只报告差异，不把本机噪声自动判为回归。
