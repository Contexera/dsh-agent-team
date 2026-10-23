# Team Member 工具面控制权缺口

日期：2026-10-23
范围：`team-member` preset 的 model-facing 工具面
状态：调查完成，未实施修改

## 1. 结论

`team-member` preset 声明的工具表在当前 Harness 公开 API 下**不是封闭集合**。

`tools.restrict({ allow })` 只过滤从 global 和祖先 scope 继承来的工具，不过滤注册在 Member 自己 agent scope 上的工具。任何插件只要在 `agent/created` 事件里往 `agent.ctx` 注册工具，就能把工具加进 Member 的工具面，绕过 preset 的白名单。

已确认的污染实例：官方 `@deepseek-ai/dsh-experimental-tool-agent-team` 在启用后会向 Team Member 注入 9 个工具和 2 段 Team 提示词。

`validateMemberPreset` 只做正向检查（7 个 Team 工具是否在位），不做反向检查（是否多了工具），因此污染静默通过。

## 2. 根因

### 2.1 Harness 的工具分层

`ToolRuntime.view()`（`deepseek-harness/packages/core/tools/src/index.ts:1186-1227`）：

```
inherited（global + scope chain，preset 属于这一层）
    ↓ 被 restrict 的 allow/deny 过滤
own（本 scope 自己的注册）
    ↓ 无条件进入 visible，注释写明 "outside the filter above"
visible
```

两处关键事实：

- `restrictableNames` 只由 inherited 循环填充（`:1200-1206`），own 层的工具名不在其中。因此连 `restrict({ deny: ['spawn_teammate'] })` 都做不到——会抛 `unknown global tool`（`:1123-1126`）。
- `schemas()`（`:1268`）和 `wireSchemas()`（`:1019-1037`）只读 `view().visible`，不查 guard。guard 影响执行，不影响模型可见的工具列表。

我们的 preset 位于 agent scope 的**父层**（`preset/agent-preset-registry/src/index.ts:265-274` 的 `bindScopeParent(agentKey, generation.key)`），所以 preset 里的 bash/fs/team_* 全在 inherited 层，能被 allow 过滤——这正是 `member-runtime.ts:110` 必须把 7 个 Team 工具并进白名单的原因。

### 2.2 三条通往 own layer 的通道

| 通道 | 说明 |
|---|---|
| `agent/created` 监听 | 官方 tool-agent-team 走这条，`install()` 里 `const scoped = agent.ctx`，随后 9 次 `scoped.tools.register` |
| `CreateAgentOptions.setup` | setup 拿到的就是 `prepared.agent.ctx`（`agent-loop/src/index.ts:811`），注册同样落 own layer |
| `agent.ctx.inject()` / `agent.ctx.plugin()` / `createScope(ctx, agent)` | 三者都复用同一个 scope key，落同一个 ToolLayer |

Cordis 的 `ScopedLayers` 以 scope 为键而非插件为键（`scope/src/store.ts:163`），所以同一 agent scope 上任意两个插件的注册落在同一个 layer，彼此无隔离。

### 2.3 时序

`agent-loop/src/index.ts:789-814` 的执行顺序：

```
setup(agentCtx, agent)          ← 我们在这里 mount preset + restrict
    ↓
setupCommit?.commit()
    ↓
prepared.publish(source)
    ↓
agents.enter() → announce()     ← 这里触发 agent/created，官方插件此时才注册
```

`core/agent/src/index.ts:552` 用 `serial` 分发 `agent/created`，逐个 await 且不吞异常。

结论：我们的 `restrict` 必然早于官方插件的注册，即使调整我们的代码时序也无法在 restrict 阶段预见对方的注册。

### 2.4 官方插件的 membership 检查为何无效

`experimental/agent-team/src/roster.ts:89-118` 的 `tryMembership()`：

