# Review 02 — Team 性能优化复审

**结论：** 本次复审列出的 5 个问题已处理。工作项仍保留“clean commit 对照、完整性能样本和真实 Agent 工具闭环”等未完成验收项，不把它们误标为已完成。

**复审范围：** 当前工作树中的 Host 通知路径、性能评测脚本、比较器、Harness 路径解析和维护文档。

**复审日期：** 2026-10-30

## Findings 处理结果

| 编号 | 结果 | 处理 | 验证 |
| --- | --- | --- | --- |
| F1 | 已处理 | 某 Member 已有延迟通知时，后续小批次也进入同一条 Member 链，不再同步插队；语义探针改为“大批次后小批次”。 | `post-commit-delivery.spec.ts` 12/12；语义探针 ordering 通过，序列为前一提交的 8 次通知后再处理后一提交。 |
| F2 | 已处理 | 比较器把 `count: 0`、缺失分位数和无效测量报告为 invalid；零基线变为正值在 `--max-regression` 下失败。 | equal、普通回归、空测量、零到正值四组 CLI 检查全部符合预期。 |
| F3 | 已处理 | baseline 复用 `scripts/harness-dir.mjs` 的 `harnessDir`，支持相对 checkout、绝对路径和 `.generated-harness` 规则。 | `DSH_HARNESS_DIR=deepseek-harness` smoke 正确记录 Harness commit。 |
| F4 | 已处理 | 注释和 Host authority 双语文档区分同步 invariant reject 与延迟通知 error log；后者不改变已返回的 committed result。 | 文档检查通过；延迟 invariant 测试通过。 |
| F5 | 已处理 | 英文和中文文档索引的 Where to start 增加 Team 性能入口。 | `npm run check:docs` 通过。 |

## 真实使用边界

新增 `bench:team:usage`，读取显式 SQLite 副本的原始 operation 和 Inbox delta，不强制用当前 ledger replay，因此旧的 `team/channel-*` 记录仍可统计。它只输出计数，不输出 Message 正文或 handle。

当前真实 profile 的统计结果为：25,838 条 operation、23 个 enabled Member、483 个 Attention Thread；enabled Member 的 follower 数 p95 为 1、最大 3，全部 durable Attention row 的最大值为 4。Thread write 的受影响 Member 估算 p95 为 3、最大 10；8 人队列阈值命中 103/10,261 次，最近 30 天为 1/2,750 次。历史 8–10 人协作高峰仍然存在，因此异步队列保留为低频保护路径，不继续扩展为常态架构。

默认矩阵已改为 1、2、4、8 follower，20 Thread/4 follower 和 1 Thread/32 follower 压力档。这样日常规模与压力规模分开，避免把 32 follower 的 synthetic 结果解释为普通使用。

## 验证结果

- `npm test`：135 个测试文件通过、1 个跳过；1540 个测试通过、1 个跳过。
- `npm run typecheck`：三个 package 通过。
- `npm run build`：通过。
- `npm run check:artifact`：358 个 artifact entry 通过，65 个 runtime relative import 全部解析。
- `DSH_BENCH_TEAM=1 npm run bench:team:semantics`：failure recovery、shutdown cancellation、mixed-batch ordering、Client invalidation 全部通过。
- `DSH_BENCH_MATRIX_SAMPLES=1 DSH_BENCH_MATRIX_WARMUPS=0 npm run bench:team:matrix`：15/15 case 通过。
- `npm run bench:team:usage -- /home/yu/.dsh/storages/agent_team.sqlite`：真实 live SQLite 只读统计通过。
- `npm run test:browser`：首次全量运行 9 个场景通过，1 个完整 journey 在退出 Team 后等待普通 composer 超时；单独重跑该 journey 通过。该次全量运行仍应视为一次间歇性 Browser 长尾，不能声称全量 Browser 一次通过，也没有把它改成更宽的假门槛。

## 当前结论

本轮评测资产已经足够支持加载、tool call、ledger、Session 和协作路径的持续对照；下一步不再增加新的 fan-out 调度层。生产侧保留 read-set、delivery plan 复用、running coverage 跳过和低频有序通知队列；评测侧保留一个 32 follower 压力档，用于防止极端协作回归。

仍未完成的项目属于验收范围，不是本次复审遗留缺陷：clean commit 上的固定版本对照、完整 Agent tool 读写闭环，以及 Browser 全量一次通过的重复确认。当前未修改 ticket 状态、未提交、未推送。
