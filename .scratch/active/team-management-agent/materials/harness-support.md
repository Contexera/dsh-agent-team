# Harness 能力核对（2026-11-09）

依据：Team `261b888`；Harness 支持线 `0.2.2-rc.1`（`66491b05`），另对照相邻 checkout `fcc0ad46`。这里记录源码支持，未运行新增的组装旅程。

| 需要 | 当前行为 | 证据 |
| --- | --- | --- |
| Session 内的问题卡 | `dsh-tool-ask-user` 通过 `ctx.userQuestions` 提问，Web profile 挂载对应 UI。自定义 preset 要显式挂 tool；可在 Team 嵌入的 DSH 对话中复用同一套 composer，实际组装列入 01 验收。 | Harness `docs/subsystems/user-questions.md`、`packages/interaction/tool-ask-user/`、`packages/bundle/web-app/cordis.patch.yml` |
| 独立 preset 与冷恢复 | Team 已持有隔离的 preset registry；定义登记一次，绑定按 Agent scope 做，支持只给一条会话使用。Host 可通过 `ctx.agents.create` / `resume` 在 setup 中挂载指定 preset。普通 Session controller 冷恢复时只从它所在的 registry 解析 preset，不能替 Team 冷启动管理会话。 | Team [patch](../../../../cordis.patch.yml) 和 [会话存储契约](../../../../docs/architecture/workspace-session-storage.md)；Harness `packages/api/session-controller/src/agent.ts` |
| 空白会话切换 preset | 普通 picker 可以对未开首轮的会话发起切换。隔离 registry 的 Agent scope 已绑定，另一个 registry 不能再次绑定；单次绑定由 Harness 强制执行。要在 01 用实际 Remote 验证路由与拒绝，也要覆盖 UI 的暂存选择，不能把隐藏 picker 当作保护。 | Harness `packages/client/ui-agent-preset/src/client/seat-store.ts`、`packages/preset/agent-preset-registry/src/index.ts`、`packages/core/scope/src/index.ts` |
| Ungrouped、标题和归档 | 带 cwd 且未分组的会话可出现在普通列表；创建时可以设标题，Harness 仍提供普通重命名。归档通过 `ArchivedSessionGate` 拦后续模型步骤；运行活动另经 Workspace 停止，不替 Team 撤销已经排队的管理调用。 | Harness `packages/api/session-controller/src/{list.ts,index.ts,archived-session-gate.ts}`、`packages/workspace/workspace/src/index.ts`；Team Host `nameMemberSession` |
| Team 内的 DSH 对话 | 现有 Member 路径使用 Session id 选择 DSH 对话；Member 目的地只存在运行时，选中、换代跟随和返回目标与 Member 相连。管理入口应复用对话挂载，另记 home 级导航目的地，不能把它加入 Member roster 或原样复用仅运行时导航。 | Team `packages/client-agent-team/src/client/{index.ts,navigation.ts,TeamAgentsPanel.tsx,TeamWorkspaceBrowser.tsx}` |
| 通用工具和全权限 | Harness `working_directory` 在 preset 外。独立 preset 需有指令加载及自己的上下文维护。全权限允许进程按宿主用户权限访问文件；工具名单不是文件访问边界。 | Team [上下文契约](../../../../docs/team-collaboration/boundaries.md)；Harness `docs/subsystems/sandbox.md`，Web `standard` preset |
| 记忆与 skills | Member 私有记忆会做 16 KiB 限制、转义和替换上下文；它的注入和 skill 目录依赖 Member 身份。目录初始化可以复用，Member 的路径迁移留在 Member 分支；记忆读取、转义与预算逻辑可以共用，但现有上下文入口依赖活 Member。skills provider 已按 scope 注册，可用管理会话自己的内置和私有目录，排除默认搜索目录。 | Team `packages/agent-team/src/{member-context.ts,member-runtime.ts,member-skills.ts}`；Harness `AGENTS.md` 中的 model-visible 日志规则 |
| Harness 自带 Team | 相邻 checkout 的 Harness 自带 Team 是子 Agent 树中的共享任务板，与本项目持久 Member/Workspace/Project 模型不同。管理会话接本项目 Host，不能拿 Harness 自带 Team 的工具或 UI 代替。 | Harness `packages/team/agent-team/README.md`、`docs/subsystems/agent-team.md`；Team [Host 权威](../../../../docs/architecture/host-authority.md) |

01 用真实 Web profile 验证组合效果：外部 bundle 的 ask-user 依赖可解析、冷启动和重载回到同一会话、问题卡的选项与回答路径可用、无 Workspace 时仍显示入口，以及普通 DSH 对话恢复。不能用组件截图代替这条测试。
