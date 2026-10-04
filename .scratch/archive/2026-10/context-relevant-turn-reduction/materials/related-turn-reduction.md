# 相关 turn 保留与 Context 缩减：方案研究

研究日期：2026-10-03。本文是研究材料，不是已确认设计或当前 API 合同。源码与测试优先；涉及 DSH 的描述已按相邻 checkout 当前源码核验。

## 1. 问题定义

目标不是单纯把 token 压到某个水位，也不是把 Agent 换到新 Session。目标是同一 Agent Session 内：

- 多轮 turn 若与当前工作相关，继续原样留在模型可见 context 中；
- 不相关 turn 可从当前模型 surface 移走，避免长期历史把窗口和 prompt 成本撑大；
- 被移走的事实仍存在于 append-only Session log，可通过检索/精确读取回查；
- 当前输入、正在展开的工作、未完成的 effect、必要的 tool 配对和 system/tool header 结构不能被误裁；
- 相关性判断失败、低置信或结构无法证明时宁可多留，不把一次错误判断变成不可逆丢失。

这是一种“按装载内容管理 context”的问题，而不是 continuity 单独拥有的“换代”问题。Rollover 仍是换到 successor Session 的边界动作；本研究只讨论同一 generation 内的 surface 管理，但必须保证 rollover/checkpoint/search 的原有语义不被破坏。

## 2. 已核验的现有能力

### 2.1 DSH Session 是两层事实模型

DSH Session 的 append-only log 是事实源；surface 是由 `system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` 等 message-producing events 组成的有序模型输入视图。Surface replacement 通过新的 message event 的 `surfaceOp: { op: 'replace', startSeq, endSeq }` shadow 旧节点，旧事件仍在 log 中。

因此“裁掉”只能先理解为从当前模型 surface 移走，而不是删除历史。`sessionQuery` 的 `SessionEventSurface` 已区分 `current`、`shadowed` 和 `log-only`，这为无关历史的回查提供了现成语义。

### 2.2 DSH compaction 已有可复用执行面，但选择器不是相关性选择器

`dsh-compaction-basic` 的 pressure 路径在 `agent/pre-step` 执行：按当前 route 的 context window、输出预留、threshold、retention 配置测量；达到阈值先运行可选 `toolResultPruner`，再从当前 surface 选择一个连续区间，生成摘要并以 replacement event 替换。默认配置约为 `thresholdRatio=0.8`、`retainRatio=0.16`、`headroomTokens=65,536`，但这些是压力策略，不是“当前输入相关性”策略。

`selectCompactableRange()` 的实际行为：从第一个非 system surface node 开始，到保留近期尾部之前选择一个连续 range；向前调整以免打断工具调用/结果配对。它不读取当前问题的语义，也不按完整 turn 做选择。`compactRegion()` 同样只接受一个连续 surface positional span，并验证 start/end 是平衡的 tool boundary；它不支持一次提交多个不连续 ranges。

摘要事务有较强的 durable 保护：写 `compaction/start`，异步摘要，检查 surface 稳定性，写 `compaction/summary` 和 replacement `user/message`，最后写 `compaction/end`；摘要必须小于被替换内容，否则失败。压缩失败保留原 surface，已完成的 durable prune progress 另有 replay-safe 语义。

`toolResultPruner` 是 model-free 的 head/middle/tail 工具结果缩减器，只针对当前 surface 上超字符预算的 `tool/result`；它不理解话题相关性，也不保证近期完整 turn 不变。

### 2.3 DSH session-query 可作 baseline 与回查通道

`sessionQuery` 提供：

- `searchEvents` / `searchSessions` 的全文查询；
- 事件 metadata filter 与 text filter；
- 由 provider 负责的 relevance ranking；
- `readEvent` 的有界邻域；
- `traceEvent` 的 replacement/source/derived relationships；
- `readSurface` 与完整 log 读接口。

现有 continuity 的 `context_search` / `context_read` 已将 search scope 授权、canonical refs、lineage、bounded result/read window 和 restorable-anchor policy 包装成模型工具。它们是显式召回面，不是每步自动选择器。第一版研究必须先测“不使用 jev 的 sessionQuery baseline”，否则无法证明 jev 有增益。

### 2.4 token-meter 能观察组成但不决定取舍

DSH token-meter 能输出 provider anchored pressure，以及 heuristically priced 的 system prompt、最新 request header tool schemas、其余 message surface 的 breakdown。它可以做触发和成本记录，但不提供“这段 turn 与当前话题相关”的判定。

DSH 记录 provider 报告的 input/output/cache read/cache write usage；DeepSeek adapter 的已有 runtime tests 证明相同前缀可复用、修改较早前缀会改变 cache reuse。这里不能假定统一 cache TTL，也不能由空闲时间推断缓存必然冷。成本评测必须比较：相关 context 的 prompt tokens、cache read/write、重建后的后续请求、jev/摘要调用、等待和召回补读。

