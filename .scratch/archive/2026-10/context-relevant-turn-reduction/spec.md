# Context 管理：三个动作与一个状态面

**状态**：设计稿，第四版（2026-10-03）。生产代码未改。前三版见 §7。

**写法**：本节起按简明技术写作。一句一个意思。术语固定（见 §3.1）。

## 1. 结论（先读这一节）

模型管理 context，只有三个动作：**压缩**、**换代**、**回退**。

今天只有一个入口能用：换代（`context_rollover`）。压缩没有入口。回退有入口，但被描述挡在门外。

三个动作共享同一个结构：**锚点**。所以它们不是三件事，是一件事的三个方向。

本设计补两件东西：

1. 一个**状态面**：告诉模型"我在哪、我能做什么、代价多少"。这是发现入口。
2. 一个**压缩动作**：模型可以调用它。这是执行机构。

触发有三条路。它们不冲突，都要有：

| 触发 | 谁发起 | 何时 |
| --- | --- | --- |
| 压力 | 宿主 | 到了引擎压力阈值，或到了硬上限 |
| 模型自己 | 模型 | 它看了状态面，觉得该压 |
| 长间隔相关性门控 | 宿主（jev 判断） | 用量 ≥ 128K，且距上一 turn ≥ 30min，且新输入与上文无关 |

**DSH 不改。** 执行机构走引擎已经公开的 `ctx.compaction.compactRegion`：区间由调用方给。原方案要的 `CompactionTrigger: 'requested'` 不再需要。理由与两条撤回的方案见 §6.2–§6.3。本轮改动落在 continuity（主体）与本仓（宿主机制），DSH 零改动，见 §6.4。

**已定（2026-10-03，human）：压缩边界写成契约（选项 B）。** 见 §6.1。

## 2. 测试结果

写这份设计前先做了测试。测试推翻了我先前的一部分说法。**先记推翻的部分。**

| 我先前说 | 实测 | 结论 |
| --- | --- | --- |
| 状态面可以按 Thread 报组成 | 组成只有三类：system / tools / messages | 说法要改。按 Thread 的组成，锚点行里才有粗估 |
| 样例里"工具输出 ~36K" | `toolsTokens` 是工具 **schema**，不是工具**结果** | **样例不准确**。工具结果算在 messages 里 |
| Team Member 跨 Thread ⇒ 回退多半不可用 | 我自己的会话里 8 行有 **5 行可回退** | **说法过头**。可回退与否看会话，不能一概而论 |
| "只压之前"成立 | 成立，但靠保留尾预算 | 是副作用，不是契约。见 §6.1 |

**测试 1：真实会话的 timeline 输出。** 我在自己的 Member 会话里调了 `context_timeline`。原始输出见附录 A。要点：

- 用量 149,763。handoff 在 200,000。硬上限 256,000。
- 8 行。5 行可回退，1 行是 head，1 行是 handoff 来源，1 行因"保留量不小于 handoff 预算"被拒。
- 每一行都只归属一个 Thread。
- 输出里没有组成，也没有 turn 计数。

**测试 2：组成数据是否可得。** 可得。来源是 token-meter 的 `contextBreakdown` 投影，给 system / tools / messages 三个数。这是启发式估算，不含路由计价。

重要发现：**这个组成，人类界面已经显示**。Web 端 ContextMeter 有一个环和百分比，点开就是这三段。**模型看不到。**

**测试 3："现在能压多少"。** 今天没有任何地方显示这个数。它可以算：用量减去保留尾。保留尾默认是窗口的 0.16。

**测试 4：区间选择器的边界。** 读码，并对照仓库自带测试（`compaction-basic/tests/compaction-basic.spec.ts`）。

- 区间**永不包含最新节点**。
- `system/message` 头节点永不进区间。
- 保留尾不足，或工具调用对不齐，就返回 `null`（测试里明确断言）。
- `retainTokens = 0` 时，区间末端正好落在"最新节点之前的那一条"上。所以指令消息会进区间。见 §6.1。

**测试 5：jev 能不能判回指。** **本机测不了**：环境里没有 `TYPESAFE_API_KEY`，本机 profile 也没装 jev 行。所以"jev 能判'继续'、'那个呢？'"这条，本轮只是采信你的判断，没有实测证据。门控设计成可插拔。等有 key 的环境再补一次实测。

## 3. 统一模型

### 3.1 四个对象

