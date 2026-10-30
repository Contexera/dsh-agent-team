# 2026-10-28 实验结果

## 实验环境

- 代码：clean detached worktree，`bf777c3`
- Harness：`/home/yu/projects/deepseek-harness`，由 `DSH_HARNESS_DIR` 指定
- Node/npm：使用仓库当前环境
- 本记录前七项实验：生产代码未修改
- 当前主工作区的未提交改动没有进入这些实验

临时 worktree、临时测试文件和构建输出已在实验结束后删除；只保留本记录。

## 实验一：通知派生调用次数

### 方法

临时 Vitest 测试使用真实 `AgentTeam` Host 和真实 ledger：创建一个 Thread，加入 1、4、8 个 Member，让它们 follow Thread，挂载 fake live Agent，然后提交一次普通 Thread reply。测试通过 `vi.spyOn` 统计当前 Host/ledger 私有派生函数的调用次数：

- `notificationFacts`
- `mainNotificationFacts`
- `unreadForFrom`
- `mainUnreadFrom`
- `inboxDeliveryPlan`
- `notificationText`

每个场景都在 setup 完成后清空计数器，只统计一次 reply 的通知路径。

### 结果

| follower 数 | `notificationFacts` | `mainNotificationFacts` | `unreadForFrom` | `mainUnreadFrom` | delivery plan | notification text |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 1 | 3 | 2 | 2 | 1 |
| 4 | 4 | 4 | 9 | 8 | 8 | 4 |
| 8 | 8 | 8 | 17 | 16 | 16 | 8 |

这确认了两类结构性事实：每个 follower 都重新派生一次通知材料；每个 follower 的 delivery plan 会计算两次，而文本渲染只计算一次。`unreadForFrom` 和 `mainUnreadFrom` 的调用数也随 follower 数增加，说明 fan-out 的成本在通知材料派生阶段放大。

### 限制

本实验没有挂载完整 invariant listener，没有真实 Member 模型 turn、Session persistence 或浏览器 Remote。它证明重复调用和增长关系，不证明用户看到的端到端毫秒收益。

## 实验二：通知 fan-out 初步墙钟

### 方法

同一 Host fixture、同一 fake Agent 和同一 Thread，连续提交 20 次普通 reply，记录每次 `reply()` 的墙钟；每个 follower 数独立启动 fixture。样本数为 20，只用于发现规模趋势，不能稳定估计 p95。

### 结果

| follower 数 | p50 | p95 | max |
| ---: | ---: | ---: | ---: |
| 1 | 0.945 ms | 5.484 ms | 5.484 ms |
| 8 | 3.605 ms | 13.139 ms | 13.139 ms |
| 32 | 9.015 ms | 13.910 ms | 13.910 ms |

样本有明显事件循环噪声；趋势显示 follower 数增加会抬高中位数，但当前样本不能给出稳定尾延迟预算。后续应在真实 invariant、真实 Member lifecycle 和更大 corpus 下复跑，并同时记录 queue wait 与 event-loop lag。

## 实验三：clean build 和静态产物

### 命令

```bash
DSH_HARNESS_DIR=/home/yu/projects/deepseek-harness \
  /usr/bin/time -f 'wall=%e user=%U sys=%S maxrss=%M' npm run build
```

### 结果

```text
wall=17.98 user=24.09 sys=2.51 maxrss=969892
```

| 产物 | raw | gzip level 1 | gzip level 9 | Brotli |
| --- | ---: | ---: | ---: | ---: |
| `client.js` | 1,093,897 B | 217,993 B | 164,929 B | 106,012 B |
| `typert.remote-client.js` | 418,751 B | 55,482 B | 38,044 B | 16,600 B |
| `typert.host.js` | 532,219 B | 73,676 B | 52,691 B | 27,919 B |

这是 clean `bf777c3` 的构建基线，不是浏览器加载时间。仍需用 Chromium trace 测 script compile/evaluate、Remote mount、普通 Web boot 和 Team usable。

## 实验四：当前 tool concurrency 声明

对 clean `bf777c3` 的七个工具执行静态注册检查：

```text
tools = 7
team_inbox      isConcurrencySafe = undefined
team_thread     isConcurrencySafe = undefined
team_attention  isConcurrencySafe = undefined
team_message    isConcurrencySafe = undefined
team_dm         isConcurrencySafe = undefined
team_task       isConcurrencySafe = undefined
team_view       isConcurrencySafe = undefined
```

因此当前 Harness 会把七个工具全部按 exclusive 执行。这个实验没有修改 classifier，也没有声称候选并行会带来收益；下一步应在真实 tool loop 中比较 1/4/8 个纯读调用的串行和候选并行总耗时。

## 当前决策影响

1. `NotificationReadSet` 的优先级得到实际调用次数证据，可以进入首个优化实验。
2. 目前没有足够数据支持跨 commit debounce、长期缓存或 cold wake 并行。
3. build 体积可以作为稳定基线，但还不能说明 Team Client 是主要加载瓶颈。
4. 当前工作区的未提交 Attention source 修复仍需单独做旧账本升级实验，不能混入上述 clean baseline。

## 实验五：delivery plan 复用原型

### 原型内容

在 clean `bf777c3` 的临时 worktree 中，把 `deliverInboxNotice()` 已经算出的 `InboxDeliveryPlan` 传给 `notificationText()`，让文本渲染使用同一份 plan。主工作区没有修改，也没有把这个原型作为正式实现提交。

### 结果

现有通知、Inbox 和 Attention 相关测试加实验测试共 105 tests 通过。调用计数变为：

| follower 数 | 原始 plan 次数 | 原型 plan 次数 |
| ---: | ---: | ---: |
| 1 | 2 | 1 |
| 4 | 8 | 4 |
| 8 | 16 | 8 |

20 次 reply 的初步 p50：

| follower 数 | 原始路径 | 原型路径 |
| ---: | ---: | ---: |
| 1 | 0.945 ms | 0.803 ms |
| 8 | 3.605 ms | 2.805 ms |
| 32 | 9.015 ms | 8.125 ms |

这些计时仍关闭完整 invariant，Agent 是 fake live handle，样本数为 20，不能作为正式 p95。它只证明 plan 复用可以在保持测试契约的前提下删除一类确定性重复工作；完整 `NotificationReadSet` 仍需处理 Ledger 的 Thread/Main unread 派生复用。

## 实验六：当前候选 `0881268` 复核

实验期间主工作区从 `bf777c3` 推进到 clean `0881268`。当前候选的窄回归：

