# Review 01 — Agent 工具与上下文呈现

**Conclusion:** Changes needed
**Work item:** agent-tools-context-rendering
**Ticket:** Whole work item（01–07）
**Compared:** `deaa671..805394f`，另含工作树未提交改动（性能工作项，范围外）
**Commits:** `56e5a92`、`b48f3b5`、`241f8f8`、`8085867`、`1e95b83`、`6b6b7f2`、`05bf168`、`b1af731`、`4d4cf87`、`805394f`
**Reviewed:** 2026-10-30

三路独立审查（Spec / Correctness / Standards & simplicity）与主线程逐条核对后确认。**Spec 审查第 1 条与 Correctness 审查第 1 条已在本次核对中复现、定位并修复**；其余发现按本节列出。

## Findings

### 高 — Agent 的 Main read 丢弃已读 Thread card（已修复）

**位置：** `packages/agent-team/src/index.ts` 的 `mainReadContext`
**证据：** Host 用 `[...background, ...unread]` 整体替换 `read.entries`，而 `background` 只保留 `kind === 'message'`，ledger 产出的已读 `thread-card` 被丢掉。真实 Host 复现：先读一次消费 card，再 post 一条新消息后第二次 read，`deaa671` 返回 `[["thread-card",6,false],["message",8,true]]`，本工作项 HEAD 返回 `[["message",8,true]]`。唯一覆盖 `Thread cards` 渲染段的测试（`packages/tool-agent-team/tests/team-tools-render.spec.ts`）直接喂 entries，绕过 Host，因此没有暴露。
**影响：** Member 读一个只有新未读消息的 Main stream 时，之前已确认过的 Thread card 一行不出现；`docs/team-collaboration/tools.md` 承诺的 card 行永不出现。Thread read 仍正常，两条路径行为不对称。
**依据：** spec §4「背景、当前状态、未读事实明确区分」；`docs/team-collaboration/tools.md` 的 `Thread cards` 段。
**Suggested fix：** 保留 ledger page 中的 `thread-card`，与 background、unread 去重后按 sequence 排序。（已实施，见回归测试。）

### 中 — `team_thread message` 读一条已在上下文中的长消息时返回零长度 part（已修复）

**位置：** `packages/tool-agent-team/src/reading-budget.ts` 的分段分支
**证据：** 真实 Agent loop 复现：40 000 字符消息，`call 0` 返回 `0-32197`，`call 1` 返回 `32197-40000`，`call 2` 起返回 `Message part 40000–40000 of 40000 — complete in current context` 加一个空 `<message-part>`，全文 358 字符，正文彻底消失。原代码在容量判断之后才计算 `missingMessageRange`，`missing === undefined` 时 `start = gapEnd = body.length`。
**影响：** 成员为引用而重复查询同一条已拼全的长消息时，结果不含任何正文；正文超过容量时同一调用直接失败并建议"让发送方改短"，而正文本来就在上下文里。`message` 从不确认已读，账务状态不受影响。
**依据：** spec §4.1「一次调用必须前进或明确指向可用的续读动作，不能反复返回同一开头」；§4.2 已提供内容的确认。
**Suggested fix：** 把 `missingMessageRange` 提到容量判断之前；`missing === undefined` 时下发 `bodyOmitted`，渲染 `body already in current context; omitted`。（已实施，见回归测试。）

### 低 — `readingCapacity` 对非 `NO_ADAPTER` 错误一律抛出（已修复）

**位置：** `packages/tool-agent-team/src/reading-budget.ts` 的 `readingCapacity`
**证据：** Harness 的 `resolveModelInfo` 会因 `INVALID_MODEL_INFO`、`INVALID_MODEL_CONTEXT`、适配器连接失败等原因 reject；原代码只兜 `NO_ADAPTER`。
**影响：** 模型元数据不可用或连接短暂失败时，每次 `team_thread` 调用都失败，包括本不需要容量信息的 `read`/`history`。
**Suggested fix：** 只对 `ABORTED` 重抛，其余一律回退保守的 256 KiB。（已实施。）

### 低 — `history` 也求解模型容量（已修复）

**位置：** `packages/tool-agent-team/src/index.ts` 的 `team_thread.execute`
**证据：** `readingCapacity` 在所有 action 分支之前无条件调用，而 `history` 走按条数分页、不经 `budgetReading`。
**影响：** 同上：`history` 因无关的模型元数据失败。
**Suggested fix：** 仅 `read` 与 `message` 解析容量。（已实施。）

### 低 — Main/Thread 读取的 preview 与 commit 重复同一段推导（已修复）

**位置：** `packages/agent-team/src/ledger.ts` 的 `readMainStream` 与 `previewMainStreamRead`
**证据：** 两处重复 `mainHeadFrom` → backlog 取页 → `readThrough` 校验 → `prepareMainReadFrom`；有 select 回调时 `readMainStream` 先完整推导一次再自己推导一次。`jscpd` 将 `[1326:39 - 1332:9]` 与 `[1361:25 - 1366:10]` 列为 clone。
**依据：** `AGENTS.md`「Keep one authoritative formatter/projection per domain concept」。
**Suggested fix：** 抽私有 `planMainRead` 共用。（已实施，clone 数 11→9，重复行 95→80。）

