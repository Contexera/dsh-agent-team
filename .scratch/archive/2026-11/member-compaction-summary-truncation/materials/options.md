# 候选方案与明天的待答问题

**判据（先定标尺，再选方案）**：
1. 摘要写不出来时，成员**不会被永久锁死**（这是本次事故的实质：不是「摘要不好」，是「成员废了」）。
2. 换模型/改全局阈值**不再**是唯一出路。
3. 成本与时延可解释、可配置（摘要是一次真实模型调用，长会话尤其贵）。
4. 不要新增第二套真相（谁写摘要、能不能写，应该只有一个判定处）。

## O0 临时措施（已生效，不算方案）

Human 把「默认压缩阈值」从默认 256K 调到 **300K**（11-05 设定；11-06 09:28 重启后从盘上加载的就是 300K）。Cole 因此越过触发点、请求放行、切模型的请求落地，随后压缩成功。
- 代价：整体压缩更晚发生，**单次摘要覆盖的历史更大**，对「能写摘要的模型」要求更高；且任何模型怪癖都会在更高水位上重演。
- 退出条件：根因级方案落地后回默认值（或按模型配置）。

## O1 摘要目标跟「下一次请求」走（解死锁的正解候选）

**做什么**：成员 admission 压缩时，如果需要摘要的路由与「本次即将发出的请求」的 provider/model 不同，就用**即将发出的那个模型**写摘要；相同则维持现状（保留前缀缓存收益）。
**为什么合理**：换模型那一刻，旧模型的前缀缓存对新模型本来就无效，所以「用旧模型写摘要以复用缓存」这个理由在切换场景下不成立；而 checkpoint 是要给**新模型**读的。
**代价**：切换场景摘要按全价计费（本来也如此）；需要定义优先级（显式配置 > 即将用的模型 > 旧路由）。
**开放问题**：账本里的成员模型与 composer 选择不一致时（本次就是：账本是 hy4free、composer 是 deepseek），"即将发出的模型"到底是哪个？这直接依赖「composer 采纳」那条链路（见 O5）。

## O2 可配置摘要目标（Team 级默认 + 按模型覆盖）

**做什么**：把「谁写摘要」变成一等配置：Team 级默认（可选）、按 `provider/model` 覆盖（`modelPolicies` 已有这个形状的上限覆盖位）。
**用途**：运维可以给「思考型/啰嗦」的模型钉一个便宜的摘要模型，或反过来给主力模型留原生摘要。
**代价**：多一个旋钮；配错会让摘要模型与对话模型语义不一致（resume 质量要抽查）。
**和 O1 的关系**：两者不冲突——O2 是显式配置优先，O1 是没配置时的默认行为。

## O3 上限与模型能力对齐

**做什么**：① 允许按模型配置摘要 `maxTokens`（`modelPolicies` 已支持，只需在成员预设/Team 配置里给出口）；② 触发 `MAX_TOKENS` 时，用该模型声明的 `max_output_tokens` 再试一次。
**读数支撑**：hy4free 在 19K 输入下就要 32,354 输出（其中 24,666 是 reasoning）；16K 对它必然不够，65K 够但一次要 155 s 以上。deepseek 系在 266K 输入下只要 5,709。
**代价**：时延与成本直接涨（思考型模型会长时间硬生成）；**所以不能全局抬，只能按模型配**。
**风险**：把「上限」当解药会掩盖 O1/O4 要解决的问题（模型再啰嗦一次还是锁）。

## O4 失败退路：别 fail-closed 到「成员不可用」

候选动作（择一或组合，需要有界次数）：
1. **换摘要目标重试一次**（与 O1 组合最自然：先按即将用的模型写，失败再按另一个已知可写的目标写）。
2. **缩小输入前缀重试**（上游 `cf7229e72a` 做过又撤回的形态）：只对**上下文超窗**有效，对本现象**无效**——记在这里是为了不再重复走这条死路。
3. **降级裁剪**：摘要实在写不出来时，退化为「保留最近 N 轮 + 一条说明性占位」，让成员**继续可用**，同时把失败事实（原因、模型、上限、读数）写进会话与成员状态。
**取舍**：降级会丢历史（但总比成员卡死强）；必须**有界**（不能每轮重试烧钱）；失败信息必须可行动。

## O5 观察面与预防（不修行为也要有）

- 成员状态里露出「上一次压缩为什么失败」+ 可行动建议（换摘要模型/抬上限/缩会话），而不是只有一个 `error` 状态点。
- composer 的模型选择**是否落到账本**（今天早先讨论过的「采纳」缺口）直接决定「成员真正在用的模型」是否可解释——本次事故里，账本与界面不一致让人一开始误判成「已经切到 Deepseek 了为什么还失败」。