```text
4 files passed
147 tests passed
```

覆盖 Attention source、post-commit delivery、Inbox delivery 和 Member lifecycle。

当前候选 clean build：

```text
wall=14.48 user=24.36 sys=3.16 maxrss=977592
```

当前候选生成物：

| 产物 | raw | gzip level 1 | gzip level 9 | Brotli |
| --- | ---: | ---: | ---: | ---: |
| `client.js` | 1,093,771 B | 217,931 B | 164,881 B | 106,054 B |
| `typert.remote-client.js` | 418,751 B | 55,482 B | 38,044 B | 16,600 B |
| `typert.host.js` | 532,219 B | 73,676 B | 52,691 B | 27,919 B |

七个 Team tool 的当前模型定义为 `19,182` UTF-8 bytes。`bf777c3` 同口径为 `19,125` bytes，增加 `57` bytes；工具数量仍为 7，当前仍没有 `isConcurrencySafe`。

同一候选版本的 tool/rejection/read/index 窄回归另外通过 7 个文件、301 tests，覆盖 rejection payload、render、空参容错、Task actions、Thread read progress、operation protocol 和 projection indexes。

构建 wall time 与 `bf777c3` 的 17.98 秒样本不能直接比较，构建样本只有一次且受缓存影响；体积比较可以复用，因为两次都绑定 clean build。

## 实验七：纯读 Team tool 调度

详细记录见 [experiment-tool-concurrency.md](experiment-tool-concurrency.md)。实验在 clean `bf777c3` 的真实 Harness loop 和真实 AgentTeam Host 上完成：控制组每格 51 个样本，真实 Host 每格 101 个样本。

结论：当前不值得仅为性能给六类纯读 action 增加 `isConcurrencySafe`。4/8 个调用的真实 Host tool 中位数只下降约 0.15–0.49 ms，p95 在不同运行中有升有降；同步 CPU 投影工作完全保持串行。只有人为加入可让出事件循环的异步等待时，parallel 才出现明显收益。所有 call/result/下一轮模型输入仍保持模型顺序。

这项实验把优先级从“先改 tool 并发分类”改为“先减少同步 projection 和重复派生”。`team_inbox`、`team_thread read` 和所有写入继续保持 exclusive；纯读 classifier 作为未来 Host 读路径出现真实异步等待后的备选方案。

## 实验八：当前工作树的 delivery plan 复用

### 实施

在当前工作树中，`deliverInboxNotice` 已经生成的 `InboxDeliveryPlan` 现在直接传给 `notificationText`。改动只存在于一次同步通知投递内，不增加缓存、第二个权威来源或新的 ledger 接口。

### 结果

基线 runner 使用当前 `0881268` 作为 Team commit，内存 Storage、一个关注 Thread 的真实 active Member 和真实 `team_view` tool。每个协作样本的计数如下：

| 指标 | 复用前 | 复用后 |
| --- | ---: | ---: |
| `notificationFacts` | 2 | 2 |
| `mainNotificationFacts` | 2 | 2 |
| `inboxDeliveryPlan` | 3 | 2 |
| `notificationText` | 1 | 1 |

复用后 3 个协作样本的 `replyCommitAndFanoutMs` 为 `8.162 / 3.196 / 2.992 ms`，`ledgerReplyMs` 为 `1.420 / 0.537 / 0.531 ms`，`fanoutDispatchMs` 为 `5.795 / 1.949 / 1.861 ms`。样本少且跨独立 Host，不能用这组数字宣称端到端耗时下降；确定性收益是每个受影响 Member 少一次 delivery plan 构造。

### 验证

```text
post-commit-delivery + agent-team-attention + inbox-delivery: 101 tests passed
npm run typecheck: passed
npm run build: passed
npm test: 1420 tests passed, 1 skipped
```

这一步没有解决 `memberInbox` 与 `notificationFacts` 之间的 unread 重复派生；完整 `NotificationReadSet` 仍需要规模矩阵验证后再决定是否继续扩大改动。

## 实验九：当前实现的通知规模复核

### 方法

在当前工作树直接使用 `host-harness` 的真实 `AgentTeam` Host、内存 Storage、一个 Project、一个 follower 和一个 fake live Agent。分别创建 1、20、100 个被 follower 关注的 discussion Thread，清空计数后提交一次 reply，统计通知路径的函数调用。每个规模只取一个样本，主要用于检查调用次数，不用于比较墙钟 p95。

### 结果

| 未读 Thread | `notificationFacts` | `mainNotificationFacts` | `memberInbox` | `unreadFor` | `mainUnreadFrom` | `inboxDeliveryPlan` | `notificationText` |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 1 | 1 | 3 | 2 | 1 | 1 |
| 20 | 1 | 1 | 1 | 41 | 2 | 1 | 1 |
| 100 | 1 | 1 | 1 | 151 | 2 | 1 | 1 |

`inboxDeliveryPlan` 已从旧路径的 2 次降为 1 次。`unreadFor` 仍按 `N + min(N, 50) + 1` 增长，说明 `memberInbox` 生成候选行和 `notificationFacts` 为返回行生成 facts 的重复派生仍在；`mainUnreadFrom` 仍计算 2 次。100 Thread 的通知结果仍受 50 行上限约束。

单次样本的 reply 墙钟为 1/20/100 Thread 的 `4.585 / 2.659 / 3.199 ms`。这个顺序受 JIT、清理和调度影响，不能解读为规模越大越快；本轮只采信调用次数。嵌套方法计时也不能直接相加。

### 决策

第一步 plan 复用已达到低风险收益，继续实现完整 `NotificationReadSet` 前必须先把 `memberInbox` 返回的 unread facts 和 Main unread 结果纳入同一份一次性派生结果，并用通知内容、覆盖、失败重试和 generation swap 回归锁住语义。

### 最新工作树复跑

用户随后提交了 UI 改动 `3d16926`；本次复跑只重新确认基线入口和 Host 路径，Team Host 优化仍是未提交工作树改动。3 个样本/场景记录在 `artifacts/team-perf/runs/2026-10-28T15-13-08-733Z-ad405719/`：

- Host boot `p50 12.547 ms`，`p95 42.176 ms`。
- `team_view` tool total `p50 2.222 ms`，Host view `p50 0.154 ms`。
- collaboration total `p50 2.986 ms`，ledger reply `p50 0.530 ms`，fan-out dispatch `p50 1.831 ms`。
- `sessionAgentMs` 和 `clientMs` 仍为 `null`，所以这些是 Host/Tool fixture 基线，不是完整端到端用户等待时间。

