# Team 性能优化迭代

## 问题

Team 的性能成本分布在启动、模型 tool call 和成员协作三条链路。当前缺少一套能把用户或模型等待时间拆成 queue、ledger、通知 fan-out、Session/Agent 和 Client 阶段的统一基线，因此局部优化无法证明端到端收益。

已有实验确认：通知路径会重复派生 Thread/Main unread 和 delivery plan，并随未读 Thread 数增长；纯读 tool 的并行分类在当前同步 projection 读取上只有很小且不稳定的收益。

## 目标

- 以“动作发起到结果可继续使用”的端到端 p95 为主指标。
- 同时记录 queue、ledger、post-commit fan-out、Session/Agent 和 Client 阶段。
- 保留原始 JSONL 样本、环境信息和规模输入，结果可在固定版本上复跑。
- 在不改变 ledger 单一权威、记录级校验、通知语义和公开协作契约的前提下，降低重复派生。

## 选择的方案

第一阶段按三条垂直切片推进：

1. 建立 Team 专用 baseline runner 和默认关闭的结构化观测。
2. 把一次通知投递所需的 Thread/Main unread、delivery plan 和文本输入收敛成一次性只读派生结果，由 Host 在同一次投递中复用。
3. 用真实 Host、SQLite、Member fixture 和规模阶梯验证优化前后 p50/p95，并记录失败、冷唤醒和多 Member 场景。

Host queue、fan-out 和协作因果使用默认关闭的结构化 hook；tool/render 阶段优先用测试 wrapper。通知 read set 只在单次投递内存在，不建立长期缓存或第二个 durable authority。

## 关键决定

- 主指标是端到端 p95；单个函数耗时只能作为定位信息。
- Thread 消息到成员回复是主协作场景；DM、Task claim 和 cold wake 作为补充场景。
- `team_inbox`、`team_thread read`、所有写入和所有 wake 副作用继续独占。
- 当前不为纯读 tool 增加 `isConcurrencySafe`。实验显示同步 projection CPU 工作无法通过 Harness parallel pool 加速，p95 收益不稳定。
- 跨 commit debounce、长期 read-set 缓存、通知上限调整、Member 激活并行和 Session fold 增量不进入首个实现切片。
- 旧版 Attention source 的升级重放与新格式稳态分别测量，不把用户未提交工作树混入 clean baseline。

## 验收 seam

- 启动：storage open、ledger replay/validate、Session inventory、Member activation、Host ready。
- Tool call：模型 call、参数处理、Host handler、queue wait、ledger/query、结果 render 和 Session 写入。
- 协作：A commit ack、B notice queued、B notice claimed、B read、B reply committed、B idle。
- 通知 read set：旧路径与新路径的 notice text、covered、undelivered、attempt、steer/followup 次序和失败隔离逐项一致。
- 规模：1/20/100 unread Thread、1/8/32 follower、SQLite 与内存 fixture、warm/cold Member。

## 开放问题

- Session fold 增量是否仍是长 Session 的主要成本，需要独立真实日志基线。
- Member activation 是否能安全并行，需要生命周期资源和失败边界实验。
- 当 Team 读取引入真实异步 I/O 后，是否重新评估纯读 tool parallel。
