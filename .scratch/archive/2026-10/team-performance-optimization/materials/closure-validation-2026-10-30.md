# 2026-10-30 完整验收补充

## 状态与范围

用户要求完整推进原工作项，不把未完成项拆出去以提前归档。验收现已完成，原工作项随实现一同归档提交，不推送。实现基线为主仓库 `f4de5a01c0edb8626a4d6ada5b6d2cc1ba4a5c1f`，Harness 为 `687f282e8625c6b8d11ff58211a90524be2e4317`，Node v24.15.0。

## 已确认并修复的问题

1. usage 未处理 resumed；removed 又读取了不存在的 data.memberId。统一按实际 data.member 快照折叠。真实 SQLite CLI 回归覆盖 enabled/suspended/archived/inactive、enabled follower 和不泄露正文/handle。
2. 原 Agent-turn 只是固定文本回答，不是 Team 读取/回复。现由确定性 adapter 驱动真实 team_thread read 和 team_message reply，cold/warm 共两次读取、两次已提交回复、六次接收方请求；记录 notice id、claim turn、call id、request/operation id。真实账本核对回复正文。
3. 原 Host boot 未包含新进程。现每个样本使用新 Node 子进程；记录空 Host ready、已有两个持久 Member 的重挂载恢复、Session inventory 与 activation。SQLite open/replay/validate 仍由独立场景测量。
4. 原 fan-out 的 threadCount 只是创建 Thread，只有目标 Thread 被关注；之后仅补关注仍不够，因为 follow 不继承历史。现每个负载 Thread 都被关注，随后真实 ledger.reply 写入未读，断言 bounded Inbox 数量等于 min(threadCount,50)。计数和阶段从填充完成后才开始。
5. running coverage 快速返回改变语义，已撤回。六个检查点对照中，前五相同，部分读取后旧路径 13 次通知/attempt14，新路径只有12次/attempt13；撤回后六个检查点完全相同。不能仅靠 coverage 非空且 undelivered 空判定无需重派生。

## 差分方法

在忽略目录生成独立 Git 快照仓库（不是修改主工作树或 Harness），before 使用原 HEAD 的生产源码，after 使用当前源码；同一套评测与测试文件覆盖到两边后创建 clean snapshot commit。生成的 UUID 与发生时间归一化，其余通知正文、steer/followup、coverage、attempt 和 undelivered 全量比较。

最终八个检查点：truncated、steer-failure、retry、derivation-failure、replacement-activation、read-then-running、carried-input-followup、recovery-prefix。2026-10-30 22:53（UTC+8）旧新八点全部一致。额外回归覆盖八人延迟通知期间替换一个 Agent、另一个投递失败，其余六个照常投递；旧 Agent 不收到通知，失败 Member 在下次提交重试。

## 实测记录

- 全量 Browser：10/10 通过；桌面、390×844 截图已检查。旧 9/10 记录保持为历史，不改写。
- 独立 Browser loading：3 样本，warnings/pageErrors 为空；样本量不支持稳健 p95 收益结论。
- 原基线16场景48样本与默认矩阵15/15通过；扩展场景的最新结果另记录。
- usage 重算：从只读连接在线备份真实数据库到仓库外临时目录，副本25838 operations，enabled23、archived8；Attention483，enabled follower p95=1、max=3。修复前的具体结论这次恰好未变，不代表旧脚本正确。
- 最终全量功能测试1548 passed/1 skipped；类型检查覆盖三个包和正式 `tsconfig.scripts.json` 中的Node性能脚本，全部通过。
- 最终docs、build、artifact（358文件、65运行时导入）、Browser（10/10）、基线（16场景48样本）、矩阵（15/15）、语义探针（5/5）均通过。扩展前 lint 有既有 unused/import-assign 警告，未改无关文件。

## 固定版本复跑方法

1. 使用主仓库原始基线 `f4de5a01c0edb8626a4d6ada5b6d2cc1ba4a5c1f` 和本工作项最终交付源码，各自 `git archive` 到独立临时目录；不能来回改共享工作树的生产文件。
2. 两边使用同一份最终 `scripts/team-performance/`、通知差分测试和路径配置。安装依赖并指定同一个 Harness checkout；本轮使用已有依赖链接，临时副本不会修改原仓库。
3. 在每个临时目录建立独立Git仓库与 `validation-snapshot` 分支并提交，运行前后确认 status 为空；记录源提交、覆盖文件SHA-256及快照commit。不把本机快照commit当可公开获取的源码地址。
4. 运行同一baseline CLI：`DSH_BENCH_TEAM=1 DSH_BENCH_SAMPLES=31 DSH_BENCH_WARMUPS=3 DSH_BENCH_SCENARIOS=<scenario> DSH_BENCH_THREADS=<threads> DSH_BENCH_FOLLOWERS=<followers> node --import tsx scripts/team-performance/team-performance-baseline.ts`。每case一个新进程，交替先before/先after。
5. 14个case：host-boot、collaboration-agent-turn；fanout为1Thread×1/4/8/32Follower、20×4、100×1；memory与SQLite各1/20/100Thread。每边31个测量样本，暖身不写入样本。
6. 输出按同scenario与规模交给 `bench:team:compare`；未知指标保留null，不为了门槛通过而删掉。查看首轮及交替重复样本，报告不稳定项，不只选最快一轮。
7. 通知差分运行 `DSH_BENCH_NOTICE_OUTPUT=<output.json> npx vitest run packages/agent-team/tests/post-commit-delivery.spec.ts -t 'preserves notice text'`；两边输出只归一化自动生成的实体ID和发生时间，比较全部检查点。

## 固定版本结果与复测

固定 before/after 快照上的14个case，每case31个样本和3次warmup，交替版本顺序，已全部完成。before 为 `4bcbb3286fe9158d585a1d438d301992eb00369c`，after 为 `7764fb52d861f8e7809ed030040214462fca0917`（均为本机独立快照仓库，不是主仓库历史提交）。最初因发现 Thread 负载不实而停止的部分结果作废。

首轮：新进程ready p95 671.950→636.020ms，完整冷协作47.862→22.660ms、热协作45.498→25.640ms。32 follower提交113.513→1.611ms，但total dispatch117.055→137.293ms；1 follower total dispatch12.783→16.016ms，SQLite100Thread replay45.255→62.850ms。这些波动项的三轮交替版本复测和SQLite同文件控制实验已完成；逐轮结果及最终解释见 [最终性能结论](final-performance-results.md)，不选择性只报改善。

确定性计数：各负载实际派发数分别2/5/9/33，与旧新一致；Main派生由8/20/36/132降到4/10/18/66。文本内部重复plan派生归零。20Thread与100Thread样本的bounded Inbox分别20与50，证明不是空积压。

日志和原始样本在 artifacts/team-perf/closure-2026-10-30/，不进入归档。
