# 05 — 唤醒换代：唯一换代入口（raft 式判定，notifyMember 处判 + 阈值配置接口预留）

**What to build:** 消息到达 idle Member 时（`notifyMember`）及 Member 激活时（`activateMember`，覆盖重启/挂起恢复），Host 判「`now − lastActivity ≥ 60min` 且实测 context ≥ 128K」→ 不 resume/投递旧代，由 01 的协调器先换代，唤起消息经激活末尾的 Inbox 重导出（`index.ts:3292`）投进新代。新代无 handoff 简报、无换代公告：第一眼 = member-context 每步自动注入的身份 + memory.md + workspace 列表 + 唤起消息。判定移植 raft `decideWakeRecycle` 形状（纯函数，任何不确定 = resume）：disabled → 无上一代 → 事实读不到 → idle 不足 → context 不足，任一不过即 resume/直接投递。事实来源：lastActivity 从 ledger/session 事件推导（Member 无现成字段，需新增推导）；context 大小对 live agent 用 meter 实测（`index.ts:2409-2411`），激活前冷读日志 + `Session.create` + measure（`2812-2821`，成本 = 每次 resume 全量 replay，需测试锁定为只在 idle 门槛过后才执行）。两阈值做成 Host 行配置（volatile 可写，默认 60min/128K），schema 预留；**设置页 UI 不做**（后续独立票）。「验收后 compactNow」不做（raft 无此物，无数据背书）。
**Blocked by:** 01（换代机制 + durable op）、04（handoff 通道已删，新代输入形状才成立）
**Status:** complete

**Outcome (2026-10-21):** 已落地。判定是 `wake-recycle.ts` 的纯 gate 阶梯（disabled / 无上一代 / 事实读不到 / 缓存可能未冷 / context 未过水位都答 resume）。与票面差异：唤起消息不再靠“激活末尾 Inbox 重导出”保证送达；提交在 `agent.runMaintenance` 内执行，ledger 记录 `inputFromSeq`，退役后从旧日志重放输入并按 Message id 去重。冷路径先检查持久化 Inbox，有普通输入就保留旧代。

- [x] 唤醒判定纯函数 + 测试：每个 resume 分支一个用例（含事实读不到 → resume 的保守方向），recycle 分支断言携带阈值与事实
- [x] `notifyMember` 判定点：消息到达活着的 idle agent 时判阈值，命中先换代（协调器 idle 边界 swap）再让 Inbox 重导出投递；换代中 DM 投递失败窗口需 notifyMember 兼底（`index.ts:2279-2282` 的 `AgentTeamDmDeliveryError` 不裸抛）
- [x] `activateMember` 判定点：重启/挂起恢复走同一纯函数；命中则不走 resume 路径，直接起新代
- [x] 事实来源实现：Member 的 lastActivity 推导（ledger/session 事件）；context 实测（live: meter；冷: Session.create + measure）；`tokenMeter` 需在 Host `static inject` 中声明（`index.ts:495-505`）
- [x] 新代输入形状测试：首条 steer 不含任何「新一代/已换代/handoff」仪式文本；环境块来自现有 member-context 注入（不新建通道）
- [x] Host 行配置 `wakeRecycle` 组：`idleMs`（默认 3_600_000）/ `minContextTokens`（默认 128_000），`.volatile()` 可写，schema 预留，设置页 UI 不做
- [x] 端到端测试：造「idle 61min + 130K」消息到达 → 断言换代发生 + 唤起消息在新代首步可见；「idle 59min」→ 断言原样投递不换代
- [x] `npm run test:browser` 绿（无 UI 面变化，跑回归）