### 2.5 jev 的能力和限制

`@wowyuarm/dsh-jev` 是结构化判断 service，不是聊天模型 adapter。它接收一个 state 和一组 `noul`/`choice`/`score` questions，返回答案、概率/置信和 usage；service 对 transient transport/status 做有界重试，取消不重试。

jev 没有跨调用记忆，不搜索 Session，不读文件，也不生成最终摘要。它只能判断调用方已经放进 state 的候选材料。因此它适合做“候选 turn 相关性排序/预筛”的可选 adapter，不适合成为 continuity 的事实存储、检索器、context 重建器或单独删除授权者。

## 3. 方案边界：三层职责

### 3.1 Host / Loom

Host 负责 domain semantics：

- 当前工作的 subject、最近输入和宿主注入的实时事实；
- 如何把 raw Session events 聚合成可判断的完整 turn；
- 哪些 turn/消息是不可裁剪保护项（当前 turn、未完成工具链、外部 effect 未决、必要的 system/tool declarations）；
- 让 sessionQuery 产生有界候选，必要时调用 jev；
- 相关性结果的 domain policy 与候选状态；
- 在实际运行中验证中文会话的漏召回、接续质量和成本。

Loom 不应把 jev raw probabilities 直接写进主体上下文，也不应让 jev 绕过 Host/DSH durable mutation。

### 3.2 DSH / compaction

DSH 负责通用的 Session surface / replacement 机制、tool pairing、summary transaction、token metering、query/read/trace 和 provider cache usage 记录。

如果第一版限定为连续旧前缀 + 近期尾部，现有 `compactRegion` 可以复用，选择候选只需把相关性用于决定摘要范围内的内容如何进入摘要；但如果目标真的是“任意不相关 turn 直接裁剪、交错相关 turn 原样保留”，现有连续 replacement 不足，需要 DSH 扩展一种可回放的非连续 turn-set surface rebuild/selection contract。这个扩展应在 DSH，而不是通过 continuity 私自拼接 replacement events。

### 3.3 dsh-context-continuity

continuity 的最小可复用 seam 应是通用调度/策略，而不是 jev 集成：

- 观察当前 subject 的 pressure、surface generation 和 durable log;
- 询问 Host 一个有界、可验证的 reduction proposal；
- 规定 protected surface、完整 turn/tool boundary、replacement 预期和 fail-closed 结果；
- 只在 host/engine 能证明 reduction 成功时继续；
- 失败、取消、候选不可验证时保留旧 surface并把当前请求交回已有 pressure/hard-limit 规则；
- 不记录或解释 Loom 的 topic 语义、tool names、cache TTL 或 jev provider。

可考虑的深接口形状（仅概念，不是最终 TypeScript）：

```ts
interface ContextReductionHost<SubjectId> {
  limitsFor(subject): PressureLimits | undefined | Promise<PressureLimits | undefined>
  surfaceFor(subject): { generation: number; tokens?: number }
  propose(subject, input: {
    usageTokens: number
    protectedRanges: readonly SurfaceRange[]
    budget: number
  }, signal): Promise<ReductionProposal | undefined>
  reduce(subject, proposal, signal): Promise<ReductionResult>
  failedFor(subject, diagnostic): void
}
```

这仍然可能过浅或过宽；更深的版本应让 continuity 自己拥有 pressure-stage 顺序、一次性/幂等/failure policy，而 Host 只提供单个“执行一个已验证 proposal”的 adapter。相关性候选、jev、摘要内容和 turn 聚合都留在 Host/DSH 内部。

候选 proposal 必须携带可验证的结构事实，而不是只带 boolean：当前 generation identity、要保留的完整 surface positions/turn ids、不可动保护项、选择的 replacement mechanism、预期 generation/token delta 和可回查 refs。Engine 在执行前重读/校验 surface；任何 mismatch 都拒绝并回退。

## 4. 推荐的落地阶梯

### Phase 0：不改代码，建立质量基线

构造真实或脱敏的中文会话样本，覆盖：

- 同一话题跨多轮继续；
- 话题切换后回头引用旧话题；
- 长工具过程后继续自然对话；
- 外部发送成功/失败/不确定；
- 多个话题交错；
- 当前 turn 中有工具调用和结果；
- 一次裁剪后又从历史召回并纠正旧答案。

对照：全量 surface、现有 token-based compaction、sessionQuery baseline、sessionQuery + jev。指标至少包括相关 turn 漏保、误保、召回成功率、回答事实错误/归属错误、prompt tokens、cache read/write、额外调用成本和等待。

### Phase 1：无 jev 的安全候选与连续前缀切片