### 低 — 三个导出无本仓使用者（已修复）

**位置：** `READ_MAX_CHARACTERS`、`isActivityOnSurface`、`renderMemberMemoryUpdate`
**证据：** 三者只在本文件内调用；`renderMemberMemoryState`/`renderMemberMemoryUpdate` 的 `privateMemoryPath` 默认值唯一调用点均显式传参。
**Suggested fix：** 去掉 `export` 与未用默认值。（已实施。）

### 低 — 三处重复的 rejection meta 组合（已修复）

**位置：** `packages/tool-agent-team/src/index.ts` 的 `team_message`（两处）与 `team_task`（一处）
**证据：** 三处相同的 `{ kind, teamFacts: teamMessageSurface(...) }`；`jscpd` 独立确认 `[1017:39 - 1024:11]`↔`[1286:40 - 1293:11]` 与 `[1032:45 - 1039:67]`↔`[1294:41 - 1305:67]`。
**Suggested fix：** 抽 `rejectionMeta(value, rendered)`。（已实施。）

### 低 — 文档称选择性 read 的幂等重试返回"current unread picture"，实际不是

**位置：** `docs/team-collaboration/tools.md`（及 `.zh.md`）对应句；`packages/agent-team/src/ledger.ts` 的 requestId 重放分支
**证据：** 重放以 `selectedThroughSequence: 0` 重算，批次恒为空；`ledger.ts:2214` 附近。
**影响：** 同一 requestId 重试且期间有新事实时，结果报"0 确认、N 未读"，而非展示新未读事实。读者按文档会高估重试的信息量。
**Suggested fix：** 改文档，说明幂等重放返回存档水位与当前剩余计数，不重新展开未读事实。**已实施**：`8fe4c07` 双语同步修正。

### 低 — 通知里"与读者的关系"只对 accept 显式

**位置：** `packages/agent-team/src/activity-facts.ts`、`packages/agent-team/src/index.ts` 的通知构造
**证据：** `accept` 有专门的 `acceptanceNotification`；`transfer`、ownership 变化只有事件字段，读者关系需从 `from`/`to`/Member 推断。
**影响：** 被转移责任的 Member 收到通知只看到 `from X · to Y`，没有一句"你是新责任人"。
**Suggested fix：** 为 transfer 增加同类的读者关系句。**未实施**——属于通知文案增强，非缺陷，需产品判断是否值得增加输出。

### 低（文档）— 验收计划把单元测试描述成 ScriptedAdapter 固定行为

**位置：** `.scratch/archive/2026-11/agent-tools-context-rendering/materials/2026-10-30-acceptance-plan.md`
**证据：** 该文件称表中测试"通过 ScriptedAdapter 固定模型行为"，但这些多为 Host/ledger/Session 单元测试；`member-context-integration.spec.ts` 以 `ctx.provide('agentTeam', ...)` 替换 Host 服务。
**影响：** 不影响结论方向（该计划本身是保守表述），但机制描述不准确，读者会高估覆盖范围。
**Suggested fix：** 更正描述。**未实施**——`.scratch` 是工作材料，按 `.scratch/AGENTS.md` 不由本次审查改写。

### 低（提交规范）— 两个提交的 message 带 body

**位置：** `805394f`、`4d4cf87`
**证据：** 两者各多一行 `Entire-Checkpoint: <id>`。来源是 Entire CLI 的 `prepare-commit-msg` hook，非手写；前 60 个提交中仅此 2 个。
**依据：** `AGENTS.md`「Write each commit message as one Conventional Commits subject line … with no body」。
**Suggested fix：** 关闭该 hook 后 reword。**未实施**——改历史需用户授权，且 `805394f` 是 master 的 tip。

### 已撤回的候选

- `activityFact` 的联合重载被 Standards 审查列为"无调用者"。实测删除后 `packages/agent-team/tests/surface-probe.spec.ts:86` 报 `TS2769: No overload matches this call`——`activityResult` helper 的参数是联合类型，是真实使用者。已恢复。
- Standards 审查建议抽公共函数处理 `team_message`/`team_task` 的 `presentationMeta` 剩余一对 clone（返回类型注解 + `renderRejection(value).text` 尾行）。这是两个不同工具的自然形状，抽它需按工具参数化间接层，收益低于复杂度，未改。
- `Earlier facts: N` 取自提交前 preview（Correctness 审查第 4 条）。只影响该行提示数字，规范未约定该字段，未改。

## Acceptance criteria

01–06 各项验收标准均已实现，证据见 Spec 审查逐条核对（`member-context.ts`、`surface-visibility.ts`、`ledger.ts`、`reading-budget.ts`、四个 `notification-*.spec.ts`、`team-addressing.spec.ts`）。下表仅列 07 与整体性标准。