## 10. 2026-10-29：基准入口可重复性修正

基于当前工作树，`scripts/team-performance/team-performance-baseline.ts` 增加了每个场景独立 warmup、逐条写入 `samples.jsonl`、`manifest.json`、工作区脏状态、场景过滤、Thread/follower 规模参数和线性分位数。新增小矩阵实测：`DSH_BENCH_FOLLOWERS=2 DSH_BENCH_THREADS=3 DSH_BENCH_SAMPLES=1 DSH_BENCH_WARMUPS=1`，`replyCommitAndFanoutMs=19.300ms`，`ledgerReplyMs=0.192ms`，`fanoutDispatchMs=11.980ms`；3 个实际投递成员对应 `notificationFacts=6`、`mainNotificationFacts=6`、`deliveryPlans=6`、`notificationText=3`。样本量不足以作回归结论，只用于确认矩阵和计数口径可运行。

## 11. 2026-10-29：ledger 读取与 SQLite replay 场景

基准入口新增两个真实 ledger 场景。每个 workload 创建 1 个 Project、1 个 Member、固定数量的 discussion Thread；每个 Thread 经过 follow 和一次 Human reply，随后对 `threadHistory`、`view`、`taskBoard`、`notificationFacts` 和 `memberInbox` 做读取，并断言事实和 Inbox 数量。SQLite 场景在写入后关闭第一个 Host，再从同一 SQLite 文件重启 Host，测量 replay、校验和读取。

在当前工作树、Node `v24.15.0`、Harness `687f282e` 下，20 Thread、3 个测量样本、每场景 1 次 warmup：内存读取 p50 `1.185ms`、p95 `5.839ms`；SQLite replay p50 `47.162ms`、p95 `56.771ms`；replay 后读取 p50 `1.677ms`、p95 `1.922ms`。每个样本包含 65 条 operation，校验结果为 20 个 notification Thread 和 20 个 Inbox item。样本仍在脏工作树运行，数字用于发现规模和阶段成本，不能作为 clean commit 回归门槛。

## 12. 2026-10-29：只读 Team tool sweep

基准入口新增 `tool-read-sweep`，通过真实 `ctx.tools.execute()` 连续运行 `team_inbox`、`team_task` 的 `board` 和 `team_view`，每个调用分别计时并校验没有错误。2 个测量样本、1 次 warmup 下，`team_inbox` p50 `1.781ms`，`team_task board` p50 `1.830ms`，`team_view` p50 `5.774ms`，三次合计 p50 `9.603ms`。该场景仍绕过模型 Provider 和 Client，只测 ToolRuntime 到 Host 的稳定路径。

## 13. 2026-10-29：客户端 bundle 资产输入

基准入口新增 `bundle-size`，读取已构建的 `packages/client-agent-team/lib/client.js`，记录 raw、gzip 和 brotli 字节数。当前工作树得到 raw `1,098,190` bytes、gzip `168,646` bytes、brotli `107,162` bytes。压缩耗时只用于确认测量执行，不当作浏览器加载耗时；真实首屏和 Remote 激活仍需浏览器场景。

## 14. 2026-10-29：固定 adapter 的 Agent wake

基准入口新增 `collaboration-agent-turn`。它用真实 `mountTeamMemberHost`、真实 Team Member preset 和固定文本 adapter，Human 启动一个提及 Member 的 Thread，等待真实 Agent 发出一次 model request 并回到 idle；不使用网络模型。单次 warmup 加单次测量的测量样本为：Thread 提交 `14.785ms`，提交到 model request `7.278ms`，model request 到 Agent idle `2.436ms`，端到端 `24.499ms`。这是本地 adapter 的运行时基线，不能代表 Provider 网络延迟。

## 15. 2026-10-29：当前构建的 bundle 复核

`npm run build` 通过后重新运行 `bundle-size`，当前客户端 bundle raw `1,098,190` bytes、gzip `168,640` bytes、brotli `107,109` bytes。构建成功且工作区其他修改保持原样；压缩阶段 `1,923.930ms` 是本地离线压缩开销，不纳入加载结论。

## 16. 2026-10-29：notificationFacts 读取复用

评测把 20 Thread 读取中的 `notificationFacts` p50 约 `1.456ms` 标为重复派生候选。实现了一个局部 read set：`notificationFacts()` 调用 `memberInbox()` 时缓存同一次同步读取已经计算过的 `unreadFor` 结果，返回后立即清除，不进入 durable state，也不改变 public result。相关通知、Attention、ledger 和生命周期测试共 134 个全部通过；随后完整 `npm test` 为 124 个文件、1458 个测试通过，1 个跳过。

优化后 20 Thread 样本的 `unreadFor` 调用数为 40（notificationFacts 20 次 + 后续独立 memberInbox 20 次）；旧路径在同一 workload 下为 60 次。SQLite replay 读阶段的 notificationFacts p50 从约 `1.456ms` 降到本轮 `0.557ms`，但总 replay 仍由 Host boot 和 ledger 校验主导，因此不把这次局部下降当作端到端回归门槛。

## 17. 2026-10-29：真实 Chromium loading benchmark

新增独立命令 `npm run bench:team:browser`。它在临时 profile 中安装本地 bundle，启动真实 Web scaffold 和 Chromium，测量页面 load、Workspace 连接、普通界面 ready、进入 Team mode 四段；临时测试文件和 profile 在结束时清理，不进入普通 `test:browser`。一次 smoke 样本为：page load `1,578.130ms`、Workspace 连接 `797.968ms`、普通界面 ready `806.909ms`、Team mode ready `164.694ms`；浏览器 console warnings 和 page errors 均为空。样本量为 1，不能作为回归阈值。

## 18. 2026-10-29：Chromium loading benchmark 复跑

修正 browser benchmark 的唯一运行目录和 manifest 后复跑成功。第二次 smoke 为 page load `982.837ms`、Workspace 连接 `582.985ms`、普通界面 ready `585.809ms`、Team mode ready `59.578ms`；console warnings 和 page errors 仍为空。两次结果差异明显，说明当前只能作为加载路径接通和输入校验，不能直接设定性能门槛；后续需要固定浏览器进程、样本量和冷/热 profile 口径。

## 19. 2026-10-29：固定规模矩阵

新增 `npm run bench:team:matrix`，每个 case 在独立 Node 进程中运行，保存子 run 的 manifest/JSONL/summary，并在矩阵目录聚合结果。默认 12 个 case 覆盖内存 ledger 1/20/100 Thread、SQLite replay 1/20/100 Thread，以及 fan-out 的 1/8/32 follower 和 1/20/100 Thread组合；每个 case 3 个测量样本、1 个 warmup。