先不接 jev。宿主用确定性输入和 sessionQuery 建立候选，固定保护最近尾部和不可动项，只允许一个连续旧前缀被 compaction；原始日志可通过 context search/read/trace 找回。此阶段回答“DSH replacement 与 Loom 业务内容是否能保持接续”，不是回答“相关性最优”。

候选必须对 turn 做 group：不能只因为一个 tool/result 命中就把 turn 拆开。无法把 surface positions 证明为 balanced boundary，或当前工作与旧内容交错无法形成连续区间时，保守不裁。

### Phase 2：jev 仅作为可选 reranker/pre-screen

给 jev 一个严格有界的 state：当前输入、最近尾部、每个候选 turn 的短文本/引用和必要 metadata；不要把完整历史直接塞入 jev。jev 只输出排序/相关性建议，低置信、异常答案、调用失败或候选为空均回退到 Phase 1 的确定性策略或“不裁”。

为防止模型判断漂移，固定 jev model 版本、问题 schema、候选上限和归一化规则；结果不得成为不可逆事实，最终 durable mutation 必须仍由 DSH compaction transaction 完成。对每次建议记录可审计的版本、候选 refs、结果摘要和执行结果，但避免把 raw probabilities 膨胀进主模型 context。

### Phase 3：若评测证明需要，扩展 DSH 非连续 surface contract

只有 Phase 1/2 的连续前缀方案在真实交错话题中明确失败，才提出 DSH 的非连续 turn-set surface rebuild。该能力需要：

- 保持 append-only log authority；
- 为被隐藏但仍可检索的事件保持清晰 `current`/`shadowed` 关系；
- 不破坏 tool call/result、system/tool header、developer tool additions、compaction source/trace；
- 一次 durable transaction 记录完整选择和替换关系，避免逐段重写造成 cache 反复失效；
- replay/cold fold/live fold 收敛；
- 在失败和崩溃中保留旧 surface 可恢复。

这不是 continuity 单包可以绕过的实现。

## 5. “质量保证”能承诺什么

### 可保证的硬性质

- 原始日志不删除；
- 任何执行的 replacement 有完整 durable transaction 和可回查 source/trace；
- 当前 turn、protected ranges、tool pairing 和必要 header 结构不被选择器破坏；
- jev/候选/摘要失败时保守保留或交回现有 pressure policy；
- reduction 只有在 surface generation/token pressure 或 durable replacement 明确推进后才算成功；
- 同一 proposal 在重试/恢复中不会生成重复或矛盾的事实；
- 被裁掉的内容可通过 context_search/context_read 或 Host-owned exact read 找回。

### 不能先验保证的质量

- jev 能识别所有“相关”turn；
- 召回不会漏掉隐式指代、跨话题回指或中文语境下的细粒度关联；
- 摘要不会改变原话归属、时间、发送结果或未决状态；
- 裁剪一定降低总成本。修改旧 prompt 可能使 cache prefix 失效；jev、摘要和补读也有成本；
- 模型一定会主动召回它不知道已被移出的内容。

这些必须通过真实回归集和人工/主模型判定对照验证。"原始日志还在"只保证 recoverability，不保证模型会意识到需要回查。

## 6. 推荐的第一张实现 ticket（待 Human 确认）

**What to build:** 在不改变默认 Team/Loom 行为的情况下，为一个 host 提供确定性“候选 turn → 保护/连续旧前缀 proposal → DSH compaction 执行 → 可回查”纵向切片，并产出质量/成本基线；jev 暂作为可插拔 reranker，不作为必需依赖。

**Blocked by:** 明确 DSH 现有 compaction adapter 是否能接收 host-owned proposal；若不能，先在 continuity 设计一个 proposal seam 或在 DSH 增加最小 adapter。

**Acceptance criteria:**

- 当前 turn、工具配对、system/tool header 和未完成 effect 不被选择；
- 只执行一个连续旧前缀 replacement，失败或无法证明安全时不裁；
- Session log、surface status、trace 和 context_search/context_read 都能解释/回查被裁内容；
- baseline 与 jev reranker 的相关 turn 漏召回、误保、接续质量和成本可比较；
- crash/replay/cold-fold 与 live path 收敛；
- Team 默认仍不启用，Loom 仅在显式实验配置中启用。

## 7. 结论

最小而可防守的路线不是直接打开 `auto:true`，也不是立即把 jev 接到 continuity 核心。先把“相关性候选”做成 Host 可选策略，把“完整 turn/连续 range/可回查/失败保守”做成 DSH/continuity 的结构契约；第一版限定在单个连续旧前缀 + 近期尾部，使用 sessionQuery baseline，jev 只作可插拔 reranker。只有真实评测证明交错话题必须支持非连续保留，才推动 DSH 增加一次性的非连续 surface rebuild 能力。
