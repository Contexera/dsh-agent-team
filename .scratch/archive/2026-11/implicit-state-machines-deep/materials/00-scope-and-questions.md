# 范围与深入问题

第一轮已经回答了“有哪些隐式状态机、哪些已复现的转移错误”。它交付了一张 68 组的地图、两处红绿修复、10 张验收票。这一轮不重复那张地图，而是把它当作索引，对**整个应用**问更深的问题。

## 第一轮做了什么，没做什么

| 做了 | 没做 |
| --- | --- |
| 按生命周期/恢复边界盘点 129 个源文件，归为 68 组。 | 没有证明每个状态都可达、每个状态都有消费者。 |
| 对高风险协议细读关键分支，定位测试锚点。 | 没有系统检查“失败只写日志、没人能看见”的路径。 |
| 复现并修复两处取消错误；10 张票从真实入口验收。 | 没有系统检查同一事实在不同 surface 上是否会读出不同结果。 |
| 明确拒绝全仓 FSM、统一 async 层、新状态仓。 | 没有把“重启/取消/晚到”作为独立维度逐域扫一遍。 |
| 记录了延后项和证据缺口。 | 没有把延后项按当前代码逐条收口。 |

## “深入”指什么

不是把每个 `useState` 都画成状态图，而是对每个已经存在的状态/协议追问六件事：

### 1. 生产者/消费者完整性

每个 enum、union、状态字段：谁写它？谁读它？如果它出现，读方会怎样？

- `subscription-admissions.ts` 的 `running` 有没有生产写入点？
- `types/operations.ts` 的 `restarted`/`context-cleared`/`renewed`/`rolled-over` 哪些是 replay-only？
- `spec.ts` 的紧凑 receipt 与旧完整 read snapshot 是否还有写入方？
- `AgentTeamWorkerRunViewState` 的 `unconfirmed` 是持久状态还是读取投影？
- 有没有状态只在测试里被构造，生产代码永远不会产生？

### 2. 权威分离与跨 surface 一致性

同一个事实，Thread、Inbox、名册、设置页、工具结果可能各读一份。它们会不会不一致？

- Worker 的 live 终态与 ledger 的 `unconfirmed`。
- `capabilityState` 的 `applied` 与 extra tool grants 的实际生效。
- Thread 的 unread 与 surface 可见性豁免。
- 订阅的 `paused` 与“撤掉 trigger”/“禁用入口”。
- 名册的 presence 与 Session binding 的 rollover 窗口。
- 设置页的 draft/committed 与 Host 的 revision。

追问：不一致时哪个是权威？用户能不能看出这是“未确认”而不是“失败”？

### 3. 失败可见性

每个 `catch`、`warn`、`log`：谁需要知道这个失败？Human、Agent、operator？

- grant 安装失败只写 Host warning，名册仍可能显示 applied。
- reminder 消费重试耗尽只写 warning，occurrence 留到“下一个 Team fact”。
- 私有记忆清理部分失败抛 `AggregateError`，没有用户可见状态。
- 附件 GC 跳过没有 meta 的目录，永久泄漏。
- 更新检查失败一律“无已知更新”。
- 订阅 late-result 被终态门禁丢弃，只有日志。

追问：失败有没有稳定 code、下一步动作、可执行的恢复提示？还是只有一句日志？

### 4. 重启与恢复

每个 durable 记录：读路径是什么？每个内存 map：重启后怎么重建？每个 `unconfirmed`：用户看到什么？

- Worker 的 `running` 记录、原生进程、sealed。
- Session generation 的 binding、continuation、wake recycle。
- 订阅 admission、checkpoint、failed delivery、replay intent。
- 附件/头像缓存、sidebar order 缓存、草稿。
- Inbox coverage、reminder occurrence、context cursor。

追问：在每一个 await 边界崩溃，重启后事实是丢失、重建，还是明确标记为未确认？

### 5. 并发、取消与晚到结果

每个 await：它跨过了哪个状态变化？回来之后有没有重读权威？

- Worker 的 start/stop/steer/continue 与 dispose。
- 压缩的主/备用摘要与取消。
- 有界读取的容量查询与取消。
- Client 的 query、change stream、thread controller、timeline。
- 订阅的 publish/retry/replay 与终态门禁。
- 生命周期链、turn boundary、inbox delivery。

追问：晚到结果会不会覆盖更新的状态？取消会不会被当成失败？停止会不会被当成成功？

### 6. UX/AX/DX 契约

每个拒绝、每个列表、每个对话框：用户/Agent 能不能据此行动？

- 工具拒绝是否有稳定 code、下一步、稳定 ref？
- 列表是否区分 loading/error/empty/partial？
- 对话框是否区分“写失败”与“写成功但刷新失败”？
- Agent 是否能从结果判断“已提交/未读/版本过期/传输失败”，而不用解析文案？
- DX：每个概念是否只有一个 owner？有没有平行 store 或只靠注释维持的不变式？

## 全域索引

下表把第一轮的 68 组当作索引，列出这一轮要追问的重点。不是每个组都需要重审；标“高”的是优先切片。

