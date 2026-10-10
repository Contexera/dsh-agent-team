# Issue #43 最终复现报告（两轮比对后）

本仓库对 GitHub issue #43 的 10 条 + 2 条附注做了两轮独立复现（本机一轮、另一份报告一轮），
结论有冲突的条目做了针对性重验。**本报告为最终结论。**

## 基线与分工

| 项 | 值 |
| --- | --- |
| 被检仓库 | `Contexera/dsh-agent-team`，tag `v0.2.2`；另在 `master`（`575b7a9d`，0.2.2 + 未发布提交）核对代码是否已改 |
| 运行时 | `deepseek-ai/deepseek-harness` tag `dsh-v0.2.0-rc.2`（`c1b47e41fc`） |
| 本机方法 | 真实 Harness 集成装配（真实 agent-loop + JSONL 持久化 + 真实 preset 组合）；Client 侧用仓库自带 slot bench |
| 另一份报告方法 | 同类真实集成测试 + 真实 Web（headless Chrome + 仓库 scaffold） |

冲突集中在 issue 2。两轮的差异不是"结果不同"，而是**读取磁盘产物的方法不同**（见下）。

---

## 结论总览

| # | 报告内容 | 最终结论 | 与另一份报告的差异 |
|---|---------|---------|------------------|
| 1 | 客户端打开错误的成员会话 | **未能复现**；“刷新后恢复”部分有真实的静默失败成因 | 一致（均未能复现）；本报告补出成因 |
| 2 | 首次失败回合在会话日志无痕迹 | **不属实**：日志完整落盘 | **冲突** → 对方"1 行"是解码方式造成的，见下 |
| 3 | `recoverMember` 在 error 状态下是 no-op | **不属实**：它真的重试了 | 一致（对方"部分属实"，实质描述相同） |
| 4 | `clearMemberContext` 用 requestId 派生会话 ID | **属实** | 一致 |
| 5 | `membersForClient` 不含失败原因 | **不属实**：字段存在且会被重新产出（第一轮我方判"部分属实"已更正） | 对方判"不属实"正确 |
| 6 | `addMember` 接受不可用路由 | **属实**（增强项） | 一致 |
| 7 | 空描述与英文 `memory.md` 占位 | **部分属实** | 一致（对方判"属实"，但"没人设可用"不属实） |
| 8 | 无文档化的 Human 侧编程接口 | **属实** | 一致 |
| 9 | `sendMessage` 默认创建 Task | **属实**（设计取舍） | 一致 |
| 10 | `updateMember` 省略字段即清空 | **属实**（语义） | 一致 |

新发现一条两轮都没写出的真实缺陷：点击成员行时座位打开失败被静默吞掉（1.1）。
（2.3 曾报「失败原因不持久」，重验后判定不成立，已更正。）

结论可靠性：每条都给了可执行的实测输出或具体文件行号；issue 2 的冲突已重验到根因（解码方式）。
需要报告者补充的只剩 issue 1 的成员创建路径。

---

## 冲突条目：Issue 2 —— 首次失败回合在会话日志无痕迹

两份报告的结论相反：

- 另一份报告：**属实**。zstd 解压后"只有 1 条事件，即创建时的 `session` 头"。
- 本机第一轮：**不属实**。内存中 16 条事件完整，`turn/start`、`turn/end` 都在。

### 重验方法与结果

用 Harness 自己的多帧解码器（`scanZstdFrames` + 逐帧 `zstdDecompressSync`）读取磁盘产物，
并在三个时点各读一次（进程运行中 / 显式 flush 后 / Host dispose 后）：