矩阵 run `2026-10-29T06-41-16-714Z-d99a42b4`：内存读取 1/20/100 Thread p50 为 `0.332/1.276/3.553ms`；SQLite replay p50 为 `9.342/17.347/59.187ms`；fan-out 在 1 Thread、1/8/32 follower 下 p50 为 `8.168/49.933/167.709ms`，20 Thread/8 follower 为 `30.034ms`，20 Thread/32 follower 为 `130.045ms`，100 Thread/32 follower 为 `94.110ms`。最后一组与 20 Thread 结果不单调，说明 fan-out 还受调度和 Agent 状态噪声影响，不能只按 Thread 数外推。

## 20. 2026-10-29：fan-out event-loop 阻塞

在协作样本中加入一次 `setImmediate` probe。20 Thread/32 follower 的另一次 3 样本测量中，`eventLoopLagMs` p50 `77.430ms`、p95 `96.781ms`，与 `fanoutDispatchMs` p50 `62.024ms` 同量级；ledger reply 本身 p50 仅 `0.161ms`。这把主要问题从 ledger 写入进一步定位到同步 fan-out 调度，下一步应评估可保持 durable commit 语义的异步通知调度边界。

## 21. 2026-10-29：异步 fan-out benchmark 原型

基准入口增加 `DSH_BENCH_ASYNC_FANOUT=1` 原型，只在 benchmark 中把 `afterCommit` 标签为 `notification for ...` 的 effect 放入下一轮事件循环；commit listener、Client invalidation 和 durable ledger 写入保持同步。20 Thread/32 follower、3 samples 下，reply 返回 p50 `1.336ms`，event-loop lag p50 `1.361ms`，通知 drain p50 `104.844ms`；同步样本约为 reply `74.750ms`、event-loop lag `77.430ms`。通知内容和计数仍完整（66 次 facts/main/plan、33 次文本），但这个原型尚未验证关闭期间、通知失败重试、顺序和 Client 订阅时序，因此不直接进入生产。

## 22. 2026-10-29：共享工作区新 HEAD 的 bundle 复核

共享工作区随后推进到 `b48f3b5`（mention candidate 分组）。在该 HEAD 上 `npm run build && npm test` 通过：125 个测试文件、1470 个测试通过、1 个跳过。重新测得客户端 bundle raw `1,102,467` bytes、gzip `169,599` bytes、brotli `107,898` bytes；相较前一版增加，后续 bundle 回归应按 commit 记录，不混用旧基线。

## 23. 2026-10-29：当前 HEAD 8085867 复核

共享工作区推进到 `8085867` 后，`npm run build && npm test` 通过：125 个测试文件、1470 个测试通过、1 个跳过。当前源码 20 Thread 内存读路径 3 samples 的 p50 为 `2.009ms`，`notificationFacts` p50 `0.962ms`，`unreadForCalls=40`，结果仍为 20 个 notification Thread 和 20 个 Inbox item。当前 bundle raw `1,102,467` bytes、gzip `169,599` bytes、brotli `107,898` bytes。浏览器样本最近一次记录的是前一 commit `241f8f8`，因此不能与当前 HEAD 混作同一加载基线。

## 24. 2026-10-29：当前 HEAD 1e95b83 的规模矩阵

当前工作区使用 Team commit `1e95b8362ee6c69c5dc4b08d886a0619eaaeb2b7`、Harness commit `687f282e`、Node `v24.15.0`，运行矩阵 `2026-10-29T11-40-30-256Z-7fdfab86`，12 个 case，每个 2 个测量样本、1 个 warmup，全部通过。

| 场景 | 规模 | p50 |
| --- | ---: | ---: |
| memory ledger read | 1 / 20 / 100 Thread | `0.444 / 0.822 / 1.942ms` |
| SQLite replay | 1 / 20 / 100 Thread | `5.828 / 13.750 / 32.497ms` |
| sync fan-out | 1 Thread，1 / 8 / 32 follower | `6.645 / 21.317 / 86.734ms` |
| sync fan-out | 20 Thread，8 / 32 follower | `17.091 / 77.319ms` |
| sync fan-out | 100 Thread，32 follower | `74.739ms` |

32 follower 的 1 Thread case event-loop lag p50 `90.334ms`；20 Thread/32 follower p50 `80.799ms`。当前 fan-out 的主要变量是 follower 数量，Thread 数量在这个单次 reply workload 中影响较小；真实 Agent fixture 调度会造成非单调波动。

## 25. 2026-10-29：通知重复读取优化和语义探针

生产路径新增一个 `running` 状态边沿快速返回：当该 Member 已有非空 notice coverage 时，状态事件不再重新派生相同的 Thread/Main facts 和 delivery plan；失败会清空 coverage，因此下一次状态或 commit 仍会重试。32 follower、1 Thread 的 3 个测量样本中，每个受影响 Member 的 `notificationFacts`、`mainNotificationFacts`、`deliveryPlans` 和 `notificationText` 均为 33 次；改动前为 66、66、66、33。墙钟受 fixture 调度影响，未把它当作时间收益，只采信调用次数。

异步 fan-out 语义探针 `scripts/team-performance/team-performance-semantics.ts` 的最新报告为 `artifacts/team-perf/semantics/2026-10-29T11-42-03-192Z-2f2d97fd/`：失败后下一次 commit 能重试；两个并发 commit 的 notification sequence 保持 `5 → 6`；Client invalidation 先于通知 drain；dispose 没有报错。但 shutdown 开始后仍执行了 `1` 个已排队通知，说明简单的 `setImmediate` queue 还没有生命周期取消或 drain 协议，继续保持 benchmark-only。

## 26. 2026-10-29：当前工作区最终检查

`npm run build && npm test` 在当前工作树通过：129 个测试文件、1503 个测试通过、1 个跳过；facades、docs、core-skills、boundaries、versions 和 comments 检查均通过。最新 bundle 为 raw `1,102,468` bytes、gzip `169,596` bytes、brotli `107,958` bytes。以上结果对应脏工作树和 Team commit `1e95b83`，不能作为已提交发布基线。

## 27. 2026-10-29：协作 cold/warm 和结果比较