| 术语 | 含义 |
| --- | --- |
| **工作集** | 模型现在看得到的东西。它的 token 数就是"用了多少" |
| **日志** | 落盘的完整记录。只追加。工作集是它的一种投影 |
| **锚点** | 谱系里一个可寻址的位置 |
| **代** | 一次上下文代。换代就是结束一代、开始新一代 |

### 3.2 三个动作

| 动作 | 改了工作集 | 改了日志 | 改了代 | 代价 | 前置条件 |
| --- | --- | --- | --- | --- | --- |
| **压缩** compact | 旧的一段换成摘要，近的一段保持原样 | 不改（只追加一个替换） | 同一代 | 一次摘要调用；cache 前缀可能失效 | 有可压区间 |
| **换代** rollover | 换成一个小工作集，由 handoff 播种 | 不改 | 新一代 | 写 handoff；重新装配；cache 重热 | 无（永远可以做） |
| **回退** return | 回到较早的前缀 | 不改 | 新一代 | 丢掉锚点之后的内容；cache 重热 | 有可回退的锚点 |
| **看状态** status | 不改 | 不改 | 同一代 | 几乎为零 | 无 |

**方向不同，这是关键。** 压缩是"身后太长，缩短它"。换代是"翻到新的一页"。回退是"翻回旧的一页"。

### 3.3 为什么它们是一个系统

三点连接：

1. **锚点是共同货币。** 压缩指令本身标出一个位置："这条之前是旧的"。Team 边界也标位置：`team_message`、`team_claim`、attention 变更都会自动产生位置。两者是同一类结构：谱系里的一个点。差别只在来源与用途。

   注意：指令今天**不是** timeline 里的一行。今天的行只有 checkpoint / boundary / handoff / head。这是缺口本身，不是反例。

2. **状态面是两个动作的发现入口。** 没有状态面，模型不知道有没有可压区间，也不知道有没有可回退的锚点。观察到的现象就是这样：回退能力存在，但没人用。
3. **触发器不同，动作相同。** 压力、模型自判、相关性门控，三条路最后都落到同一个动作上。所以不必为每条触发各造一个机制。

### 3.4 我们希望模型建立的认知

一段话：

> 我的工作集有大小、有组成、有历史。我可以缩短它（压缩），可以翻页（换代），也可以翻回去（回退）。我该在边界处、长间隔回来后看状态。压缩是安全的，因为日志只追加；但压缩要付一次摘要调用。

用在哪里：

| 时机 | 动作 |
| --- | --- |
| 刚闭合一段工作，且用量高 | 看状态；必要时压缩 |
| 隔了很久回来 | 看状态 |
| 身后走错了一条长分支 | 看状态；有没有可回退的锚点 |
| 用量接近 handoff 预算 | 换代 |

## 4. 流程：长间隔相关性门控

条件：用量 ≥ 128K，且距上一 turn ≥ 30min。

1. pre-step 读用量与间隔。两个门槛都过，才继续。
2. 宿主调 jev 一次。问题是否定型：本次输入与最近若干轮 user_input 有关吗。
3. 有关，或 jev 判不出，或 jev 不可用 → 正常继续。不换代。
4. 无关 → 宿主**扣住**本次输入，并 reject 这一步。**reject 结束被扣的那个 turn**。
5. 宿主 steer 一条换代指令。指令**引用扣住输入的原文**（截前 4000 字符），点名 `context_rollover`。
6. 模型写 handoff 并调用换代动作。
7. 换代落地 → 扣住的输入随 `carriedInput` 进新代，模型继续处理它。

> **remedy 变更（2026-10-04，human）**：第 5–7 步原为"投一条压缩指令 → 模型调压缩动作 → 压完把输入投回去"。现在换成换代，理由是同形先例 `acceptanceContextAdvice` 已在跑，且换代不需要压缩引擎（压不动的 scope 恰恰是这条门控要照顾的）。**第 5 步的"引用原文"是换代方案唯一必须补的东西**：输入被扣住就开不出 step，模型本来在盲写 handoff，而 handoff 是下一代的全部种子。

**时序（2026-10-04 核过 DSH 源码，实现按这个来）**

