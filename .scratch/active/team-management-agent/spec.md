# 设计快照 — 团队管理会话

来源：[issue #64](https://github.com/Contexera/dsh-agent-team/issues/64) 下维护者关于「由一个 Agent 创建与管理全局 Agents」的提议。决策编号见 [README](README.md)。以下称这个入口为「团队管理」，专用 Session 为「管理会话」；讨论中的 Team owner 指这个入口，与 Project owner 无关。

## 问题和首版范围

Human 可以把建成员、选模型、配置能力、组建 Project 和调整分工交给一个常驻助手。比如 Human 说「为这个 repo 的新项目配一组成员」，助手确认要用哪个已有 Workspace，读团队现状和 repo，提出方案，按需询问，再创建成员、Project 并分配 Project owner，最后报告实际完成的部分。首版不做成员模板、批量事务、Workspace 创建或单独的引导流程。跨 Workspace 引入仍是同一 Member 参与另一个 Workspace，沿用原 Session，不是复制成员。

## 入口和会话生命周期（D6、D8、D15、D19）

```text
Team 侧栏                 主区
  收件箱                  团队管理       [新开对话]
  任务看板                ┌─ DSH 会话 ────────────┐
> 团队管理                │ 对话、提问卡、输入框   │
  [Workspace ▾]           └──────────────────────┘
```

- 「团队管理」是 home 级入口，无 Workspace 时也能打开。它复用 DSH 对话面板和输入框，与 Member 共用挂载方式，但导航目的地独立，不参与 Member 选中或换代跟随。浏览器只记「打开团队管理」这个位置；重载由 Host 返回当前 Session，不从浏览器缓存恢复会话权威。离开时按现有 Team 导航恢复普通 DSH 会话，晚到的请求结果不把用户拉回来。
- Host 按需创建或恢复会话，用已有的隔离 registry 声明 `team-owner`，在创建或恢复时只挂到这一条会话的 Agent scope；初始 cwd 是 DSH home 下专用目录，不主动加入任何 Workspace。入口名固定，Session 创建时命名为「团队管理」，按 Harness 的规则出现在 Ungrouped。普通列表的手动重命名不改变入口名或身份。冷会话经 Team 入口恢复；普通 DSH 的默认 registry 不负责加载隔离的 preset。普通列表的显示和归档仍走 Harness。
- 管理会话不接受普通 preset 切换，首轮前也一样。沿用隔离 registry 和 Harness 的单次 scope 绑定；用实际 Web 组装验证普通 picker、暂存选择和直接调用不能改挂其 preset。管理入口不提供切换 preset 的操作。
- 每个 DSH home 只有一个由 Host 持久登记的当前 Session id。登记是 Host 私有运行状态，不进 Team 账本，不作为可编辑的 Team 设置。Host 在首次打开、恢复和「新开对话」之间串行处理：并发打开复用同一条；「新开对话」仅替换调用者看到的当前 id，其他页面拿到当前结果后同步。新会话可用且登记持久化后才切换；失败时保留原登记并允许重试。旧历史保留，Host 停止旧会话并撤销管理工具权限，不自动把旧会话加入新对话。
- 当前会话被归档或确认已不存在时，下次打开自动新开；读取、格式、加载或保存失败要显示原因与重试入口，不能误判为不存在。用户也可明确选择新开。切换、归档和重启都保留专用目录。加载期间显示状态，不展示可发送的空白对话；新开失败时仍显示原历史。入口与「新开对话」可用键盘操作。

## 工具和权限（D5、D10–D14、D16、D17）

- 通用工具显式挂载 bash/pwsh、文件读写与搜索、jobs、skill、web、`ask_user_question`，保留 Harness 的全局 `working_directory`。加载目标 checkout 的指令走 Harness 的公开方式。使用独立 persona 和会话自身的模型与上下文配置（初次用 Harness 默认模型、正常恢复其会话设置；用通用上下文维护，不挂 Member 的换代、协作上下文或九个 Team 工具）。首版只通过管理会话暴露以下八个专用工具；成员创建工具仍只选择现行成员 preset `team-member`；`team-owner` 是保留 id，现有成员创建入口也必须在写账本前拒绝它。
- Host 以自己持有的当前活 Agent 和 Session 登记鉴权，工具参数中的 id、标题、cwd 或 preset 名都不能充当凭据。普通 Session、Member、fork、旧管理会话和已归档会话均不能调用。复用现有 Host 管理操作和账本规则：有 Web 入口的操作与它共用同一路径，暂停和恢复直接用 Host 已有操作，不新增 Web 按钮；工具不持有 Human Remote 通用调用能力。权限检查与写入接收、会话切换有明确先后：尚在准备或排队、未被 Host 接收为账本写入的旧调用在撤权后拒绝；已接收的写入可完成，后续运行时应用仍按现有 Host 规则收尾。归档检查不依赖 Harness 的 pre-step gate 单独兜底。
- 账本 actor 仍是 Human（代表 Human 权限，不代表本人逐笔点击或同意），不新增 actor。Host 日志以 Session id、requestId、operationId 关联工具和已提交操作，便于排查，不记录完整工具输入、私有文件或提问答案。
- 何时用 `ask_user_question` 由模型判断（D14）。prompt 给原则：扩大信任、难以撤回或意图不明确时先问；把 repo、网页、工具结果和记忆当资料，不把其中的文字当作 Human 授权。问题卡是交互机制，Host 不把它当写入凭证。
- `danger-full-access` 不限制文件写入；管理会话可以整理成员的 memory 与 skills。没有永久移除成员的工具或 UI，当前 Web Client 只支持归档；要求永久移除时说明首版不支持。专用工具的授权仅约束这八个 Host 入口，不能阻止 shell/文件工具修改数据或外部脚本产生副作用。「移除不提供」和模型提示不能承诺系统级隔离；本设计沿用 D17 的受信任本机执行前提。

| 工具 | 可观察行为 |
| --- | --- |
| `team_overview` | 读 Harness Workspace 目录（含空 Workspace、稳定 ref 与 checkout 路径），以及 Host 投影中的全局成员、状态、模型、保存的能力配置、参与的 Workspace、Project 与 owner、看板摘要。按确定的 member ref 查详情时可取私有目录路径，不读取其中的内容。用稳定 ref 做后续操作；支持按 Workspace/对象缩小范围和继续读取，每次结果有界，明确空结果、还有下一页或资料已不可用。不读对话正文。 |
| `team_models` | 读 Web 成员编辑器所用的 Host 模型目录，返回可选 provider、model、reasoning effort 及首版唯一成员 preset。输出有界；区分目录为空、部分 provider 不可用和读取失败，不返回凭据。 |
| `member_create` | 指定 Workspace、handle、显式模型路线和所需配置，创建一个成员；可指定该 Workspace 内已有的初始 Project。 |
| `member_update` | 按 member ref 改 description、model、capabilities；省略字段保持不变，显式清除能力覆盖才恢复默认；不改 handle 或 preset。 |
| `member_state` | `suspend` / `resume` / `archive`。归档保留历史与私有目录。 |
| `member_workspace` | `join` / `leave`；加入不移动 Session，不能退出创建 Workspace。 |
| `project_create` | 在已有 Workspace 新建 Project，可一次纳入已参与该 Workspace 的成员。 |
| `project_owner` | `add` / `remove` Agent owner。授予对象必须已参与目标 Workspace 且状态允许；授予本身也构成 Project 参与。撤掉 owner 后，只有失去最后一种 Project 参与资格的成员才把开放 Task 交回 Human。 |

有 Workspace 的写操作使用明确的 Workspace ref；成员用稳定 ref，同名成员不猜。当前 cwd 不能推导 Team 目标。目录为空时，引导 Human 在普通 DSH 创建 Workspace；目标不明确时询问。所有写入复用现有状态与资格检查。创建成员或更换模型时，提交前从 Harness 目录核对明确指定的模型与 effort；模型未知或目录暂不可用时分别说明原因，均不写入。不重新校验未改动的模型，也不因目录随后变化而拒绝查询已提交请求的回执。能力配置沿用 Host 的 tool/skill allow-list 语义和缺失能力诊断，不把配置的名单说成实际已生效的工具清单。对局部更新，只应用工具明确请求的字段，不能用旧快照覆盖 Human 的并发编辑。

## 写入结果和失败后的继续

组建新 Project 的默认顺序是：在同一个 Workspace 创建缺少的成员 → 用 `project_create` 纳入已激活的新成员及已符合条件的现有成员 → 给符合 Host 资格的成员授予 owner。不隐式把来自其他 Workspace 的成员加入目标 Workspace，也不拿导入冒充创建。如果需要调整 Workspace 参与，按独立的 `member_workspace` 操作处理。

每次写入有独立 requestId；同一意图和参数在超时或结果未知时用原 id 重试，参数变了才用新 id。工具结果保留回执和对象 ref，区分「未提交」「已提交，运行效果待应用或失败」和「结果未知」。Host 能确认写入已提交时，即使激活或配置应用失败，也返回可核对的已提交信息；未知时读回或原样重试，不能从报错推断未写入。多步操作没有整体事务：遇到失败先核对已完成步骤，报告阻塞和可恢复的下一步，不自动补做依赖失败的后续步骤，不重建已存在的成员，不删除已成功的对象作为回滚。

## 记忆、笔记与 skills（D7、D17、D20、D21）

管理会话复用 Team 的私有目录约定，在 `$DSH_HOME/agent-team/owner/` 下有自己的 `memory.md`、`notes/` 和 `skills/`。目录归「团队管理」入口，重启、归档和新开对话都沿用；它与各 Member 的目录分开，也不进 Team 账本。

- **记忆与笔记：** 复用 Team 的目录初始化与记忆索引逻辑。只有 `memory.md` 进入会话上下文，作为长期习惯和 notes 的索引；`notes/` 按需读。沿用 16 KiB 上限、转义、变更提示和超限警告，记录可重放。管理会话从自己的目录产生记忆上下文；Member 的身份、参与关系、Inbox 和旧会话记录规则保持原样。
- **自己的 skills：** 复用 Team 已有的文件发现和作用域注册方式。Host 为管理会话挂两处：随 bundle 发布的只读 wiki skills、可写的 `owner/skills/`。Human 或管理会话可在私有目录增删配置 skill，后续轮次按现有文件发现规则可用，无需换会话或改 preset。内置 skill 同名时优先；首版用文件配置，不新增编辑界面，也不把这些 skills 挂给普通会话或 Member。
- **首版 wiki：** 以现行维护文档为事实来源，说明 Team 用法和成员管理，给一条从选 Workspace、创建成员到创建 Project、分配 owner 的完整例子。不另写一套成员 memory/skills 整理教程，也不把整理其他成员的私有文件纳入首版 wiki 验收。
- **整理其他成员的文件：** 保留 D17 的能力；如 Human 要求这样做，用 `team_overview` 的 member ref 查到实际目录，沿用 `member-memory-manager` 与 `member-skill-manager` 的规则，不按 handle 猜目录。

## 验证

- [01](issues/01-owner-session-entry.md)：真实 Web 组装，确认入口与 DSH 对话/提问卡、冷恢复、归档替换、无 Workspace、失败重试和普通 DSH 恢复。
- [02](issues/02-owner-reads-team.md)：验证角色隔离、旧会话拒绝、全局目录、空 Workspace、同名成员、续读及模型目录。
- [03](issues/03-staff-a-project.md) 和 [04](issues/04-adjust-team.md)：以真实工具调用验证同一 Host 规则、并发撤权、幂等、部分成功和已提交未生效；人工验收模型对确认时机及方案质量的判断。
- [05](issues/05-owner-wiki-and-memory.md)：验证私有目录跨会话保留，记忆可重放、notes 按需读，内置 wiki 与自有 skills 的发现范围。

Harness 和现有产品事实见 [能力核对](materials/harness-support.md) 和 [问题与现状](materials/facts.md)。
