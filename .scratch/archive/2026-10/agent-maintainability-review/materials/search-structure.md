# 搜索与职责调查（只读）

## 0. 快照与范围

- 仓库 HEAD：`001f8f1f00fea518ba95cfea24370f97e0b2f1f6`（master）
- 工作区未提交改动（原样保留，未触碰）：`packages/client-agent-team/src/client/{TeamChannelPage.tsx, TeamChannelPanel.tsx, TeamPanelHandle.tsx, channel.module.css, conversation.module.css, panel-width.ts}`、`packages/client-agent-team/tests/panel-width.spec.ts`、`scripts/team-ui.e2e.ts`
- Node v24.15.0 / pnpm 11.7.0
- 本轮只做只读检索与阅读：未运行测试、构建、生成器或浏览器命令；未改任何业务文件。
- 未读取 `.scratch/archive/` 下的历史审查结论，也未使用 `design-basis.md` 作为事实来源。
- 导航起点只有 `docs/README.md`；行为判断依据为 `packages/**` 源码与测试。

方法说明：三个维护任务各自从自然语言需求出发，先记录原始检索词与误命中，再看实现与测试；不先读答案倒推。后文每条结论分「事实（可复核路径）」「推断」「反证尝试」「未验证」。

---

## 1. 盲查实验记录（按任务）

### 任务 A：同一 `requestId` 重放、payload 不同时怎么处理

| 步骤 | 原始查询 | 结果 |
| --- | --- | --- |
| A1 | `rg -n 'requestId' packages -l` | 30+ 文件，包含 Client 组件（由前端生成 requestId）、`tool-agent-team`、`context-continuity-host`。方向性噪声大 |
| A2 | `rg -c 'requestId' packages --glob '*.ts' \| sort -t: -k2 -rn` | 命中重心：`tests/agent-team.spec.ts`(493)、`tests/member-lifecycle.spec.ts`(459)、`src/ledger.ts`(62)。这一步才把入口定到 ledger |
| A3 | `rg -n -i 'idempot' packages scripts docs` | 产出真正的领域词：`docs/architecture/host-authority.md:137`（upload 的 requestId 就是幂等键；同 payload 重放、不同 payload 拒绝为 request collision）、`ledger.ts:149,163` |
| A4 | `rg -n -i 'collision\|different payload' packages/agent-team/src` | 找到唯一抛出点 `ledger.ts:4553 throwRequestCollision` 与 `attachments.ts:120,138,154` |
| A5 | `rg -n 'assertSame[A-Za-z]+' packages/agent-team/src/ledger.ts` | 44 处调用 / 23 个不同方法，分布在 `ledger.ts:4317-4490` |

需要跳读的文件：`src/ledger.ts`（4762 行，必须跳到 4290-4560 才看到比较器与错误），`tests/operation-protocol.spec.ts`（1287 行，真正的重放契约表在 514-1090），`tests/attachments.spec.ts`（分散 5 处断言）。**没有**一个名为 `idempotency.ts` / `request-comparison.ts` 的文件，检索必须靠 "collision" 这个词或直接进 ledger 的公共方法体（`byRequest` 分支）。

误命中：`requestId` 在 Client 侧也有大量出现（`client/requests.ts`、`TeamThreadPage.tsx:175` 等），这些是"生成新 id"而非"重放判定"，A1 阶段无法区分。

### 任务 B：普通 Session 为什么会出现 Team 工具

| 步骤 | 原始查询 | 结果 |
| --- | --- | --- |
| B1 | `rg -n 'team-member' packages -l` | 20 个文件，绝大多数是 Client/测试，噪声高 |
| B2 | `rg -n 'presetId' packages -l` | 26 文件，主要是 Member 增删改，不是隔离机制 |
| B3 | `rg -n 'isolate' docs cordis.patch.yml packages` | 命中权威点：`cordis.patch.yml:5-25`（`isolate.agentPresets: true` + 私有 registry `default: team-member`）；`docs/harness-navigation.md:71` 复述 |
| B4 | `rg -n -i 'ordinary session' packages docs` | 命中守卫测试 `tests/member-tool-policy.spec.ts:352`、`tests/member-lifecycle.spec.ts:2303` |

需要理解的文件：`cordis.patch.yml`（全仓唯一 preset 定义处，`config.plugins` 内联）、`packages/tool-agent-team/src/index.ts`（工具定义）。注意 `packages/agent-team/preset/` 目录已不存在（见结论 1）。