- 指令走 `steer`，落在 inbox 的 `next-step`；`Inbox.claim()` 先取 `next-step` 再取一条 `next-turn`。所以 reject 之后 driver 会**单独为指令开一个 turn**——模型在这个 turn 里只看到指令，看不到那条被扣住的输入。这是 remedy 生效的关键。
- 扣件在**被扣的那个 turn 结束时**就丢掉（不是等换代）。这是硬的：宿主在压力策略**之前**查 `needsAdmissionGate`（Team 现有接线就是这么查），挂起活过那个 turn 会把唯一携带指令的 turn 也拒掉。
- 投回要等 `whenIdle()`（driver 收敛），也就是指令那个 turn 跑完之后；并且在**投递那一刻**再查一次有没有换代落地——模型在指令 turn 里换代了，输入就走 `carriedInput`，不投回。
- 判据是"有没有成功的 `context_rollover` 结果落地"（coordinator 的 `subjects.has(id)`），不做 surface 前后比较。

边界与失败：

| 情况 | 处理 |
| --- | --- |
| 模型收到指令但没换代 | 投回扣住的输入。不能卡住。**（兜底归 coordinator 自己：投递等 driver 收敛，并在投递那一刻再查一次换代；宿主不需要任何释放调用。时序见上。）** |
| 模型在指令那个 turn 里换代了 | 输入走 `carriedInput` 进新代，不投回。 |
| 换代在飞时又来了一个 turn 结束 | 输入归换代，不投回。判据是"有没有成功的换代结果落地"。 |
| 换代请求了但 swap 失败 | 输入已随 plan 交给宿主（`carriedInput`），归宿主的 `executeTransition` 边界，coordinator 不重复投递。 |
| jev 超时或报错 | 不换代。正常继续。记一条日志。不装成安静 |
| jev 没装 | 整条门控不启用 |

**两个阈值的归属（2026-10-04 human 更正：两处数字语义不同）**：本门控的两个门槛是 continuity 自己的默认值 `DEFAULT_GATE_TOKENS = 128_000`、`DEFAULT_GATE_IDLE_MS = 1_800_000`（导出，构造器第三个参数按策略覆盖）。Team 仓那两个数字不是同一件东西：`ACCEPT_TASK_BOUNDARY_THRESHOLD = 128_000` 是"被 accept 的 Task 是天然翻页点"的业务边界（并被路由的 `handoffAt` 封顶），`CLOCK_REFRESH_INTERVAL_MS = 1_800_000` 是一个 turn 内两次时钟快照的最小间隔（时间感知刷新）。**两者都不迁**：数字相同是调参口径的巧合，不是同一个语义；宿主想要别的数字就在构造 `ContextPressurePolicy` 时覆盖。

唤醒与扣件机制都现成：`agent.status === 'idle' ? followup(msg) : steer(msg)`（`agent-team/src/index.ts:1866`）。扣件是 `needsAdmissionGate` / `captureQueuedInput` / `captureClaimedInput` / `drainCapturedInput`（continuity `coordinator.ts:118-167`），今天绑在换代上。同一代内要用，需新增一份"压缩挂起"状态。

**落点（2026-10-03 改）**：这条门控写进 continuity 的通用策略 `ContextPressurePolicy`（`src/pressure.ts`）——它已经有 pre-step 决策、notice latch、硬上限强制压缩与 overflow 重试，本仓 `pressure-policy.ts` 是同形的重复实现，届时应删掉。见 §6.4。

**成本提醒**：pre-step 在 turn 启动的关键路径上。jev 默认超时 30 秒、重试 3 次。这条用途要更紧的配置。

## 5. 状态面

### 5.1 今天的输出

Team 侧 render 模板：

```
Context timeline: {usage} tokens used (handoff at {handoffAt}, hard limit {hardLimit}). {n} item(s):
- {name} [source: {kind}; anchor {6位摘要}] (retained ~{r}, discarded ~{d}; Threads {…}) — restorable — ref: {ref}
- … — not restorable — {理由}
History incomplete: …（可选）
```

它回答的是"我的谱系里有哪些点"。它没有回答"我在哪、我能做什么、代价多少"。

### 5.2 建议的输出

按测试 1、2、3 的实测字段重写。不写实测拿不到的字段。

```
Context: 149,763 / 200,000 handoff / 256,000 hard limit
Composition (heuristic): system ~8K · tools ~11K · messages ~131K
Anchors: 8 rows · 5 restorable
  - "task #45 spec v4" [checkpoint] retained ~140K, drops ~9K — restorable, ref: …
  - "Team message" [boundary] retained ~105K, drops ~44K — restorable, ref: …
  - "context handoff" [handoff] — never a return target
Compact now: about 118K compactible; keeps the last ~32K verbatim
```