`collaboration-agent-turn` 增加同一 Host、同一 Agent 的第二次提及：第一次记录 Member 的首次唤醒，第二次在 Agent 回到 idle 后复用同一生成记录 warm turn。单次测量样本为：cold `triggerToAgentIdleMs=21.714ms`，warm `warmTriggerToAgentIdleMs=9.957ms`；warm 结果还拆成提交、model request 等阶段。当前只使用固定本地 adapter，不能代表模型网络耗时。

新增 `scripts/team-performance/compare-team-performance.mjs` 和 `npm run bench:team:compare`。它接受单次 run 的 `summary.json` 或矩阵的 `results.json`，比较共同场景的 p50/p95/p99，缺失场景和缺失指标单独列出；`--max-regression` 只在调用方明确指定时返回失败，并把口径不兼容视为失败。用同一文件自比较验证了 run 和 matrix 两种输入格式，另用新增指标的前后结果验证了 schema 变化不会被静默忽略。

## 28. 2026-10-29：Tool 写入路径

基准新增 `tool-write`，通过真实 `ctx.tools.execute()` 调用 `team_message` 的 `post` 和 `team_dm`，记录公开消息的 ToolRuntime/Host 阶段以及私信耗时，并确认两次结果都不是 error。最新单次样本为 `toolTotalMs=9.285ms`、`hostPostMs=4.261ms`、`teamDmMs=11.819ms`；它使用两个 Member 和一个私信投递目标，只用于建立写工具基线，不能代表更大 fan-out 的用户等待。

## 29. 2026-10-29：完整 baseline smoke 复跑

使用默认 9 个场景、每场景 1 个测量样本、0 次 warmup 的 smoke 复跑成功，输出为 `artifacts/team-perf/runs/2026-10-29T12-20-38-946Z-4abf6b3c/`。新增 `tool-write` 的本次样本为 `toolTotalMs=5.795ms`、`hostPostMs=3.927ms`；cold Agent turn 为 `29.658ms`，warm Agent turn 为 `6.586ms`。样本量只用于确认所有场景和断言接通，不作为性能门槛。

随后把 `tool-read-sweep` 扩到 `team_attention status` 和真实 `team_thread read`，把 `tool-write` 扩到 `team_dm`；最新默认 smoke 输出为 `artifacts/team-perf/runs/2026-10-29T12-29-30-291Z-ecf63f80/`。该次 `team_threadMs=9.330ms`、`team_attentionMs=3.342ms`、`teamDmMs=11.611ms`，9 个场景均通过；仍只有一个样本，不能作回归门槛。

## 31. 2026-10-29：异步通知语义探针复核

最新语义报告为 `artifacts/team-perf/semantics/2026-10-29T12-37-05-919Z-458a905a/`。失败重试、顺序、Client invalidation 和 dispose 均通过；失败路径调用次数为 `1 → 2`，两个并发提交的 sequence 为 `5 → 6`。关闭请求后仍有 `1` 个排队通知执行，原有生命周期风险没有变化，因此仍不把异步 fan-out 放进生产。

同一目录整理后的矩阵 runner 也用 `collaboration-fanout:1:1`、1 sample、0 warmup 复跑通过，矩阵输出为 `artifacts/team-perf/matrices/2026-10-29T12-38-51-456Z-4f3b9f18/`；子 run 的 `replyCommitAndFanoutMs=34.028ms`、`fanoutDispatchMs=24.450ms`。单样本只验证 runner 接通。

## 32. 2026-10-29：合并 Thread/Main 通知读取

生产通知投递新增短生命周期 `notificationSnapshot`：`notificationFacts` 和 `mainNotificationFacts` 在一次投递内共享 `memberInbox` 已计算的 Thread/Main unread material；没有引入长期缓存，也没有改变通知时序。32 follower、1 Thread 的计数样本显示 `mainUnreadFrom` 从旧路径的 `66` 次降为 `33` 次，`notificationFacts`、`mainNotificationFacts`、delivery plan 和文本均为 `33` 次。优化后样本报告在 `artifacts/team-perf/runs/2026-10-29T12-55-52-449Z-06fdb7c1/`；`replyCommitAndFanoutMs=313.607ms`，但单样本受 fixture 调度影响，不能用来证明墙钟下降。

随后完整 `npm test` 通过：129 个测试文件、1505 个测试通过、1 个跳过。优化后的语义报告为 `artifacts/team-perf/semantics/2026-10-29T13-03-36-366Z-5a6d7c6e/`，失败重试、顺序、Client invalidation 和 dispose 均通过，shutdown 后执行 1 个排队通知的风险仍存在；单 case 矩阵 `artifacts/team-perf/matrices/2026-10-29T13-03-34-624Z-3ccf6473/` 通过。

## 33. 2026-10-29：新 Member activation 基线

基准新增 `member-activation`，在独立 Team Host 中从 `addMember` 开始计时，直到真实 `Agent` handle 可用；它补上了此前 `host-boot` 和 `collaboration-agent-turn` 都没有覆盖的 Session/preset activation 阶段。单次 smoke 为 `memberActivationMs=154.391ms`，报告在 `artifacts/team-perf/runs/2026-10-29T13-11-29-175Z-d003956b/`；样本量不足以作 p95 或回归门槛。

默认 baseline 已扩为 10 个场景，每场景 1 sample、0 warmup，全部通过，输出为 `artifacts/team-perf/runs/2026-10-29T13-13-43-904Z-7d88c8c9/`。该次新 Member activation 为 `122.720ms`；这两个单样本只说明路径稳定接通，不能比较绝对快慢。

## 30. 2026-10-29：当前工作树 Chromium loading 复跑

`npm run bench:team:browser` 在当前工作树通过，报告记录在 Harness 临时 stress test 输出中：page load `890.272ms`、Workspace connection `454.649ms`、ordinary ready `458.015ms`、Team mode ready `74.692ms`；console warnings 和 page errors 均为空。仍是单次 smoke，说明加载链路和目录整理后的入口可用，不能作为稳定回归阈值。


### Entry 34 — 2026-10-30：补齐已有 Session 恢复基线

- 评测入口增加 `member-resume` 场景：先真实 `addMember`，再 `suspendMember`，测量 `resumeMember` 到 Agent 可用。
- 双样本运行：`artifacts/team-perf/runs/2026-10-30T01-15-29-910Z-a8414bc2/`。`member-activation` p50 为 `22.714ms`，`member-resume` p50 为 `11.794ms`；样本量仅用于验证路径和记录量级，不设硬阈值。
- 该场景验证了已有 Session 恢复路径进入可复用回归矩阵，仍需后续补齐通知失败、read/reply、Task 和 Session fold 等更长尾场景。


