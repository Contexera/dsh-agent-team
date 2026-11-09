# #82：成员使用宿主插件工具的可行性

核对日期：2026-11-09。Team 源码基线 `b455aa8`（包版本 `0.2.7`）；Harness 引用固定到 `dsh-v0.2.2-rc.1`（`66491b05`）。本轮核对源码、测试断言和公开文档，尚未运行插件组合。

## 需求与现状

- [#82](https://github.com/Contexera/dsh-agent-team/issues/82) 记录了一个宿主看板插件：简报进入 Team 成员上下文，但 `project_*` 工具不可用。Issue 未提供插件名、源码或版本；不能判断它依赖当前 Session、Workspace 或哪一套权限。维护者提出由插件声明、用户选择、成员白名单再收窄的方向，未承诺实施。
- [#76](https://github.com/Contexera/dsh-agent-team/issues/76) 的起因是官方实验 Team 的工具混入。此前的[归档决定](../../../archive/2026-10/member-tool-surface-control/README.md)是限制工具执行，不隔离其他插件注入的提示。提示与工具各有入口；启用工具不解决提示注入，提示出现也不代表工具有授权。[当前架构说明](../../../../docs/architecture/tools-and-preset.md)记录了这一限制。
- [成员激活](../../../../packages/agent-team/src/index.ts#L2709)先挂载 preset，再执行[工具策略](../../../../packages/agent-team/src/member-runtime.ts#L100)。现有策略捕获 preset 工具定义及共享的 `working_directory`；成员白名单只能收窄，Team 工具和 `working_directory` 保留。执行检查绑定的是同一个工具定义对象，拒绝成员直接或嵌套调用未授权工具，拒绝改用同名定义。[测试](../../../../packages/agent-team/tests/member-tool-policy.spec.ts#L184)覆盖宿主全局工具默认排除、成员不能用白名单放行、同名替换拒绝，并明确验证后来直接注册到成员自身的工具仍可能出现在模型请求里，但调用被拒绝。两项保证应分别验收。
- [#79](https://github.com/Contexera/dsh-agent-team/issues/79) 的工作是把任务交给本机外部 Agent。#82 的工具仍由当前 DSH 成员发起调用；不依赖 #79 的执行引擎。

## 已有公开接口

- Harness 的 [工具注册和可见性](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L121)支持全局和按 scope 注册，近层可以覆盖同名定义。成员可以用 `tools.restrict` 限制继承的工具，该接口不会过滤成员自身 scope 的注册。[`resolve`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L264)保留原工具的条件和注册生命周期：条件不满足就不声明；原注册被移除或替换后，从当步可执行集合剔除。
- [`ToolDefinition` 和工具调用上下文](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/contracts.ts#L25)提供 schema、执行方法和调用者 Agent 等信息，但工具定义与公开的查询接口没有稳定的插件来源 ID。仅靠全局工具名能选中当前注册，不能证明插件重载或重启后同名工具仍来自原插件。调用时传入的是 Team 成员的 Agent；插件如果需要普通 Session 的状态或用 Session 推导 Workspace，就要拿真实插件验证。Team 成员创建 Workspace、可参与的 Workspace 和当前工作目录是[不同概念](../../../../packages/agent-team/src/member-context.ts#L181)。
- Harness 的 [preset](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/preset/agent-preset-registry/README.zh.md#use-this-package)可挂载独立插件行，定义更新后旧 Agent 保留已经绑定的代际。用户直接覆盖内置 preset 的 `plugins` 需要维护完整列表；[Host profile 补丁](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/app-boot/README.md#known-limitations-and-deferred-work)也不对同一行的配置做深合并。
- 工具定义与注册条件分别存放；把查询到的定义重新注册一遍，不会自动继承 [`when`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/contracts.ts#L104) 或原注册的卸载时机。现有 DSH MCP 客户端[重连时替换注册](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/tools.ts#L145)，可用于验证动态重注册。
- 参考：[OpenCode 权限文档](https://opencode.ai/docs/permissions/#agents)区分全局规则、Agent 规则和按服务区分的 MCP 工具名。可借鉴按 Agent 收窄和展示工具来源；它的规则采用后匹配优先，不能据此推断 DSH 的插件兼容性或 Team 的授权优先级。

## 接入方式

| 方案 | 可覆盖的工具 | 主要代价 |
| --- | --- | --- |
| 用户直接点名宿主已注册工具 | 已启用插件注册的全局工具；可沿用原定义、条件与执行路径 | 配置选择的是工具名；公开查询不能保证跨重启的插件来源。用户验证工具在成员 Session 中的兼容性，Team 处理缺失和运行中的定义替换。 |
| 为成员 preset 追加 DSH 插件行 | 可在 preset scope 独立挂载的插件；可同时引入工具、提示和插件的其他行为 | 需要单独解决加载和失败诊断；已有宿主插件也不一定适合再挂一次。 |
| profile 覆盖 `team-member` 的完整插件列表 | 能在 preset 内独立挂载的插件 | 复制并维护内置列表；整个插件可能带入提示、监听器和状态。适合作为受控环境下的验证手段。 |

**已确认：** Team 保持默认隔离，在设置里按确切名字搜索、多选宿主已注册工具。插件的选择、配置、依赖和兼容性由用户负责，沿用 DSH 安装和管理插件的方式。不要求插件作者做 Team 适配，也不维护兼容名单。成员专用插件加载和按插件自动分组不纳入首版。

**工具执行：** 把选中的现有定义纳入成员工具范围，保留 [DSH 工具准入和生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L239)，无需复制定义或重复加载插件。仅安装插件不会放行工具，也不会使旧白名单里原本无效的名字生效。

**追加插件行是另一种能力。** [Cordis patch](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/include/src/patch.ts#L65)只能向原生 group `insert`，而 [`team-member` 的插件列表](../../../../cordis.patch.yml#L24)是 [AgentPreset 的配置字段](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/preset/agent-preset/src/index.ts#L15)，不是可直接追加的 group。

## 放行范围

- **已确认：** 当前 DSH profile 使用一份统一的外部工具清单，默认空；放行后所有 Team 成员都可用。即使成员的白名单只包含 `read`，它也可以使用统一放行的 `project_list`。[现有成员白名单](../../../../docs/architecture/host-authority.md#member-capabilities-and-skills)对原有工具的限制保留；它不能单独放行 profile 未批准的宿主工具。

## 配置与生效

- [现有 Team 设置](../../../../packages/client-agent-team/src/client/TeamSettingsSection.tsx#L67)使用 [DSH 设置服务](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/settings/settings/README.md)，可把改动保存在当前 profile，无需另建存储。首版不做插件安装或成员选择器。
- **可复用：** [DSH 每个模型步骤](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L283)重新解析工具、组装提示和运行上下文。工具增删写入[请求记录](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L655)；支持历史工具更新的模型会收到原生更新块，其他模型请求使用当前工具清单。上游[工具更新测试](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/tests/tool-updates.spec.ts#L53)覆盖两种请求方式，[上下文测试](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/tests/loop.spec.ts#L676)验证运行上下文变化。这些文件与 `dsh-v0.2.2-rc.1` 一致。Team 不补发工具更新提示，不改 agent loop。
- **Team 仍需做的事：** DSH 只会呈现过滤后可用的工具；它不会替 Team 更新权限。Team 已监听 [`loader/volatile-update`](../../../../packages/agent-team/src/index.ts#L584)，已有[按成员在回合边界换工具限制](../../../../packages/agent-team/src/member-runtime.ts#L163)的路径。复用配置和作用域限制，按实际回合边界更新，仍用原 Session。[DSH 可连续开始下一轮](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L420)，不能只等空闲状态；[下一轮开始事件](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L326)先于工具解析，可作为核对生效时机的依据。不以 `agent/pre-step` 当作当步放行前的入口：该事件发生在 DSH 已解析工具、组装提示之后。
- **卸载与替换：** [DSH 当步工具选择](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L264)检查原注册还在不在，同名替换不会继承该步的资格；已开始的工具执行不承诺中断。选中的插件停用或未就绪时，Team 自带工具仍可运行。

## 按插件选择

- [宿主插件清单](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/host/plugin-inventory/src/types.ts#L16)已有插件项 ID、模块名、显示信息和启用状态，但不提供该插件的工具。[工具注册表](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L44)只保存工具定义及使用条件，公开查询返回定义或 schema；[`tools/change`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/events.ts#L50)也不带变化的工具或插件 ID。Cordis [effect 诊断](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/cordis/src/fiber.ts#L569)只有标签，而注册时标签固定为 `tools.register()`，不能把某个名字对应到某个插件。
- **未来按插件选择的前提：** DSH 在工具注册时按实际调用者记录可公开查询的来源，并将当前注册与宿主插件项关联。Team 才能列出已启用且提供全局工具的插件项、展示该项工具并按插件放行。插件启用、卸载、重新加载或同一包配置多项时，都基于真实注册关联更新；无法识别来源的工具不自动归组。需要确认最小上游接口及注册经子插件或共用服务代理时的归属定义；目前未改上游。
- **不等上游的选择：** 首版在 Team 设置中按确切工具名放行，可显示当前的工具清单供选择。不能可靠自动按插件分组；不按工具前缀、npm 包名或插件注册先后猜归属。该方案能复用同一会话的热更新，但配置体验与用户偏好的按插件选择不同。

## 自维护的工具来源插件

- **职责：** 仅从当前注册读取「原工具定义、注册者所属插件项」的对应关系，不重新注册工具、不执行工具、不决定权限。Team 用这份信息展示已启用且有宿主全局工具的插件项，选中后仍由原工具服务执行。工具来源与插件是否适用于成员会话是两件事，用户仍负责后者。
- **验证方式：** 在内存中加载 npm 发布的 Cordis `4.1.0`、Loader `1.1.0` 和 DSH Tools `0.2.2-rc.1`，使用实际 Loader 和工具注册表，工具插件和提示服务用最小测试替身。通过 Cordis [点号属性转发](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/cordis/src/utils.ts#L167)在原 `tools.register()` 前观察调用者和作用域，调用原方法后按工具定义记录来源。[Loader.locate](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/loader/src/index.ts#L194)可从调用者 fiber 找所属插件项。未安装依赖、未构建、未启动完整 DSH Web 或修改生产源码。

| 检查 | 实测结果 |
| --- | --- |
| 观察插件晚于工具注册 | 已注册工具仍能查到，来源无法补认。 |
| 子插件注册全局工具、成员 scope 单独注册 | 正确识别子插件所属插件项；保留原定义和使用条件，成员 scope 工具未混进全局清单。 |
| 注册同名工具失败、旧插件停用后换来源重注册 | 失败不抢占来源；旧工具消失，重注册后来源是新插件项。 |
| 观察插件无强依赖关系，停用观察插件 | 原工具保留，新工具仍可正常注册，之后的来源不再被观察。 |
| 为原 `tools` 服务增加观察插件依赖 | 启动时注册被捕获，但停用观察插件会使核心 `tools` 服务不可用。 |

- **判断：** 当前验证了采集技术，未找到可依赖的无侵入启动方案。Loader [异步导入插件](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/loader/src/config/entry.ts#L226)，调整配置行序无法保证先装观察入口；改为 [entry `inject`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/loader/src/index.ts#L128) 会让核心工具服务依赖观察插件。首版不建议替换核心工具服务，或把观察插件变成核心依赖。完整 Web 中的第三方插件和实际调用不在此次验证范围。
- **替代方案：** 若先交付，不使用来源插件，在 Team 设置列出 DSH 当前实际注册的宿主全局工具，支持搜索并多选；显示确切工具名，排除成员已有的同名工具，不推断插件归属。若首版必须自动按插件选择，则以 DSH 提供可靠来源查询为前置。

**下一步验证：** 用模拟模型从真实成员 Session 调用已放行的工具，核对调用者、当前工作目录和目标资源；并用普通 DSH Session、未放行工具对照。如果能确认 issue 中看板插件的身份，优先选它，否则选另一个现有插件。补测同名替换、卸载或重启，以及插件在成员激活后才就绪的情形。现行成员自身 scope 的提示和工具声明限制单列，不用放行全局工具的测试替代它们。
