# 模型实际读到的文本（第四版草案）

**这份文件是什么**：模型运行时真的会看到的字符串草案——工具描述、工具输出、宿主推的两条消息。给人过目与迭代用；实现时以代码为准。

**三条原则**

1. 只在模型要做决定的地方给它字。它不需要知道机制。
2. 每条都要写清"什么时候值得用"，不能只写"这是什么"。
3. 失败与"不可用"必须能读出来，不能含糊成成功。

---

## 1. `context_compact`（新工具，第一版无参数）

引擎默认描述（continuity 出货）：

> context_compact: shorten this context generation in place. One stretch of older history behind you is replaced by a summary; your most recent work stays verbatim. The log is append-only — the summary replaces what you see, not what was recorded. Call it right after you close a piece of work and usage is high; a context_status result shows how much is compactible and how much the recent tail keeps. It never switches generation and never returns to an anchor: use context_rollover for those. The result names the stretch that was replaced and what it cost, or says there was nothing safe to compact; a failure always leaves this context unchanged and says so.

中文意思（给人看，不进模型）：

- 就地缩短**同一代**。
- 身后一段 → 摘要；最近一段 → 原样保留。
- 日志只追加：换掉的是"你看到的"，不是"记录下来的"。
- 用完一段工作、用量高时调；数字在 `context_status` 里。
- 不换代、不回退——那是 `context_rollover`。
- 结果写清换了哪段、代价多少，或"没有安全可压的区间"；失败一定原样保留并明说。

结果渲染（成功）：

> Compacted: replaced {n} earlier messages (about {k} tokens) with a summary. Recent work kept verbatim; this context is now about {usage} tokens.

结果渲染（没有可压区间 / 失败）：

> Nothing safe to compact: {reason}. This context is unchanged.

---

## 2. `context_status`（今天叫 `context_timeline`）

今天描述的结尾是一句门：

> Use this tool when you specifically intend a checkpointRef return: to pick the smallest sufficient ref, or to confirm that a fresh handoff is the better path when every anchor is non-restorable.

这句把"看状态"绑死在"我已经决定要回退"上。改成：

> context_status: read where this context stands before you decide what to do with it — tokens used against the handoff budget and the hard limit, the composition of the work set, how much is compactible now and how much the recent tail keeps verbatim, and the anchors in this lineage with which ones are restorable. Call it at a boundary, after a long gap, or when you are unsure where you stand. An anchor is a selectable default exactly when it resolved at a completed turn and is attributable to exactly one {topic}; a non-selectable anchor states its reason. Structural only: no transcript content. A fresh context_rollover (no checkpointRef) never requires reading this status first — call it directly; cite a checkpointRef only when this status listed that exact ref as restorable.

---

## 3. `context_status` 的输出

模板（字段来源标在括号里）：

```
Context: {usage} / {handoffAt} handoff / {hardLimit} hard limit        (measured)
Composition (heuristic): system ~{a}K · tools ~{b}K · messages ~{c}K   (heuristic estimate)
Anchors: {n} rows · {m} restorable
  - "{label}" [{kind}] retained ~{r}K, drops ~{d}K — restorable, ref: {ref}
  - "{label}" [{kind}] — not restorable — {reason}
Compact now: about {x}K compactible; keeps the last ~{y}K verbatim      (computed: usage − retain tail)
```

样例：

```
Context: 149,763 / 200,000 handoff / 256,000 hard limit
Composition (heuristic): system ~8K · tools ~11K · messages ~131K
Anchors: 8 rows · 5 restorable
  - "task #45 spec v4" [checkpoint] retained ~140K, drops ~9K — restorable, ref: ck_7f3a91
  - "Team message" [boundary] retained ~105K, drops ~44K — restorable, ref: bd_2c81e0
  - "context handoff" [handoff] — not restorable — a fresh generation, not a return target
Compact now: about 118K compactible; keeps the last ~32K verbatim
```

三点：

1. `Composition` 是三类（system / tools / messages），不按 Thread；按 Thread 的数字只在锚点行里。
2. `Compact now` 是算出来的（用量 − 保留尾），不是存储字段。
3. 锚点行保留今天的 `retained` / `discarded` / `restorable` / 理由。

---

## 4. 128K 压力 notice（今天 → 之后）

今天的原文（`contextPressureNoticeText`，第三句是全部引导）：

> Context pressure: {usage} tokens measured; the handoff budget is {handoffAt} and the hard limit is {hardLimit}. Work in hand: {…}. Background jobs: {…}. Finish the current atomic action, then call context_rollover with a handoff covering your objective, the action in flight, and external side effects and their verification state — write only what a fresh generation could not reconstruct on its own, and a fresh context is the default path. Record anything durable in your private memory/notes first.

之后（压缩可用时点名两个动作）：

> … Finish the current atomic action. Then either shorten this generation in place — call context_compact, your recent work stays verbatim and you keep working here — or call context_rollover with a handoff when the work has genuinely moved to a new page. context_status shows how much is compactible and which anchors are restorable. Record anything durable in your private memory/notes first.

**待定一条**：到 handoff 预算时，默认动作是"换代"（今天的文本、spec §3.4 也这么写），还是"先压缩、不够再换代"？只动这句话，不动机制。

---

## 5. 门控指令（jev 判"无关"时投给模型的那条）

> Held request: the request just received looks unrelated to the work in this context, and this context is large ({usage} tokens). Before it is delivered: call context_compact to shorten this generation in place — the stretch before this instruction becomes a summary, your recent work stays verbatim. The held request is delivered right after, and you continue with it. If nothing safe can be compacted, say so; the request is delivered either way.

要点：这条由 `followup` 投递，会成为工作集里最新的 user_input；压缩区间只覆盖它之前的内容（这是契约，见 spec §6.1）。

---

## 6. 预期模型层影响

| 时机 | 今天 | 之后 |
| --- | --- | --- |
| 刚闭合一段工作、用量高 | 没有动作，继续堆 | 看状态；必要时就地压缩，同代继续 |
| 到 128K | 只有换代 | 换代（默认不变），notice 里多了压缩这个选项（默认待定） |
| 隔久回来、话题无关 | 拖着旧上下文答 | 先压再答；jev 判不出就不压 |
| 走错一条长分支 | 回退能力在，描述把它挡住 | 状态面列出可回退锚点与代价 |

**怎么知道真的发生了**（可测，不是承诺）：

1. 真实会话跑过 128K，数它有没有在没人提醒时调 `context_compact` / `context_status`。
2. 门控那次：看它是否在收到指令的同一 turn 内调用压缩。
3. 失败路径：造一次"没有可压区间"，看它如实回报而不是假装成功。