### Entry 35 — 2026-10-30：补齐 Task start 写入路径

- `tool-write` 现在同时测量 `team_message post`、`team_dm` 和 `team_message start(kind=task)`；Task start 先通过真实 `addProjectOwner` 建立 Agent 项目 owner 条件。
- 双样本运行：`artifacts/team-perf/runs/2026-10-30T01-19-38-985Z-8288e5d9/`。`taskStartMs` p50 为 `1.762ms`，`teamDmMs` p50 为 `2.9345ms`。
- 首次 smoke 暴露并修复了 benchmark 对不存在的项目 owner 条件的假设；修复后入口通过，生产代码未改动。


### Entry 36 — 2026-10-30：补齐 Thread read/reply 工作流

- 新增 `thread-read-reply` 场景：真实 Member 通过 `team_thread read` 获取当前 Thread，再用 `team_message reply` 提交回复。
- 双样本运行：`artifacts/team-perf/runs/2026-10-30T01-28-51-225Z-cfb4ab09/`。`threadReadMs` p50 为 `1.871ms`，`threadReplyMs` p50 为 `1.883ms`，合计 `readReplyMs` p50 为 `3.754ms`。
- 该链路现在和 Task start、DM 一样进入默认评测集合；通知错误的时间基线和 Session fold 仍未覆盖。


### Entry 37 — 2026-10-30：加入通知失败恢复时间基线

- 新增 `notification-retry` 场景：第一次通知强制抛错，确认提交已完成；下一次 Reply 触发重新派发并等待成功。
- 双样本运行：`artifacts/team-perf/runs/2026-10-30T01-32-52-692Z-4c1cfd3e/`。首次尝试的 `firstDeliveryMs` p50 为 `5.214ms`，重试的 `retryDeliveryMs` p50 为 `2.040ms`；两次都记录 `deliveryAttempts=2`、`failedAttempts=1`、`successfulAttempts=1`。
- 这条基线确认了失败恢复的时间量级和 durable commit 与 delivery 的分界，仍不把两个样本当作性能阈值。


### Entry 38 — 2026-10-30：为 fan-out 增加通知派生分项耗时

- `collaboration-fanout` 现在同时记录 `notificationFactsMs`、`mainNotificationFactsMs`、`mainUnreadFromMs`、`deliveryPlanMs` 和 `notificationTextMs`，用于区分重复调用和单次处理变重。
- 最新 32 follower、1 Thread、3 samples：调用次数仍为每个受影响 Member 一次；`notificationFactsMs` p50 `1.120ms`、`mainNotificationFactsMs` p50 `0.040ms`、`deliveryPlanMs` p50 `0.265ms`、`notificationTextMs` p50 `0.626ms`。
- 32 follower、100 Thread、2 samples：`notificationFactsMs` p50 `2.155ms`、`notificationTextMs` p50 `1.009ms`。当前增长仍小于 Agent fixture 调度噪声，没有足够证据继续改生产通知文本算法；先保留分项指标作为后续回归依据。
- 最新报告：`artifacts/team-perf/runs/2026-10-30T01-48-19-761Z-b61c29be/`、`artifacts/team-perf/runs/2026-10-30T01-49-06-935Z-d246017c/`。


### Entry 39 — 2026-10-30：拆分 Agent turn 的通知排队阶段

- `collaboration-agent-turn` 新增 `triggerToNoticeQueuedMs`、`noticeQueuedToModelRequestMs`，并为 cold/warm 各自记录；原有 commit、model request、最终 idle 指标保留。
- 双样本运行：`artifacts/team-perf/runs/2026-10-30T01-53-35-375Z-06af12ae/`。cold trigger→notice queued p50 `1.824ms`，queued→model request p50 `3.043ms`；warm 分别为 `0.974ms` 和 `3.337ms`。
- 该拆分说明通知进入 Agent 与模型请求等待是两个独立阶段，后续可以分别做 Host fan-out、Agent queue 和模型适配器实验。


### Entry 40 — 2026-10-30：完整默认基线复跑

- 在新增 fan-out 分项耗时和 Agent queued 阶段指标后，默认 13 场景、每场景 1 sample、0 warmup 复跑通过。
- 输出：`artifacts/team-perf/runs/2026-10-30T01-55-09-939Z-68333cba/`。这次只验证入口、断言和指标 schema 接通，不把单样本数值当回归阈值。


### Entry 41 — 2026-10-30：复跑异步 fan-out 原型

- 当前源码、32 follower、1 Thread、3 samples 下，同步路径 `replyCommitAndFanoutMs` p50 `62.332ms`，`eventLoopLagMs` p50 `67.661ms`；通知派发 p50 `43.263ms`。
- benchmark-only 异步原型输出 `artifacts/team-perf/runs/2026-10-30T01-56-34-394Z-2d1d3f11/`：reply 返回 p50 `1.157ms`，event-loop lag p50 `1.172ms`，但 notification drain p50 `63.677ms`。
- 这确认异步派发确实能把提交路径从事件循环中移出，但不会减少总工作量；关闭生命周期仍有排队通知在 shutdown 请求后执行的语义风险，所以不进入生产。


### Entry 42 — 2026-10-30：补齐纯内存 Session fold 基线

- 默认基线新增 `session-fold`，同一批 synthetic Session events 测量 cursor cold fold、80% 前缀后的增量追加 fold，以及 Team context projection cold fold；入口参数为 `DSH_BENCH_SESSION_EVENTS`。
- 10k events 双样本：`artifacts/team-perf/runs/2026-10-30T02-09-19-056Z-0c9c69d3/`，cursor cold p50 `0.134ms`、增量 p50 `0.0135ms`、projection cold p50 `0.339ms`。
- 100k events 双样本：`artifacts/team-perf/runs/2026-10-30T02-09-41-290Z-70ba718a/`，cursor cold p50 `0.541ms`、增量 p50 `0.079ms`、projection cold p50 `4.088ms`。
- 该结果只说明内存 fold 的增长和增量收益；真实 JSONL/SQLite Session bytes、持久化 replay 和 Agent activation 组合仍需独立场景。


### Entry 43 — 2026-10-30：补齐真实 JSONL Session replay

