# SCOPE：工具结果、通知与 Agent context

> **历史范围记录（2026-10-29）：已由 [spec.md](spec.md) 替代。** 下文保留起因、初步倾向与当时问题，不再用于推断待决策事项或实施顺序；当前入口为 [README](README.md)。

## 起因

Attention 改造需要在多种结果中解释 follow/unfollow：

- owner、accountable、Claim executor、Thread 作者自动建立 Attention；
- 显式 follow / unfollow；
- active Claim 导致的 unfollow 拒绝；
- Thread / Main stream 读取与通知中的当前状态；
- @ / reply 是一次直接通知，不等于持续关注。

这些说明如果分别手写，会与现有工具结果、recovery hint、Host notification 和 persona 一样继续分散。Human 因此要求另开工作项，统一并审视整个 Agent-facing 工具与 context 呈现，而不只处理 Attention 文案。

## 目标

让 Agent 在合适的时刻获得足够且不过量的信息：

1. 刚刚发生了什么。
2. 当前与下一步有关的状态是什么。
3. 为什么出现这个状态（仅当事实可确定）。
4. 下一步可以做什么，或被什么阻塞。
5. 哪里可以读取完整事实，而不是在通知里复制完整事实。

统一的是**事实来源、语义和预算原则**，不是强迫所有出口显示相同文本。

## 初步目标结构

```text
ledger / runtime projection / operation result
  → 面向 Agent 的结构化状态与变化事实
  → 各出口的 renderer
     tool result：本次变化与必要状态
     error：拒绝原因与可执行恢复
     notification：唤醒原因与读取入口
     dynamic context：当前身份、参与和必要状态
     persona / core skill：稳定规则与按需参考
```

结构化数据仍是 Host、Client、测试与恢复逻辑的权威。自然语言不成为第二份状态来源，Client 不解析提示文本来恢复事实。

## 范围

### 工具设计与结果

审视七个 Team tools 的：

- action 划分、参数 schema、默认值与 Workspace 推断；
- structured result 与 render 是否一致；
- 成功、无提交、typed rejection、抛错的结果差异；
- 当前状态、已读/未读、Task/Claim、refs、revision 和恢复指引；
- 相同概念是否在不同工具中使用不同名称或给出矛盾建议；
- 输出是否有界，省略后是否仍指出完整事实的读取入口。

本工作项可以提出工具契约修正，但不能把「统一文案」当成拒绝修正糟糕工具设计的理由。

### Agent 通知与错误

审视：

- Host 从 durable unread 派生的 direct / activity / ordinary / Main / reminder 通知；
- DM relay、Workspace participation、恢复和上下文换代相关通知；
- recovery-hints 与 tool-level rejection 的重复、冲突和缺失；
- 同一事实在通知、工具结果和后续读取中是否被无意义重复。

### Prompt 与动态 context

审视：

- persona prefix 与 core skills 的稳定规则；
- Member identity、Project ownership、Workspace participation、private memory 和 time context；
- 通知与工具结果是否重复 persona 已常驻说明的规则；
- 动态状态是否被误写进稳定 prompt，或稳定教学是否在每次结果里重复；
- context 注入的更新、替换、持久化与重放是否仍由原有 authority 决定。

## 非目标

- 不建立要求所有工具共用一个巨型函数或统一字符串的抽象。
- 不让每次工具调用附带整套领域教学。
- 不把 notification 变成完整 Thread/Task 内容副本。
- 不用自然语言代替 structured fields，也不让渲染层产生 ledger authority。
- 不改变 Human Web Client 的视觉呈现，除非后续另有明确需求。
- 不一次重写所有工具；先盘点，再用窄的端到端用例验证机制。
- 不重复 `team-tools-model-eval` 的评测建设，也不改变 `attention-delivery-model` 已确认的领域决策。

## 初步设计原则

1. **事实共享，文本分型**：同一语义可复用，不同出口按用途和预算渲染。
2. **操作结果说变化，读取结果说状态**：原因只来自本次操作或可靠事实，不猜历史动机。
3. **稳定规则常驻，动态状态按需**：persona/core skill 与动态 context 分工明确。
4. **错误给恢复，不只给拒绝**：建议必须与当前状态和实际可执行动作一致。
5. **通知给入口，正文按需读**：维持有界、合并、可重派生的通知边界。
6. **重要信息优先于重复信息**：同一 turn / result 中避免 persona、notice、result 多次说同一件事。
7. **一次迁移到位**：机制确认后删除被替代的旧渲染和重复提示，不长期保留双路径。

## 只读审查清单

- [ ] 七个工具逐一对照 schema → execute → structured result → render → tests → maintained docs。
- [ ] 标出共享 helper、各工具私有 renderer 和 Host 私有 renderer 的真实边界。
- [ ] 对照 `recovery-hints`、工具拒绝和通知文本，找出同一状态的不同说法。
- [ ] 对照 persona、`team-domain-model`、member/time context，标出常驻与动态的重复。
- [ ] 统计典型结果的行数/字符量和正文预算，找出高价值状态被教学文本淹没的情况。
- [ ] 从模型评测材料提取可复现的证据，区分模型误用、schema 问题和结果指导不足。
- [ ] 选定 Attention 的最小端到端用例，再决定第二个用例；不预设所有状态都需要统一。

## 待与 Human 拍板的问题

### Q1. 统一的落点

是在 tool/Host 之上共享一个 Agent-facing 语义视图，还是只收敛文案 helper？初步倾向前者：共享事实与语义，保留每个出口的 renderer；具体模块归属需先完成包依赖调查。

### Q2. 信息预算

哪些信息允许默认出现在每种出口，单条结果/通知的预算与去重范围是什么？初步倾向用「本次变化 + 当前阻塞 + 一个下一步」限制工具结果，稳定教学移出重复路径。

### Q3. 工具契约调整范围

本轮是否允许同时修正盘点中确认的 schema、action 和 structured result 问题？初步倾向允许有证据的窄修正，但与呈现迁移分票，避免无法判断模型改善来自哪里。

### Q4. 验证方式

除了 snapshot/contract tests，怎样用真实 Agent 或现有模型评测验证「指导更有用且没有显著增加无效 context」？初步倾向复用 `team-tools-model-eval` 的 harness，比较恢复轮数、错误调用与输出量，不以单轮主观文案为准。

## 首个用例的最低表达要求

Attention 用例至少覆盖：

- 自动 follow 的对象、已知原因和普通更新后果；
- 显式 follow 后从何时开始接收、历史如何读取；
- unfollow 后普通更新停止、direct/责任信号保留、可以重新 follow；
- active Claim 时为何拒绝以及怎样解除限制；
- 未 follow 的读取结果怎样提示重新订阅；
- @ / reply 不会自动建立持续关注。

通用机制若不能简洁表达这些场景，就不能算完成。
