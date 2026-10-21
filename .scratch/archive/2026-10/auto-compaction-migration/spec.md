# 断 cc 回归 raft 式 context 管理 — 定稿规格 v2（#117）

2026-10-20 · human 拍板三轮：12:11「走 A，不依赖 cc，重新实现，不保守」；17:29「甚至不需要 context_rollover，推翻重来也没问题，参照 raft」；17:39「阈值 256K，UI 不做但预留接口」；18:12「唤醒判定选 A：notifyMember 处判定，其余 agent 自决」。v1 调研存档见文末。

## 最终形态

Team 成员的 context 生命周期只有三个机制，没有第四个：

```
├── 引擎自动压缩（session 内部原地瘦身，唯一 mid-turn 兜底）
│    auto: true，thresholdRatio 对齐 256K（分路由 modelPolicies），
│    retainRatio ~0.08，摘要 = cc 7 节模板（移植进本仓子类）
│
└── 唤醒换代（唯一换代入口，Host 持有，模型无决策权）
     消息到达 idle Member 时（notifyMember 判定，含激活路径）：
     idle ≥ 60min 且 context ≥ 128K → 先换代再投递唤起消息。
     事实读不到一律 resume（raft 的保守方向）。
     新代第一眼 = 每步自动注入的身份 + memory.md + workspace 列表
     + 唤起它的那条消息（由激活末尾的 Inbox 重导出投递）。
     无 handoff 简报、无换代公告、无交接仪式。
```

跨代连续性的答案：**平时持续维护 memory.md，换代后自然读回来**——不再赌一次性 handoff 简报的质量。memory.md 注入机制（`member-context.ts`）已是现成载体，语义天然正确（自描述、替换性参考资料、非指令），一行不用改。

## 删除清单（全部有 44 天数据或 raft 实测背书）

- `context_rollover` 工具及整条模型主动换代链路（`requestNewContext`、`handoffMessageFor`、新代首条 steer）。
- cc 依赖整链：package.json 依赖、`context-continuity-host.ts`、`context-judge.ts`、`compaction-engine.ts`（19 行再导出）、Config 的 `gate`/`jev` 组、设置页 contextJudge 段 + `judge-form.ts` + locales 键。
- 工具面其余 cc 产物：`context_checkpoint`（含 checkpointRef 回退）、`context_status`、`context_compact`；search/read 本就未挂载。
- `TeamPressurePolicy`（引擎 auto 替代）、advice 整档（`compact-now`/`rollover`/`keep` 全删——没有 rollover 后 advice 失去对象；验收压缩不做，见下）。
- **准入闸门整套**（`needsAdmissionGate`/`captureQueuedInput`/`captureClaimedInput`/`holdClaimedInput`/`returnHeldInput`/`handBackInput`）：它为「turn 中途模型主动换代」设计。v2 换代只在消息到达 idle 成员时发生，唤起消息等换代完成后经 Inbox 重导出投递——没有「排队输入暂扣/交还」场景。**v1 里最危险的 75 行时序整套消失，其失败路径测试需求随之消失。**
- `reconstructMissingHandoff`（`index.ts:2541-2580`）：崩溃恢复时向新代 steer「Context handoff: …」——正是 v2 禁止的仪式文本，随 handoff 通道一并删除。

## 保留 / 新建

1. **换代协调器（Team 自持，大幅缩水版）**：只保留唤醒边界所需——idle 边界 swap、pending-transition 崩溃恢复、checkpoint 续接修复。以 `2b8d3eef` 的 369 行为底，**不补** v1 所列 7 个闸门方法。崩溃恢复半边借现役测试形状（`context-continuity-host.spec.ts:169` 起），改写为「legacy pending（turnEndSeq===-1）视为 spent 丢弃」——否则历史日志里的未完成 pending 会让新代永久卡在 isTransitioning。**新增 durable op `team/member-session-recycled`**（actor=host/system）：现有 `rolloverMemberSession` 要求 member actor、`renewMemberSession` 要求 human actor，Host 自动换代两者都不满足；durable schema 是 strict 联合，新 op 走 domain version 升级，旧事件只停生产、保留 decode。
2. **checkpoint 投影自持**：旧版自足实现为底，零 cc import，legacy 事件（`new_context`/`team_thread` 时代）仍正确解码。投影键/codec/ref 形状逐字节一致。
3. **compaction 引擎子类**：extends `@deepseek-ai/dsh-compaction-basic`，只覆盖 `summarize()` 注入 cc 的 7 节模板全文（42 行，含测量依据注释：133 次真实压缩，通用模板 30% 复述代码、41% 丢「谁在等我」）。preset 挂本子类，`auto: true`（删掉现在的 `auto: false`）。
4. **唤醒换代判定**：纯函数，移植 raft `decideWakeRecycle` 的判定形状——enabled → 有上一代 → 事实可读 → idle > 60min → context > 128K，任一不过即 resume。判定点在 `notifyMember`（消息到达活着的 idle agent 时）与 `activateMember`（重启/挂起恢复）两处；命中则先走协调器换代，唤起消息由激活末尾的 Inbox 重导出（`index.ts:3292` 现有机制）投进新代。事实来源：lastActivity 从 ledger/session 事件推导；context 大小对 live agent 用 meter 实测，激活前冷读日志 + `Session.create` + measure。
5. **阈值配置面（预留接口，UI 不做）**：引擎阈值走 preset yml（`thresholdRatio` 全局 + `modelPolicies` 分族）；唤醒换代两阈值做成 Host 行配置（volatile 可写，默认 60min / 128K），schema 预留，设置页 UI 是后续独立票（client 注释零余量，不顺手做）。