- 默认基线新增 `session-replay-jsonl`：使用真实 `dsh-session-persistence-jsonl` zstd backend 写入、flush、关闭，再重新打开读取同一批 Session events，并记录文件 bytes。
- 10k events 双样本：`artifacts/team-perf/runs/2026-10-30T02-16-23-392Z-fcc920db/`；write p50 `69.027ms`，read p50 `21.921ms`，合计 p50 `90.947ms`，文件约 `22,822` bytes。
- 100k events 双样本：`artifacts/team-perf/runs/2026-10-30T02-17-14-593Z-f92f4f34/`；write p50 `679.884ms`，read p50 `140.153ms`，合计 p50 `820.036ms`，文件约 `190,406` bytes。写入方差明显，后续比较必须拆开 write/read。


### Entry 44 — 2026-10-30：默认评测集合复跑

- 默认入口扩为 15 个场景，加入纯内存 `session-fold` 和真实 `session-replay-jsonl`。每场景 1 sample、0 warmup 的 smoke 全部通过。
- 输出：`artifacts/team-perf/runs/2026-10-30T02-19-34-186Z-87b36946/`。结果比较器自比较 198 个指标行，0 个回归、0 个缺失场景或指标。


### Entry 45 — 2026-10-30：当前工作树最终验证

- 当前 HEAD 为 `05bf168 feat: prioritize bounded notification context`；browser loading smoke 通过：page load `797.320ms`、Workspace connection `341.545ms`、ordinary ready `351.560ms`、Team mode ready `70.205ms`，无 console/page error。
- `npm test` 的 Typert、facades、docs、boundaries、versions、comments、build 前置检查通过；Vitest 仍有 3 个失败：两个来自当前通知上下文 WIP 的 shipping/tool 文案断言不一致，一个 Thread context 场景在并行整套运行中失败但单独重跑通过。评测脚本未修改这些用户本地测试。


### Entry 46 — 2026-10-30：补齐批量 Member activation 基线

- 默认基线新增 `member-activation-batch`，同一 Host 分别顺序和并发调用真实 `addMember`，记录批次总耗时与单 Member p95。参数为 `DSH_BENCH_MEMBERS`，默认 8。
- 8 Member 双样本：`artifacts/team-perf/runs/2026-10-30T02-36-08-902Z-7ea3e1b3/`；顺序批次 p50 `158.945ms`，并发批次 p50 `64.888ms`。
- 16 Member 双样本：`artifacts/team-perf/runs/2026-10-30T02-36-43-596Z-5cac8780/`；顺序批次 p50 `350.789ms`，并发批次 p50 `132.530ms`。
- 当前 activation 可以从并发调用中获益，未发现需要立即修改生产调度的证据；保留该场景作为 activation queue 回归基线。


### Entry 47 — 2026-10-30：默认评测集合扩展到 16 个场景

- 默认入口加入 `member-activation-batch` 后扩为 16 个场景；每场景 1 sample、0 warmup 的 smoke 全部通过。
- 输出：`artifacts/team-perf/runs/2026-10-30T02-39-31-054Z-967819c7/`。结果比较器自比较 210 个指标行，0 个回归、0 个缺失场景或指标。


### Entry 48 — 2026-10-30：扩展规模矩阵的参数路由

- `run-team-performance-matrix.mjs` 默认 case 从 12 个扩展到 15 个：新增 `member-activation-batch:8:1`、`session-fold:10000:1`、`session-replay-jsonl:10000:1`。
- runner 会把 case 的 size 路由到对应的 `DSH_BENCH_MEMBERS` 或 `DSH_BENCH_SESSION_EVENTS`，旧的 Thread/follower case 行为保持不变。
- 三个新增 case 用 1 sample、0 warmup 在独立 Node 进程复跑通过：`artifacts/team-perf/matrices/2026-10-30T02-42-48-210Z-fc58674d/`。


### Entry 49 — 2026-10-30：完整 15 case 矩阵 smoke

- 使用 `DSH_BENCH_MATRIX_SAMPLES=1 DSH_BENCH_MATRIX_WARMUPS=0` 跑完整默认矩阵，15/15 case 通过。
- 输出：`artifacts/team-perf/matrices/2026-10-30T02-44-32-317Z-71fd0913/`。矩阵现在同时覆盖旧的内存/SQLite/fan-out 规模，以及批量 activation、Session fold、JSONL replay。


### Entry 50 — 2026-10-30：JSONL 压缩取舍对照

- `session-replay-jsonl` 增加 `DSH_BENCH_SESSION_COMPRESSION=zstd|none` 参数，默认仍是 zstd。
- 100k events、双样本 zstd：文件约 `190,406` bytes，write/read/total p50 `679.884/140.153/820.036ms`，报告见 `artifacts/team-perf/runs/2026-10-30T02-17-14-593Z-f92f4f34/`。
- 同规模 none：文件约 `8,255,730` bytes，write/read/total p50 `416.396/120.856/537.252ms`，报告见 `artifacts/team-perf/runs/2026-10-30T02-50-27-617Z-18981ed9/`。
- 无压缩总耗时约少 35%，但文件体积约为 zstd 的 43 倍；这是存储空间与写入延迟的明确取舍，不足以支持修改生产默认。


### Entry 51 — 2026-10-30：压缩参数后的默认 smoke

- `session-replay-jsonl` 增加压缩参数后，默认 zstd 配置下 16 个场景 smoke 仍全部通过。
- 输出：`artifacts/team-perf/runs/2026-10-30T02-52-25-273Z-e6e6c293/`。


### Entry 52 — 2026-10-30：最新提交后的完整回归恢复全绿

- 在 HEAD `b1af731 refactor: align team tool guidance and acceptance` 上运行 `npm test`，facades/docs/core-skills/boundaries/versions/comments 和 Vitest 全部通过。
- 结果：134 个测试文件通过、1 个跳过；1525 个测试通过、1 个跳过。此前通知上下文 WIP 的两个合约文案/断言失败已不再出现。


### Entry 53 — 2026-10-30：最新提交后的 browser loading

- HEAD `b1af731` 上重新运行 `npm run bench:team:browser`，build 和 assembled Web stress test 通过。
- page load `764.800ms`、Workspace connection `577.649ms`、ordinary ready `580.356ms`、Team mode ready `55.936ms`；console warnings 和 page errors 均为 0。


### Entry 54 — 2026-10-30：browser loading 增加多样本统计