### 任务 C：Team 卸载后 sidebar 没恢复

| 步骤 | 原始查询 | 结果 |
| --- | --- | --- |
| C1 | `rg -n 'restore\|leaveTeam\|selectPanel' packages/client-agent-team/src` | 命中 `client/index.ts:390-410`（member session restore effect）、`~455-480`（panel ownership effect）、`client/navigation.ts` |
| C2 | `rg -n 'remote.agentTeam\|slots.inject' packages/client-agent-team/src/client` | 入口两条：`index.ts:553`（`ctx.inject(['remote.agentTeam'])` 后才 `applyUi`）、`index.ts:119,126,299,501` 四处 slot 注册 |
| C3 | 测试定位 | `tests/team-mode-conversation.client.spec.tsx`、`tests/team-mode-agents.client.spec.tsx:441-477`（普通 Session 选择被保留的断言） |

需要理解的文件：`client/index.ts`（554 行，同时是插件入口、Remote 装配、4 个恢复/所有权 effect、settings section）。恢复逻辑没有独立模块，检索只能靠 effect 字符串 `'agent-team: member session restore'`、`'agent-team: panel ownership'`。

---

## 2. 候选结论

### 结论 1：AGENTS.md 指向已被删除的 `packages/agent-team/preset/`

- **事实**：`AGENTS.md:59` 写「Tools and preset: `packages/tool-agent-team/`、`packages/agent-team/preset/`」。该目录不存在：`ls packages/agent-team/preset` 报错；`git log --diff-filter=D -- 'packages/agent-team/preset/*'` 显示 `72c53ad2 chore: certify the stable line against dsh 0.1.7-rc.1` 删除了它。真实定义位置是 `cordis.patch.yml:22-25`（`@deepseek-ai/dsh-agent-preset` 行内联 `config.plugins`），`cordis.patch.yml:19-21` 的注释也把旧目录描述为"retired roster"（历史表述，正确）。`tests/shipping.spec.ts:293` 明确断言 manifest 不再包含该路径。
- **维护任务中的代价**：任务 B 中按 AGENTS 指路会先 `ls` 一个不存在的目录，然后必须自行推断 preset 在 YAML 里；这是"入口指错"，不是"文件太大"。
- **反证尝试**：`rg -n 'packages/agent-team/preset' -g '!node_modules'` 全仓只有 3 处：`AGENTS.md:59`、`cordis.patch.yml:21`（retired 语境）、`shipping.spec.ts:293`（否定断言）。`docs/architecture/tools-and-preset.md:5,9` 与 `docs/harness-navigation.md:71` 都正确指向 preset 定义行/Cordis patch，说明其余导航已更新，只有根 AGENTS 未同步。
- **分类**：**已证实缺陷**（导航文档过期，低成本修复：把 `packages/agent-team/preset/` 改为 `cordis.patch.yml` 的 preset 行）。未验证：是否有脚本检查 AGENTS 中的路径存在（`scripts/check-docs.mjs` 未读）。

### 结论 2：幂等/冲突判定没有独立可检索的入口，错误文案是跨 6 个测试文件的隐式契约

- **事实**：唯一判定点是 `throwRequestCollision`（`packages/agent-team/src/ledger.ts:4553-4555`，文案 `was reused with a different operation or payload`）；`attachments.ts:154` 复制了同一句文案（`attachments.ts:120,138` 注释说明这是刻意的同一语义）。同一个 requestId 的"同 payload 重放"分支在每个公共方法开头以 `this.state.byRequest.get(request.requestId)` 复现，共 20+ 处（`ledger.ts:598,622,650,672,708,761,792,916,949,991,1031,1086,1136,1167,1232,1300,1340,1377,1418,1656,3809`），payload 相等性判定分散在 23 个 `assertSame*` 私有方法（`ledger.ts:4317-4490`）。
- **维护任务中的代价**：定位"重放判定"必须先知道 `byRequest` 或 collision 文案；新写一个操作的作者要同时改：公共方法、`assertSame*`、`applyTo`、`validateOperation`、`changeScopesOf`，分处 5 个不同行段（592-1650 / 4317-4490 / 2784 / 2198 / 2033）。
- **反证尝试（削弱了缺陷主张）**：`tests/operation-protocol.spec.ts:519-540` 用 `Record<AgentTeamOperation['kind'], ProtocolRow>` 在编译期强制每个 kind 声明 `retry.same` / `retry.changed`，并在 `:1217-1223` 实际驱动"同 id 同 payload 必须 resolved、同 id 改一个字段必须 collision"。缺行会 typecheck 失败，比较器写错（例如漏比一个字段）会让 `changed()` 不抛错而红。因此"人会忘记加比较器"这一风险已被现有测试挡住；真正剩下的代价只是**检索路径长**，不是漏检。
- **分类**：**改进（可检索性）**，非缺陷。若要做，最小收益动作是把 23 个 `assertSame*` 收进一张按 kind 索引的表并放到独立文件（纯函数，不引转发层），这样"重放相等性"有一个名字可搜。不建议把 `byRequest` 前置分支抽成装饰器——那会把授权、校验顺序藏起来。未验证：协议表是否覆盖 `attachments` 的 upload/send 路径（`attachments.spec.ts:311-313` 有独立断言，但未逐行核对）。

