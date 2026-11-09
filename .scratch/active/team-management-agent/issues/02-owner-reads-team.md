# 02 — 团队管理能看清整个团队

**What to build:** Human 问「我现在的团队是什么情况」，管理会话通过 `team_overview` 读取所有 Workspace 的目录和团队现状，通过 `team_models` 列出成员可选模型、reasoning effort 和唯一成员 preset `team-member`。复用 Harness 目录、Host 投影和现有模型目录。
**Blocked by:** 01
**Status:** pending

- [ ] 没有 Workspace、已有空 Workspace、同一 Member 跨 Workspace 参与，以及不同 Workspace 的同名成员，均返回可区分的结果。模型能拿到后续写入所需的稳定 Workspace、Member、Project ref 和 Workspace 的 checkout 路径；按 member ref 查看详情可拿到实际私有目录，不返回凭据、会话正文或私有文件内容。
- [ ] 成员、Project、owner 和看板摘要可以按范围查询和继续读取；大团队不会被无提示截断。没有结果与目录读取失败返回不同结果。
- [ ] 模型路线和可选 effort 与 Web 成员编辑器一致；provider 局部失败不被当成目录为空，结果有界；成员可选 preset 中没有 `team-owner`。
- [ ] Host 在真实工具调用中检查当前活 Agent 和登记。普通 Session、Member、fork、已归档或被替换的管理会话被拒绝；不能靠传入 id 或同名 preset 通过检查。验证其他 preset 的工具面不变。
- [ ] 工具契约文档记录结果范围、续读、ref 和拒绝语义。
