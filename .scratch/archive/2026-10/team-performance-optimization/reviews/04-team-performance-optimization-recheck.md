# Review 04 — Team 性能优化最终验收

**Conclusion:** Pass
**Work item:** team-performance-optimization
**Ticket:** Whole work item
**Compared:** 主仓库基线 `f4de5a01c0edb8626a4d6ada5b6d2cc1ba4a5c1f` 与本次完整工作树；固定性能对照在独立 clean snapshot 中运行相同评测脚本
**Commits:** 本报告与实现、正式文档和工作项归档一同提交；本机测量快照不属于主仓库提交
**Reviewed:** 2026-10-30

## Findings

No confirmed findings.

本轮发现的问题均已修复并验证：usage 的 resumed/removed 状态折叠、未执行 Team 工具的协作场景、复用进程的冷启动场景、没有实际未读积压的 fan-out 负载、空比较结果假通过，以及 `running` 快速返回遗漏读取后重试。最后一项通过撤回快速返回修复，没有再添加特殊分支。

Pass 表示交付实现与本工作项验收已经完成，**不表示所有场景的 p95 均下降**。大批量提交提前返回有稳定收益，全部派发完成时间存在代价；此取舍已写入正式文档。原始 SQLite 长尾差异未稳定复现，原因未查明。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 固定版本、真实负载与分段观测 | Met | 14 个 case × 两版本 × 31 样本；相同 schema 2 脚本，另做三轮交替版本复测。负载断言检查未读数与实际派发数。 |
| 真实 Agent 协作读写 | Met | cold/warm 共两次 `team_thread read`、两次已提交 `team_message reply`、六次接收者模型请求；记录 notice、turn、call、request、operation。 |
| 冷启动和持久 Member 恢复 | Met | 每样本新建 Node 子进程测到空 Host ready；在该进程内另测两个持久 Member 的 Host 恢复，SQLite open/replay/validate 独立记录。 |
| 通知读取与 plan 复用不改变事实 | Met | snapshot 等价、异常清理、跨提交更新测试；八个旧新通知检查点的正文、coverage、undelivered、attempt、steer/followup 全等。 |
| 队列顺序与生命周期 | Met | 大批次后的小批次不插队；换代不投给旧 Agent；单 Member 失败不影响其他 Member；关闭后未开始派发为 0；异步 invariant 记录 error。 |
| 使用情况统计 | Met | 真实 SQLite CLI 测试覆盖 enabled/suspended/archived/inactive 与正文/handle 隔离；实际只读副本重算完成。 |
| 评测失败可见 | Met | 无效分位数、零基线、完全空测量和耗时回归均有比较器退出码测试；Node 性能脚本纳入正式类型检查。 |
| 工程与组装路径检查 | Met | 全量功能测试、类型、build、artifact、Browser、基线、矩阵、语义探针全部通过；桌面和 390×844 截图已检查。 |
| 结果和约束归入正式文档 | Met | 中英文性能文档、Host authority、开发入口、package README、Changelog 同步更新。 |

## Checks run

| Command or check | Result |
| --- | --- |
| `npm test` | 137 files / 1548 tests 通过；1 file / 1 test 跳过。前置 docs、facades、core-skills、boundaries、versions、comments 检查通过。 |
| `npm run typecheck` | Host、tools、Client 及 `tsconfig.scripts.json` 全部通过。 |
| `npm run test:browser` | 完整 build 成功；10 files / 10 tests 通过，包含普通 DSH 恢复、多页面、键盘/鼠标和 bundle 切换。 |
| `node scripts/run-browser-test.mjs -t 'keeps four same-origin Team pages responsive'` | 单场景通过，另外 9 项按过滤跳过；用于保留并检查最新桌面与手机截图，不代替全量 Browser 结果。 |
| `npm run check:artifact` | 358 个文件，65 个运行时相对导入全部可解析，无散落源码。 |
| `DSH_BENCH_TEAM=1 npm run bench:team` | 默认 16 场景、48 个测量样本完成。 |
| `npm run bench:team:matrix` | 15/15 case 通过。 |
| `DSH_BENCH_TEAM=1 npm run bench:team:semantics` | 5/5 通过；关闭后运行数 0，大小批次序列为八个 12 后一个 13。 |
| 旧新通知差分 | 八个检查点全部相等；只归一化自动生成实体 ID 和发生时间。 |
| 固定性能对照 | 首轮 868 个测量样本，三轮重点复测 930 个；同一 SQLite 文件控制实验另有 168 个。结果见最终性能材料。 |
| 独立 Browser loading | 3 样本，warnings/pageErrors 为空；不据此宣称稳健 p95 收益。 |
| 优化前独立 build 与优化后 Client 体积 | raw 1103398→1102468 B，gzip 169853→169602 B，brotli 107924→108000 B；不宣称二进制相同。 |
| 相邻 Harness 工作区 | Browser 完成后状态为空，未保留临时 overlay。 |

最后一轮完整检查在 2026-10-30 23:05–23:11（UTC+8）完成，截图专项在 23:14 完成。原始日志与样本保留于忽略目录 `artifacts/team-perf/`，不进入归档。

## Unverified scope and residual risk

- 固定 adapter 不代表生产模型提供方延迟；新进程空 Host 启动与同进程持久 Member 恢复，不等于完整真实 profile 的跨进程恢复。
- 31 样本的 p95 是本机观察，不是生产 SLO。大批次总派发时间可能增加；SQLite 最初长尾差异原因未查明。
- 本轮没有 Client 源码修改，但压缩产物有微小差异：brotli 增加 76 B（约 0.07%），原因未查明。
- 早期 lint 返回成功但有既有 unused/import-assign 警告；未扩大范围清理无关文件。
- 未发布、未推送；没有把日常截图标记为人工批准的视觉基线。

## Review record

- Spec sources: `spec.md`、`issues/01–03`；原始决定作为历史保留，实际性能取舍见 `materials/final-performance-results.md`。
- Standards sources: 根 `AGENTS.md`、`.scratch/AGENTS.md`、`docs/AGENTS.md`、正式开发检查与 Host authority 文档。
- Uncommitted and untracked changes included: 本次 Host/ledger 修改、三组新增或扩充测试、七个性能脚本、命令与类型配置、正式文档以及原工作项完整归档；不包含 ignored artifacts、真实 profile 或临时快照仓库。