### 结论 3：`ledger.ts` 4762 行的真实职责是 7 类，其中只有两类可以无成本移出

- **事实（方法清单与行段）**：
  | 行段 | 职责 | 变化原因 |
  | --- | --- | --- |
  | 526-560 | `Projection` 状态与索引 | 新增索引 |
  | 592-1453 | 35 个写请求（含 byRequest 重放分支） | 新增业务操作 |
  | 1470-2000 | 读/查询/view/status/validate 入口 | 新增读面 |
  | 2001-2160 | change scope 派生、affected members | Client 唤醒语义 |
  | 2170-2770 | 重放校验（`validateOperation` 单函数 2198-2586，约 390 行） | 不变量收紧、legacy 修复 |
  | 2784-3150 | `applyTo` 单函数（2784-2944，约 160 行）+ inbox delta 应用 | 投影语义 |
  | 3159-3560 | 读回执、未读计算、Inbox delta 构造 | 阅读模型 |
  | 3829-4270 | ref/授权/可见性辅助 | 权限收紧 |
  | 4290-4560 | 请求比较器 + `same*` + 错误 | 新增操作 |
- **推断**：可无转发层移出的只有 4290-4560（比较器，纯函数：`(stored, request) => boolean`）与 4660-4720 的 legacy 修复/`normalizeOperation`（纯函数：`(operation, projection) => operation`）。`validateOperation` 与 `applyTo` 必须与 `Projection` 私有字段同处一文件，否则要么暴露内部状态、要么造出 getter 转发层——这两块**建议保留现状**。
- **反证尝试**：编译期已有 `assertUnhandledKind(operation: never)`（`ledger.ts:458`），新增 kind 时 `applyTo` / `validateOperation` 的 `switch` 会 typecheck 失败，所以"巨型 switch 漏分支"不成立；移动它们的主要收益只是文件行数，不值得拆。
- **分类**：**改进（有限：移出比较器与 legacy normalizer）**；其余 **合理保留**。未验证：是否存在跨文件共享的 `Projection` 类型（`interface Projection` 未 export，`ledger.ts:371`），这决定了第一个拆分是否真的零成本。

### 结论 4：`index.ts` 4003 行的实体是「Typert Remote 服务 + 组合根 + 生命周期」，Remote 方法不可移出

- **事实**：`packages/agent-team/src/index.ts:492 export default class AgentTeam extends TypertRemoteService`；`static inject`（`:496-506`）声明 8 个服务；构造函数（`~665-780`）就地组装 10 个协作者（`MemberRuntime`、`RecoveryCoordinator`、`TeamContextProjectionHost`、`createTeamContextManagement`、`TeamPressurePolicy`、`TeamContextJudge`…）；Remote 方法面（`view`/`sendMessage`/`updateMember` 等）与成员生命周期方法（`activate`/`swap`/`executeMemberTransition`）在同一类上。
- **维护任务中的代价**：搜"member activation"会落在 4000 行文件；但 `member-runtime.ts`（550 行）与 `context-continuity-host.ts`（395 行）已经把两块实质性逻辑移出，说明拆分是渐进发生过的。
- **反证尝试（支持保留）**：`package.json` 的 exports 把 `./host` 指向 `packages/agent-team/lib/index.js`，`lib/typert.host.*` 由该类的装饰器生成（`docs/architecture/client-and-remote.md` 声明 Typert 产物由声明生成，且禁止手改）。把 Remote 方法挪到独立类会需要委托方法，等于转发层，并会改动生成器的输入形状——正好是任务说明里"只为行数制造转发层"的情形。
- **分类**：**合理保留**（Remote 面 + 组合根）。可选的局部改进：`replyContextsFor` / `withReplyTo` / `repliesToLine`（`:861-940`，纯投影辅助）与 `judgeConfig`/`refreshGate`/`humanHandle` 等无状态辅助可移入已有模块，收益仅为可读性。**未验证**：Typert 生成器（`scripts/generate-typert.mjs`）是否要求所有 Remote 方法同处一类——只能从 `lib/typert.*` 存在与否间接推断，未读生成器。

