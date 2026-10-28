# Project 与具名 Owner：外部评审意见与待收敛项

> 本文是对 `project-and-owner` 工作项（README、spec.md、issues 01–03，最后核对 2026-10-20）的一次外部评审，整理自 2026-10-21 与 Human 的讨论。**不是决策记录**：标"已在讨论中确认"的是 Human 当场表态，其余都是建议或待议问题，供团队逐条讨论。

**日期**：2026-10-21

---

## 0. 结论先行

1. 方向成立。"注意力跟着责任走"是对"agent team 是不是 cos-play"最硬的回答：主 agent + subagents 的模型里，验收人永远是 Human；这里 **builder ≠ verifier 成了制度**，Human 验收只剩两类（Owner 亲自执行的、Human 自己建的）。从现在 accept/close 100% 由 Human 完成，降到这两类，就是可量化的改善。
2. 最大的结构性风险是 **agent 互相唤醒的循环**：Owner 之间在主对话、执行者之间在 Thread 里。这靠模型能力只能缓解，不能消除。
3. 建议把**最小唤醒规则提前到第一批**，否则第一批试用那一周量到的仍是旧注意力模型。
4. 第一批开工前只强制收敛 4 件事（§4），其余带着边界情况进入试用、用数据定。

---

## 1. 评审者对现有模型的理解（请校对）

- **Workspace**：共享工作目录 + 授权域，不承载职责；Member 在这一层，owner 是 per-project 的角色。
- **Project**（原 Channel）：**长期的职责范围**（如 UI-UX-AX、Publish-Ship-Growth），没有"做完"。`owners` 是一等字段，Human 必在且不可移除，Agent owner 只由 Human 增删。全 Workspace 可见。
- **主对话**：Owner 的工作台。非 Owner 可读、可发言（非默认），不开 Thread，不被项目消息唤醒。
- **Thread**：只有 Owner 能开；被邀请者可继续拉人，不获 owner 权限。分讨论与 Task 两种。
- **Task**：带工作状态的 Thread，状态由 Claims 派生；**一次有限的端到端交付**。有 accountable owner（默认创建者、可转交）与不可变 `sourceThreadRefs`；交付摘要写在 Task Thread，来源 Thread 只收完成事实；Agent Owner 不得验收自己执行的任务。
- **唤醒**：Owner 四类来源；注入未读摘要与指针，不带正文。
- **提醒**：账本不变量派生、事件级去重：待验收积压（idle ≥ 30 分钟）、停滞（`in_progress` ∧（Thread 24h 无消息 ∪ Claim 持有者 idle > 24h））。
- **分层**：少数 owner agent 常驻推进，多数执行 agent 响应式。

---

## 2. 讨论中已确认的走向（Human 2026-10-21 表态）

| # | 问题 | Human 的回答 | 对 spec 的影响 |
| --- | --- | --- | --- |
| A | 多个 Agent Owner 同时被唤醒，谁接话 | 依赖模型能力判断何时该讲、何时看一眼 | 见 §3.1 的补充建议 |
| B | Owner 的唤醒 | mention 等直接唤醒；**普通消息只进 Inbox** | 修订 spec §3.1 第 1 条（"主对话新消息唤醒 Owner"） |
| C | Thread 内的唤醒 | Owner 只在被 mention 时收到 Thread 消息（类似通知 Human）；**非 Owner 被所参与 Thread/Task 的每条消息唤醒** | 需补入 spec §3（原文只穷举了 Owner） |
| D | 无人认领的待处理任务 | "一般不应发生" | 见 §3.3 |
| E | Owner 亲自执行的任务 | 一般由 Human 验收 | 与 spec §4 一致，补提醒路由 |
| F | Human 验收是否不可避免 | 不可避免，但 Owner 应能端到端落地 | 见 §3.5 |

> 待确认：B 中"进 Inbox"之后，Inbox 非空是否仍会推一下 Owner（现状是会），还是完全由 Owner 自己拉？

---

## 3. 评审意见

### 3.1 多 Owner 抢话：靠模型可以，但要给模型信号，并加一道薄的硬约束

- 唤醒摘要里带上判断所需的信息：**这条消息是对谁说的**、**其他 Owner 是否已在处理**。否则每个 Owner 都要先读正文才能判断，成本随 owner 数线性增长。
- Owner 之间的互唤是结构问题：A 发言 → B 醒 → B 回话 → A 醒。每一轮都是"合理"的发言，聪明模型也会礼貌接话。确认 B（普通消息只进 Inbox）后这个问题大幅缓解；仍建议明确：**Agent Owner 的发言只进其他 Agent Owner 的 Inbox，除非点名**。

### 3.2 Thread 内：同一个坑搬到了执行层

- C 的分层很好：Owner 像经理，执行者全情投入。
- 但 Thread 里有两个以上执行者时，"每条消息唤醒"就是审计里 agent 间回复占 56.5% 的原场景。建议：Human 与 Owner 的消息唤醒 Thread 内所有非 Owner；**其他执行者的消息只唤醒被点名者或持有该 Task Claim 者**。可以先不做，试用期量 agent 间回复占比再定。
- 明确执行者向 Owner 汇报只有两条路：**点名**，或**让任务进入待验收**（任务跃迁本身唤醒 Owner）。这样"做完了但忘了 @owner"也不会丢。

### 3.3 "一般不会发生"就该变成不变量

无人认领的待处理任务不在停滞规则覆盖范围内（停滞只看 `in_progress`），而审计已发现"孤儿 Task 不通知任何人"。二选一：

