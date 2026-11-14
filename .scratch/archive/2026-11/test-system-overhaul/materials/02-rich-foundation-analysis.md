# 测试底座充血（Deep Test Foundation）可行性与收益分析

- **性质：** 当前设计分析（2026-11-14）
- **理论对照：** 遵循 `.agents/skills/codebase-design/SKILL.md` 的 **Deep Module** 原则——用极小的调用接口承载高杠杆的复杂准备与守卫逻辑，使测试作者与 AI 代理以最少认知成本直达业务断言。

---

## 1. 为什么单纯“去复杂度收敛（瘦包装）”收益触顶？

如果只做“合并 `new Context()` + 抽掉 `afterEach(cleanups)`”的瘦收敛，每个文件大约只减少顶部 10–15 行样板代码。进入每个 `it(...)` 内部后，仍然充斥着大量低信噪比的协议仪式：

- 每次写操作都要手造不撞号的 `requestId('...')`、重复传 `workspaceId` / `presetId: 'team-member'` / `model: { provider: 'mock', model: 'mock' }`；
- 每次准备前置状态都要手写 `readThread` → 取 `revision` → 调 `changeTask` / `changeClaimForAgent` → 手写 `if (res.kind !== 'committed') throw new Error(...)`；
- 每次操作 Member 都要 `ctx.agents.get(added.status.member.sessionId)!` 再 `await waitForIdle(ctx, live)`；
- 更关键的是，**瘦包装不提升缺陷检出能力**：
  - 只有少数显式写了 `expect(() => ctx.agentTeam.validateLedger()).not.toThrow()` 的用例才会校对账本不变量；
  - Client `harness.tsx` 的 30+ 扁平开关和 Tool `fakeHost` 的 `as never` 字面量无法在编译期感知 Host/Remote 契约变更。

---

## 2. “测试底座充血”的四大真实收益

### 收益 1：Given 阶段压缩 50%–70% 协议噪音，测试意图一眼可见

