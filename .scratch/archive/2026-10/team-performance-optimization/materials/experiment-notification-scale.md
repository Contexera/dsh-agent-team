# 通知 fan-out 规模实验

## 结论

在干净的 `bf777c3` 上，使用真实 `mountTeamMemberHost` fixture 复测后，单次提交触发的通知 fan-out 有固定的重复派生，并且调用次数和同步耗时随未读 Thread 数量增长。

- 每个受影响的 Member 单次 fan-out 固定调用 `notificationFacts` 1 次、`mainNotificationFacts` 1 次、`notificationText` 1 次。
- `inboxDeliveryPlan` 固定调用 2 次：Host 在 `deliverInboxNotice` 调用 1 次，`notificationText` 内部再调用 1 次。
- `unreadFor` 的调用次数为 `Thread 数 + min(Thread 数, 50) + 1`。前一项来自 `memberInbox` 扫描候选 Thread，后一项来自 `notificationFacts` 为返回的 Inbox 行再次派生 facts。
- `mainUnreadFrom` 固定调用 2 次：一次生成 `memberInbox` 的 `main`，一次由 `mainNotificationFacts` 重新生成。
- Host 的 `notificationFacts` 默认最多返回 50 个 Thread。100 个未读 Thread 的 fixture 中，候选扫描仍覆盖 100 个 Thread，但通知材料只包含 50 个；因此该格没有覆盖超过 50 个 Thread 的通知渲染。
- 三个规模的 fan-out 核心耗时中位数分别为 0.195 ms、0.549 ms、1.047 ms。相对 1 Thread，20 和 100 Thread 分别约为 2.81 倍和 5.36 倍。

## 环境

- 仓库：`/home/yu/projects/dsh-agent-team`
- 实验 commit：`bf777c39ecc1ff912a3b473d85f575dd0758bdd5`
- Node：`v24.15.0`
- npm：`11.12.1`
- 系统：WSL2，Linux `6.6.87.2-microsoft-standard-WSL2`
- CPU：Intel Core i7-14650HX，8 个可见逻辑 CPU
- 测试：Vitest `5.0.5`
- 时间：2026-10-28，Asia/Shanghai

## 装配与探针

每个规模都新建一份临时 worktree，并完整运行 `npm run build`。测试使用 `mountTeamMemberHost`，配置空的 working-directory stub、静默 token meter 和真实的 `member-context`、`team-tools` preset 行。

每个测试格执行以下步骤：

1. 创建一个 Member，并确认它处于 active 状态。
2. 创建 1、20 或 100 个 discussion Thread，每个 Thread 的正文都直接 mention 该 Member。
3. 等待 setup 完成后，以 `performance.now()` 包装 Host 与 ledger 上的相关方法。
4. 先执行一次回复作为预热，再执行 7 次 mention 回复。每次回复触发该 Member 的真实 post-commit fan-out。
5. 每格取 7 次样本的中位数；重复三个独立 Vitest 进程，再取三个进程级中位数的中位数。

`fanoutCoreMs` 是以下同一层调用耗时之和：`notificationFacts`、`mainNotificationFacts`、第一次 `inboxDeliveryPlan`、`notificationIdentity`、`notificationText`。第二次 `inboxDeliveryPlan` 已包含在 `notificationText` 内，没有重复相加。`commitMs` 是从发起 reply 到它完成的墙钟时间，包含 ledger 提交和 post-commit 工作。

临时探针文件为 `packages/agent-team/tests/notification-scale.experiment.spec.ts`。其内容只存在于实验 worktree，未进入主工作区或提交历史。

## 命令

```sh
git -C /home/yu/projects/dsh-agent-team worktree add --detach \
  /home/yu/projects/dsh-agent-team-notif-exp bf777c3

ln -s /home/yu/projects/dsh-agent-team/node_modules \
  /home/yu/projects/dsh-agent-team-notif-exp/node_modules

printf 'deepseek-harness\n' \
  > /home/yu/projects/dsh-agent-team-notif-exp/.generated-harness

cd /home/yu/projects/dsh-agent-team-notif-exp
npm run build
./node_modules/.bin/vitest run \
  packages/agent-team/tests/notification-scale.experiment.spec.ts \
  --reporter=verbose
```

三个独立进程均以 `Test Files 1 passed (1)`、`Tests 3 passed (3)` 结束。

## 调用次数

| 未读 Thread | 未读 facts | fan-out 返回的 Thread | `notificationFacts` | `mainNotificationFacts` | `inboxDeliveryPlan` | `notificationText` | `memberInbox` | `unreadFor` | `mainUnreadFrom` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 3 | 2 |
| 20 | 20 | 20 | 1 | 1 | 2 | 1 | 1 | 41 | 2 |
| 100 | 100 | 50 | 1 | 1 | 2 | 1 | 1 | 151 | 2 |