| Criterion | Result | Evidence |
| --- | --- | --- |
| 逐工具核对 schema→Host→结果→render→错误恢复→文档 | Met | 各 tool 测试 + `docs/team-collaboration/tools.md` |
| persona、工具及参数说明、结果、core skill 各司其职 | Partial | `cordis.patch.yml` 常驻 persona 复述 `team_thread` 专有的续读/分段/容量规则，与工具 description 重复；违反 spec §7.3 |
| 已提交、未提交、已记录未送达、无法判定四态区分 | Met | `post-commit-delivery.spec.ts`、`team_dm` recorded-not-delivered 分支 |
| F1–F6 真实 Session/Host/tool 组合 | Met | `thread-read-context`、`main-read-context`、`thread-read-selection`、`surface-*`、`notification-*`、`activity-*` |
| 复用既有模型评测 harness 并运行 | Not verified | 未运行，README 标"待授权" |
| 比较目标完成、行动改变、误调用与恢复，重复样本 | Not verified | 同上 |
| 量测脚本区分 Session/日志/surface/累计输出 | Met | `harness/context-volume.mts`、`harness/README.md` |
| 文档、README、core skill、CHANGELOG 对齐实现 | Met | 全套双语文档改动 + `check:docs` |
| 未做项明确记录，不宣称模型验收完成 | Met | 工作项 README 状态行、07 两项未勾 |

## Checks run

| Command or check | Result |
| --- | --- |
| `npx vitest run --project suite`（干净基线，性能改动暂存） | 133 files / 1506 tests 通过，1 原有跳过 |
| `npx vitest run --project suite`（修复后工作树） | 133 files / 1509 tests 通过，1 原有跳过 |
| `npm run typecheck`（性能改动暂存） | 通过 |
| `npm run check:docs` | 通过（28 份文档、28 对双语、56 个最长块在上限内） |
| `npm run check:core-skills` | 通过（team-domain-model 7814/7850） |
| `npm run check:boundaries` | 通过（112 个源文件） |
| `npm run check:comments` | 通过（四目录全部在上限内） |
| `npm run lint` | 仅原有 2 条 `ledger.ts` warning，无新增 |
| `npx jscpd --config .jscpd.json packages/agent-team/src packages/tool-agent-team/src` | 修复后 clone 11→9，重复行 95→80，重复 token 967→833 |
| `node --import tsx .scratch/active/.../harness/context-volume.mts <snapshot>` | 1 输入文件、1 Session、16 次请求，与记录一致 |
| Thread card 回退复现（真实 Host，`deaa671` vs HEAD） | `deaa671` 保留 card，HEAD 丢失；修复后与 `deaa671` 一致 |
| 长消息 `message` 空 part 复现（真实 Agent loop） | 第三次调用起零长度 part；修复后为 274 字符的 omitted 说明 |
| `deaa671` 全量测试 | 通过（确认上述两条是本工作项引入，非既有） |

## Unverified scope and residual risk

- **真实模型评测未运行**：07 剩下两项（复用模型评测 harness、比较目标完成/行动改变/误调用恢复并重复样本）需要本轮模型配置与费用授权。未授权不得运行，不得复制归档凭据。**07 不能标 complete 或归档。**
- **typecheck 当前为红**：`packages/agent-team/tests/post-commit-delivery.spec.ts:214,230` 报 `TS7034`/`TS7005`，来源是未提交的性能工作项新加测试（`const members = []` 缺类型标注）。把性能改动 stash 后 typecheck 干净通过。属性能工作项收尾事项。
- **`npm run test:browser` 未跑**：本工作项不改 Client、Remote、manifest 或 Web 组装；相邻提交 `b48f3b5` 的 mention picker 是可见 UI 改动，其 browser 运行记录在工作项 README，但提交树本身无法证明是针对最终 mention 改动跑的。建议向操作者确认一次。
- **未推送**：master 领先 `origin/master` 12 个提交。
- **性能工作项未提交**：`package.json`、`packages/agent-team/src/index.ts`、`ledger.ts`、`tests/post-commit-delivery.spec.ts`、`scripts/README.md`、未跟踪的 `scripts/team-performance/` 仍在工作树。
- 两处低危未实施项（幂等重放文档措辞、transfer 读者关系句）与一项提交规范问题（Entire-Checkpoint trailer）见 Findings。

## Review record

- Spec sources: `.scratch/archive/2026-11/agent-tools-context-rendering/spec.md`（§2 三状态、§4 读取与恢复、§4.1 长内容、§4.2 已提供内容的确认、§5 写入条件、§6 通知、§7 工具结果与规则放置、§9 完整流程与验收）；`issues/01`–`07`；`materials/2026-10-29-accepted-flows.md`；`materials/2026-10-30-acceptance-plan.md`；`materials/2026-10-29-implementation-progress.md`
- Standards sources: `AGENTS.md`、`docs/AGENTS.md`、`docs/development/start-and-checks.md`、`docs/architecture/package-ownership.md`、`.scratch/AGENTS.md`
- Uncommitted and untracked changes included: 否。性能工作项的 5 个已修改文件与未跟踪的 `scripts/team-performance/` 全程排除在审查外；仅在核对 typecheck 失败归因时暂存对比，已完整还原（diff 与审查前逐字节一致）。本次核对中产生的源码修复与两条回归测试在工作树中，尚未提交。