三点说明：

1. `Composition` 是三类，不是按 Thread。按 Thread 的数字只在锚点行里有。
2. `Compact now` 是算出来的（用量 − 保留尾），不是存储字段。
3. 锚点行保留今天的 `retained` / `discarded` / `restorable` / 理由。那几行就是回退的决策面。

### 5.3 名字与措辞

建议**同一个工具改名换描述**，不新开一个。

- 理由：锚点行就是回退决策面。状态面是它的超集。拆开会重新制造"我该调哪个"。
- 名字：`context_status` 比 `context_timeline` 更贴它的工作。
- 描述：去掉今天那句门。今天是 "Use this tool only when you specifically intend a checkpointRef return"。这句让工具只在模型**已经想回退**时可见。改成"在边界处、长间隔回来后、或不确定自己站在哪里时调用"。
- **更正（2026-10-03 晚，核到源码）**：先前写的"这句话是本仓自己写的，不是引擎文本"**说错了**。同一句在 continuity 的 `tools.ts`（`timelineDescription`）里也在——Team 那份是手抄的副本。所以改一处就修好所有宿主。Team 的 `timelineGuidance` 缝之所以不生效，是因为它注册的是自己的 timeline 副本，没有注册引擎那个。

**落点（2026-10-03 改）**：字段与描述进 continuity 的 `ContextTimeline` 契约与 `ContinuityToolText`（宿主供数、引擎渲染）；本仓那份 render 覆盖（非可回退行不打印 ref）跟着同源改，两边不要漂开。见 §6.4。

### 5.4 回退的门槛

今天跨 Thread 的边界直接判不可回退，理由是"写一份新 handoff"。这条太紧。

Team 的事实很便宜：Threads、Tasks、Claims 都在账本里，可以重读。贵的是模型自己的推理链。

建议：让它可回退，把代价写进行里。例如"会同时丢掉 Thread X / Y 的事实——它们可以重读"。不要直接拒绝。

## 6. 契约与改动面

### 6.1 哪个成契约

要成契约的那一条是：

> **压缩区间不得包含压缩指令这条消息，也不得包含它之后的任何消息。**

今天它不是契约，是保留尾预算的副作用。保留尾默认是窗口的 0.16（200K 窗口约 32K）。一条指令消息很小，必然落在保留尾里。所以今天实际成立。

但两处会破：

1. `retainTokens = 0`。区间末端正好停在指令那条上。overflow 那条路就是这么调的。
2. 将来有人调小保留尾。这是静默失效。

两个选项：

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| A 接受现状 | 靠保留尾预算 | 契约只是"今天成立" |
| **B 写成契约（已选）** | 区间上界由调用方给，卡在"最新那条 `user/message` 之前" | 这条检查由我们承担，并加测试 |

**已定（2026-10-03，human）：选 B。**理由：一个会删内容的机制，边界值得是契约。

B 的落点从引擎移到了调用方（见 §6.2）：区间由我们选，上界就由我们的选择器保证，不再需要引擎改代码。上界取"**最新那条 `user/message` 之前**"：

- 门控触发时，压缩指令就是最新的 user_input ⇒ 原契约成立。
- 模型自判时，最新的 user_input 是本轮输入 ⇒ 本轮整段原样保留。比"保留尾 32K"更保守，而且是结构性的，不随预算漂移。

### 6.2 三个入口，为什么走 `compactRegion`

`ctx.compaction` 是公开服务（契约包 `@deepseek-ai/dsh-compaction`，本仓的 peer）。它有三个入口：

| 入口 | token 门槛 | 保留尾 | turn 内能跑吗 |
| --- | --- | --- | --- |
| `compactIfNeeded(agent, trigger)` | 有（`trigger` 是封闭联合） | 引擎定 | 能 |
| `compactNow(agent)` | 无 | **0，等于全压** | 不能：要求 true idle，turn 内直接抛 |
| **`compactRegion(start, end, agent, signal)`** | **无** | **调用方定** | **能**：要求有开着的 turn |

**走第三条。** 它不检查任何 token 阈值，区间由调用方给。所以"低于引擎阈值压一次"这件事**不需要新的理由值**。契约包同时导出了边界校验要用的 `toolPairingBalancedBefore` / `toolPairingBalancedAfter`；`compactRegion` 的文档就是要求调用方拿这两个做边界检查。