“未读 Thread”和“未读 facts”是本轮测量开始时的状态。每次测量 reply 会给第一个 Thread 增加一个 fact；预热加 7 次测量后，该 Thread 从 1 个 fact 增至 9 个 fact。Thread 数量保持不变。

## 耗时

| 未读 Thread | `commitMs` 中位数 | `fanoutCoreMs` 中位数 | fan-out 占 reply 墙钟 | 各进程 `fanoutCoreMs` 中位数范围 | 单样本最大 `fanoutCoreMs` |
|---:|---:|---:|---:|---:|---:|
| 1 | 1.321 ms | 0.195 ms | 14.8% | 0.185–0.206 ms | 0.445 ms |
| 20 | 1.557 ms | 0.549 ms | 35.2% | 0.476–0.573 ms | 0.682 ms |
| 100 | 2.057 ms | 1.047 ms | 50.9% | 1.046–1.049 ms | 7.439 ms |

最后一次通过运行的逐方法中位数如下。`memberInbox` 和 `unreadFor` 是嵌套调用，不能与 `notificationFacts` 相加。

| 未读 Thread | `notificationFacts` | `notificationText` | `memberInbox` | 两次 `inboxDeliveryPlan` 合计 | `mainNotificationFacts` |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.055 ms | 0.115 ms | 0.037 ms | 0.010 ms | 0.002 ms |
| 20 | 0.304 ms | 0.232 ms | 0.215 ms | 0.038 ms | 0.003 ms |
| 100 | 0.520 ms | 0.157 ms | 0.419 ms | 0.064 ms | 0.003 ms |

100 Thread 进程中有一次单样本达到 7.439 ms，明显高于该格其余样本。样本数和运行环境不足以判断它来自 GC、调度抢占还是业务代码，不能据此估计 p95 或 p99。

## 影响

重复调用在 1 Thread 时已固定存在，且不随规模消失：delivery plan 被构造两次，Main unread 被派生两次，Inbox 候选 Thread 的 unread facts 在 `memberInbox` 与 `notificationFacts` 之间重新计算。

Thread 数量增加后，重复扫描继续增长。即使 H1 阶段只把前 50 个 Thread 写入通知，`memberInbox` 仍扫描全部候选，`notificationFacts` 还要为返回行再派生 facts。

本实验的绝对耗时只有 0.2–1.0 ms。它足以确认路径随规模增长，但单独看 fan-out 还不能解释用户可见的秒级等待。下一步应把这组同步 fan-out 计时接入真实提交墙钟，并补测持续增长的 Main backlog、每个 Thread 多条 facts、SQLite ledger 和多 Member fan-out。

## 限制

- 使用内存 storage backend 的真实 Host fixture，未覆盖 SQLite I/O、进程重启或实际 Web Client。
- 每个格只有一个 Project、一个 active Member、一个 submitter 和一次串行 fan-out，没有多 Member 并发。
- 初始每个 Thread 只有 1 个 fact；后续回复主要让第一个 Thread 的 facts 增长，没有测试大量 facts 分布在所有 Thread 的情况。
- fan-out 的 Thread 输出上限为 50，100 Thread 格的渲染部分与实际候选扫描不处于同一规模。
- 探针会增加 `performance.now()` 调用开销；嵌套方法耗时之间存在包含关系，不能全部求和。
- 每个独立进程有 7 个有效样本，只适合报告中位数和变化方向，不足以估计 p95、p99。
- `commitMs` 含 ledger 提交、校验调度和其他 post-commit 工作，不能视为纯通知耗时。
- 测量在 WSL2 上运行，未做 CPU 绑核或空闲环境隔离；长尾波动较大。

## 建议

先实现单次通知投递内的 `NotificationReadSet`，让 `memberInbox`、`mainNotificationFacts`、delivery plan 和 `notificationText` 共用同一份派生结果。随后用相同 fixture 复测这些固定调用次数：目标应至少降为 `inboxDeliveryPlan` 1 次、`mainUnreadFrom` 1 次，并避免为返回的 Thread 再次执行 `unreadFor`。

```text
当前一次 fan-out
  notificationFacts ─┬─ memberInbox
                     │    ├─ unreadFor × N
                     │    └─ mainUnreadFrom × 1
                     └─ unreadFor × min(N, 50)
  mainNotificationFacts ─ mainUnreadFrom × 1
  inboxDeliveryPlan × 2
  notificationText × 1

目标 shape
  derive NotificationReadSet × 1
    ├─ Thread facts × N
    ├─ Main unread × 1
    └─ delivery plan × 1
  render notificationText × 1 from the same set
```
