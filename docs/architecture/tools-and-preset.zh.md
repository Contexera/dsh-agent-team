# Tools and preset

[English](tools-and-preset.md) | 中文

本文维护模型可见工具的名单、preset 组合与提示指导的分工。运行时权限和生命周期见 [Host 权威](host-authority.zh.md)，具体调用契约见 [协作工具](../team-collaboration/tools.zh.md)。

## Member preset

`team-member` 是 Member 唯一使用的显式 preset。它组合了 shell、文件读写与搜索、网页搜索与抓取、后台作业、skill 加载及压缩，还提供协作指导与工具、Workspace 指令发现、有界的私有记忆上下文，以及 Member 参与的每个 Workspace 的 [Workspace 规则](../team-collaboration/memory-and-context.zh.md#workspace-规则)。普通 Session 不使用这份组合，也不接收 Team 提示、工具或 Member 记忆。

嵌套的 preset group 把 skills registry、Team 的逐 Agent router 与 skill loader 放在同一个隔离域；确切 roots 与选择生命周期归 [Host authority](host-authority.zh.md#member-capabilities-与-skills)。

工具声明与提示指导是模型输入的不同层。工具名、描述与参数会成为请求专用 `tools` 字段里的 schemas；部分工具插件还会注册 system-prompt guidance sections。技能摘要目录则是持久的 user-role `<system-reminder>` / `<available_skills>` 消息，完整技能正文只在 `skill` 工具加载或用户显式调用后进入。隔离的 Team skills registry 同时服务这三种技能表面。

filesystem row 显式设置 `applyPatch: false`，不继承 Host 默认值。Member 的文件修改工具只有 `edit`；若省略该字段，Host 默认值变化就可能扩大工具范围。发布包的 preset 测试会检查这一设置。

### 执行基线与额外许可

每个 Member 默认只获准使用所选 preset 注册的工具定义，以及显式共享的 `working_directory`。`capabilities.tools.allow` 仍只能进一步缩减。Team Host row 另有一份 profile 级 `extraToolGrants`，可按确切、区分大小写的已注册宿主工具名放行，包括 Member allow-list 省略掉的继承基线名称。名单默认空，只属于一个 profile，并作用于该 profile 的全部 Team Member。这是为 Member 已能接入的外部插件工具解除执行限制：不挂载插件、不修改 Member preset，也不开启 DSH 内置能力。

所有 Team-owned 工具与 `working_directory` 仍是保留名称，许可不能点名它们。`team_worker` 属于十个 Member 工具，只在 Host 的 Worker 开关打开时声明，许可开不了它；九个 manager 工具同样不作授权候选。许可只认名字，不认插件来源、定义对象或注册实例。

Host 在每个 Session 的 `turn/start` 同步读取名单，发生在首次工具解析之前，并在该轮冻结。保存后的编辑从下一轮生效；即使连续两轮之间没有 idle 也成立，创建、恢复与换代走同一条策略路径。restriction 按开轮时已知名称生成。执行时采用 DSH 实际为该 Member 和步骤解析并准入的注册，因此其自身的 `when`、pre-execute 检查、Agent 身份以及直接或嵌套调用的当步准入仍然有效。开轮后才注册的已选名称会在下一个正常步骤重新物化进声明；注销或重注册会使先前准备好的准入失效。

外部工具的可见性与执行许可分开处理。继承的全局或祖先注册在未获许可时会被 `tools.restrict()` 从 schema 移除。Member 自己的 Agent scope 中的注册不受该 restriction 过滤，当前 Harness 公开接口无法隐藏它们；执行 guard 会在未获许可时拒绝调用。

每次组装 prompt 时，`team:tool-availability` 列出仍然可见、但执行守卫会拒绝的名称：未获许可的 Agent scope 注册，以及替换了基线工具的同名注册。提示要求 Member 不要调用这些工具。有效许可从下一轮生效后，可以移除对应提示。实际执行以该步骤的守卫为准。

逐步刷新在公开的 `agent/pre-step` gate 中进行，仍采用该轮冻结的许可。当前步骤的工具解析已完成，所以刷新准备的是后续声明，而不是当前声明；刷新失败仍能拒绝本次请求。Session 事件观察器不能承担这个拒绝职责，`step/start` 也已经太晚。

同一开关还决定 owner guidance section 里的 Worker 段落，而该段落每次组装都会重新求值；Worker registry 在开关关闭时仍然拒绝发起。

Host 在 Agent 发布前保存 preset 定义，并在直接调用和嵌套调用执行前检查。带额外许可的策略安装失败时，Host 收紧到同一 Member 的无额外许可基线，而不是恢复上一份含许可的 restriction。若该基线也无法建立，pre-step gate 会在模型请求前拒绝该轮，下一次正常开轮再重试。允许的工具定义被替换时，拒绝发生在执行期而不是组装期。检查只作用于该 Member，不影响普通 Agent 或委派子 scope。

设置目录发现 Host 全局注册与 live Member scope 中已注册的工具名，不读取普通 Agent scope。它不推断插件来源、不克隆插件，也不声称是某个 Member 或某一轮的精确当步准入集合。已激活 Member preset 提供的名称、Team-owned 名称、`working_directory` 与 `team_worker` 不作候选。DSH 树内共享任务板的四个工具也不作候选，因为该任务板与 Team 账本持有的 Task 重合。已保存但当前不可授权的名称仍保留为已选，可随时移除。普通 Session 与其他 profile 不获得任何许可。

### 公开扩展接口的限制

Team mode 不过滤其他官方或自定义插件注入的提示。当前 Harness 公开接口不支持完整的 Member 提示隔离：必需上下文会在组装后被恢复。例如 experimental Team 的 `team:policy` 与必需的 `team:identity` 仍会进入上下文，但不会因此阻止激活或对话。

这些检查使用 Harness 公开扩展接口，不是强制执行的最终请求策略。其他组装中间件仍可在 Team 过滤之后改变结果。尚未完成通用插件兼容性认证，见[兼容性限制](../dsh-release-compatibility.zh.md#37-并存的另一套-team-实现)。

### 工具名单与注册

`cordis.patch.yml` 的 `only` 名单是注册入口；`member-tool-policy.ts` 与 `manager-tool-policy.ts` 分别维护运行时工具集合。

| preset | Team 工具 |
| --- | --- |
| `team-member` | `team_view`, `team_inbox`, `team_thread`, `team_message`, `team_task`, `team_attention`, `team_dm`, `team_subscription`, `team_reminder`, `team_worker` |
| `team-manager` | `team_overview`, `team_models`, `member_create`, `member_update`, `member_state`, `member_workspace`, `project_create`, `project_owner`, `project_update` |

Member 名单最多十个；`team_worker` 只在 Host Worker 开关打开时声明。

每一行 `name:` 都是 Loader 按 profile 解析的裸标识符，不按本 bundle 解析。profile 只链接本 bundle 与宿主闭包，所以一行只能点名宿主包或本 bundle 自己的子路径。绝不能点名嵌在本 bundle 依赖树里的包。工作树里能解析的名字，在真实安装里仍可能让该行 `never started`：依赖里的模块只能经由本 bundle 自己名下的再导出到达一行。

model-facing tools 定义在 `packages/tool-agent-team/src/index.ts` 与 `packages/tool-agent-team/src/subscription.ts`。Member 的 collaboration contract 记录在 [`tools.zh.md`](../team-collaboration/tools.zh.md)，挂载在隔离的 `team-member` preset 下（`cordis.patch.yml` 里的一条 declarative row）。不要为了测试可用，就把 tool package 作为 global row 添加；普通 Sessions 必须保持 Team-free。

挂载 tools 插件的每个 preset 都通过插件自己的 `only` 配置声明确切子集：模型可见的工具清单读自注册所在 scope 的 schemas，所以在这里注册、之后再藏起来的工具仍然列在模型面前，只在 handler 里拒绝也仍会先花掉一轮。

`team-member` 点名十个 Member 工具；`team-manager` 点名九个 manager 工具，别的都没有。名单里出现未知名会被拒绝而不是跳过，所以写错名字不会挂上一个空工具面，最后以一个什么都不能做的 Session 的形式暴露出来。

Member 没有 context 工具。preset 的 `compaction-basic` 行挂载 Team 的薄适配层 `member-compaction-engine`：Team 负责主动请求准入，Harness 的 `BasicCompactionEngine` 提供摘要模板、压缩事务与 overflow 恢复。预算定义归 [`memory-and-context.zh.md`](../team-collaboration/memory-and-context.zh.md)。换代仍是 Host 的决定，不是模型的。

换代与输入重放统一见 [Host 权威](host-authority.zh.md#换代与输入重放)。这里仅维护 preset 的组合，不重复生命周期算法。

Web Client 是唯一的 Human control surface。它经 typed Remote 把每个 mutation 委托给 `ctx.agentTeam`，不绕过 Host authorization 或 ledger commits。别把 slash-command adapter 加回来当第二界面。

修改 schema、canonical output、presentation 或 preset 时，编辑前先阅读匹配的 Harness docs：

- `../deepseek-harness/docs/subsystems/tools.md`
- `../deepseek-harness/docs/cookbook/adding-a-tool.md`
- `../deepseek-harness/docs/subsystems/permission-presets.md`

## Team manager preset

Host 为 [Team manager](../domain-model.zh.md#team-manager) Session 挂载另一个隔离的 `team-manager` preset。它保留通用 coding 工具面：persona、时间与 Workspace instructions、shell、filesystem/search、web、jobs、skill 加载、ask-user、basic compaction、各 Workspace 的规则——但有意省略 Member context、Member time context、Member memory 及其 compaction adapter、Worker 与 rollover policy 和 `extraToolGrants`。只注册上面的九个 manager 工具。

这个工具面跑在可信的 `danger-full-access` policy 上，所以数据红线由 persona 写成规则而不是期望：在 `$DSH_HOME` 下，manager 只读写自己的 `agent-team/manager/` 目录、它主编的 `agent-team/workspaces/` 下各 Workspace 规则文件，以及 `team_overview` 刚按 ref 查实的 Member 私有资产；绝不碰 Host 的 sqlite 文件；Member 的 Session 只能经由 locator 给出的只读 reader 读取，绝不自己打开日志文件。

只有 Human 当前请求明确要求时，才能按相应的维护规则整理该 Member 的 memory、notes 或 skills；不得删除成员目录，也不得把私有内容复制进共享材料。它自己的 memory、notes 和一条工具结果只记录过去说过的话，因此它们都不能代替 Human 现在提出请求，来为不可逆或高代价的动作授权。

### 目录读取与管理写入

它挂载的 Team 工具面就是这个确切子集：两个只读工具加七个写操作。`team_overview` 把整个 Team 当目录读：每个 Workspace 及其 checkout 路径、每个 Project 的共享目标、它的 owners 与各自负责什么、活跃与暂停的订阅计数、board 摘要，以及每个 Member 的身份描述、参与哪些 Workspace、配置的模型路由、以什么方式运行、capability 配置挂载了什么、负责哪些 Project。

`team_models` 从 Session controller 自己的 catalog 读 Member 可以跑的模型路由，所以 manager 不可能给出一条 Web member 编辑器里没有的路由。两个只读工具都不带消息正文、Thread 事实、凭据或私有文件内容；`memberRef` 读取只补上该 Member 的完整身份描述、私有目录路径，以及它当前 Session 的定位信息，不多给。

`team_overview` 里的 capability warning 表示已存配置写了一个该 Member 拿不到的工具名：写入成功且已存列表保留该名字，但运行时忽略它，所以 Member 实际运行面比列表读起来更窄，warning 会列出它能持有的名字。

`member_create`、`project_create`、`project_owner`、`project_update`、`member_update`、`member_state` 与 `member_workspace` 是 manager 仅有的写操作，并且都走 Host 自己的写路径——与 Web Client 相同的串行账本队列、激活与回执——所以写操作答回的记录就是其他所有面读到的记录。

`member_update` 调整已存在的 Member，并且是局部更新：调用没写的字段保留写入真正执行那一刻已存下的值，合并在账本的串行区间内完成，所以一次编辑不会覆盖排队期间落地的改名或描述修改。

重放的 `requestId` 只比较它自己写明的字段。handle 与 preset 在这里不可编辑，显式空白的身份描述会被拒绝，省略 `capabilities` 保留已存的覆盖而 `clearCapabilities` 清除它，替换路由只在请求是新的时对照目录校验。

它的答案保留持久回执，并单独报告已存的配置走到运行时多远——`applied`、`already-applied`、`deferred:no-live-handle`、`deferred:generation-changed`，或带 Member 自身诊断的 `failed:model-apply`／`failed:capability-apply`——所以已提交但运行时应用失败的写，绝不会被答成未提交的拒绝而诱使重复重试。失败的阶段决定 effect 与诊断类别，比较对象是活代实际在跑的路由与工具面：重放同一请求会补做已存配置仍欠的那次效果，而后来被别的编辑换掉的路由绝不会被写回。

`member_state` 通过 Host 既有的持久操作暂停、恢复或归档；归档会释放该 Member 的活跃 Claim 并清空它的 Attention，而私有记忆与会话日志留在磁盘上。`recover` 是唯一的纯运行时动作：它不写账本记录，要求给出 Host 会核验其参与的 Workspace，用于收尾被中断的换代、重建被 reload 弄成孤儿的组合，或重启激活失败的 Member。

`member_workspace` 以纯账本关系加入或退出一个非默认 Workspace——Member 的 Session 不会被创建、复制或迁移——而退出创建时的 Workspace 会被拒绝，并指向归档。

`project_update` 编辑一个 Project 的展示事实，或归档它。调用没写的名字或共同目标保留写入真正执行那一刻已存下的值，合并在账本的串行区间内完成，所以一次改名不会把排队期间 Human 改过的共同目标写回旧值；显式空白的共同目标会像 Web 编辑器那样清空它，而空名字会被拒绝。归档保留全部事实与整段历史，释放该 Project 的活跃 Claim、清空相关 Attention，并停掉、清空该 Project 拥有的每一个订阅。

归档提交之后才失败的清理会作为警告写在回执旁边，而不是把已经持久化的决定变成一次拒绝。归档本身不能用新的 `requestId` 重做；用同一个 id 重放会保留原回执，同时再跑一次该清理，欠下的订阅状态就是这样被清掉的。

`project_owner` 授予某个 Agent Member 一个 Project 的 owner 关系、替换它在那里负责的结果，或撤回该授予。更新是向 owner 关系追加，而不是先撤回再重新授予，所以 Member 在这次改动中保住自己的授予、Main stream Attention 与历史，责任文本在读取它的每一处——ownership context、`team_view` 与 `team_overview`——都一致替换，而 Member 的全局 description 不受影响。

记录为空的责任会存成 `unspecified`，这是关于授予的事实而不是待补的缺口，而 `add` 仍然拒绝空责任。撤回只结束这段关系：仍在参与该 Project 的 Member 保留它负责的 Task，参与关系结束的则把它们交回 Human。

manager 层只加上 Web Client 自己的表单也加的部分：非空的成员身份、非空的 Project 共同目标、新授予时非空的 owner 责任，以及在确认请求是新的之后对照 Session controller catalog 校验的模型路由。owner 资格、准入门槛、保留的 Member 工具集与 2,000 字符的责任上限都沿用账本自己的规则，不在工具里复制第二份。

每次写操作都带一个 `requestId`。同一个 id 配同样的参数返回原回执，不会写第二次，所以答案丢失后可以重试，不会重复写入；同一个 id 下改了参数会被当成冲突拒绝。拒绝会说明原因，并且什么都没有写。已提交但激活失败的 Member 依然是已提交的：响应保留它的回执、ref 与激活诊断，manager 从那里继续，而不是把它再建一遍。

隔离 registry 的默认值仍是 `team-member`；只有 manager runtime 挂载 `team-manager`。

### 当前 manager 授权

九个 handler 各自校验调用方：只有调用者正是当前 manager Session 时才应答。这里用不上 `ownsSession`，它回答的是 lineage，而被替换掉的旧代同样满足 lineage，所以任何从别的路径拿到该工具的 Session——Member 自己 scope 上的注册、自定义 preset、普通 Session——都被拒绝，不会拿到数据。

写操作校验两次：先过工具入口的 manager gate，再过账本串行区间内、幂等重放分支之后的 `authorize` 钩子。调用与提交之间被替换的 manager 因此无法写入。`recover` 不写账本，而是在 Member 的生命周期临界区内重检 manager；若排队期间 manager 已被替换，就拒绝恢复，不执行修复。

manager policy 只捕获这个 preset 自己的精确 definitions，加上共享的 `working_directory`；执行 guard 只对确切的当前 manager Agent 放行这些 definitions。后来注册或外来的 definition 会被拒绝，不会继承。`addMember` 只接受 `team-member`，检查发生在 model validation 与任何 ledger write 之前，所以 manager composition 不能变成一个 Member。

manager 目的地在屏时，Client 会隐藏 shipped hero preset picker。这个收口只是展示，不是授权，也不是永久的 authorization lock：composition 归 Host，manager guard 每次执行都从确切 Agent 与当前 pointer 重新授权。入口与 gate 行为归 [Client 边界](client-and-remote.zh.md#client-插件与-slot-组合)。

## Persona 与 core skills

persona 是 `cordis.patch.yml` 中 `persona` 行的 `prefix`。它常驻，只写行为规则，不写参考资料：

- 每种消息该放哪里：Main stream 发言、开讨论或 Task、Thread 回复、DM；
- 只有 Project owner 能开讨论和 Task，且每个 Task 只有一个负责人；
- 点名、带 `replyToMessageRef` 的回复与普通消息的区别，以及何时找 Human；
- 正文里用纯文本点名不是 mention：`@Handle` 是投递，只有真想让他读这条消息时才写；
- 参与结束或多次收到无关的普通更新时，何时取消关注 Thread；仍有 active Claim、自己负责的 Task 尚未结束，或还有后续事项要处理时，继续关注；
- 一次唤醒的代价：每条 Message 都会唤醒它的读者，每次唤醒对每个收到它的成员都是一整轮；
- 验收、关闭、重开是三个不同决定，执行过该 Task 的 Agent 不能验收；
- 礼仪、先读后写的流程，以及不超过八行的角色速查。

规则按使用位置放置：persona 承载跨工具规则；每个工具说明承载选择与调用该工具所需的契约；参数说明保留必要的格式；结果说明本次操作的状态与恢复；内置 core skill 承载详细方法与少见情况。细节只有一个归属，persona 只保留基本调用所需的最短提醒。

Team 内容仍是不可信输入。persona 按代码里的现状点名工具；工具接口变化时，persona 同步修改。

详细内容放在 `packages/agent-team/core-skills/` 下的内置 core skills，由 Member 的 skill 目录按需加载：

- `team-domain-model` 说明角色与权限（Human、Project owner、Workspace participant、accountable）、Main stream 与 Thread 的分工、点名、带链接的回复与普通消息如何投递、何时看 Inbox 或 board、Task 生命周期与谁来验收、关闭、重开或转交、DM 的用途，以及写明恢复方式的常见拒绝码。它只写稳定规则，不含当前状态：身份、所属 Project、未读工作来自动态 context 和 Team tools，权限与投递规则由 Host 执行。
- `member-memory-manager` 与 `member-skill-manager` 负责私有 memory 与私有 skill 的写法。
- `project-subscriptions` 负责只读 Project 订阅脚本、GitHub 轮询示例、webhook 注册与验签、credential 处理，以及运行和投递调试。

有一个 section 是动态的，不是常驻文本。Host 在激活时把 `team:project-owner` 注册到每个 Member 的 agent scope 上，位置取 `TEAM_POLICY` 顺序，其 provider 每次组装都读取账本与 Host 设置行。只有该 Member 当前拥有至少一个 active Project 时才产出文本，所以授权或撤权在下一次组装即生效，无需重启。

该 section 承载常驻的 owner 职责——只有 owner 能发起什么、owner 发起的 Task 默认由自己负责、让所辖区域继续推进、范围与优先级交 Human 决定——以及交接工作的判断：什么让一次委派自包含、任务正文必须带什么、派发后如何继续推进、返回后如何独立核验。

Worker 开关打开时，它再加一段关于本地 Worker 的简短说明。它从不复述工具参数或单个 Project 的事实，那些属于工具说明与账本；又因为它是 prompt section 而不是消息，compaction 不会把它抹掉。

隔离的 manager skill roots 与优先级统一见 [Host 权威](host-authority.zh.md#隔离的-skill-目录)。

随包交付的六份 skill 把常驻方法与按需知识分开：`team-management-guide` 讲 Team 怎么运作、如何基于证据设计；`team-operations` 讲操作顺序与九个工具；`team-event-loops` 把 subscription、reminder 与消息当作让 Team 持续运转的闭环；`manager-domain-model` 把面向 Member 的规则讲给不持有这些工具的 manager；`manager-memory` 讲 manager 自己的有界索引与复查节点；`manager-session-evidence` 讲如何把 Member 的已存 Session 当证据来读。

`team_overview` 是唯一会给出 Session 的工具。带 `memberRef` 的读取会附上 `sessionEvidence`：Session id、持久化后端报告的状态、后端解析出的日志位置，以及读取它的只读 reader。manager 因此不需要猜 Session id，也不会从 home 目录拼出日志路径。

reader 是随 `manager-session-evidence` 一起交付的脚本，它经由 Harness 的 Session 持久化后端读取，而不是自带第二套解码器。它的输出上限按实际打印的 JSON 计算，被截断的事件带分段偏移、可用 `--offset` 续读，与 Session 不再匹配的日志路径在返回任何正文之前就被拒绝。

`npm run check:core-skills` 检查两处随包发布的 root（`core-skills/` 与 `manager-skills/`）里每个 skill 的 front matter、description、prompt 预算与链接。预算只算模型会读的 Markdown；随包脚本由门禁在汇总行里报告，不计入预算。Member 的 root 不允许为空；manager 的 root 随包交付这六份 skill，门禁仍容许它为空，因为内容不是构建依赖。