- `parentSession === undefined` → 跳过成员查找，落到 `:111-112`：`if (this.subagentDescriptor(agent)) return undefined; return { root: agent, role: 'lead' }`
- `subagentDescriptor()`（`:468-471`）只认 session 后缀里的 `subagent/descriptor` 事件。我们的 Member 由 `ctx.agents.create()` 创建（`agent-team/src/index.ts:2197`），全仓无该事件写入。

因此我们的 Member 在官方眼里恒为 lead，`maybeInstall` 的 gate 放行。

前提条件：官方 tool-agent-team 的 `inject` 是 `['agents','agentTeams','tools','systemPrompt']`（`experimental/tool-agent-team/src/index.ts:17`），服务名是 `agentTeams`；本 bundle 的服务名是 `agentTeam`（`agent-team/src/index.ts:418`）。所以该威胁只在宿主**同时**组合了官方 experimental `agent-team` 包时成立。

### 2.5 污染的具体内容

来自 `experimental/tool-agent-team/src/index.ts`：

| 类别 | 内容 |
|---|---|
| 工具 | `spawn_teammate`(:192)、`send_message`(:221)、`list_agents`(:239)、`wait_agent`(:249)、`interrupt_agent`(:285，默认开启)、`team_task_create`(:298)、`team_task_list`(:322)、`team_task_get`(:354)、`team_task_update`(:369) |
| 提示词 section | `team:policy`(:173)，内容是与本 bundle语义冲突的协作指引 |
| 提示词 context | `team:identity`(:178)，告诉模型"You are the Team Lead named lead" |

附带影响：官方 profile patch 会 disable 掉 `tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-subagent-list-agents` 四个 global 行。如果某个 Member 的 `tools.allow` 里配了这些名字，激活时它们会落入 `capabilityWarnings` 并静默消失。

## 3. 影响范围

### 3.1 已确认（当前组合下会命中）

官方 `@deepseek-ai/dsh-experimental-tool-agent-team`，前提是宿主同时组合官方 experimental `agent-team` 包。

### 3.2 有条件成立（取决于宿主组合）

| 包 | 条件 | 对 Member 的影响 |
|---|---|---|
| `dsh-tool-subagent` 的 modelSelection 路径（`subagent/tool-subagent/src/index.ts:458-479`） | 该行出现在 Member 的 scope 链祖先上 | 工具注册落 own layer。当前 `team-member` preset 未列此行，故不命中 |
| `dsh-experimental-browser-use-runtime` 的 `/mcp` 子入口（`experimental/browser-use-runtime/src/mcp.ts:134,181`） | 宿主组合了 browser-use playwright/devtools MCP | 无 membership 检查，每个 live agent 都会拿到 `mcp__<server>__*` |
| `dsh-mcp-resources`（`mcp/mcp-resources/src/index.ts:108-118`） | MCP client 挂在 agent scope | `list_mcp_resources` 等落 own layer |
| `dsh-experimental-claude-code-mods`（`experimental/claude-code-mods/src/host-ops.ts:338,354`） | 宿主挂了该行且有 mod 调 `$.tool.register` | mod 的工具以 `mcp__<mod>__<tool>` 落 own layer |

### 3.3 不命中（已排除）

- `dsh-subagent` 的 `structured_output`（`subagent/src/structured.ts:83`）：只作用于声明了 `outputSchema` 的委派子 agent，Member 不经此路径。
- `dsh-acp`：Member 由 agent-team 激活，不经 ACP 建会话。
- 所有在 `agent/pre-step` / `agent/status` 里注册工具的包：全仓交叉搜索为空，不存在。
- 其他 experimental 工具包（ralph、terminal、session-query、worktree、cua、stagehand、computer-use 等）：注册落 global 或 preset scope，会被 allow 过滤。

## 4. 可选处理路径

### 4.1 同名抢占（可彻底阻断，但会破坏对方）

在 Member setup 里于 `agent.ctx` 上预注册官方 9 个工具的占位定义。依据 `scope/src/store.ts:43-46` 与 `tools/src/index.ts:746-750`，同 scope 同名注册抛 `tool "X" is already registered in this scope`。官方的 `install()` 有 try/catch 回滚（`tool-agent-team/src/index.ts:401-404`），该失败会让它的整个 install 回滚。

