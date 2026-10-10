# Issue #43 — 处置计划与已确认决策

接 agent-team workitem `thread-hover-quote` 之下同级。复现与判定已完成，见
[report.md](report.md)。本文件是**处置阶段**的入口：Operator 已就每条「设计取舍」给出决定，
下面记录决定本身，以及动工前需要 operator 再确认的那一项。

**状态**：decisions recorded；implementation not started
**最后更新**：2026-10-10

---

## Operator 已确认的决定

复现报告把 10 条分成三类：**确实的缺陷**、**对外契约变更（breaking）**、**文档/文案**。
除 #8 的产品面扩张外，其余全部放行，理由是「服务于未来发展，有收益即可」。

### A. 确实的缺陷 —— 按 bug 处理，无需再决策

| 项 | 处置 |
| --- | --- |
| **1.1**：点成员行时 `openSession` 失败被静默吞掉，导航栏已切、座位没动 | 捕获失败，回退导航快照或至少上行 alert |
| ~~**2.3 / 5**：失败原因纯内存，重启后丢失~~ | **判定不成立，不修**。详见 [ticket 01](issues/01-durable-failure-diagnostic.md)：成员会被重启的 wake 重新唤醒，同一持久来源重新产出同一诊断。修复方案已全部回滚。 |

### B. 防御 / 文案 —— operator 授权按最优处理

| 项 | 处置 |
| --- | --- |
| **6**：`addMember` 不校验路由 | 只拒绝「provider 未注册」这一层；**不做**创建期模型探测 |
| **7**：说明可空 + 英文 `memory.md` 模板 | 说明保持可选、界面引导填写；模板跟随界面语言 |

### C. 对外契约变更 —— operator 已批 breaking

| 项 | 决定 | 连带改动 |
| --- | --- | --- |
| **9**：`sendMessage` 缺省建 Task | 改成显式 `asTask`，缺省不再建 Task（与模型工具、Web 输入框一致） | 无 |
| **10**：`updateMember` 整体替换语义 | 改成局部更新，清空需显式传 `null` | **UI 的「跟随全局默认」必须改成显式传 `null`**，否则点它没有反应 |

### D. #8 —— 本次**不做**产品面扩张

> 「收益不明确，当前继续保持 agent-team 在 dsh web 去使用。」

但 **8a 放行**：把 `ctx.agentTeam` 现有方法面写进文档，标注哪些是 Remote 契约、哪些是内部。
这是给既有接口背书，不写新代码、不承诺新入口。
**8b（CLI / loopback HTTP）不做。**

---

## 动工前需要 operator 再确认的一项

**C 类两项（#9、#10）是破坏性改动，需要一个版本层面的决定。**

当前 `Unreleased` 段已在 CHANGELOG 里累积 Feature 条目。存量直调 Remote 的调用方
（含 operator 自己的 `team-bridge`）会因为这两项静默改变行为。选项：

1. **下一个 minor/major 里一次性改掉**，CHANGELOG 明确列出行为变更 + 迁移方式。
2. **先立 compat一堂**：保留旧缺省，新增显式语义，下个 major 再切。

倾向选项 1——报告指出三条入口（Remote / 模型工具 / Web 输入框）的 `asTask` 缺省值现在自相矛盾，
维持现状没有收益。但这是 operator 的版本决策。

---

## 落地顺序建议

依赖顺序，非强制串行：

1. **A 类两条**（缺陷，无争议）——可立即开始
2. **B 类两条**（独立、低风险）——可与 A 并行
3. **C 类两条**（breaking，需上面的版本决定）——决定后开工，`updateMember` 改动必须与 UI「跟随全局默认」同批
4. **D 类 8a**（纯文档）——任何时候

每一项的实施 ticket 待上面的版本决定后开到 `issues/` 下；本仓库 [
`.scratch/AGENTS.md`](../../../AGENTS.md) 的 ticket 骨架（What to build / Blocked by / Status / 验收清单）

---

## 对外出口

- 正式交接版Verdict 表：保持在 [report.md](report.md)，不动报告本身。
- GitHub issue #43 回复草稿：[reply.md](reply.md)。
- Breaking 变更对外沟通tool：CHANGELOG `Unreleased`（决定后立即写，在代码之前）。

---

## 实施 ticket

按 `.scratch/AGENTS.md` 的骨架开在 [`issues/`](issues/) 下，编号按依赖顺序：

| ticket | 内容 | 依赖 | Status |
| --- | --- | --- | --- |
| [01](issues/01-durable-failure-diagnostic.md) | ~~失败诊断跨重启保留~~ → 原判定不成立 | None | **complete（不需改）** |
| [02](issues/02-member-row-open-failure.md) | 成员行点击失败不再静默 | None | ready |
| [03](issues/03-addmember-reject-unknown-provider.md) | addMember 拒绝未注册 provider | None | ready |
| [04](issues/04-localized-memory-template.md) | 私有记忆模板语言 | **Operator 决策** | pending |
| [05](issues/05-explicit-astask.md) | sendMessage 的 asTask 改显式（breaking） | None | ready |
| [06](issues/06-partial-updatemember.md) | updateMember 改局部更新（breaking） | None | ready |
| [07](issues/07-document-host-service-surface.md) | ctx.agentTeam 接口面落文档 | None | ready |

**#9/#10 的版本决定**：operator 选了「下一个版本一次性改掉，CHANGELOG 写清行为变更 + 迁移方式」。
因此 05、06 动代码前先在 CHANGELOG `Unreleased` 写 Changed 条目。