## 我的初步意见（待 Human 拍板）

O1（解死锁，语义正确、改动面小）+ O4.1/O4.3（有界退路，防锁死）+ O2/O3 作为运维手柄（按模型配置，不动默认）。O5 单独排，属于可观测性改进。**不建议**把「全局抬上限」当修复。

## 明天要回答的问题

1. **横向量**：历史上有多少成员/模型中过这个错？为什么只有 Cole 持续中（他的会话在 256K 水位上，且模型是 hy4free）？
   **→ 11-06 已答，见 `cross-section.md`**：15 次 / 4 成员（Cole 8、Tome 5、Aster 1、Ferry 1）/ 2 模型（hy4free、step-5-preview）；卡死的是 Tome（≈1.8 h）与 Cole（≈1.6 h）。Cole 最惨是因为「26.5 万输入 × hy4free」的组合每次都把 16K 花在思考上，而其他人的输入更小或模型能写。
2. 模型维度：哪些模型在「固定输入 + 16K 上限」下写不出摘要？给出「模型 → 所需预算」的表（用 `replay-compaction.py` 批量跑，成本低）。
   **→ 日志侧已给出估读**（hy4free 24 万输入要 12–16K、26.5 万必超；step-5-preview 偶发 12K；deepseek 3K）；「最小可用预算」仍要重放矩阵，hy4free 单次 150–250 s，等 Human 同意再跑。
3. 语义：切换场景下「摘要目标用新模型」是否会降低 resume 质量？（抽查几份 checkpoint 与新模型的续跑效果）
4. 退路设计的边界：重试几次、在哪些环节（admission / 手动 `/compact` / 上下文超窗恢复）分别怎么处理？
5. 与 `wake-recycle` 的关系：换代（丢轨迹但立刻可用）和「退化为裁剪」（保留近况但丢远史）哪个应当是默认逃逸？
6. 测试怎么造：stub summarizer 返回 `max-tokens` finish，断言「成员下一轮不被锁 + 摘要目标切到新模型 + 退路有界」——这条能红的门是本次修复的验收核心。

## 横向量算计划（便宜、可当天做完）

- 扫全部成员会话的 `compaction/end` 错误分布 × `request/header` 的 model → 中标率。
- 对出现过错误的模型，各取 1–2 个真实会话用 `replay-compaction.py` 在 `max_tokens ∈ {16384, 32768, 65536}` 重放 → 得出「该模型需要多少预算」。
- 输出一张表进本目录，作为 O3 配置建议与「默认值该不该动」的依据。

## 实现接缝（11-06 核实，给实现方）