以 [member-acceptance.spec.ts](../../../../packages/agent-team/tests/member-acceptance.spec.ts#L24-L58) 的首个用例为例：

- **现状（34 行，前 17 行全是协议仪式）：**
  需要依次手写 `createProject`、`addMember`、`startThread` + `if (started.kind !== 'committed')`、`ctx.agents.get(...)`、`waitForIdle`、`readThreadForAgent`、`changeClaimForAgent` + `if (claim.kind !== 'committed')`、`readThread`、`changeTask` + `if (accepted.kind !== 'committed')`，第 44 行才进入真正被测动作。
- **充血后（~12 行，Given / When / Then 清晰分离）：**
  ```ts
  const h = await realHarness(new ScriptedAdapter())
  const project = await h.createProject('engineering')
  const builder = await h.addMember('builder', { projects: [project] })
  h.pressureState.usageTokens = 0
  const task = await h.human.startTask(project, 'Investigate the release')
  await builder.claimTask(task, 'own the fix')
  await h.human.acceptTask(task)

  // When
  await builder.readThread(task)

  // Then
  expect(builder.queuedNotices(isAcceptanceNotice)).toHaveLength(1)
  expect(builder.splicedNoticeTargets(isAcceptanceNotice)).toEqual(['next-step'])
  ```
  `TestHuman` / `TestMember` / `TestTask` 句柄在内部自动递增 `requestId`、默认携带 `workspaceId`/`model`、自动串起 `read -> baseRevision -> write -> assertCommitted`，既消灭重复，又让阅读者立刻看清“测的是什么”。

### 收益 2：内建全局不变量守卫，免费放大全仓检出率

- **自动账本自检：** `openTestLedger` / `hostHarness` / `realHarness` 在 `onTestFinished` 清理前默认执行一次 `validateLedger()`（针对故意注入损坏账本的恢复测试提供 `{ validateLedger: false }` 退出开关）。这会为已迁移底座的用例增加账本一致性检查；覆盖范围和额外运行成本须实测，不代表全部 138 个 spec 已自动覆盖。
- **自动环境与句柄守卫：** 统一管理 `DSH_HOME` 保存与恢复、`try / finally` 释放 `fiber` / `facility` / `backend` / `root`、Client `slotCrashes` 归零校验与 `runtime.dispose()` / `localStorage.clear()`。

### 收益 3：Client 底座从“30+ 布尔开关袋”升级为“强类型领域构建器 + 故障注入器”

目前 [packages/client-agent-team/tests/harness.tsx](../../../../packages/client-agent-team/tests/harness.tsx#L114) 的 `runtimeWithTeam(options)` 接收 30 多个扁平字段（如 `seedTaskRef`, `seedThreadRef`, `seedTaskless`, `seedsAsMainMessages`, `seedTaskStatus`, `remainingUnreadCounts`），并返回一个包含约 50 个无类型字段的巨型对象。

充血升级为分域的 `ClientTestBench`：
- **强类型领域种子工厂**：`bench.projects.seed(...)`、`bench.threads.seed(...)`、`bench.inbox.seed(...)`、`bench.workers.seed(...)`，默认产出合法的 `@contexera/dsh-agent-team/types` 结构，只覆写用例关心的字段，改字段名即编译报错；
- **语义化故障与延迟注入**：用 `bench.failNext('reply', ...)` / `bench.holdNext('readThread')` 替代手写的 `mockResolvedValueOnce({ ok: false, error: ... } as never)`；
- **高频 UI 动作辅助**：`bench.openTeam()`、`bench.openProject('engineering')`、`bench.openTask(1)`，减少各 `.client.spec.tsx` 里重复的 DOM 查找点击样板；
- **保留兼容出口**：保留 `runtimeWithTeam` 包装一层，支持老 spec 平滑迁移。

### 收益 4：Tool 底座从“5 份无类型 `as never` 假对象”升级为“强类型契约替身”

`packages/tool-agent-team/tests/` 下 5 个工具动作 spec 各自手写 `fakeHost()` 并用 `as never` 强转，Host 方法改名或加必填字段时单测仍绿。
统一抽为受 Host 类型约束的 `TestToolHost`（通过 `satisfies` 校验 `*ForAgent` 入参/出参签名）+ 标准化 committed 回执构造器，并复用 `callTool(toolName, args, host)`。

---

## 3. 充血不越界的 4 条硬性护栏

测试底座充血最怕“把断言也藏进 helper 变成黑盒”或“在测试里重实现一遍业务逻辑”。必须坚持以下 4 条边界：

1. **Given 充血，When / Then 显式**
   快捷方法只用于搭建前置状态（Given）或做纯净的内省读取（如 `queuedNotices()`）；被测动作本身（When）与结果断言（Then）必须明文留在 `it(...)` 内。
2. **零平行权威（Zero Parallel Business Logic）**
   Host/Ledger 句柄的领域动作委托真实 `ctx.agentTeam` / `AgentTeamLedger`；Client Remote stub 与 Tool Spy 允许种子、回执和故障设置，不能复制 Host 状态机。`SlotTestRuntime` 只负责 Client 装配，不提供真实 Host 业务动作。
3. **双层逃生舱（Fluent + Raw Escape Hatch）**
   每个充血句柄都必须暴露底层原始对象（`.ctx`、`.agent`、`.memberId`、`.taskRef`、`.raw`）。当测试需要验证非法入参、并发版本冲突（stale `baseRevision`）、权限拒绝或竞态时，随时直接调底层原始接口。
4. **向后兼容、渐进采用**
   新领域句柄与快捷方法作为增量属性挂载在现有 harness 返回对象上（保留 `{ ctx, workspaceId, ... }`），不逼迫全仓 208 个文件一次性重写。

---

## 4. 迁移执行核对（2026-11-14）

### 4.1 仍保留 `new Context()` 的 13 个文件

Ticket 02 要求收编因缺少底座而内联 `new Context()` 的 Host/Ledger spec，并说明无法收编的例外。交付后 `rg -l 'new Context\(' packages` 命中 13 个测试文件；它们只组合被测插件所需的少量服务，不启动 Team Host，因此不适用 `harness()` / `openTestLedger()`：

| 文件 | 保留原因 |
| --- | --- |
| `packages/agent-team/tests/loader-composition.spec.ts` | 被测对象就是 Loader/Include/Group 的异常加载路径，必须手动构造 Cordis 组合。 |
| `member-compaction-budget.spec.ts` | 直接驱动 `TokenMeter` 与 Session 投影，不需要 Team Host。 |
| `member-compaction-flow.spec.ts` | 只挂 AgentLoop 依赖和自定义 `agentTeam` 替身，验证压缩状态机。 |
| `member-context-integration.spec.ts` | 以投影测试替身检查 Member 上下文改写。 |
| `member-time-context-integration.spec.ts` | 检查 Member 时间上下文的一步注入。 |
| `preset-compaction.spec.ts` | 验证 preset 行自身的健康检查与共享 compaction 服务。 |
| `shipping.spec.ts` | 解析随包发布的 patch 行与系统 prompt 变量名。 |
| `stored-session-reader.spec.ts` | 直接读写 JSONL 持久化后端。 |
| `subscription-runner.spec.ts` | 组合沙箱执行器，验证一次无人值守运行。 |
| `subscription-storage-upgrade.spec.ts` | 直接打开 SQLite 后端验证 v0.2.7 声明迁移。 |
| `webhook-ingress.spec.ts` | 挂载独立 webserver realm，验证真实 socket 入口。 |
| `session-trace.spec.ts` | 运行 `scripts/session-trace.ts`，只需 JSONL 持久化。 |
| `packages/client-agent-team/tests/slots.client.spec.ts` | 只装配 Client SlotRegistry 与设置表单，不使用 Client bench。 |

### 4.2 测试目录重复度

仓库的 `.jscpd.json` 忽略 `**/tests/**`，因此按本票口径用一份不忽略测试目录的临时配置单独扫描 `packages/agent-team/tests`（`min-tokens 70`、`min-lines 10`、`mode mild`）：

| 基线 | 克隆数 | 扫描行数 | 重复率 | 文件数 |
| --- | ---: | ---: | ---: | ---: |
| `57f762f9`（本票交付前） | 91 | 43,954 | 2.97% | 148 |
| 本票交付 | 69 | 44,066 | 2.03% | 151 |

扫描行数基本不变而克隆数与重复率同时下降，说明下降来自共享底座收编，而不是删除场景。命令：`jscpd --min-tokens 70 --min-lines 10 --format typescript,tsx --pattern '**/*.{ts,tsx}' packages/agent-team/tests`。
