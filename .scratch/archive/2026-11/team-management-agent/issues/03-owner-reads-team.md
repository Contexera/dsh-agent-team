# 03 — 团队管理能看清整个团队

**What to deliver:** Human 问「我现在的团队是什么情况」，管理会话通过 `team_overview` 读取所有 Workspace 的目录和团队现状，通过 `team_models` 列出成员可选模型、reasoning effort 和唯一成员 preset `team-member`。复用 Harness 目录、Host 投影和现有模型目录。

**Blocked by:** 01, 02

**Status:** complete（2026-11-14 Human accept，Task #152：Iris 复看与 Vera 独立验收通过，全门禁含浏览器车道在 HEAD `f5cb783` 全绿）

**独立验收后的修订**（2026-11-14 Reeve，Task #152 同一条 Thread）：Vera 判定不通过、Iris 补了一条 e2e 门禁红。已按三条意见改完并本地提交：渲染出 `(unspecified)`（与 `team_view`／Client 一致，description／README／render／测试四处对齐）；`team-member` 的 `only` 行改为由 `AGENT_TEAM_TOOL_NAMES` 派生，并在 shipping spec 钉住「member 行 == 常量」与「member ∪ manager == 插件默认集」；删除与 `availability` 重复的 `AgentTeamManagerMemberEntry.state` 和已死的 archived 渲染分支；未知 `projectRef` 改为拒绝而不是答空；兼容文档与三个 README 索引行的工具计数改为十二个；`scripts/e2e/team-manager.e2e.ts` 那条「manager 不持任何 `team_` 工具」的过期断言改为「恰好持 `team_overview` + `team_models`」。fork 一条由 Vera 的探针独立证实（被拒）。等 Vera 在新 HEAD 上复验 `manager-reads.spec.ts` 与浏览器车道。

**Required context:** [设计快照](../spec.md) 的「工具和权限」中 `team_overview` / `team_models` 行和「写入结果和失败后的继续」；[产品与现状](../materials/facts.md)；Harness Workspace 目录与 Session controller 模型目录；Host 的成员、Project、owner 和运行态投影。

**Boundaries:** 只读；不读对话正文；不返回私有文件内容或凭据；不写账本；不把模型目录失败当成空目录；不按 handle 猜成员。

- [x] 没有 Workspace、已有空 Workspace、同一 Member 跨 Workspace 参与，以及不同 Workspace 的同名成员，均返回可区分的结果。模型能拿到后续写入所需的稳定 Workspace、Member、Project ref 和 Workspace 的 checkout 路径，以及团队级关键开关（如 Worker 开关）、成员运行态与结构化故障诊断（`availability`、`diagnostic`、`capabilityState`、`capabilityWarnings`）和 Project 失败暂停订阅计数；按 member ref 查看详情可拿到实际私有目录，不返回凭据、会话正文或私有文件内容。
- [x] 每个 Project 返回共同目标和 owner 的 `memberRef` / `responsibility`，每个 enabled Member 返回 active owner 关系；以中性事实显示仅有 Human owner 的 Project、责任未说明的 owner，以及没有 active owner 关系的长期 Member，不使用 `missing`、健康异常或必须修复的判定。普通非 owner 参与仍如实显示，不能误报为授权关系或要求 Host 禁止。
- [x] 成员、Project、owner 和看板摘要可以按范围查询和继续读取；大团队不会被无提示截断。没有结果与目录读取失败返回不同结果。
- [x] 模型路线和可选 effort 与 Web 成员编辑器一致；provider 局部失败不被当成目录为空，结果有界；成员可选 preset 中没有 `team-manager`。
- [x] Host 在真实工具调用中检查当前活 Agent 和登记。普通 Session、Member、fork、已归档或被替换的管理会话被拒绝；不能靠传入 id 或同名 preset 通过检查。验证其他 preset 的工具面不变。（普通 Session、Member、已归档与被替换的管理会话、以及只挂 `team-manager` 同名 preset 的外来 Session 都有专门测试；fork 由独立验收的探针证实——`isSeeded` + `parentSession` 指向 manager + `agentPreset: 'team-manager'` 的 Agent 同样被拒。其他 preset 的工具面由 shipping 与 member-tool-policy 两个 spec 的不变式守住，`team-member` 行现在由 `AGENT_TEAM_TOOL_NAMES` 派生并被 shipping spec 钉住。）
- [x] 工具契约文档记录结果范围、续读、ref 和拒绝语义。

**Evidence to return:** 变更文件、工具与鉴权测试命令及结果、分页/空结果/失败样例、未验证范围。
