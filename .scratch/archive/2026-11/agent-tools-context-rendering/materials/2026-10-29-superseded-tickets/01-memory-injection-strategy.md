# 01 — memory 索引的注入策略（默认 (b)：只会在话开始/压缩后整份注入）

**What to build:** 成员上下文里的 memory 索引不再每步整份重发。会话开始与压缩后整份注入一次；会话中途 memory.md 变化时只注入一行（索引已更新的提示 + 用量百分比 + 「以文件为准」），成员凭常驻路径用文件工具读回。验收时可度量：memory 变化触发的 member-context 累计字符下降 ≥ 80%，且旧副本不再每 step 累积。

**Blocked by:** None — can start immediately

**Status:** ready

- [ ] 去重判据从「最近一条 member-context 消息等于这次拼出的完整块」改为**两类摘要**（每会话保存 lastContextDigest / lastMemoryDigest，或两种消息都携带这两类摘要）。**不改这条，(b) 会比现状更糟**：中途只发一行后，下一次完整块永远不等于最近一条消息，于是每个 step 重发整块（无论那一行是不是同一个 producer）。
- [ ] 注入判断按 fail-closed 顺序（Vera 2026-10-29 定，次序不能反）：
  1. surface 上没有本 producer 的消息（会话开始 / 压缩后）→ 整块；
  2. 先比**非 memory 段摘要**（identity + ownership + workspaces）：不同 → 整块；
  3. 再比 **memory 摘要**：不同 → 一行；
  4. 两者都相同 → 跳过。
  先比 memory 再比非 memory 是错的：最新一条是一行时它只带 memory 摘要，此时 ownership 变了会被误判为「无变化」，旧列表继续留在 context。
- [ ] 两个边界不允许降级成一行，必须走整块（或显式警告）：memory.md 被删除/不可读；memory 超过 16KiB 预算（整块形式的警告「contents were not injected」不能被一行吞掉）。
- [ ] 单测：同一会话连续多步，只有一次一行提示；全块只在会话开始与压缩后出现；索引确实变化时一行提示出现；索引未变时没有任何注入；ownership 撤销仍替换旧列表（现有行为不回归）。
- [ ] 集成测试的 fake surface 必须累积消息（现在从不累积，等于这条守卫没有回归网）；补跨 step 断言：**先发一行再改 ownership/workspaces → 整块；先发一行再删 memory.md → 不可用提示；先发一行再把 memory 推过 16KiB → 预算警告**。
- [ ] 删掉块内与 persona 逐字重复的教学文本（memory 段与 workspaces 段，约 1.5K）。
- [ ] 若保留标记句，写明「上方索引已过期，以文件为准」；块首「complete replacement」的表述随之改成真话。
- [ ] 度量脚本改造：`harness/member-context-resend.mjs` 与 `harness/member-context-triggers.mjs` 按 session 目录口径、按段归并、按 surface 折叠计数（拆成多条消息后注入次数与触发原因都归不了类）。
- [ ] 门槛：memory 触发重发的累计字符下降 ≥ 80%（harness 复跑对比 `materials/2026-10-28-baseline-and-proposal.md` §1 基线）。
- [ ] (a) 只重发 memory 段保留为兜底路径，有测试覆盖其触发条件；默认不走。
- [ ] 旧副本问题记录在案：`PreStepDecision` 只接受 `UserMessage[]`，插件钩子申请不到 `surfaceOp: replace`；本票只用 (b) 把块变小（副本累积随之缩小约 75%），是否记为 Harness 扩展点不足另行判断。