### 结论 5：Client 的「进入/退出/恢复」没有单一所属模块，四个 effect 各自订阅不同服务

- **事实**：`packages/client-agent-team/src/client/index.ts` 内，Team 模式与 sidebar/panel 的关系由四个彼此独立的 `ctx.effect` 承担：`'agent-team: member session restore'`（`:390-410`，订阅 `navigation`，条件式 `openSession(returnTo)` 与 `selectPanel(TEAM_PANEL_ID)`）、`'agent-team: change subscriptions'`、`'agent-team: panel ownership'`（`:455-480`，订阅 `layout.panelInfo`，负责 activePanelId ↔ mode 单向同步，另有一次性的 reload 恢复）、`'agent-team: mode marker'`（document dataset）。当前会话选择通过 `currentMainSessionId`（`:83-88`）从 `sessions.list.byId` 的 `retainedBy.mainView` 反查。
- **维护任务中的代价**：任务 C 的"卸载后 sidebar 没恢复"必须同时读懂 `navigation.ts`（状态机）、两处 effect 的触发条件、以及 `0.1.7` 没有公开 clear 这一约束（`:388-395` 注释）。检索"restore"只命中第一个 effect，容易漏掉 `panel ownership` 里那段一次性 reload 恢复（`:472-476`）。
- **反证尝试**：这种分散有明确理由——它订阅的是三个不同服务（navigation、layout、connection），合并成一个 effect 会引入跨服务的隐式顺序；且 `openMemberSessionImpl`（`:145-180`）已经集中了"进入 Member Session"的协调（含失败回滚）。测试侧 `tests/team-mode-agents.client.spec.tsx:441-477` 覆盖了"添加 Member 不抢走 Human 普通 Session"与"return target 捕获"。
- **分类**：**待验证**。若要判定为缺陷，需要一条具体失败：例如"Team 卸载（bundle 行移除）时 sidebar 是否恢复"——`connection/reset` 只重建流（`:445`），没有看到"Team 行消失后清 `agentTeamMode` / 恢复普通 sidebar"的代码路径，但卸载属于 Cordis fiber 销毁，副作用应由 `ctx.effect` 的 disposer 完成（`:478-489` 有清理 `dataset`）。**未验证**：未运行任何 Client 测试，也未读 `navigation.ts` 全文，因此不能断言存在残留缺陷；建议由测试调查者用现有 client spec 或 browser 路径验证"卸载 → 普通 DSH 恢复"。

### 结论 6：命名只在一处造成真实检索歧义（`types.ts` 与 `types/` 并存），其余不建议改名

- **事实**：`packages/agent-team/src/types.ts` 与 `packages/agent-team/src/types/`（`entities.ts`、`operations.ts`、`requests-results.ts`）同时存在；`src/index.ts:164` 是 `export type * from './types.ts'`，测试与 Client 都从 `@contexera/dsh-agent-team/types` 或 `../src/types.ts` 导入（`tests/operation-protocol.spec.ts:40-56`）。`package.json` 的 `./types` 出口指向 `lib/types/types.d.ts`，说明 facade 是已发布契约。
- **维护任务中的代价**：要找"操作种类"时，`rg 'AgentTeamOperation'` 先命中 facade，再跳 `types/operations.ts`（425 行）；多一跳，但方向明确。
- **反证尝试**：facade 是公开导出面（改名会破坏 `exports`），且 `types/` 拆分按领域（实体/操作/请求结果）已经比单文件清晰；`data`/`config`/`utils` 这类泛化名在本仓未出现于 `packages/**/src`（`config` 只作为 `Config` 接口名，`index.ts:419`）。Client 侧 `team-formatters.ts`(531)、`team-queries.ts`(339) 等命名具体，检索命中率高。
- **分类**：**合理保留**（facade 与目录并存）。唯一可考虑：在 `types.ts` 顶部用一行注释说明"facade，实质定义在 `types/`"，降低一跳的困惑——但这属于注释预算（`check:comments`）管辖，收益很小，可不做。