**ticket 04 挡住的原因**（调研时发现，已写进 ticket）：模板是 Host 侧写的，
而界面语言是 Client 侧按 `navigator.language` 判定的；Harness 里找不到 Host 可读的界面语言来源。
所以「Host 按界面语言挑模板」目前走不通，需 operator 在两个做法间选一个。

---

## ticket 01 的弯路记录（2026-10-10）

第一轮我判定「失败原因纯进程内存、重启即失」，并写了一版修复
（`restoreDurableTurnFailure`：激活时读 Session 尾部 `turn/end` 回填 runtime 槽）。
两者都错了，详见 [ticket 01](issues/01-durable-failure-diagnostic.md)：

- 那个现象是**读早了**——重启的 wake 已经让成员在跑，还没轮到失败。
- 修复方案即使生效也会被设计本身清掉：`running` 状态按设计清空 runtime 槽，
  因为正在跑的回合本身就是新证据。

修复已全部回滚，`git diff` 里没有 `src/index.ts`。

## 对外出口

- 正式交接版Verdict 表：保持在 [report.md](report.md)，不动报告本身。
- GitHub issue #43 回复草稿：[reply.md](reply.md)。
- Breaking 变更对外沟通tool：CHANGELOG `Unreleased`（决定后立即写，在代码之前）。

---

## 实施 ticket

按 `.scratch/AGENTS.md` 的骨架开在 [`issues/`](issues/) 下，编号按依赖顺序：

| ticket | 内容 | 依赖 | Status |
| --- | --- | --- | --- |
| [01](issues/01-durable-failure-diagnostic.md) | ~~失败诊断跨重启保留~~ → 原判定不成立 | None | **complete（不需改）** |
| [02](issues/02-member-row-open-failure.md) | 成员行点击失败不再静默 | None | ready |
| [03](issues/03-addmember-reject-unknown-provider.md) | addMember 拒绝未注册 provider | None | ready |
| [04](issues/04-localized-memory-template.md) | 私有记忆模板语言 | **Operator 决策** | pending |
| [05](issues/05-explicit-astask.md) | sendMessage 的 asTask 改显式（breaking） | None | ready |
| [06](issues/06-partial-updatemember.md) | updateMember 改局部更新（breaking） | None | ready |
| [07](issues/07-document-host-service-surface.md) | ctx.agentTeam 接口面落文档 | None | ready |

**#9/#10 的版本决定**：operator 选了「下一个版本一次性改掉，CHANGELOG 写清行为变更 + 迁移方式」。
因此 05、06 动代码前先在 CHANGELOG `Unreleased` 写 Changed 条目。

**ticket 04 挡住的原因**（调研时发现，已写进 ticket）：模板是 Host 侧写的，
而界面语言是 Client 侧按 `navigator.language` 判定的；Harness 里找不到 Host 可读的界面语言来源。
所以「Host 按界面语言挑模板」目前走不通，需 operator 在两个做法间选一个。

---

## 实施受阻：ticket 01 的第一版思路行不通（2026-10-10）

**尝试过的做法**：把写入失败记录的 `turn/end` 作为持久来源，在 `activateMember` 成功路径上
把 runtime 槽恢复出来（`restoreDurableTurnFailure`），不新增持久状态、账本仍是唯一权威。

**代码本身是work的**：加 PROBE 验证过，重启时确实读到
`{"message":"gateway answered 401","code":"AUTH"}` 并写进了 runtime 槽。

**但立刻被设计本身冲掉**，两步之内：

1. `activateMember` 成功后会做一次 Inbox wake（`notifyMember({ kind: 'activation' })`）
2. 这次 wake 起一个回合 → `agent/status` 变 `running` → index.ts:847 的
   `clearMemberFailure(memberId, 'runtime')` **按设计清空 runtime 槽**

那条清除是有道理的：**正在跑的回合本身就是新证据**，没有理由留着上一次的失败。
所以「把历史失败塞回 volatile runtime 槽」这个位置和语义本身就冲突——
不是清除逻辑有 bug，是我把两种不同性质的东西塞进了同一个槽。

**推论**：要让重启后仍看得到上次失败，必须区分「上一次已结束回合的结果」和
「当前活跃回合的状态」两件事，而不是把前者伪装成后者。
这需要别的数据流（例如让 `memberStatus` 在 runtime 槽为空时，
去读一次该 Session 已结束回合的结果），是比原方案更大的一处改动。

**当前已把半成品撤回**（`git stash`，工作流必须干净再往下推），
ticket 01 需要重新设计，选项：

- **A**：不碰 presence/diagnostic，改为把最近失败作为**成员的一行持久投影**
  （账本 operation 或一条 limitedRecord），`memberStatus` 用它兜底。语义干净但要新增持久状态。
- **B**：接受 proposal 不动 presence，只在 **UI 侧**补一条「上次失败」的可查询入口
  （例如行菜单 /  tooltip 读 Session 尾事件）。成本低，但 Host API 不体现。
- **C**：维持现状，把 #5 报告为「持久上下文信息（我需要额外上下文才能继续）」，报告里说清楚这是已知限制。

**倾向 A**——报告established「看不见上次失败」是一个真实的运维痛点，而 A 是真正在修它；
B 是把问题推到 UI；C 等于不修。
但 A 涉及新增持久状态（ operator 之前对 breaking 敏感、对复杂性也敏感），需要他确认。