```
--- BEFORE flush (进程仍在运行) ---
  frameCount = 2
  bytes=288  types = ["session","sandbox/mode"]
--- AFTER a 400ms wait (无显式 flush) ---
  frameCount = 3
  bytes=8680  types = ["session","sandbox/mode","session/title","agent/inbox/spliced",
                       "turn/start","agent/inbox/spliced","step/start","system/message",
                       "user/message","user/message","user/message","request/header",
                       "request/context","assistant/attempt","step/end","turn/end"]
  assistant/attempt data = {"turn":1,"step":1,"stream":[{"chunk":{"type":"finish",
    "reason":{"kind":"error","failure":{"message":"gateway answered 401","code":"AUTH"}}}}]}
  turn/end data = {"turn":1,"reason":{"kind":"error",
    "error":{"message":"gateway answered 401","code":"AUTH"}}}
--- AFTER host dispose ---
  同上，16 条
```

### 结论

**"失败回合不写日志"不成立。** 失败的回合在磁盘上留了完整 16 条事件，
`turn/end` 里带着结构化的失败原因（`{"kind":"error","error":{"message":…,"code":"AUTH"}}`），
`assistant/attempt` 里带着流的失败 chunk。等待 400ms（无需显式 flush、无需 dispose）即可读到全部内容。

**另一份报告"只有 1 行"的成因是解码方式**，不是产物内容：

该 JSONL 后端把每次批量写入编码成**一个独立的 zstd 帧**追加（`compressZstdFrame` 每批一帧）。
Node 的 `zstdDecompressSync` 只解码**第一个帧**。本机用同样的一次性解码读同一份文件，
得到的正是 `["session"]` 一条——与对方报告完全一致。用多帧解码读同一份文件则是 16 条。
同一个文件、两种读法，所以这不是环境差异，是**读取侧的伪影**。

对方报告自己也提到"解压后"得到 1 条，并把它与报告者所说的"六条"并列为环境差异——
实际那条 1 是解码上限，不是日志内容。

佐证（代码层面）：agent-loop 的 `turn()` 在开头就 `session.append('turn/start')`，
并在 `finally` 里无条件 `session.append('turn/end', { turn, reason })`
（`agent-loop/src/agent.ts:305,385`）。失败回合不留痕在结构上就不可能。

写入延迟是**正常的批量策略**：live 事件按 `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200`
（`session-persistence-jsonl/src/storage.ts:35`）成批落盘，属设计行为，不是缺陷。

### 2.3 关于「失败原因不持久」——第一轮判错了，已更正

第一轮我报告「失败原因只存在进程内存里，重启后成员变回可用、诊断消失」。
**后半句经重验不成立**，原因是当时读取的时机不对。

实际行为：成员默认 enabled 且 Inbox 有待送事实，**重启会让它重新被唤醒**；
路由若仍是坏的，这一回合又以同一个错误失败，`agent/error` 再次填回 runtime 槽。
同一个持久来源（Session 日志）重新产出同一个诊断。实测：

```
重启后立刻读： presence=working  diagnostic=null      ← 已被重启的 wake 唤醒，正在跑
该回合结束后： presence=error   diagnostic={"class":"runtime","detail":"gateway answered 401"}
```

所以失败原因**不会丢**。第一轮读到 `working`/`null` 是读早了——它正在重试，还没轮到失败。

为验证这一点，我曾写过一版修复（`restoreDurableTurnFailure`：在激活路径上读 Session 尾部
`turn/end` 并回填 runtime 槽）。代码有效，但两步内被设计本身清掉：
激活后的 Inbox wake 起回合 → `status: 'running'` → `clearMemberFailure(..., 'runtime')`
按设计清空。那条清除是对的：**正在跑的回合本身就是新证据**，
把「上次已结束回合的结果」塞进「当前活跃回合状态」的槽里，语义冲突。
修复已全部回滚，`re-derives a Member's failed last turn when the Host restarts`
这条测试把真实行为钉住。

**残留的时间窗**：重启瞬间到该回合结束之间，确实短暂显示 `working` 而非 `error`。
这属于设计本意（它正在重试），不是缺陷。

## 冲突条目：Issue 5 —— `membersForClient` 不含失败原因