分工：引擎仍然管摘要调用、事务与 durable 锁、surface 稳定性校验、"摘要必须比原文小"的比较、token 计量。我们只定**何时**与**留多少**。

代价四条，都记在这里：

1. **区间选择要自己写**（约 25 行：跳过 `system/message` 头、从尾往前走够保留量、退到配平边界、上界卡住）。`selectCompactableRange` **引不进来**——它在 `src/region.ts`，而发布出去的包 `files` 只含 `lib/index.js`。所以是复述，不是复用。缓解：只写一处，测试照抄引擎自带断言。落点在宿主（本仓）——除非选 §6.4 的 B，把它整个放进 continuity。
2. **要求有开着的 turn**（`owner: 'current-turn'`，没有就抛）。工具调用满足；宿主在纯 idle 时想压不满足（那条只能走 `compactNow`，而它保留尾是 0）。
3. **`stability: 'whole-surface'`**：摘要期间 surface 任何变化（例如并发 steer）都判 `changed`，保留原 surface 并如实回报。失败方向本来就是"不压"。
4. **日志少一个理由**：`compaction/start` 不会带"调用方发起"。要留痕得本仓自己记一条。

### 6.3 撤回的两条

| 撤回的 | 为什么 |
| --- | --- |
| `CompactionTrigger` 加 `'requested'` | 前提是"只能走 `compactIfNeeded`"。而 `compactRegion` 一直公开、且不设阈值。所以既不用改 DSH，也不用提上游 patch。 |
| 调低 `thresholdRatio` | ① 阈值不是"0.8×窗口"，是 `min(ratio×窗口, 窗口 − 输出预留 − headroom)`，随路由变；② `'pressure'` 分支会先跑工具结果 prune（装了 pruner 就跑）；③ 它仍然只会返回 null 或把日志读成压力触发。 |

还有一条先前写的判断要撤回：**"宿主自己算区间要把引擎的判据复制一份，不能接受"**——这句话说错了。引擎公开导出了配平助手，`compactRegion` 的契约就把边界检查交给调用方；我们复述的只是"留多少"这一条策略，不是引擎的机制。保留量、边界校验、事务都仍在引擎里。

### 6.4 改动面

| 仓 | 本轮改动 |
| --- | --- |
| **continuity**（`@wowyuarm/dsh-context-continuity`，0.1.6 → 0.1.7） | **主体。** ① 压缩工具 `context_compact` + 描述 / 渲染 / 失败语义，**外加机制**：选区间 + 调 `ctx.compaction.compactRegion`；② 门控写进通用策略 `ContextPressurePolicy`，并**依赖 npm 版 `@wowyuarm/dsh-jev`（可选 peer）**、把 128K 与 30min 收成自己的默认值；③ 状态面契约 `ContextTimeline` 加组成与可压量（宿主供数、引擎渲染） |
| **本仓** `@wowyuarm/dsh-agent-team` | ① 挂工具与依赖（不再写机制）；② **删掉** `pressure-policy.ts` 那份重复实现，改为实现 continuity 的 `PressurePolicyHost`；③ jev 接线；④ render 覆盖照旧 |
| **DSH**（`deepseek-harness`） | **零改动。** 只用已公开的面：`ctx.compaction`（`CompactionEngine.compactRegion`）、契约包导出的 `toolPairingBalancedBefore/After`、`ctx.tokenMeter`、`session.surface.nodes`、`agent/pre-step`。这些都在本仓 peer 里（`@deepseek-ai/dsh-compaction` / `dsh-token-meter` / `dsh-session` / `dsh-agent`） |
| **jev** | 零改动。它是服务，只回答一个问题 |

**为什么主体在 continuity**：那套工具是它的产品面（"a subject manages its own context through them and nothing else"），而且本仓已经依赖它——放 continuity，Team 与将来的 Loom 一起继承；放本仓只有 Team 用得上。

**发布路径**：continuity 走 `pnpm changeset` → 发版 → 本仓 `dependencies` 从 `^0.1.6` 提到 `^0.1.7`。本仓现在吃的是 pnpm store 里的 0.1.6（不是本地 checkout），所以**开发期联调要先 link 到 checkout**。

