# 设计快照 — 团队管理会话

来源：[issue #64](https://github.com/Contexera/dsh-agent-team/issues/64) 下维护者关于「由一个 Agent 创建与管理全局 Agents」的提议。决策编号见[决策记录](materials/decisions.md)。以下称这个入口为「团队管理」，专用 Session 为「管理会话」；讨论中的 Team owner 指这个入口，与 Project owner 无关。

## 问题和首版范围

Human 可以把理解 Team、识别持续责任、设计并创建成员和 Project、交接 owner 责任及调整分工交给 Team owner。比如 Human 说「让这个 repo 的性能长期有人负责」，助手先判断这是一项持续责任还是一次性任务，再读团队现状和 repo，优先复用现有成员；确实缺少长期判断能力时才创建成员，并为 Project owner 写明责任。首版不做成员模板、批量事务、Workspace 创建、主动巡视或额外的引导界面（管理工具不创建 Workspace；入口只复用现有 Workspace）。跨 Workspace 引入仍是同一 Member 参与另一个 Workspace，沿用原 Session，不是复制成员。

## 产品原则与首版定位（D3、D20、D22–D25）

完整的定位与角色边界见[定位、责任与协作原则](materials/product-principles.md)。实施时不得把「组建团队」理解成按项目临时招聘开发、测试、文档等职能 Agent：

- Team 的长期价值是 owner 对结果持续负责、主动推进并从交付中积累判断；Worker 只承担按次执行。Project 是持续目标和公共协作记录，Domain 是持续判断责任，两者不一一对应。
- 每个 enabled 的长期 Agent Member 通常至少是一个 active Project 的 owner，但不要求独占 Project，也可在其他 Project 作为普通成员参与。Host 允许创建、撤权等过渡状态；`team_overview` 显式报告没有 active owner 责任的长期成员。
- Member `description` 表达全局身份，Project `description` 表达共同目标，owner 关系的 `responsibility` 表达该 Member 在这个 Project 中负责的具体结果。首版扩展 owner 关系及现有 `team_view`、ownership context 和 Human 投影，不另设 Domain 实体。
- 标准交接由持久目标和责任字段、现有 owner Activity / Main 标记及后续 ownership context 共同完成，不依赖 DM 送达，也不建全员交接 Thread。首版不新增通用双向 DM 工具。
- Team owner 首版就能在对话中引导、设计并直接搭建和调整团队：它会 grilling Human，把持续目标、责任边界和协作方式讨论清楚，同时建立 Human 对 Team 的直觉，并按判断直接创建 Member、Project 和带责任的 owner。引导不是全部，执行也不只是被动代点按钮。后续扩展的是无需 Human 发起、像 Project owner 一样自行发现团队缺口并主动复查的机制。

## 入口和会话生命周期（D6、D8、D15、D19、D26）

```text
Team 侧栏                 普通 DSH Session 面板
  收件箱
  任务看板                ┌──────────────────────────────┐
> 团队管理                │ 标准会话历史、提问卡、输入框  │
  [Workspace ▾]           └──────────────────────────────┘
```

- 「团队管理」是 home 级入口，无 Workspace 时也能打开（没有 Workspace 时走普通 DSH 的「选择/创建工作区」空状态）；宽侧栏、窄屏抽屉和桌面折叠 rail 均提供入口。点击后像打开 Member 一样让 Team 的 `main` 影子让位给 shipped `ConversationPanel`，直接打开管理 Session；不新增 Team 主区页面，不用 `SessionProvider` 自包 `conversation.content`，也不改变 DSH 的会话历史、composer、提问卡和普通会话操作。Team 只在现有会话头部公开槽位按管理目的地挂「新开对话」；首轮前的起步提示若保留，只用现有 `conversation.hero.options` 槽位，不自绘主区。
- 导航目的地与 Member 会话分开，不参与 Member 选中或换代跟随；主区仍是普通 DSH Session。浏览器只记「打开团队管理」这个位置；重载由 Host 返回当前 Session，再从普通会话目录打开，不从浏览器缓存恢复会话权威。离开时按现有 Team 导航恢复普通 DSH 会话，晚到的请求结果不把用户拉回来。
- **入口 Workspace 归属（2026-11-13 复核）：** shipped `ConversationContent` 只在 Workspace 列表尚未就绪时用非空 cwd 的目录名做 chip 标题；列表就绪且 Session 没有所属 Workspace 时，`chipTitle` 为空，空白会话的输入框被锁成「Choose workspace」。因此管理会话必须归属一个真实 Workspace。解析顺序：① Harness 默认 Workspace（`workspace/initializeDefault` 按 `defaultWorkspaceId` 返回的 `<Documents>/deepseek-harness/default-workspace`，不是路径匹配；空安装首次启动时创建，已有则复用）；② 没有默认 Workspace 时用 `workspaceRegistry.list()` 持久顺序的第一项；③ 一个 Workspace 都没有时显示普通 DSH 的「选择/创建工作区」空状态，由 Human 在普通 DSH 创建后再打开。管理会话的 cwd 是所选 Workspace，私有 memory/skills 仍在 `$DSH_HOME/agent-team/owner/`；九个管理工具读全部 Workspace，不把 cwd 当作团队范围。不建专用 Workspace，也不为入口另造 Workspace 选择器。
- Host 按需创建或恢复会话，用已有的隔离 registry 声明 `team-owner`，在创建或恢复时只挂到这一条会话的 Agent scope。初始 cwd 和 Workspace 归属按 D26 的解析顺序确定；无论落到哪个 Workspace，九个管理工具都读全部 Workspace，不把 cwd 当作团队范围。入口名固定；Harness `create` 没有 title 字段，Host 在创建后按现有 `sessionTitle.rename` 路径命名为「团队管理」。普通列表的手动重命名不改变入口名或身份。**Host 启动时必须预恢复**已登记且未归档的当前管理会话：`session-controller` 只读 host-plane 的 preset registry，看不到隔离 registry 里的 `team-owner`；若用户先在普通列表点开冷会话，会得到 `gateway/internal`（底层 `agent-preset/not-found`）。预恢复用 `ctx.agents.resume({ resumeSessionId, setup })` 在 setup 里挂 `team-owner`，与 `activateMember` 同构；预恢复失败要保留登记、记录诊断并允许重试，不能把失败当成会话不存在。普通列表的显示和归档仍走 Harness。
- 管理会话不接受普通 preset 切换，首轮前也一样。沿用隔离 registry 和 Harness 的单次 scope 绑定；管理目的地可在 `conversation.hero.agentPreset` 槽位移除切换控件，但权限不能依赖隐藏控件。用实际 Web 组装验证普通 picker、普通首页已暂存的选择（共享 `staged`）和直接调用都不能改挂其 preset。可见拒绝反馈只由该控件提供；若移除控件，直接 `select` 仍被 Host 拒绝但没有可见提示，需在验收中明确接受这一点，不能声称有可见拒绝。
- 每个 DSH home 只有一个由 Host 持久登记的当前 Session id，保存在 Host 自有的私有存储域（`openTeamStorage()`，兼容 bundle 挂载时的隔离 sqlite 与测试态的 `storageDomain`），不进 Team 账本，不写进会被渲染成设置表单的 Host row volatile config。Host 在首次打开、恢复和「新开对话」之间串行处理：并发打开复用同一条；「新开对话」仅替换调用者看到的当前 id（带期望的旧 Session id 防止多页并发连换两条），其他页面拿到当前结果后同步。新会话可用且登记持久化后才切换；失败时保留原登记并允许重试。旧历史保留，Host 停止旧会话并撤销管理工具权限，不自动把旧会话加入新对话。
- 当前会话被归档或确认已不存在时，下次打开自动新开；读取、格式、加载或保存失败要显示原因与重试入口，不能误判为不存在。用户也可明确选择新开。切换、归档和重启都保留专用目录。加载期间显示状态，不展示可发送的空白对话；首轮前可通过标准 Hero options 提供静态起步问题，不另建向导流程；新开失败时仍显示原历史。入口与「新开对话」可用键盘操作。

## 工具和权限（D5、D10–D14、D16、D17）

- `team-owner` preset 显式挂载整套行：独立 persona、`tool-presentation`（固定 `mode: native`）、`agent-instructions`、时间上下文、bash/pwsh、文件读写（`applyPatch: false`）与搜索、jobs、skill、web、`ask_user_question`（`@deepseek-ai/dsh-tool-ask-user`）及通用 `compaction` 组（`compaction-basic`、`command-compact`、`tool-result-pruner`），保留 Harness 的全局 `working_directory`。web-app 在 host 平面禁用了压缩行和多数具体工具行，但通用 `tools` 行仍在，不能假设「省略即缺失」；必须显式挂载所需行。对 `team-owner` 的 Agent scope 施加 `tools.restrict` + `tools.guard`：基线是本 preset 声明的工具、`working_directory` 和 Host 注册在管理 Agent scope 上的九个管理工具；`restrict` 只移除继承来的全局工具，九个管理工具注册在自身 scope，靠 guard 的允许名单放行；不应用 profile 的 `extraToolGrants`（那是 Member 的授权）。挂载后校验 `team-owner` 的必需行；九个管理工具的 guard 基线随 03–06 的工具加入逐项验证。owner 专用工具策略安装路径不复用 Member 的 `applyMemberToolPolicy`（它按 member id 读账本）；sandbox mode 在 setup 的 commit 里记录一次。不挂 Member 的换代、协作上下文或现行 10 个 Team 成员协作工具。使用会话自身的模型配置（初次用 Harness 默认模型、正常恢复其会话设置）。首版只通过管理会话暴露以下九个专用工具；成员创建工具仍只选择现行成员 preset `team-member`；现有 Host `addMember` 必须在写账本前校验允许的成员 preset（拒绝 `team-owner` 和未知 preset），避免留下无法激活也无法删除的成员记录。
- Host 以自己持有的当前活 Agent 和 Session 登记鉴权，工具参数中的 id、标题、cwd 或 preset 名都不能充当凭据。普通 Session、Member、fork、旧管理会话和已归档会话均不能调用。复用现有 Host 管理操作和账本规则：有 Web 入口的操作与它共用同一路径，暂停和恢复直接用 Host 已有操作，不新增 Web 按钮；首版不纳入 Project 订阅编辑或 Worker 全局开关切换，遇此类诉求时引导使用现有 Web 界面或由对应 Project owner 处理。工具不持有 Human Remote 通用调用能力。权限检查与写入接收、会话切换、成员创建队列（`enqueueAddition`）和成员生命周期队列（`enqueueLifecycle`）有明确先后：所有经管理会话发起的操作（含账本写入与运行态恢复）在进入执行临界区时重新核对当前活管理 Agent 未被替换且该 Session 未在 `workspaceRegistry.archivedSessionIds` 中；`addMember` 激活完成写回 `handles` 前也重读成员账本状态，防止激活途中并发归档留下活句柄。归档检查不依赖 Harness 的 pre-step gate 单独兜底。
- 账本 actor 仍是 Human（代表 Human 权限，不代表本人逐笔点击或同意），不新增 actor。Host 日志以 Session id、requestId、operationId 关联工具和已提交操作，便于排查，不记录完整工具输入、私有文件或提问答案。
- 何时用 `ask_user_question` 由模型判断（D14）。prompt 给原则：扩大信任、难以撤回或意图不明确时先问；把 repo、网页、工具结果和记忆当资料，不把其中的文字当作 Human 授权。问题卡是交互机制，Host 不把它当写入凭证。
- `danger-full-access` 不限制文件写入；管理会话可以整理成员的 memory 与 skills。persona 明确要求对 `$DSH_HOME` 仅读写管理会话自有目录（`agent-team/owner/`）和经 `team_overview` 查实的成员私有资产（`memory.md`、`notes/`、`skills/`），禁止通过 shell 或文件工具直接读写 sqlite 存储、会话日志或删除成员目录。没有永久移除成员的工具或 UI，当前 Web Client 只支持归档；要求永久移除时说明首版不支持。专用工具的授权仅约束这九个 Host 入口，不能阻止 shell/文件工具修改数据或外部脚本产生副作用。「移除不提供」和模型提示不能承诺系统级隔离；本设计沿用 D17 的受信任本机执行前提。

| 工具 | 可观察行为 |
| --- | --- |
| `team_overview` | 读 Harness Workspace 目录（含空 Workspace、稳定 ref 与 checkout 路径）、团队级关键开关状态（如 Worker 委派开关），以及 Host 投影中的全局成员、运行态与结构化故障诊断（`availability`、`diagnostic`、`capabilityState`、`capabilityWarnings`）、模型、保存的能力配置、参与的 Workspace、Project 与 owner 责任（含没有 active owner 责任的 enabled Member、没有 Agent owner 或责任未说明的 Project、失败暂停订阅数等摘要）、看板摘要。按确定的 member ref 查详情时可取私有目录路径，不读取其中的内容。用稳定 ref 做后续操作；支持按 Workspace/对象缩小范围和继续读取，每次结果有界，明确空结果、还有下一页或资料已不可用。首版不读对话正文。 |
| `team_models` | 读 Web 成员编辑器所用的 Host 模型目录，返回可选 provider、model、reasoning effort 及首版唯一成员 preset。输出有界；区分目录为空、部分 provider 不可用和读取失败，不返回凭据。 |
| `member_create` | 指定 Workspace、handle、`description`、显式模型路线和所需配置，创建一个成员；可指定该 Workspace 内已有的初始 Project。`description` 在管理工具层必填，用于表达成员的全局身份；Host 请求本身允许空串以兼容旧路径。 |
| `member_update` | 按 member ref 改 description、model、capabilities；省略字段保持不变，显式清除能力覆盖才恢复默认；不改 handle 或 preset。 |
| `member_state` | `suspend` / `resume` / `archive` / `recover`。前三种为账本持久状态变更（归档保留历史与私有目录）；`recover` 为运行态恢复操作（无账本提交，沿用 Host `recoverMember` 完成半途换代、收尾挂起清理、重建丢失的 preset 或唤醒卡住的活会话，并返回最新运行态与诊断）。`recover` 需要 Workspace ref，Host 会校验成员在该 Workspace 的参与关系；其余三种用 member ref。 |
| `member_workspace` | `join` / `leave`；加入不移动 Session，不能退出创建 Workspace。 |
| `project_create` | 在已有 Workspace 新建 Project，以 `description` 记录持续共同目标，可一次纳入已参与该 Workspace 的已激活成员。一次性任务不应为了执行而新建 Project 或长期 Member。 |
| `project_update` | 按明确的 Workspace ref 与 Project ref 更新 `name` / `description`（省略字段在账本队列内保留原值），或执行 `archive`（释放活跃 Claim、清理相关 Attention 并停止及清除该 Project 下的全部订阅私有状态，保留历史）。当前 Host 请求要求 `name` 和 `description` 两个字段并在账本内全量覆盖；06 要把请求改为可选并在 `ledger.updateProject` 的串行队列内读取当前记录、合并未传字段。 |
| `project_owner` | `add` / `update` / `remove` Agent owner。`add` 由管理会话要求提供有界 `responsibility` 和可选交接说明；Web 现有授权入口允许留空并显示「未说明」。`update` 修改当前责任，使用 01 新增的只追加账本操作，不通过 remove+add 模拟；`remove` 撤回关系。授予对象必须已参与目标 Workspace 且状态允许，授予本身也构成 Project 参与。复用现有 owner Activity、Main 标记和提交通知完成交接，责任不依赖 DM 送达。撤掉 owner 后，只有失去最后一种 Project 参与资格的成员才把开放 Task 交回 Human。 |

有 Workspace 的写操作使用明确的 Workspace ref；成员用稳定 branded ref（不复用按 handle 全局猜第一个命中的 `memberTarget`），同名成员不猜。当前 cwd 不能推导 Team 目标。目录为空时，引导 Human 在普通 DSH 创建 Workspace；目标不明确时询问。所有写入复用现有状态与资格检查。创建成员或更换模型时，在确认 `requestId` 尚未提交（`!ledger.hasCommitted(requestId)`）之后，再从 `sessionController.modelCatalog()` 核对明确指定的模型与 effort；模型未知或目录暂不可用时分别说明原因，均不写入。不重新校验未改动的模型，且已提交请求的幂等重放直接返回原回执、绝不因模型目录随后变化而报错（顺带修正现有 `addMember`/`updateMember` 在幂等判断前调 `assertModelRoute` 的顺序）。能力配置沿用 Host 的 tool/skill allow-list 语义和缺失能力诊断，不把配置的名单说成实际已生效的工具清单。对局部更新，Host 在 `enqueueLifecycle` 队列内读取当前成员最新记录并仅合并工具明确请求的字段（同时让 Member 会话自身的 `request/header` 模型回写也走同一队列合并最新字段），不能用调用前旧快照覆盖并发的 handle/description/model 编辑。`project_update` 的局部字段和 `project_owner update` 同样在账本自己的串行队列内读取当前记录并合并；不要用调用前快照补齐。`project_owner update` 写一条新的只追加操作，回放时替换该 owner 的 `responsibility`，并复用 owner Activity/Main 标记路径通知该成员；旧记录缺少字段时显示「未说明」。责任字段写入前 trim，空串表示未说明，上限 2,000 字符；账本 rules version 从 7 升到 8 并 gate 新操作；新增 `AgentTeamProjectOwnerUpdateRequest`、Host `updateProjectOwner` 和对应 Remote；`AgentTeamOwnerActivity.kind` 增加 `owner-responsibility-updated`。

## 写入结果和失败后的继续

建立持续责任的默认顺序是：判断诉求是否值得长期负责并优先复用现有成员 → 在同一个 Workspace 只创建缺少的长期判断角色 → 用 `project_create` 记录共同目标并纳入已成功激活（`availability === 'active'`，Host 的 `assertProjectMembersAvailable` 门槛严于账本）的新成员及已符合条件的现有成员 → 给符合 Host 资格的成员授予 owner 并写明各自 `responsibility`。若某新成员已写入账本但激活失败，先报告该成员的激活诊断或单独建不带该故障成员的 Project，不在激活失败时直接把它塞进 `project_create`。不隐式把来自其他 Workspace 的成员加入目标 Workspace，也不拿导入冒充创建。如果需要调整 Workspace 参与，按独立的 `member_workspace` 操作处理。

每次写入有独立 requestId；同一意图和参数在超时或结果未知时用原 id 重试，参数变了才用新 id。工具结果保留回执和对象 ref，区分「未提交」「已提交，运行效果待应用或失败」和「结果未知」。Host 能确认写入已提交时，即使激活或配置应用失败，也返回可核对的已提交信息；未知时读回或原样重试，不能从报错推断未写入。多步操作没有整体事务：遇到失败先核对已完成步骤，报告阻塞和可恢复的下一步，不自动补做依赖失败的后续步骤，不重建已存在的成员，不删除已成功的对象作为回滚。

## 记忆、笔记与 skills（D7、D17、D20、D21）

管理会话复用 Team 的私有目录约定，在 `$DSH_HOME/agent-team/owner/` 下有自己的 `memory.md`、`notes/` 和 `skills/`。目录归「团队管理」入口，重启、归档和新开对话都沿用；它与各 Member 的目录分开，也不进 Team 账本。cwd 是 D26 解析出的 Workspace，私有目录仍在 `owner/`；注入文案按实际 cwd 表述，不固定写「outside the Workspace cwd」。

- **记忆与笔记：** 复用 Team 的记忆渲染、16 KiB 上限、转义、变更提示和超限警告，为管理会话单独挂载不依赖 `memberForAgent` 的记忆上下文插件，并写入面向团队管理的初始 `memory.md` 模板（不沿用 `# Member memory` 文案），记录可重放。只有 `memory.md` 进入会话上下文，作为长期习惯和 notes 的索引；`notes/` 按需读。管理会话从自己的目录产生记忆上下文；Member 的身份、参与关系、Inbox 和旧会话记录规则保持原样。
- **自己的 skills：** 复用 `mountMemberSkillProvider` 的目录发现和作用域注册方式。Host 为管理会话挂两处：随 bundle 发布的只读管理会话内置 skills 目录（与成员的 `core-skills/` 分开并纳入 skill 静态检查）、可写的 `owner/skills/`。Human 或管理会话可在私有目录增删配置 skill，后续轮次按现有文件发现规则可用，无需换会话或改 preset。内置 skill 同名时优先；首版用文件配置，不新增编辑界面，也不把这些 skills 挂给普通会话或 Member。
- **首版 wiki 与责任原则：** 以现行维护文档和[定位、责任与协作原则](materials/product-principles.md)为来源，说明 Team 用法、持续责任、Project/Domain 的区别、owner 主动推进、Worker 并发和独立验收；给一条从识别持续目标、优先复用成员到建立 Project、授予带责任的 owner 并完成交接的例子。一次性任务不扩编，独立验收不默认创建测试成员。不另写一套成员 memory/skills 整理教程，也不把整理其他成员的私有文件纳入首版 wiki 验收。
- **整理其他成员的文件：** 保留 D17 的能力；如 Human 要求这样做，用 `team_overview` 的 member ref 查到实际目录，沿用 `member-memory-manager` 与 `member-skill-manager` 的规则，不按 handle 猜目录。

## 验证

- [01](issues/01-owner-responsibility.md)：账本回放、`team_view`、ownership context 和 Web owner 入口显示同一份责任；旧记录显示「未说明」；更新操作不通过 remove+add 模拟。
- [02](issues/02-owner-session-entry.md)：真实 Web 组装，确认入口与 DSH 对话/提问卡、入口方案决定的 Workspace 归属、冷恢复、归档替换、失败重试和普通 DSH 恢复。
- [03](issues/03-owner-reads-team.md)：验证角色隔离、旧会话拒绝、全局目录、空 Workspace、同名成员、续读、owner 责任空缺及模型目录。
- [04](issues/04-staff-a-project.md)：以真实工具调用验证同一 Host 规则、激活门槛、幂等、部分成功和已提交未生效；人工验收模型对确认时机及方案质量的判断。
- [05](issues/05-adjust-a-member.md) 和 [06](issues/06-adjust-a-project.md)：验证局部合并、并发撤权、恢复闭环、Project 归档副作用和 owner 责任更新/撤回。
- [07](issues/07-owner-memory-and-skills.md)：验证私有目录跨会话保留，记忆可重放、notes 按需读，私有 skills 的发现范围。
- [08](issues/08-owner-guide-skills.md)：验证两份内置 skills 的加载、内容链接和静态检查；人工判断它能否教会 Human 按持续责任组织 Team。

Harness 和现有产品事实见 [能力核对](materials/harness-support.md) 和 [问题与现状](materials/facts.md)；定位见[责任原则](materials/product-principles.md)，具体使用流程、prompt/context 分层和内置 skills 的拆分见 [交互与引导参考](materials/flows-and-guidance.md)。