## 阈值定案（256K，human 17:39 拍板）

| 路由族 | window | thresholdRatio | 说明 |
|---|---:|---:|---|
| 1,000,000 族（含 Team 默认路由） | 1,000,000 | **0.256** | 全局默认 |
| 1,048,576 族 | 1,048,576 | **0.2441** | modelPolicies |
| 922K（auto/gpt-6.1-sol） | 922,000 | **0.2779** | modelPolicies |
| 272K / 200K 族 | — | 物理不可达（容量封顶 78K / 102K） | 显式认领更早触发 |

`retainRatio: 0.08`（1M 族压完留约 7 万，一次压掉约 18 万，避免频繁小压）。`modelPolicies` 的 provider 段落地时按真实 profile 路由填，不猜。

## 风险与已知未验（human 承担）

- 换代从「模型自主」变「Host 强制」：turn 中段「方向变了想重来」的能力消失，只剩压缩兜。raft 接受同一代价（ compaction 是 mid-turn 唯一兜底）。
- 最坏情况：成员重复刚做过的分析。缓解全押在 memory.md 的持续维护质量上。
- raft v1→v2 教训已吸收：新代输入不放任何「你是新一代」文本，否则 13/13 会变成执行交接仪式。
- 256K 阈值对长任务能力影响无测量；端到端触发需烧 token；provider 段待落地。
- 「验收后 compactNow」**不做**（raft 无此物，属无背书的自创新行为，且唯一触发方已随 advice 删除）。

## 验收口径（沿用 materials/，相应收缩）

- `handback-acceptance-matrix.md`：**作废**（闸门删除，该时序不存在了）。换代失败路径收缩为「唤醒换代中途崩溃 → 重启后 recoverPendingTransition 恢复」，有现役测试形状可借。
- `thresholds.md`：公式与测量方法仍有效，数值按上表 256K 重算。
- `test-coverage-of-rollover.md`：崩溃恢复半边继续是门；闸门半边随删除作废。
- `acceptance-plan-for-A.md`：摘要模板移植、preset 行名真实 profile 验收两条仍是最强约束。

## 执行顺序约束（不变）

先删 `context-judge.ts` / `judge-form.ts`（净减 117 行注释）再改会加注释的地方；本次不抬注释额度；scripts 零余量不碰。

## 连带面

- `package.json` 依赖 + `shipping.spec.ts` 版本断言；`scripts/continuity-dir.mjs` + `generate-typert.mjs` 拷贝段删
- preset 引擎行名改本 bundle 子路径（真实 profile 验成员可用）
- `docs/team-collaboration/memory-and-context.{md,zh.md}`、README 双语、CHANGELOG
- 成员换面需重启档位

---

## 调研存档（拍板前，备查）

### v1 → v2 的变化根因

v1 保留 `context_rollover`（44 天 521 次调用，主力链路）。human 17:29 指出可连它一起删，参照 raft（botiverse/raft-source）：raft 无任何换代工具，唤醒点纯函数判定（60min cache TTL × 128K，均为 fleet 实测），换代后新会话零仪式（v1 有公告，13/13 canary 全在执行交接仪式，v2 改空 briefing）。Team 的 memory.md 每步注入机制（`member-context.ts`）天然是 raft v2 的环境块形状，跨代连续性不需要新设计。

### raft 源码要点（2026-10-20 读 `/tmp/raft-source`）

- `wakeSessionRecycle.ts:33-38`：60min = 实测 prompt cache TTL，超过则 resume 大 session 等于全价重写；128K 在 48K–256K 间成本不敏感，捕获 98.6% 冷重写。
- `decideWakeRecycle`（纯函数）：disabled / unsupported_runtime / no_prior_session / explicit_resume_prompt / runtime_profile_control / session_facts_unavailable / cache_possibly_warm / context_below_threshold → resume；全过才 recycle。**任何不确定 = resume。**
- 冷 idle 收割 sweep（10min）把冷进程停掉让下次唤醒走 recycle——Team 无此需（换代是 session 层不是进程层）。
- compaction 失败账本：连续 3 次终态压缩失败 → 拒绝 resume 该 session（Pi 单请求摘要可能永远超窗，有 agent 一周失败 759 次）。Harness 引擎多步压缩无此失败模式，不移植。
- v2 换代输入：环境块自描述 XML + 原始唤起消息，中间无任何启动类型说明。

### cc 在 Team 里的三层（v1 调研，仍准确）

L1 压力策略（`TeamPressurePolicy`，33 行）/ L2 工具面（`createContinuityTools` 四工具）/ L3 换代本体（coordinator 494 行，16 处 index.ts 调用点，host 6 接口全在本仓）。断 cc 边界 = 只换中间协调器，两端不动（`materials/rebuild-contract.md`）。

### 数据背书

687 会话 / 829 次调用：rollover+compact 83.2%；checkpoint 回退 0 命中；检索 5 次全败；通知→行动中位 61 秒。44 天全程 `auto: false`——即「引擎自动压缩」在 Team 从未真实运行过，03 票落地后是首次。