- `team-performance.e2e.ts` 增加 `DSH_BENCH_BROWSER_SAMPLES`；每个样本独立启动 Web scaffold 和 Chromium，输出 `manifest.json`、`samples.jsonl`、`summary.json`，默认仍为 1 次快速 smoke。
- 3 samples 运行通过：`artifacts/team-perf/browser/runs/2026-10-30T03-10-48-927Z-e28200ca/`。page load p50/p95/p99 为 `670.683/688.013/689.553ms`；Workspace connection 为 `311.891/343.645/346.467ms`；ordinary ready 为 `315.038/352.050/355.340ms`；Team mode ready 为 `68.890/73.501/73.911ms`。
- 首次多样本运行发现临时 profile 的 `scaffold` symlink 未在样本间清理，第二次启动会报 `EEXIST`；runner 已在每个样本关闭后清理该 profile，修复后 3 samples 全部通过。3 个样本均无 console warning 或 page error。


### Entry 55 — 2026-10-30：扩大 ledger 读取和 fan-out 规模

- `ledger-read-memory` 先在 1000 Thread 规模触发并修复了评测脚本的断言缺口：通知和 Inbox 的公开 `limit=100` 会截断返回，断言不能要求返回全部 Thread；现在同时保留总 workload 和返回数量。
- 1000 Thread、2 samples、1 warmup 通过：`artifacts/team-perf/runs/2026-10-30T03-27-18-933Z-dcdaeb62/`；`ledgerReadMs` p50 `30.139ms`，`notificationFactsMs` p50 `14.191ms`，`memberInboxMs` p50 `14.385ms`。
- 64 follower、1 Thread、3 samples 通过：`artifacts/team-perf/runs/2026-10-30T03-27-48-166Z-76beb47c/`；旧同步路径仍以 `fanoutDispatchMs` p50 `248.400ms`、event-loop lag p50 `312.620ms` 为主，通知派发规模已经超出同步提交可接受的事件循环区间。


### Entry 56 — 2026-10-30：将大 fan-out 异步原型收敛为生产队列

- 当一次提交影响至少 8 个 Member 时，通知 effect 在 durable commit 和 Client invalidation 之后进入有序 post-commit 队列；单 Member 路径保持原有同步可观察时序，避免改变普通通知契约。
- 队列在 Host 开始关闭后跳过尚未执行的通知；下一次 Member activation 会从 durable Inbox facts 重派。32 follower 的语义探针五项检查全部通过：失败重试、顺序、Client invalidation、关闭无异常、关闭后不执行排队通知。
- 32 follower、3 samples 的新路径报告为 `artifacts/team-perf/runs/2026-10-30T03-42-23-638Z-bb57a20f/`；`replyCommitAndFanoutMs` p50 `2.185ms`、event-loop lag p50 `2.216ms`、通知 drain p50 `299.533ms`。64 follower、3 samples 报告为 `artifacts/team-perf/runs/2026-10-30T03-41-28-353Z-99f73b8e/`；对应 p50 为 `5.582ms`、`5.618ms`、`858.808ms`。
- 新增 Ledger queue 拆分后，32 follower 最新复跑 `artifacts/team-perf/runs/2026-10-30T06-22-09-874Z-f6ab1b78/` 的 `ledgerQueueWaitMs` p50 `0.016ms`、`ledgerQueueOperationMs` p50 `1.346ms`；durable operation queue 不是当前 fan-out 瓶颈。


### Entry 57 — 2026-10-30：生产队列后的 browser loading 复测

- 当前工作树 build 和 3 次独立 Web scaffold/Chromium 运行通过：`artifacts/team-perf/browser/runs/2026-10-30T06-27-52-158Z-b563ba77/`。
- page load p50/p95/p99 为 `1298.264/3323.842/3503.893ms`；Workspace connection 为 `565.703/768.138/786.132ms`；ordinary ready 为 `567.582/805.642/826.803ms`；Team mode ready 为 `135.409/178.551/182.386ms`。
- 3 个样本均无 console warning 或 page error，但 page load 长尾明显；browser 基线应保存 p95/p99 和每个样本，不应把一次运行的 p50 当作稳定门槛。


### Entry 58 — 2026-10-30：按 Member 拆分通知队列

- 全局串行通知队列在 32 follower、3 samples 下 drain p50 `299.533ms`，会让一个 Member 的通知阻塞其他 Member。改为每个 Member 保序、不同 Member 并行调度，并继续保留关闭时跳过未执行 effect 的检查。
- 32 follower、3 samples 新报告：`artifacts/team-perf/runs/2026-10-30T06-34-47-791Z-9b5a2443/`；`replyCommitAndFanoutMs` p50 `1.405ms`、event-loop lag p50 `1.430ms`、通知 drain p50 `71.918ms`。
- 64 follower、3 samples 新报告：`artifacts/team-perf/runs/2026-10-30T06-35-58-851Z-f16458f9/`；`replyCommitAndFanoutMs` p50 `2.094ms`、event-loop lag p50 `2.120ms`、通知 drain p50 `145.226ms`。相对之前全局串行的 64 follower drain p50 `858.808ms`，总 drain 明显下降；Durable commit queue wait 仍约 `0.011ms`。


### Entry 59 — 2026-10-30：当前工作树最终评测 smoke

- 默认 16 场景、每场景 1 sample、0 warmup 通过：`artifacts/team-perf/runs/2026-10-30T06-52-26-126Z-e3c681e1/`。
- 结果比较器对该 run 自比较，使用 `--max-regression 0`，210 个指标行没有回归或缺失场景/指标。
- 当前工作树最终 `npm test` 为 134 个测试文件通过、1 个跳过；1528 个测试通过、1 个跳过。`check:docs`、`check:artifact`、build、browser loading 和语义探针也通过。


### Entry 60 — 2026-10-30：新 HEAD 上的完整规模矩阵

- 在当前 HEAD `d39ec06` 和工作树评测改动上，以每个 case 1 sample、0 warmup 运行默认完整矩阵，15/15 case 通过。
- 矩阵报告：`artifacts/team-perf/matrices/2026-10-30T06-58-44-288Z-2923064e/`。它覆盖 8 Member activation、1/20/100 Thread 内存读取、SQLite replay、1/8/32 follower 与 20/100 Thread fan-out，以及 10k Session fold/JSONL replay。
- 随后在同一当前状态运行 `npm test`：134 个测试文件通过、1 个跳过；1528 个测试通过、1 个跳过。


### Entry 61 — 2026-10-30：当前 HEAD 的 assembled Web smoke

- 当前 HEAD `d39ec06` 上重新 build 并运行 1 次 assembled Web loading：`artifacts/team-perf/browser/runs/2026-10-30T07-09-14-792Z-e2719669/`。
- page load `818.701ms`、Workspace connection `432.988ms`、ordinary ready `435.608ms`、Team mode ready `147.507ms`；无 console warning 和 page error。