**已定（2026-10-03 晚，B 方案）**：机制那半边放 continuity——它自己 peer `@deepseek-ai/dsh-compaction`（白名单本就只收 `@deepseek-ai/dsh-*`，所以不破"引擎对宿主中立"），自己选区间、自己调引擎。本仓零机制代码。这一条与同晚的 jev 决定同向：continuity 直接依赖它需要的服务，不再要求宿主逐个注入能力。

**不做**：本轮不给 Member 挂 `context_search` / `context_read`。

## 7. 决策记录

| 版本 | 触发 | 谁执行 | 为什么被取代 |
| --- | --- | --- | --- |
| 一 | 宿主产出 proposal | 宿主选区间 + jev 相关性排序 | 区间选择引擎已能做，边界由引擎校验 ⇒ proposal 层与 jev 重复 |
| 二 | 宿主验收锚点 | 引擎 `compactRegion` | "每次验收都压"太频繁；时机该由更懂现场的一方定 |
| 三 | 模型自行调用 | 模型工具 | 补上了缺失的动作，但没有触发条件 ⇒ 模型多半不会用 |
| **四** | **三条路：压力 / 模型 / 长间隔相关性门控** | **模型工具（门控只是提示路径）** | 本版 |

第三版的压缩工具不是被推翻。它是本版的执行机构。变的只是**发起方**：第三版里"何时压"只由模型自判，本版把发起方扩到三个（压力 / 模型自判 / 长间隔门控），模型自判仍是其中一条。

**路线变更（2026-10-03 晚，两条 human 决定）**

1. **提不了上游 patch** ⇒ 撤回 `CompactionTrigger: 'requested'`，改走引擎公开的 `compactRegion`（§6.2）。DSH 零改动。
2. **"最好是改进 continuity，毕竟 team 这边也依赖它"** ⇒ 主体落点从本仓移到 continuity（§6.4）：工具、门控策略、状态面契约都进 continuity；本仓只留宿主机制，并删掉那份重复的压力策略。

## 8. 验证

必须先回答：**这套东西实际值不值。**

固定中文样本，四组对照：不压、现有压力压缩、模型自判的压缩、门控触发的换代。记录：

- 模型是否在合适时机用状态面与压缩动作；是否滥调；
- 接续质量；事实、归属、发送结果、未决状态的错误率；
- prompt tokens、cache read/write、后续请求的前缀复用；
- 摘要调用、handoff 撰写、重新装配、补读各自的成本与等待；
- 压完后的回查成功率；
- crash、replay、cold fold、live fold 的收敛。

jev 门控另需一组实测：样本里要有"继续"、"那个呢？"这类回指。本轮无 key，未测。

## 9. 明确不做

- 不删除 append-only 日志。被压掉的事件仍在日志里。
- 不做任意不连续 turn 集合的多段替换。
- 不引入 proposal 层。
- 不用压缩取代换代。
- 不做"每次验收自动压缩"。
- 不改变默认行为，除非显式启用。
- 本轮不给 Member 挂召回工具（`context_search` / `context_read`）。

## 附录 A：测试 1 的原始输出

```
Context timeline: 149763 tokens used (handoff at 200000, hard limit 256000). 8 item(s):
- current head [source: head; anchor 637887] (retained ~149763, discarded ~0; Threads thread:b485f9a3-…) — not restorable — the head is the current working set; returning to it discards nothing
- Team task claim change [source: team-boundary; anchor 1464a9] (retained ~140403, discarded ~9360; Threads thread:b485f9a3-…) — restorable — ref: team-boundary-cfdd53f3…
- Team message [source: team-boundary; anchor 114644] (retained ~140403, discarded ~9360; …) — restorable — ref: team-boundary-5e80b77f…
- Team message [source: team-boundary; anchor f9b5d7] (retained ~105389, discarded ~44374; …) — restorable — ref: team-boundary-42bef7ef…
- context handoff [source: handoff; anchor 0b3ed8] (retained ~105389, discarded ~44374; …) — not restorable — source 'handoff' is not a restorable checkpoint
- Team message [source: team-boundary; anchor d81c34] (retained ~207228, discarded ~149763; …) — not restorable — retained context would not materially shrink the working set
- Team task claim change [source: team-boundary; anchor 11e973] (retained ~193822, discarded ~149763; …) — restorable — ref: team-boundary-6a029382…
- Team message [source: team-boundary; anchor 3a59a3] (retained ~193822, discarded ~149763; …) — restorable — ref: team-boundary-32da9f52…
```