| 域 | 第一轮结论 | 深入问题 | 优先级 |
| --- | --- | --- | --- |
| D01 提交协议 | ledger 唯一权威，先持久再 apply | 跨表写（admission→delivery）之外还有没有两次独立持久写？replay validator 是否仍接受从未写过的形状？ | 高 |
| D02 invariant | pending/latch 可并存 | 故障闩锁是否只在日志里？mount 重验失败谁看见？ | 中 |
| D03–D06 生命周期/资格 | 退出/归档/撤权与责任图同一 operation | 部分失败（私有目录、Session archive）是否会让 ledger 与文件系统分叉？ | 中 |
| D07 Session 换代 | 旧入口 replay-only | 哪些过渡类型没有 writer？类型是否仍暗示可调用？ | 中 |
| D08–D10 Thread/Task/Claim | 原子责任图，status 派生 | 验收/关闭/重开在 live 与 replay 是否完全同规则？ | 已由 10 覆盖 |
| D11–D14 Attention/read | 看得到≠已读，fence 顺序固定 | surface 豁免与 durable read 是否还有别的交叉路径？ | 中 |
| D15–D16 reminder | 纯 planner + ledger episode | 消费重试耗尽后的“下一个 fact”是否可能永远不来？ | 中 |
| D17–D19 context/cursor | Session 事件权威，缓存可重建 | 冷启动/换代/截短边界是否都有测试？ | 中 |
| M1 capabilities | 意图与 applied proof 分开 | grants 是否也该有 applied proof？ | 高 |
| M2 turn boundary | 等待只结算一次 | 等待期间 Session 换代/暂停/关闭是否都释放？ | 中 |
| M3 私有记忆 | 文件权威，清理非原子 | 部分失败是否会在下次启动重试？ | 低 |
| M4–M5 budget/compaction | 每步预算、有界补试、断路 | 取消/超时/真实窗口变化的组合是否还有未覆盖分支？ | 高 |
| M6 身份/记忆新鲜度 | 文件权威，surface 取证 | 16 KiB 上限后的 unavailable 是否可行动？ | 低 |
| M7 generation swap | settled ≠ activation 成功 | 调用方是否都回读权威？ | 中 |
| M8 idle | 进程观察，不持久 | 未知 idle 是否被误当成“长期无进展”？ | 低 |
| M9 时间上下文 | 当前代事件 fold | 换代/回退/并发是否都夹零？ | 低 |
| H1–H6 Host | 启动/链/流/Inbox/恢复/SQLite | 关闭顺序、coverage 重派、SQLite 失败面是否都有可见结果？ | 中 |
| T1–T2 工具 | 稳定 ref、结构化拒绝、有界读取 | 新工具（`team_worker`、subscription 收件人）是否沿用同一拒绝/恢复契约？ | 高 |
| S1–S4 订阅/Webhook | 四种成功语义分开 | admission 状态、publish vs execute、late-result 门禁是否还有未覆盖组合？ | 高 |
| S5 更新检查 | 提示缓存，off 语义待定 | off 是网络开关还是隐藏提示？ | 中 |
| S6 设置迁移 | 当前字段优先，不造迁移仓 | 新字段（grants、Worker、sidebar order）是否沿用同一迁移纪律？ | 中 |
| S7 文件 | payload/meta 两阶段，TTL GC | 半写目录、头像保留、破损 sidecar 的可见结果？ | 中 |
| S8 解析/恢复话术 | 纯转换/契约 | 新拒绝码是否都有 recovery hint？ | 中 |
| C01–C04 激活/流/查询/导航 | 公开槽位、scope 流、共享 query | 新 Worker/grants 面是否绕过了这些 owner？ | 高 |
| C05–C07 草稿/加载/聚合 | 局部 owner，失败保留旧值 | 新设置页/Worker 列表是否区分 loading/error/empty/partial？ | 中 |
| C08–C10 Thread/Main 读取 | 有界读、晚到守卫 | Worker 事实进入 Thread 后，read/revision/workerStates 是否一致？ | 高 |
| C11–C12 写 fence/Attention | 非乐观、requestId、revision | Worker stop/steer 是否沿用同一 fence 语义？ | 高 |
| C13–C15 composer/附件/时间线 | 局部状态，真实入口验收 | 新附件/Worker 交互是否影响 IME、焦点、滚动？ | 中 |
| C16 sidebar | 第一轮说 localStorage 偏好 | 现在是 Host row 设置；补水/上迁/未确认写入是否都覆盖？ | 中 |
| C17–C19 创建/编辑/行菜单 | 表单身份、失败保留输入 | 新 grants/Worker 设置是否沿用同一冲突/重试语义？ | 中 |
| C20 模型目录/提醒 | 缓存旧值 + 失败 | 目录失败与缓存成功是否仍混成空列表？ | 低 |
| C21–C22 身份/设置 | 头像降级、公共 form model | 新设置组是否复用同一 revision/conflict 语义？ | 中 |
| C23–C24 订阅/消息 | 单卡 pending、日志/删除分离 | 新 Worker 行/诊断是否复用同一 pending/错误面？ | 中 |

## 切片选择原则

1. **先找“两个 surface 会不一致”的地方**：这是 UX/AX 最贵的错误，也最容易在静态阅读中漏掉。
2. **再找“失败只写日志”的地方**：这是 operator 最晚知道、用户最困惑的地方。
3. **再找“状态没有生产者/消费者”的地方**：这是 DX 的误导，通常修复很小。
4. **最后才是纯局部状态的类型整形**：没有复现就不改。

第一轮已经证明：没有真实入口证据的“统一化”会扩大回归面。这一轮沿用同一条纪律。