- **失败先于上路**：Team 在 `agent/request` 上 `{prepend:true}` 装 `prepareBudget`，`await next()` 拿到拟用请求后、**请求发出前**调用 `engine.compactIfNeeded(agent,'context-overflow')`；压缩用 `agent.session.requestHeader()`（最后成功的路由）测预算与摘要。Cole 的 `turn/end` 错误是裸的 `summarization truncated`（不是 Harness `Cannot switch to … MODEL_SWITCH_COMPACTION_FAILED` 的包装）⇒ Team 的门确实先于 Harness 的 model-switch 压缩触发（11-05 四次 turn error 均如此）。
- **Harness 的 model-switch 路径也救不了**：`compaction-basic/src/index.ts` 里 model-switch 的 `agent/request` prepend 虽然按新 header 定价，但 `protected summarize()` 取 `conversationTarget(agent)` = `session.requestHeader()`（旧路由），注释写明是为了复用前缀缓存。
- **唯一定制点（10:22 修正）**：`summarize()` 是 `BasicCompactionEngine` 文档声明的 sole subclass customization hook，Team 的 `MemberCompactionEngine` 已继承它。但**不能**靠「传一个带 `summarizationProvider/Model` 的 config」——`summarizeWithLlm` 没有从安装包导出（`lib/index.js` 只导出 `BasicCompactionEngine` + default），Team 调不到它。可行的形状：覆写 `summarize()` 时给 `super.summarize()` 传一个「路由视图」（`session.requestHeader()` 返回拟用路由，其余 `session.id`/`toolHistory()`/`options` 引用真实 session），让 Harness 自己的摘要实现发往拟用模型；指令文本、信封、checkpoint 框架仍归 Harness。风险：依赖默认摘要的读取面，需用测试钉住（信封除 provider/model 外逐项一致）。
- **已有配置面（无需新引擎代码）**：`summarizationProvider/Model`、`maxTokens`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`（按模型覆盖）；Team 预设现在只设了 `maxTokens: 16384`。
- **暂存来源（10-02 修正）**：在 `agent/request` 里暂存的拟用目标**赶不上 Harness 的 model-switch 压缩**——`prepend` 是 `unshift`（后注册先跑），无论引擎与 Team 谁在外层，Harness 那条要么在 `prepareBudget` 之前跑完、要么同样在暂存之前。要两入口同一函数，拟用路由得在两者之前拿到：首选 `agent/pre-step` 的 `modelSelection`（这一步的固定路由），admission 再用 `proposed` 校准；手动 `/compact` 不在 step 内，天然拿不到。待 Reeve 确认 `modelSelection` 是否可靠到「即将发出的路由」。
- **待定**：失败退路放在 `prepareBudget`（能保证「本轮仍可用」）还是 `summarize()`（更贴近机制）由设计方定。

## Reeve 对齐结论（11-06 09:55，方向已定）

- **O1 同意，但必须带能力门**：只有拟用模型的 `contextWindow` 能承接「本次摘要输入 + 实际解析的摘要 `maxTokens`」时才让它写；否则仍由旧路由先完成压缩再切换（保住「旧模型读得懂自己的历史」这层保护）。边界取保守：恰好相等判「不能承接」。默认预算后经 Human 要求调整为 32,768，按模型配置时取最终解析值。
- **目标来源**：`agent/request` 下游返回的 `proposed.provider/model`，不另读账本/composer/`agentTarget`；优先级 **显式摘要配置 > 拟用模型 > 已提交路由 > AgentOptions**。
- **共享选择函数**：Team admission 与 Harness model-switch 两个入口必须同一函数；拟用路由从 `agent/pre-step.modelSelection` 按 Agent 暂存（Reeve 10:05 确认：这一步及其重试的固定 provider/model，`agent/request` 只能改其他控制项，改路由会被 `prepareRequest` 直接拒绝），**按 step 管理**：`step/end`、pre-step reject/异常都要清理；重试与 `agent/request-error` 的 overflow recovery 仍读得到，手动 `/compact` 天然没有。admission 的 `proposed` 只做**一致性断言**，不一致在压缩前 fail loud。不写账本、不提前提交 request header。
- **有界**：替代目标最多重试一次，不做模型轮转；最终降级形态另行定。
- **resume 质量**：checkpoint 是模型中立的，新模型续跑质量要验收，但不是架构阻碍。
- **O2/O3**：只暴露手柄；11-06 10:34 Human 要求「摘要预算再提一提」后，Reeve 把默认从 16,384 提到 **32,768** 并入本票（实测 265,826 输入在 65,536 上限下实际 18,804，32K 已覆盖）。

## 验收门（我起草，待实现方接；256K 默认阈值下造）

测试 seam：`packages/agent-team/tests/member-compaction-flow.spec.ts` 的假 adapter 已把 `purpose === 'compaction'` 的 `GenerateOptions` 收进 `summaries[]`，可直接断言摘要真的发给了哪个 provider/model。

1. **无切换长会话**（committed = proposed = hy4free、26.5 万输入）：摘要两次都失败后，本轮请求仍然发出并完成、有可见失败记录——不再每轮锁死。
2. **切换场景**（committed = hy4free、proposed = deepseek）：摘要目标 = 拟用模型，切换落地。
3. **小窗口拟用模型**：摘要仍由旧路由写，切换被拒或保留旧路由。
4. **显式 `summarizationProvider/Model` 优先**，且失败后目标不泄漏（紧接着的手动 `/compact` 回默认目标）。
5. **替代目标最多重试一次**（`summaries.length` 有界）。每步理论最坏总数（Reeve 10:43 定）：`2 + 2×(1+1) + 2×1 = 8`（新增退路 2/region；admission 1 region；Harness switch `compactionRetries+1` region；overflow `maxOverflowRetries` region）。测试要断言精确次数，组合用例打到 8 或证明实际更低。
6. **两处来源一致 + fail loud**：admission 的 `proposed` 与 pre-step 暂存的路由一致；不一致时在压缩前就抛错（说明 Harness 的固定路由契约被破坏）。
7. **`agent/request` 改路由被拒**：构造一个试图改 provider/model 的 request，断言在摘要发生前报错——依赖的契约变化不能被静默吞掉。
8. **暂存生命周期**：`step/end`、pre-step reject/异常都清理；同一 step 的重试与 overflow recovery 仍读得到，手动 `/compact` 读不到。
