# 02 — 打开并恢复团队管理会话

**What to deliver:** Human 从 Team 侧栏的 home 级入口打开「团队管理」，主区使用 shipped DSH Session 面板；Host 创建/恢复一条专用 Session，按 D26 的解析顺序归属 Workspace（默认 Workspace → 第一个现有 Workspace → 普通空状态），挂隔离的 `team-owner` preset，持久登记当前 Session id，支持「新开对话」、重启预恢复、归档后自动新开和失败诊断。本票不含九个管理工具。

**Blocked by:** None — no ticket blockers

**Status:** ready

**Required context:** [设计快照](../spec.md) 的「入口和会话生命周期」「工具和权限」；[决策记录](../materials/decisions.md) D26；[Harness 能力](../materials/harness-support.md)；[流程与引导参考](../materials/flows-and-guidance.md) 第 1、3 节；`cordis.patch.yml` 的 preset registry；`packages/agent-team/src/index.ts` 的 `activateMember` / `ctx.agents.resume` / `openTeamStorage`；`packages/agent-team/src/member-runtime.ts`（确认哪些 Member 专用策略不能复用）；`packages/client-agent-team/src/client/navigation.ts`；Harness `session-controller` 的 preset 解析和 `ConversationContent` 的空白会话行为。

**Boundaries:** 不做 Team 主区页面；不自绘 composer；不做 Workspace 创建工具；不提供 preset 切换；不把九个管理工具放进本票；不改 Harness；不把 cwd 当作团队范围；不复用 `applyMemberToolPolicy`（它按 member id 读账本），新增 owner 专用工具策略路径。

- [ ] 入口在宽侧栏、窄屏抽屉和桌面折叠 rail 均可用；点击后让出 Team 的 `main` 影子，显示 shipped `ConversationPanel`，不新增 Team 主区页面。按 D26 解析 Workspace：默认 Workspace 由 `workspace/initializeDefault` 返回（内部按 `defaultWorkspaceId`，不是路径匹配）；没有时用 `workspaceRegistry.list()` 持久顺序的第一项；都没有时显示普通 DSH 的「选择/创建工作区」空状态。验证空白会话在 Workspace 列表就绪后仍能输入。
- [ ] 首次打开创建一条会话；并发打开、刷新页面和重启后从 Host 解析到同一条。Team 导航增加 `owner` 目的地；浏览器只持久化这个 token，不持久化 Session id。当前 Session id 由 Host 私有存储域（`openTeamStorage()`）持久登记。Host 启动时预恢复已登记且未归档的管理会话，冷会话不会因隔离 registry 返回 `agent-preset/not-found`。
- [ ] 「新开对话」仅替换所见的当前 id；两页同时发起不会连续换两条。新会话可用且登记持久化后才切换，旧会话停止、历史和专用目录保留。启动或登记失败可重试，原登记不丢失。
- [ ] 新会话标题为「团队管理」，普通列表显示在所选 Workspace 下；Team 入口固定同名。归档或确认已不存在后再次打开会创建新会话；暂时读不到、格式或加载失败给出诊断，不当作丢失。
- [ ] 按实际工具面验证 preset 隔离与收口：管理会话有 persona、时间上下文、通用文件/命令/搜索/网页/jobs/skill 工具、`ask_user_question`、压缩和 `working_directory`，不含现行 10 个 Team 成员协作工具、成员上下文插件、profile `extraToolGrants` 或宿主全局泄漏工具；普通 Session 与 `team-member` 的组装不变；从现有成员创建入口传 `team-owner` 或未知 preset 在写账本前被拒绝。`team-owner` 的工具策略走 owner 专用安装路径；sandbox mode 在 setup 的 commit 里记录一次，重启不重复。本票校验 preset 的必需行和通用工具面；九个管理工具的 guard 基线由 03–06 各自加入时验证，不在本票要求。
- [ ] persona 只放每次都必须成立的原则（身份与边界、默认动作、确认原则、不可信输入、数据红线、恢复纪律、表达），具体流程放 skills；确认原则和数据红线的行为在 04 验收。
- [ ] 管理目的地不出现 preset 切换控件，普通首页已暂存的 preset 选择或直接调用均不能改挂；普通会话的 preset 切换仍正常。若移除控件，验收明确记录直接 select 无可见反馈。
- [ ] 在已组装的 Web profile 用可控模型验证问题卡的展示和答案回传，管理会话与普通 DSH 对话均走 shipped Session 面板。
- [ ] 组件检查覆盖选中态、加载/失败/重试和离开期间的晚到结果；`npm run test:browser` 走「打开入口 → 直接输入 → 提问 → 新开/重载 → 还原普通 DSH 会话」，检查键盘、焦点、折叠 rail、桌面和 390×844。
- [ ] 更新 preset、会话恢复与术语的维护文档和相关包 README；现有成员协作工具仍只在 `team-member`。

**Evidence to return:** 变更文件、组件与浏览器测试命令及结果、dev profile 手工验收记录、未验证范围。本地 Harness 仍是 rc.1（`66491b05`）；实施前按 rc.2（`ddac9676`）复核或更新 checkout，并在证据里注明实际验证的版本。
