# 02 — 状态面（`context_timeline` → `context_status`）

**What to build:** 模型有一个"我在哪、我能做什么、代价多少"的入口。它在边界处、长间隔回来后、不确定自己站在哪里时被调用。回退的发现入口从"先有意图再看"变成"先看有没有值得回的点"。

**Blocked by:** None — can start immediately。与 01 独立。

**Status:** ready

- [ ] **continuity**：同一个工具改名换描述（不新开工具）。描述由引擎自己拼（`timelineDescription`），去掉今天那句门——"Use this tool when you specifically intend a checkpointRef return"——改成"在边界处、长间隔回来后、或不确定自己站在哪里时调用"。**这句在引擎文本里也有，Team 那份是手抄副本**，所以改一处即可。
- [ ] **continuity**：`ContextTimeline` 契约加两项：组成（system / tools / messages）与"现在能压多少"（用量 − 保留尾，算出来的数，不是存储字段）。标注启发式估算。**不要写成"工具输出"**：`toolsTokens` 是工具 schema，不是工具结果。
- [ ] **本仓**：`context_timeline` 的 render 覆盖（非可回退行不打印 ref，免得被抄进 `checkpointRef`）跟着同源改，别让副本漂开。
- [ ] **本仓**：放宽回退门槛——跨 Thread 的边界不再直接判不可回退，改成把代价写进行里（"会同时丢掉 Thread X / Y 的事实——它们可以重读"）。"保留量不小于 handoff 预算"这条不变。
- [ ] 锚点行保留今天的 `retained` / `discarded` / `restorable` / 理由。那几行就是回退决策面。
- [ ] 验证：真实 Member 会话里各字段都能算出来；未启用时不改变既有输出。
