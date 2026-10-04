# 01 — 压缩动作（模型可调用的同 Session 压缩）

**What to build:** 模型在同一个 Agent Session 内多了一个自己调用的压缩动作。它把身后一段安全连续前缀换成摘要，然后继续干活。压了哪段、省了多少、或"没有可压区间"，都如实回报。跨 Session 的 handoff 仍归 `context_rollover`。工具契约与机制都在 continuity；本仓只负责挂工具与依赖。

**Blocked by:** None — can start immediately。本项是 03 的前置。

**Status:** ready

- [ ] **continuity**：`createContinuityTools` 加第四个工具（第一版不带参数），`ContinuityToolAdapter` 加对应成员。分工与 rollover / checkpoint 一致：描述、校验、渲染、失败语义都在引擎；机制也在引擎（见下一条，2026-10-03 定为 B 方案）。scope 里拿不到压缩能力时，如实回报"不可用"，不是失败。**可选性照 `createSearchTools` 那种**：引擎出货、宿主决定挂不挂；不挂的宿主 schema 逐字不变（今天 Team 就只挂了 rollover / checkpoint / timeline，没挂 search / read）。
- [ ] **continuity（机制，2026-10-03 定 B 方案）**：自己选区间 + 调 `ctx.compaction.compactRegion(start, end, agent, signal)`——`agent` 从 `exec.agent` 拿（可选字段，缺席即回报"本 scope 不可用"）。新增 DSH peer `@deepseek-ai/dsh-compaction`（devDependency 钉版本 + 进 `check:boundaries.mjs` 白名单；白名单本来就只收 `@deepseek-ai/dsh-*`，所以这不破"引擎对宿主保持中立"的规则）。**不得**走 `compactNow`：它要求 true idle（turn 内抛），且保留尾是 0，等于全压。
- [ ] 区间选择只写一处（约 25 行）：跳过 `system/message` 头节点；从尾往前走够保留量；退到 `toolPairingBalancedBefore` 成立的边界；`end` 过 `toolPairingBalancedAfter`；上界卡在**最新那条 `user/message` 之前**。两个配平助手由契约包导出，不要自己实现配对规则。**也不要去 import 引擎 backend 的区间选择器**：开发树里那个包是指向邻近 checkout 的软链，`src/` 在、本地跑得通；发布形态只带 `lib/index.js`，用户装不到。没有任何可压区间就返回"无"。
- [ ] 边界契约（spec §6.1 选项 B）：区间不含压缩指令这条，也不含它之后的任何消息。上界取"最新 `user/message` 之前"即自动成立；加测试：保留尾取 0 与调小两种情况都不越界。
- [ ] 如实回报：压了哪段、省了多少，或"没有可压区间"（无副作用）。引擎的结果只给被压内容的价格（`shadowedTokenCount`）与被替换的节点表；要报"压缩前后总量"，机制这半边得自己用 `ctx.tokenMeter` 在调用前后各测一次。无可压区间、边界不合法、摘要或事务失败、取消时，一律保留原 surface，不静默、不谎报成功。整面稳定性由引擎兜底：摘要期间 surface 一变（并发 steer 落地也算）就判 changed，照实报失败。
- [ ] 工具描述说清使用时机：刚闭合一段工作、且用量较高时值得调用。不鼓动回退。
- [ ] 发现面接线：宿主到 handoff 预算时推的那条 notice，今天只点名换代（文本旋钮 `rolloverToolName`）。压缩可用时要一并点名压缩动作（同形的旋钮）。模型不会自己想起来用——压力时刻这条 notice 是最不依赖模型自觉的引导点。
- [ ] 验证 crash、replay、cold fold、live fold 收敛；证明未启用该工具时既有行为逐字不变。
- [ ] 联调前提：本仓吃的是 pnpm store 里的 continuity 0.1.6，先用 workspace link 或 `file:` 指向 dsh-plugins checkout；落地走 `pnpm changeset` → 发版 → 本仓升依赖。