- 另一份报告：**不属实**。`diagnostic` 字段存在，两种失败场景都能取到，客户端已有渲染路径。
- 本机第一轮：**部分属实**。字段确实存在，但它不持久。

**最终结论：部分属实。** 两边的观察都对，合并起来才是完整事实：

| 维度 | 事实 |
| --- | --- |
| 字段是否存在 | 存在。`AgentTeamAgentMemberStatus` 有 `diagnostic?: AgentTeamMemberDiagnostic` |
| 失败时是否填充 | 填充。实测 `{"class":"runtime","detail":"gateway answered 401"}` |
| 客户端是否渲染 | 渲染。`TeamPresenceDot` 拼 `错误: <detail>`；Thread 页有风险行 |
| **是否持久** | **否。进程内 Map，Host 重启后清空，成员变回"可用"** |
| 结构化程度 | 只有 `{ class, detail }`，无报告者建议的 `code`/`at` |

对方报告判"不属实"时只验了"字段存在且当前可见"，没有验重启后的行为。
报告者说的是"UI 承诺会说明原因但看不到"——最吻合的解释是**失败发生在上一个 Host 进程里**。

---

## Issue 1 —— 客户端打开错误的成员会话

两轮均**未能复现**，且两轮覆盖了互补的两半路径：

- 对方：真实 Web，UI 连续创建 `alpha`/`beta`/`gamma`，逐个点击 → 三行各自打开自己的会话，
  刷新前后一致。
- 本机：slot bench，向 roster 注入 3 个新成员行并逐个点击 →
  `openSession` 依次收到 `["session:member:writer","session:member:reviewer","session:member:analyst"]`。
  去掉"先把 session 加进 Client 目录"这一步（页面还没收到 `api-session/added` 的形状）结果相同。

代码上也找不到"行 → 会话"的索引映射：行按钮直接 `openMemberSession(status.member.sessionId)`，
行以 `memberId` 为 key。

对方未能覆盖桥接（`team-bridge`）路径：从 scaffold 根上下文调 `ctx.agentTeam.addMember`
时成员无法激活（诊断 `preset-composition: Unknown agent preset: team-member`），
且 `TeamAgentsPanel.tsx:364` 在 `availability !== 'active'` 时把按钮置为 disabled，因此点不动。

### 1.1 两轮都没覆盖的一条真实边缘缺陷（新）

顺序问题。`openMemberSessionImpl`（`client/index.ts:161-177`）先改导航状态，
**之后**才去打开座位：

```ts
navigation.actions().enterMemberSession(sessionId, returnTo)  // 先改导航快照
ctx.layout.selectPanel(null)
ctx.uiWorkspace.openSession(sessionId)                        // 后开座位
```

而 `uiWorkspace.openSession` 的契约是 `openSession(target: SessionTarget): void`
（`ui-workspace/src/client/navigation.ts:34`）——**同步 void**，调用方拿不到结果、也 catch 不到。
它内部走 `replaceMain`，首行就是 `this.sessions.retain(target, { source: 'mainView' })`，
而 `resolveTarget` 在 Client 目录里没有该 id 时**同步抛** `sessions.retain: unknown session <id>`
（`session-controller/src/client/sessions/manager.ts:135-152`）。

实测（让 `openSession` 抛该错误——即新建成员而页面尚未收到目录更新时的形状）：

```
点击三次，click 未抛出（错误被 React/void 吞掉）
openSession 收到三个 id（三次都调用了）
页面 alerts = []
mainView = []
```

**结果：导航快照已切到该成员（`enterMemberSession` 生效、侧栏高亮跟着走），
但座位打开失败，且失败被完全吞掉——用户看不到任何提示。**
座位因此停留在上一个会话。

这与报告者的描述吻合：点了之后显示的不是这个成员的会话，刷新（目录补齐后）恢复正常。

