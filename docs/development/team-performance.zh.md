# Team 性能评测

[English](team-performance.md) | 中文

## 目的

这组评测衡量 Human 或 Member 能感知的成本，包括加载、工具调用、ledger 读取、Session 操作与协作。评测不是生产路径，需手动运行。比较前后结果时，两边应采用相同的[认证环境](environments-and-install.zh.md#沙箱与-ci-环境)和负载。

场景源码位于 [`scripts/team-performance/`](../../scripts/team-performance/)。入口和输出格式见 [`scripts/README.md`](../../scripts/README.md)。

## 运行评测

### 基线

默认由一个进程调度 16 个场景；Host 冷启动另用一个全新的 Node 子进程。想先做定向验证时，把 `DSH_BENCH_SCENARIOS` 设为下表中的一个场景。

```sh
DSH_BENCH_TEAM=1 npm run bench:team
```

命令在 `artifacts/team-perf/runs/` 下写入一次运行目录，包含 `manifest.json`、测量样本 `samples.jsonl` 和 `summary.json`。默认使用 3 个测量样本和 1 个 warmup。用 `DSH_BENCH_SCENARIOS` 选择场景，用 `DSH_BENCH_THREADS`、`DSH_BENCH_FOLLOWERS`、`DSH_BENCH_MEMBERS`、`DSH_BENCH_SESSION_EVENTS` 等对应变量调整负载规模。

### 规模矩阵

在独立 Node 进程中运行默认 15 个 case：

```sh
npm run bench:team:matrix
```

用逗号分隔的 `scenario:threads:followers` 设置 `DSH_BENCH_MATRIX_CASES`。默认协作场景覆盖真实数据中的 1–4 个 follower、8 个 Member 的队列边界、20 个 Thread 的积压，以及 32 个 follower 的压力场景。测量 Member 或 Session 时，第一个规模值改为 Member 数或事件数。

每次矩阵运行在 `artifacts/team-perf/matrices/` 下生成 manifest 和 `results.json`。后者指向 `artifacts/team-perf/runs/` 下各个场景的运行目录。

fan-out fixture 中 `DSH_BENCH_FOLLOWERS` 是一个 receiver 之外的额外 follower 数，所以设为 32 会派发 33 次通知。原始样本记录预期和实际次数。8档覆盖延迟路径，大小批次交错及关闭行为另由语义探针检查。

### 真实 profile 使用情况

请传入一致的 SQLite 快照，不要读取正在使用的 profile 数据库。按[发布手册](../release-runbook.zh.md)的备份步骤创建快照：只复制正在使用的 WAL 数据库主文件，可能漏掉已提交的数据。命令会以只读方式打开副本：

```sh
npm run bench:team:usage -- /path/to/agent_team.sqlite --json
```

报告统计 operation、Member、Thread Attention 规模、回复影响人数，以及接近通知队列阈值的 operation。它读取原始 operation，不强制使用当前 ledger replay，因此旧的 `team/channel-*` 记录仍可统计。

`members.current` 统计 enabled 与 suspended 的 Agent Member；archived 和 inactive 仅保留在 `byState` 中。enabled follower 不包含 Human 或非 enabled Agent；全部 follower 包含 Human Attention 行。生命周期折叠包含恢复和移除后的完整快照。

受影响 Member 数是估算值：包含持久化 Inbox 接收者、每次 operation 后的 Thread Attention 和 actor，但不包含 Main stream 接收者推导。报告只输出计数，不输出 Message 正文或 handle。

### Browser 加载

测量组装后的 Web bundle 和 Team mode：

```sh
DSH_BENCH_BROWSER_SAMPLES=3 npm run bench:team:browser
```

每个样本使用新的临时 Web scaffold 和 Chromium。runner 记录页面加载、Workspace connection、普通界面 ready、Team mode ready、导航计时、传输字节数、console warning 和 page error。结果写在 `artifacts/team-perf/browser/runs/` 下的 `manifest.json`、`samples.jsonl` 和 `summary.json`。

Chrome 默认位于 `/usr/bin/google-chrome`，不在这个位置时设置 `CHROME_PATH`。结合 p95、p99 和单个样本看结果：冷启动波动较大，少量样本不足以判断长尾。

### 语义探针

检查 commit 后有序通知队列：

```sh
DSH_BENCH_TEAM=1 npm run bench:team:semantics
```

探针检查投递失败重试、按 Member 的顺序、通知 drain 前的 Client invalidation、关闭取消和 dispose 错误。时间评测通过不能代替这些检查。

### 比较运行结果

比较两次基线 summary 或两个矩阵结果文件：

```sh
npm run bench:team:compare -- before/summary.json after/summary.json
npm run bench:team:compare -- --max-regression 20 before/summary.json after/summary.json
```

Host boot、Agent 协作及 fan-out 的原始样本带有 `schema: 2`。旧结果测量的路径或未读负载不同，不能直接用于这些场景的前后对照；须在两个生产版本上运行相同的当前评测脚本。

比较器输出共同场景的 p50、p95、p99。设置 `--max-regression` 后，缺少场景或指标、测量无效、基线为零而新值为正，都会导致比较失败。只有负载、环境和场景 schema 一致，阈值才有意义。

## 场景覆盖

| 范围 | 场景 | 主要证据 |
| --- | --- | --- |
| 加载与激活 | `bundle-size`、`host-boot`、`member-activation`、`member-activation-batch`、`member-resume` | bundle 字节数、Host fixture boot、新 Member 和已有 Member 激活、顺序与并发激活 |
| Tool 路径 | `tool-call`、`tool-read-sweep`、`thread-read-reply`、`tool-write`、`notification-retry` | tool 总耗时、Host handler 耗时、结果字节数、读写和失败投递恢复 |
| 协作 | `collaboration-fanout`、`collaboration-agent-turn` | durable commit、Ledger queue wait/service、fan-out dispatch、事件循环延迟、通知 drain、模型请求和 idle 阶段 |
| Session 与存储 | `session-fold`、`session-replay-jsonl`、`ledger-read-memory`、`ledger-replay-sqlite` | cursor 和 projection fold、JSONL 写入/读取/字节数、受限 ledger 读取、SQLite 打开/replay/校验 |

基线使用真实 Team Host fixture；需要模型回合时使用确定性的 model adapter。它不代表生产模型提供方或某一台用户机器。Browser 场景检查组装后的完整路径，Node 场景解释该路径内部的成本。

`collaboration-agent-turn` 记录冷/热回合的通知入队、领取、模型请求、读取/回复工具调用、持久 receipt 和 idle。它检查两次已提交回复、两次读取、六次接收方模型请求及关联 ID。热回合发起方使用真实读取结果中的 revision，不凭空构造。

`host-boot` 测量新 Node 进程到空 Host ready，再单独测量该进程内两个持久 Member 的恢复。存储打开、replay 和校验由 `ledger-replay-sqlite` 测量。fan-out fixture 关注负载中的每个 Thread，并在关注后写入未读事实；断言拒绝名义上 20/100 个 Thread、实际只有一个未读的负载。

## 当前约束

- 通知复用和有序派发由 [Host authority](../architecture/host-authority.zh.md#lifecycle-与通知) 定义。提交耗时与通知排空对应不同的完成点；把工作移到提交之后不代表工作消失。
- Agent 回合场景由确定性 adapter 驱动真实 `team_thread read` 与 `team_message reply`，检查回复已提交并记录冷/热阶段。Host boot 使用全新 Node 子进程，在该进程内另测已有 Member 的 Host 恢复。两者都不包含生产模型提供方延迟。
- JSONL 生产默认仍是 `zstd`。在当前 fixture 中，无压缩 replay 更快，但占用明显更多磁盘空间。
- 当前测得的批量 Member activation 已经从并发调用中获益。仅凭这一结果不能改变 Host startup 的恢复顺序，还需要单独的启动恢复实验。
- Browser 冷启动有明显长尾。保留样本记录并比较分布，不要把一次运行变成硬性验收阈值。
- 延迟派发可以让提交更早返回，但也可能增加全部通知完成的时间，因为 Agent 工作会与派发交错。两个完成点必须分别报告；这项优化降低调用方阻塞，不减少通知总工作。

## 改动流程

改动性能敏感路径时，先运行能观察该改动的最小场景，再运行相关规模 case 和语义探针。前后比较必须使用相同场景。墙钟数据要和 operation 数、结果形状一起检查；耗时下降但事实缺失的结果应视为失败。把结果视为已交付前，运行 `npm test` 和 `npm run check:artifact`。

不要把密钥、真实 profile 或临时 browser overlay 放进仓库。时间评测和规模矩阵需显式开启；测试套件会显式运行小规模场景契约检查，验证 cold boot、真实工具回复和未读负载，但不设耗时门槛。