但失败会从 `agent/created` 的 serial 分发往上抛（`agent/src/index.ts:552`），经 `announce()` → `publish()` → `initializeAgent` 的 catch → `prepared.dispose()`（`agent-loop/src/index.ts:818-835`），**导致 Member agent 创建失败**。

结论：此路会阻断污染，但同时让 Member 无法激活。不可用，除非官方改为容忍安装失败。

### 4.2 guard 否决（行为正确，schema 仍可见）

在 Member scope 注册 `tools.guard()`，对白名单外的工具返回拒绝原因。依据：

- `tools/src/index.ts:1144-1150`：guard 存进本 scope 的 ToolLayer。
- `:1152-1162` `guardReason()`：先 global，再 `chainLayers(exec.agent)` 由远到近，第一个返回原因的 guard 决定结果，之后的 guard 不执行——单调否决，`prepend` 的 allow 也无法推翻。
- `:1527-1539`：guard 拒绝生成 `isError` 结果，工具 body 不执行。

局限：`view()` 不查 guard（`:1186-1227`），所以 9 个工具的 schema 仍会出现在模型的工具列表里。模型看得见、能调用、收到报错。行为安全，界面不干净。

### 4.3 无公开 API 可摘除对方注册

已核查 ToolRuntime 与 SystemPrompt 的完整公开成员：

- `ToolRuntime`：`presentAs`、`register`、`restrict`、`guard`、`get`、`schemas`、`executionMode`、`execute`。无 `list()` / `entries()` / `unregister()` / `has()`。
- `SystemPrompt`：`section`、`context`、`variable`、`tools`、`assemble`、`refreshContext`、`suppressRuntimeContext`、`getSectionOrder`、`getContextOrder`。无按名移除。
- 同 scope 内同名 section 注册直接抛错（`system-prompt/src/index.ts:407-415`），无法 shadow 掉对方的 `team:policy` / `team:identity`。
- 唯一能改掉别人贡献的公开接缝是 `system-prompt/assemble` waterfall（`:677-680`），可重写 sections/contexts/tools/variables 整个对象。

### 4.4 反向检测与诊断

在 `validateMemberPreset` 增加反向检查：比对激活后的 schema 集合与预期白名单，出现额外工具时记录诊断。这不阻止污染，但让污染可见、可归因。

## 5. 处理建议

按优先级：

1. **反向检测**（低风险，先做）。`validateMemberPreset` 已有 schema 快照，增加一次集合比对，把意外工具名写进 Member 的诊断字段。这让"谁污染了工具面"从静默变成可观测。
2. **guard 否决**（中等风险）。接受 schema 仍可见的代价，换取调用被拒。可与第 1 项共享同一份白名单常量。
3. **提示词污染单独处理**。即使工具被 guard 拦下，`team:policy` 与 `team:identity` 仍会进入系统提示词，与我们的协作语义直接冲突。`system-prompt/assemble` waterfall 是目前唯一公开的摘除接缝。
4. **同名抢占不做**。会让 Member 无法激活，除非上游改变错误语义。

文档侧：`docs/dsh-release-compatibility.md` 第 3.7 节已记录两套并存不受支持，但未记录污染路径与 own layer 语义。该节需要补充本报告第 2 节的机制说明。

## 6. 未验证项

- 污染复现：`web-dev` profile 当前未安装官方 bundle（`node_modules` 与 `cordis.patch.yml` 均无官方 agent-team 痕迹），污染现象由用户报告，未在本地复现。
- 共存运行：按第 5 节实施前，不建议在两个包同时挂载的 profile 里做验证，因为当前状态下 Member 激活本身就可能受第 4.1 节路径影响。
- guard 与官方插件注册顺序：若 guard 注册在官方插件之后，`guardReason` 仍按插入顺序遍历本层全部 guard，不影响否决效果；此点基于 `store.ts:139-141` 的插入顺序语义推断，未实跑。