可达性判断：`retain` 抛错的前提是该 id 不在 Client 会话目录里。新建成员的 sessionId 由 Host 生成，
Client 需经 `api-session/added` 才知道它，因此**成员刚创建而目录尚未刷新时这个窗口是真实存在的**。
它不能解释"三个成员全部指向第一个"（三次点击各带各的 id，失败时座位是保持不动而非跳到第一个），
所以原报告的现象仍未复现；但"点了没反应/显示不对、刷新后好"这部分是站得住的。

建议：`openMemberSessionImpl` 捕获 `openSession` 的失败——回退导航快照，
或至少上行报一个 alert，别让状态和提示同时静默。

---

## 其余条目（两轮一致，合并记录）

### 3. `recoverMember` 在 error 状态下是 no-op —— 不属实

分支顺序（`index.ts:1184-1240`）：完成中断的会话切换 → 收敛非 enabled 的残留 →
重建孤立 preset 组合 → 无 live handle 时重新激活 → 其余走 `steerResume`。
`presence: 'error'` 且 handle 健在时走最后一条。

实测（ScriptedAdapter：第一次应答，之后一直 401）：

```
recover 前 : error {"class":"runtime","detail":"gateway answered 401"}
模型请求数 : 1 → 2        ← 恢复提示真的发起了新一轮
recover 后 : available     ← 这一轮成功，错误态清除
再次唤醒   : error（同一条 401）
```

所以它不是空转。对方报告"部分属实"，描述实质相同：会重试，但对永久性失败（路由/密钥错误）无效。

**一个真实的表达问题**：返回值里的 `presence` 是 steer 完成那一刻读的，
新一轮还没跑完，所以仍是旧的 `error`。只看返回值会误判成"没生效"。
JSDoc 描述的是另两个分支，与 steer 分支无关，容易误解——文档问题成立，行为不成立。

### 4. `clearMemberContext` 用 requestId 派生会话 ID —— 属实

两轮一致。以 `requestId = team-bridge:clear:cl1` 调用：

```
新会话 ID   = agent-team-team-bridge:clear:cl1
磁盘目录名  = agent-team-team-bridge~003Aclear~003Acl1
```

根因 `SessionId(\`agent-team-${request.requestId}\`)`（`index.ts:1270-1272`），
冒号经 `encodeSegment` 转义为 `~003A`，成为**用户可见的持久路径名**。
注释说明目的是让重试幂等；但该幂等已由 `hasCommitted(requestId)` 独立保证，
不依赖 id 由 requestId 派生。建议改回 `agent-team-<uuid>`（与 `addMember` 一致）。

### 6. `addMember` 接受不可用路由 —— 属实（增强项）

两轮一致。`assertModelRoute`（`index.ts:2896-2907`）只在显式给了 `reasoningEffort` 时查元数据，
不校验 provider 是否注册、密钥是否配置、网关是否接受 Harness 请求形状。

本机实测 pin 到不存在的 provider：

```
addMember 返回: availability=active  presence=available
首回合之后    : error {"class":"runtime","detail":"context pressure policy:
                the routed model capacity is unknown; refusing to forward a request
                without a bounded context budget"}
```

注意死因不是 401：该路由解析不出上下文容量，压力策略 fail-closed
（`resolvedContextWindow` 把解析失败记为 unknown）。死因因部署而异，
正对应报告者"首回合必死且死因难读"的抱怨。至少应在 provider 未注册时直接拒绝。

### 7. 空描述与英文 `memory.md` 占位 —— 部分属实

两轮一致确认两点：`description` 可空串；`memory.md` 是英文占位模板
（`- <what this Member owns, and does not own>`），中文界面下不一致。

**"首次唤醒的成员没有人设可用"不属实**：成员上下文每次 pre-step 注入
`renderMemberIdentity(member)`，加上私有记忆、Workspace 列表、时间上下文，
以及 preset 的 `persona` 前缀。description 为空只是少了半句职责描述。

### 8. 无文档化的 Human 侧编程接口 —— 属实

