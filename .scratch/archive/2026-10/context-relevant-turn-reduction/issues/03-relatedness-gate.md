# 03 — 长间隔相关性门控

**What to build:** 用量 ≥ 128K，且本次 turn 距上一 turn ≥ 30min 时，宿主问 jev 一次："本次输入与最近几轮 user_input 有关吗？"无关就扣住本次输入、投一条**换代**指令（模型写 handoff 并调 `context_rollover`），扣住的输入随新代交回。策略本身进 continuity 的通用压力策略，所有宿主一起继承。

**Blocked by:** 无——**2026-10-04 human 把 remedy 从"压缩"改成"换代"，本条不再依赖 01**（换代不需要压缩引擎）。

**Status:** in-progress（continuity 一半已交付 dsh-plugins `10de0d5` + remedy 变更；本仓一半未做）

- [x] **continuity**：在 `ContextPressurePolicy` 的 pre-step 决策里加第三条路（现状是"低于 handoff 预算什么都不做 / 到预算 steer notice / 到硬上限强制压缩"）。新增第四种决策 `hold`。
- [x] **continuity 的 jev 依赖（2026-10-03 human 定，覆盖"宿主注入能力"的旧写法）**：直接依赖 **npm 版** `@wowyuarm/dsh-jev`（0.1.1 已发布，导出 Cordis 服务 `Jev`，用 `decide()` 提问），不引 workspace 源码。形状照 DSH peer 那套：可选 peer（`peerDependenciesMeta.optional`，没装时宿主照常跑）+ devDependency 钉已发布版本 + 本包 `scripts/check-boundaries.mjs` 的 `ALLOWED_PACKAGES` 加一条（注释说明这是唯一一条跨包例外）。落地时根 `AGENTS.md` 那句 "the packages do not depend on each other" 要补显式例外句。**（已补：根 `AGENTS.md` 的例外段、包级 `AGENTS.md` 的同类说明、`check-boundaries.mjs` 里 `ALLOWED_PACKAGES` 的带理由条目，都在 `10de0d5` 落地。）**
- [x] **两个阈值由 continuity 导出、宿方可覆盖**（`DEFAULT_GATE_TOKENS` / `DEFAULT_GATE_IDLE_MS`，构造器第三个参数可覆盖）。**Team 侧不迁（2026-10-04 human 更正：两处数字语义不同）**——`ACCEPT_TASK_BOUNDARY_THRESHOLD` 是"accept 一个 Task 是天然翻页点"的业务边界，`CLOCK_REFRESH_INTERVAL_MS` 是一个 turn 内时钟快照的最小间隔（`member-time-context.ts:52,145`），删它等于去掉一个在跑的行为。判据 = 引擎的触发条件归 continuity，宿主域的业务边界归宿主。
- [ ] **本仓**：删掉自己那份 `pressure-policy.ts`（与 continuity 通用策略同形的重复实现），改为实现 `PressurePolicyHost`。
- [ ] **本仓**：装配时把 `ctx.jev` 交给策略；没装 jev 就不启用门控，不是失败。
- [x] 无关 → 扣住本次输入 + reject 这一步 + 投一条换代指令（复用 continuity 的扣件：`needsAdmissionGate` / `captureQueuedInput` / `captureClaimedInput` / `drainCapturedInput`）。**2026-10-04 起 remedy 是换代，不是压缩**；同代内的"挂起"状态已新增。
- [x] 换代落地 → 扣住的输入走 `TransitionPlan.carriedInput` 进新代。
- [x] 兜底：模型收到指令但没换代 → turn 结束立即投回扣住的输入，并如实告知。不能卡住。**（兜底由 coordinator 自己拥有：挂起在**被扣的那个 turn** 结束时丢掉，投回等 driver 收敛（所以指令那个 turn 先独占跑完），并在投递那一刻再查一次有没有换代落地。宿主不需要任何释放调用，`releaseHeldInput` 因此从公开面撤掉。）**
- [x] jev 判不出、超时、报错 → 不换代，正常继续，显式记一条。不装成安静。
- [x] 收紧超时与重试：pre-step 在 turn 启动关键路径上，jev 默认 30 秒 × 3 次会拖住起动。**（`judgeTimeoutMs` 默认 5s，传 signal 并且 race。）**
- [x] 实测：样本里必须有"继续"、"那个呢？"这类回指。**2026-10-04 用真 key 做了**：20 次真实调用 + 已交付策略的端到端 8 场景，证据在 [materials/jev-gate-probe.md](../materials/jev-gate-probe.md)。要点：明确回指 ≥0.93（稳定），新工作 ≤0.04；**「那个呢？」稳定落在 0.52–0.55 的带内 ⇒ 不换代**，即票面点名的这个形状拿不到 remedy（方向保守、不会误扣）；真机延迟 p100 = 579ms，5s deadline 有约 9× 余量。

**已交付形状以 continuity 的 `.changeset/context-long-gap-gate.md` 与 `docs/integration.md` seam 9 为准**（ticket 只记边界，不重抄）。
