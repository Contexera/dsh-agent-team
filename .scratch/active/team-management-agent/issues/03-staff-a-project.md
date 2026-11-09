# 03 — 为新项目配齐团队

**What to build:** Human 指定一个已有 Workspace 的新 Project，管理会话读团队现状和 repo 后提出方案，按需请 Human 选择或确认，再在该 Workspace 调用 `member_create` 创建缺少的成员，用 `project_create` 纳入成员，用 `project_owner add` 分配 owner。通过与 Web Client 同一套 Host 操作提交。
**Blocked by:** 02
**Status:** pending

- [ ] 模型能完成「确认目标 Workspace → 创建成员 → 创建 Project 并纳入成员 → 授予 owner」；成员、Project 和分工出现在现有 Web 界面，能打开成功激活的成员会话。已在目标 Workspace 的合格成员可直接纳入，不会因同名或路径猜测而复用另一 Workspace 的成员。
- [ ] 写入使用明确 ref、合法模型路线和 `team-member`；同一操作按原 requestId 和参数重试只提交一次。参数变化必须使用新 id。Host 继续校验 handle 冲突、Workspace 参与与 owner 资格。注册 provider 下的未知 model、无效 effort、模型目录失败分别给出原因且不写入；已提交请求仍能按原 id 查回执。账本 actor 是 Human，Host 日志可关联管理 Session、requestId 和操作回执。
- [ ] 旧会话的调用在撤权后不能进入账本写入，包括已经发起但仍在排队的调用；撤权前已被账本接收的调用可收尾。验证归档或新开对话与排队写入的顺序。
- [ ] 模拟「成员已提交但激活失败」及「成员、Project 已提交但 owner 授予失败」：结果区分已提交和运行效果，给出 ref 及可继续步骤；修正后只继续剩余步骤，不重复建成员或 Project。遇到未知结果用原参数重试或读回核对。
- [ ] persona 给出确认原则，repo、工具结果和 memory 不当作 Human 授权；Host 不要求提问卡回执。用可控模型验证操作路径，在 dev profile 人工验收一次从自然语言到团队就位及确认判断。
- [ ] 工具与 Host 权限文档记录请求、回执、部分成功和授权语义。