---

## 3. 超长文件清单（本轮观察，非完整基线）

| 文件 | 行数 | 性质 |
| --- | --- | --- |
| `packages/agent-team/tests/member-lifecycle.spec.ts` | 5506 | 测试，按场景聚集 |
| `packages/agent-team/src/ledger.ts` | 4762 | 手写实现（见结论 3） |
| `packages/agent-team/src/index.ts` | 4003 | 手写实现 + Remote 面（见结论 4） |
| `packages/agent-team/tests/agent-team.spec.ts` | 3120 | 测试 |
| `packages/client-agent-team/tests/team-mode-conversation.client.spec.tsx` | 1343 | 测试 |
| `packages/agent-team/tests/operation-protocol.spec.ts` | 1287 | 测试（表驱动，见结论 2） |
| `packages/client-agent-team/src/client/TeamThreadPage.tsx` | 1010 | UI 组件 |
| `packages/agent-team/src/types/requests-results.ts` | 1008 | 类型声明 |
| `packages/tool-agent-team/src/index.ts` | 1003 | 7 个工具定义 + 共享规则 |
| `scripts/team-ui.e2e.ts` | 工作区有未提交改动，未统计/未审查 | 脚本 |

说明：此表只用于职责分析，不是完整机械基线；完整计数与"生成物/vendor 除外"的口径属主 agent 的盘点任务。

---

## 4. 本轮未覆盖

1. **未运行任何测试/类型检查/浏览器命令**，所有"现有测试能挡住"的判断都来自阅读断言，未实证红绿。
2. **未读** `packages/agent-team/src/spec.ts`（563 行，Zod schema 与 domain spec）、`scripts/generate-typert.mjs`、`scripts/check-docs.mjs`、`packages/client-agent-team/src/client/navigation.ts` 全文，因此结论 4 关于 Typert 约束、结论 1 关于是否有路径检查、结论 5 关于状态机完整性均属未验证。
3. **未覆盖 Host 重启重放的运行时证据**：只读了 `ledger.ts:2170-2198 replay()` 与 `validateRecords` 的存在，未逐行核对"重启后 `byRequest` 重建"与 SQLite/JSON 双路径差异，也未查 `invariant.ts` 的启动校验。
4. **未覆盖 preset 隔离的"guidance / private memory"两层**：只确认了工具缺失有测试（`member-tool-policy.spec.ts:352`）与 `context_rollover` 缺失有测试（`member-lifecycle.spec.ts:2303`），没有找到断言"普通 Session 不注入 Team persona 段落"的测试；`docs/architecture/tools-and-preset.md:5` 声明了这一条。若需要，检索建议：`rg -n 'prefix\|systemPrompt\|guidance' packages/agent-team/tests packages/tool-agent-team/tests`。
5. **未覆盖** `scripts/team-ui.e2e.ts` 的职责（工作区正在改），以及 `artifacts/` 下产物。
6. 结论 2、3、5 的"改进收益"是阅读推断，未做拆分原型，也未测改动后的检索步数。

---

## 5. 供复核者的最短复现命令

```bash
ls packages/agent-team/preset                         # 结论 1：目录不存在
rg -n 'packages/agent-team/preset' -g '!node_modules' # 结论 1：仅 3 处引用
rg -n 'assertSame[A-Za-z]+' packages/agent-team/src/ledger.ts | wc -l   # 结论 2：44
rg -n 'was reused with a different operation or payload' packages        # 结论 2：定义 2 处 + 断言 6 处
rg -n "readonly [a-z]*: RetryCoverage|Record<AgentTeamOperation\['kind'\], ProtocolRow>" packages/agent-team/tests/operation-protocol.spec.ts  # 结论 2 的反证
rg -n "private (validateOperation|applyTo)\(" packages/agent-team/src/ledger.ts           # 结论 3：2198 / 2784
rg -n "assertUnhandledKind" packages/agent-team/src/ledger.ts                             # 结论 3 的反证
rg -n "agent-team: (member session restore|panel ownership)" packages/client-agent-team/src/client/index.ts  # 结论 5
```