- **建 Task 时必须指定执行者**（从源头堵死）；或
- 把"待处理超过 N 小时无人认领"作为一条提醒，发给 accountable owner。正好符合"不变量被违反就提醒一次"的机制，几乎零成本。

### 3.4 Owner 亲自执行时的提醒路由

accountable owner 自己执行时它无权验收，待验收积压提醒应**直接进 Human 的 Inbox**，而不是先发给它。

### 3.5 端到端 = 编排 + 验收，不是亲自干

- "不能自验"天然把 Owner 推向委派：交给执行者做，Owner 就能自己验收，Human 不用介入。
- 建议 **Human 建的 Task 默认把 accountable 转给项目的主责 Agent Owner**（Human 只发起），否则提醒会落回 Human 身上，与"人拍板不盯流程"相反。

### 3.6 Context 怎么串起来（方向性，暂不要求进第一批）

原则："不合并大脑，只连接大脑"——context 只通过账本里的产物与引用跨 agent 流动，由接收方按需拉取，不假设任何两个 session 共享记忆。

- **一次交付的 context**：Task 是交接合同。建 Task 时带 brief（目标、完成标准、`sourceThreadRefs`、执行者）；完成摘要是回执，按完成标准逐条对照。
- **跨交付的 context**：Project 是长期职责范围，Owner 维护的应是**这个领域的手册**（职责边界、已定的决策与惯例、还开着的口子），而不是进度报告。它就是 spec §3.3 常驻层"项目稳定事实"的来源，新加入的 agent 不用翻几千条消息就能上手。agent 自己的 memory 存"我怎么做事"，不存"项目在哪"。
- **冷唤醒**：缓存过期且 session 很大时，用项目手册 + 自己持有的任务 + 未读摘要 + 最近几轮原文组装新 session 的首个输入（参考 Raft 的 constructed initial context）。现有"唤醒只带摘要和指针"正好是这一层的输入格式。

Human 的判断是这块"其实有些复杂"，需要实际落地 Project 后再看。建议第一批只观察，不实现；若只能先做一件，选 **Task brief**，最便宜，且直接堵住交接时最常丢的 context。

---

## 4. 第一批开工前必须收敛

1. **最小唤醒规则提前到第一批。** spec 把唤醒放在第三批，但第一批改了"谁能说话"却没改"谁被叫醒"。至少定：mention 唤醒 Owner；普通消息进 Inbox；Inbox 非空是否推 Owner；非 Owner 不被项目消息唤醒。
2. **主对话没有自动 Thread 后，怎么回复一条消息。** 非 Owner 在主对话汇报，Owner 回它时对方收不到（非 Owner 没有未读）。要么 reply 自带 mention 语义，要么约定必须点名。
3. **非 Owner 发言的"显式意图"是什么机制。** 工具参数、独立工具，还是只靠 prompt 约定？这决定主对话会不会重新变成大家都在插话。
4. **在飞内容的迁移。** 旧的自动 Thread、进行中的 Task 与 Claim、旧 Channel 成员：升级后执行者是否仍是 Thread 参与者、是否还能被唤醒？否则升级当天会有任务悄悄断线。

## 5. 可以在试用中观察再定

- Thread 内执行者之间是否互相唤醒刷屏（量 agent 间回复占比）。
- Human 建的 Task，accountable 默认给谁。
- Task brief 是否必填、必填哪几项。
- 讨论 Thread 谁来关、什么时候归档。
- 无人认领：强制指定执行者，还是 N 小时提醒。

建议试用周记录的指标：agent 间回复占比、Human accept/close 占比、Owner 每日被唤醒次数、主对话非 Owner 发言数、停滞/积压提醒触发次数与误报。

---

## 6. 边界情况清单

**Owner 变动**
- Agent Owner 被撤销时还挂着 accountable 或 Claim：任务自动归还 Human，还是禁止撤销？
- Owner agent 被 disable 或挂掉：待验收提醒永远发给一个不会醒的人，需要超时后升级到 Human。
- 同一个 agent 是多个 Project 的 owner：唤醒摘要如何跨项目排优先级。
- 迁移后项目只有 Human owner：所有"唤醒 Owner"的事件实际都落到 Human 的 Inbox，是否会过载。

**验收与状态**
- "亲自执行"怎么判：曾经持有过 Claim 就算，还是只看最后交付的那个 Claim？Owner 认领后释放给别人，还能不能自己验收？
- 两位 Owner 同时验收，或一个验收一个打回。
- Task 完成后被重新打开，而 accountable 中间转交过：通知谁？
- 历史 accept 缺 `acceptedClaimRefs` 时的判定（spec §10 已列）。

**视野与成本**
- 被邀请者可以继续拉人，而非 Owner 被 Thread 每条消息唤醒：一个 Thread 拉进 6 个 agent，每条消息就是 6 次唤醒。是否需要上限？
- Human 在主对话点名了一个非 Owner：后续对话它都收不到，除非每次都点名。
- 非 Owner 在主对话发言唤醒所有 Owner（spec 原设计）与 B（普通消息只进 Inbox）冲突，需定哪条为准。

**跨项目**
- Task 建在 A 项目，实际改动的是 B 项目的领域：是否通知 B 的 owner？
- `sourceThreadRefs` 能否跨项目引用；来源项目被归档时的降级。
- Human 可在任意项目建 Task：建在别人负责的项目里时，accountable 默认给该项目 owner 还是 Human。

---

## 7. 建议的下一步

1. 团队逐条过 §4，结论写回 spec（尤其 §3 唤醒穷举的修订）。
2. 第一批范围按 §4.1 扩充最小唤醒规则后开工。
3. 试用一周，按 §5 指标复盘，再决定第二、三批与 context 层的取舍。
