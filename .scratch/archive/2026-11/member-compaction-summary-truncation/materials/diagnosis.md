# 诊断：成员压缩摘要被 reasoning 吃满 ⇒ 成员被锁死

本文件只记录**已核实**的事实和明确的推断分界。读代码位置时注意：行号会漂，认名字不认行。

## 1. 症状

成员会话 UI 连续出现：

```
本轮运行失败 · summarization truncated at the token cap (incomplete checkpoint)
Compact: Compaction could not produce a useful summary. The attempt is recorded in the session log.
```

- 每一轮**在发出请求之前**就失败（不是模型回答错，是压缩先失败）。
- 「换模型」无效：composer 切成 Deepseek-V4.1-Flash 之后仍连续失败 6 次。
- 该成员在 Team 列表里呈现 `error` 状态。

## 2. 时间线（Cole 会话，2026-11-05）

| 时刻 | 事件 |
| --- | --- |
| 19:48:29 | 会话模型 `workbuddy/hy4free`（reasoning high），`request/header.maxTokens = 64000` |
| 21:36:01 | turn 2 内自动压缩触发（step 36 之前的 admission） |
| 21:41:21 | 压缩失败（320 s）；turn 2 以 error 结束 |
| 21:41–22:18 | 手动 `/compact` 与后续 turn 3/4 又失败 4 次（232–338 s） |
| 21:53:30 | Human 在 composer 切到 `auto/deepseek-v4.1-flash`（high） |
| 21:57–22:28 | 之后 6 次压缩**仍全部失败**，header 一次没变（死锁） |
| 23:04:56 | Human 抬高阈值后，header 终于变成 `magpie/auto/deepseek-v4.1-flash`（maxTokens 384000） |
| 23:13:28–23:13:59 | 自动压缩**成功**（31 s、`maxTokens 16384`、摘要输出 2692 token、覆盖 285,505 token） |
| 23:11–23:24 | turn 7/8/9/10 全部 `completed` |

## 3. 根因链

1. **触发**：成员每次请求前都会算预算；下一次请求的输入将越过 `memberCompaction.tokens`（默认 256,000）时，先做一次压缩。代码：`packages/agent-team/src/member-compaction.ts`（`prepareBudget` → `engine.compactIfNeeded(agent, 'context-overflow', signal)`；阈值函数 `memberCompactionThreshold`）。`'context-overflow'` 这一支**不使用保留尾部**（`selectCompactableRange(..., 0)`），所以摘要要覆盖几乎全部历史。
2. **压缩引擎**：`packages/agent-team/src/member-compaction-engine.ts` 继承 Harness 的 `BasicCompactionEngine`；成员预设里 `compaction-basic` 的 `config.maxTokens: 16384`（仓库根 `cordis.patch.yml` 的 `team-member` 预设）。代码里另有同名常量 `MEMBER_SUMMARY_TOKENS = 16_384`。
3. **摘要目标**：`summarize()` 用 `conversationTarget(agent)`；它优先取 `session.requestHeader()`，也就是**最后一次成功请求**的路由（Harness `compaction-basic/src/region.ts` 的 `buildSummarizationInput` + `summarizer.ts` 的 `summarizeWithLlm`：`target = configured ?? latest ?? agentTarget`）。**这就是死锁的源头**：header 只在请求成功后才更新，而请求要成功先要压缩成功。
4. **摘要预算**：`GenerateOptions.maxTokens = config.maxTokens`（16384）。对思考型模型，**reasoning token 与正文共享这个上限**（网关 `usage.completion_tokens_details.reasoning_tokens` 实证）。
5. **失败判定**：provider 回 `finish_reason=length` → Harness 映射成 `max-tokens` finish → `finishError()` 抛 `summarization truncated at the token cap (incomplete checkpoint)`（Harness `compaction-basic/src/summarizer.ts`）。这是**失败闭合**（fail-closed），所以没有「写了一半也能用」的降级。
6. **成员被锁**：异常从 `prepareBudget` 冒泡到本轮 → turn error；下一轮重复。

## 4. 最小对照（同一网关、同一输入、同一上限）

输入 = 从 Cole 会话日志转出的 265,826 token / 151 条消息，末尾追加 Harness 的 `COMPACTION_INSTRUCTION`，`max_tokens = 16384`：

| 模型 | `finish_reason` | completion | 其中 reasoning | 正文 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| `workbuddy/hy4free` | **length** | 16,384 | **16,384** | **0 字符** | 155 s |
| `auto/deepseek-v4.1-flash` | stop | 5,709 | 2,585 | 10,074 字符 | 63 s |

补充读数（同一套脚本，用来理解规模与上限的关系）：

| 输入 | 模型 | 上限 | 结果 |
| --- | --- | --- | --- |
| 19,357 | deepseek-v4.1-flash | 65,536 | stop，输出 2,088 |
| 115,016 | deepseek-v4.1-flash | 65,536 | stop，输出 2,472 |
| 266,065 | deepseek-v4.1-flash | 65,536 | stop，输出 3,914 |
| 511,920（重复内容凑量，指示性） | deepseek-v4.1-flash | 16,384 | stop，输出 5,756 |
| 19,357 | **hy4free** | 65,536 | stop，输出 **32,354**（reasoning 24,666）|

⇒ 结论：**问题不是「上限太小」，而是「上限与模型行为不匹配」**。同一个 16K 上限对 deepseek 系完全够用（2.5k–5.8k），对 hy4free 连小输入都要 32k。

## 5. 历史与先例

- 既有成员压缩历史：`.scratch/archive/2026-08/member-compaction-diagnosis/`（**不同故障**：HMR 之后 preset 孤儿 ⇒ `compaction is unavailable`；根因在 standing mount 生命周期，与本次无关，但同属「成员压缩失败把成员锁住」这一类）。
- 上游做过又撤回的相近修复：`cf7229e72a`「retry oversized summaries with smaller prefixes」（针对 **CONTEXT_WINDOW_EXCEEDED**，即上下文超窗，不是 `MAX_TOKENS` 截断），随后被 `3081c71bab` revert（PR #7105）。**本现象不在那个修复覆盖范围内**——重试更小的前缀不能解决「模型把预算全用在思考上」。

## 6. 已核 vs 推断（别混）

**我核过的（可复跑）**：错误串与失败闭合路径；成员预设上限 16,384；阈值 256,000 与触发点；Cole 全程 9 次尝试的时间与错误；最小对照两组读数；恢复后那次成功压缩的 `compaction/summary`（provider/model/maxTokens/usage/shadowedTokenCount）；账本里 Cole 的模型记录仍是 `workbuddy/hy4free`。

**推断（有代码依据、未单点验证）**：死锁的具体机制（摘要取 `requestHeader()` 而非「下一次请求将用的模型」）；手动 `/compact` 也走同一目标解析；上游 revert 的动机。

**未测**：其他成员/其他模型的中标率；512K 阈值下真实会话的摘要是否仍能落在 16K 内；thinking 预算对 hy4free 是否随输入线性增长。

## 7. 影响面

- **谁会中**：任何「reasoning 重且啰嗦」的模型 + 语音摘要用量大（长会话）的成员。当日 Ferry 的会话也中过一次同型错误。
- **触发条件**（经验）：会话输入接近 256K（默认阈值）× 模型把大部分输出预算花在 reasoning × 摘要是 fail-closed。
- **后果**：该成员**完全不可用**（每一轮都在请求前失败），且**换模型切不出去**（死锁）；现有自动逃逸只有 `wake-recycle`（空闲 > 60 min 且上下文 > 128K 时唤醒换代，代价是丢工作轨迹）。