两轮一致。包无 `bin`、无 CLI；维护文档写明 Web Client 是唯一 Human control surface。
`ctx.agentTeam` 服务方法面没有任何文档化承诺，外部 `ctx.get('agentTeam')` 属未文档化用法。

### 9. `sendMessage` 默认创建 Task —— 属实（设计取舍）

两轮一致。`ledger.ts:1077`：`const asTask = request.asTask !== false`——只有显式 `false` 才不建。
实测省略时创建 `{"status":"todo","resolution":"open"}` 的 Task。

对比很刺眼：模型侧 `team_message` 工具**默认不建**（`asTask: args.asTask === true`），
工具描述明写 "start defaults to a taskless Thread"；Client composer 开关默认也是 `false`。
同一个概念在 Remote 入口上缺省值相反——只有直调 Remote 的调用方会踩到。

### 10. `updateMember` 省略字段即清空 —— 属实（语义）

两轮一致（对方验 `model` + `capabilities`，本机验 `capabilities`）。
实测建成员时设 `capabilities`，随后只传 `handle`/`description`：

```
capabilities after = undefined
```

类型注释写明 "Absent clears any capability override, matching `model`"。
`model` 的"缺省即清除"在 UI 上有表达（"跟随全局默认"），`capabilities` 的清除无任何 UI 表达。
Client 编辑器已踩坑并绕开（显式回显 `status.member.capabilities`），证明该语义危险。

---

## 附注两条（非 bug，两轮一致）

1. **唤醒语义未文档化**：`docs/architecture/host-authority.md` 写了 "one wake per affected Member"，
   但未列举触发者。实测触发唤醒的有：mention 送达、DM、promotion、Task acceptance、
   participation 变化、成员激活。建议补清单。
2. **无恢复决策树**：`recoverMember` 有 5 条分支，`clearMemberContext` 是换上下文的重建，
   文档没有"先试哪个"。建议在 `docs/team-collaboration/` 补一节。

---

## 建议修复顺序

| 优先级 | 条目 | 改动 | 风险 |
|--------|------|------|------|
| 中 | 1.1 | `openMemberSessionImpl` 捕获 `openSession` 失败：回退导航快照 + 上行 alert | 低；只把静默失败变成可见失败 |
| 中 | 4 | `clearMemberContext` 的新 sessionId 改用 `agent-team-<uuid>`；幂等继续靠 `hasCommitted` | 低 |
| 中 | 6 | `addMember` 在 provider 未注册时直接拒绝 | 低；把"注定失败"提前成明确错误 |
| 中 | 9 / 10 | 改 `asTask` 缺省；改 `updateMember` 为真正的局部更新（清空需显式 `null`） | **breaking**，需版本说明 |
| 低 | 7 | 说明列为推荐必填；`memory.md` 模板跟随界面语言 | 低 |
| 低 | 8 / 附注 | 文档：服务方法面稳定级别、唤醒触发清单、恢复决策树 | 无 |
| — | 2 / 3 | 不修；`recoverMember` 的 JSDoc 建议改写以减少误解 | 无 |

## 收尾说明

- 全部 10 条 + 2 条附注均已判定，每条给了实测输出或具体文件行号。
- 两轮结论冲突的 issue 2 已重验到根因（zstd 单帧解码）。
- issue 5：我方第一轮「部分属实」的判定经重验更正为「不属实」（详见 2.3）。
- 「失败原因不持久」这条第一轮判错了，成因是读取时机而非产品行为；修复方案已全部回滚。
- 回归验证：`packages/agent-team` 680 passed / 0 failed，
  `packages/client-agent-team/tests` 280 passed / 0 failed。
- 本次为只读调研，**未改动产品代码**；建议的修复均未落地。

## 待报告者补充（不阻塞）

- Issue 1 中“三个成员全部指向第一个”的具体创建路径（是否经外部桥 `team-bridge`）。
  两轮用 UI 与直接注入 roster 的方式均未能复现该现象；
  “刷新后恢复”这部分已有成立的解释（1.1）。
