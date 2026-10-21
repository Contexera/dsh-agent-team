# review 与审计结论存档（2026-10-21）

## reviewer 独立 review（分支 feature/auto-compaction-migration vs c6768f22）

结论原文见 subagent 存档。处置记录：

| 发现 | 严重度 | 处置 |
|---|---|---|
| `this.ctx.tokenMeter` 未 inject 导致换代度量路径生产静默失效 | P0 | **实测推翻**。两个最小 Context 探针（sibling row 读 root-provide 服务，含 isolate 组形态）均读到值不抛错；base patch 中 `token-meter` 与 Host 行同层（`deepseek-harness/packages/bundle/base/cordis.patch.yml:348`），正是探针形态。Cordis `internal/get` waterfall 向上查 fiber 链，未 inject 不等于抛错（只有 `prop in fiber.inject` 且 inactive 才抛「inactive context」）。 |
| member-lifecycle.spec.ts:3189 全量跑竞态（把瞬态 unavailable 当终态） | P1 | 已修：改 `vi.waitFor(availability === 'active')`。 |
| 新 durable op 未升 domain version，降级回旧 build 打不开 | P1 | 决策确认不升（01 票判断正确）：spec.ts 注释已写判据「version 只在 stored record 含义改变时动」；git 史 `069110cf`「reset domain version to 1」证明惯例——DM/thread-read/reply/participation 等纯增量 kind 全部留 v1，唯一动过版本的是 actor 形状/CONTEXT 结构破坏性变更。已在 CHANGELOG Unreleased 加 Upgrade note 点名降级影响。 |
| 测试约束力缺口：唤醒换代 4 条端到端依赖 root meter；`onTurnEnd` 二次校验与 `scheduleCheckpointContinuations` 无覆盖 | P1 | 已补 `team-context-management.spec.ts` 新用例「refuses the swap once the Agent behind the intent has already been replaced」——**该用例抓到真实缺陷**：whenIdle 回调里 `agentForMember !== agent` 分支直接 return 不摘锁，`isTransitioning` 永久 true 挡住后续换代。已修（拒绝时 delete + settleMember），提交 `2c791337`。 |
| session-trace.ts 未收录新 op kind | P2 | 已修：补 `member-session-recycled` 与 `member-session-rolled-over`。 |
| generated-and-seams.md 仍称引擎声明被复制 | P2 | 已修。 |
| context-codec.ts 手写器无生产调用 | P2 | 判断为**刻意保留**：4 个测试文件用它生成 byte-identical fixture 锁定旧日志可读回，移到 tests 会造成 4 处复制。模块头注释已改写为「writers stay so the golden tests generate fixtures byte-identical to what history holds」。 |
| wake-recycle 边界严格 `>`/`<=` 与 spec「≥」不一致 | P2 | 保守方向（差 1ms/1token 判 resume），已在 spec 风险节说明，不改。 |
| index.ts 无 handle 路径失败时 Service.init 循环用旧 member 快照 | P2 | 见下「已知遗留」。 |
| team-compaction-engine.ts 复制 finishError/summaryText 共 35 行、SummaryResult 结构重复 | P2 | 接受：`summarize()` 是唯一钩子，base 的这些 helper 不导出；复制是引擎设计的必然成本，有测试锁定形状。 |

## 已知遗留（未修，记录在案）

- `index.ts` 无 live handle 的 recycle 路径 commit 后走 `finishMemberTransition`，若失败，`Service.init` 的循环会用**循环开始时的旧 member 快照**再 `activateMember` 一次，此时 durable binding 已指向新 session，会撞 stale binding 校验。触发条件：冷换代 commit 成功但后续激活连续失败且进程重启。影响：该成员 unavailable，下轮启动重试。修复方向：循环内重读 binding。风险低，未排期。

## 用户要求的三项修复（均已完成并提交）

1. README 中英「无需操心上下文 / No context babysitting」bullet 删除。
2. cordis.patch.yml 删除 14 条本机 profile 路由的 modelPolicies（preset 只留全局 0.256/0.08/65536；分路由微调交由部署方在 profile 层做）。同步测试改为：全局值 + 测试内构造 policy 验证匹配语义。
3. 清理确认：rollover/checkpoint/judge/gate/handoff 全删净；额外查出并删除 04 漏删的 3 个死方法（`rolloverSeedForMember`/`activeClaimCountForMember`/`activeClaimsForMember`）。

## 提交线（c6768f22..HEAD）

```
8189a5b2 docs: drop the removed engine copy step from the generation seam
d7574d2c docs: note the downgrade impact of the recycled-session operation kind
0567fb87 chore: drop the local route thresholds, the context-babysitting README claim, and three dead ledger readers
2c791337 fix: release the transition lock when the Member moved generations mid-turn
f6ba962f docs: describe wake-recycle and engine-owned compaction in the maintained documents
99955f8e feat!: replace dsh-context-continuity with a Team-owned generation coordinator and remove model-facing context tools
6c715df7 feat: self-host the context projection, codec, compaction template, and wake-recycle decision
```

基线状态：1088 passed + 1 skip，typecheck/check:comments(3641/4150)/check:boundaries/docs 28 对/test:browser 5 passed 全绿。
