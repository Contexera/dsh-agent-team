# 04 — 为持续目标建立 Project 与 owner 责任

**What to deliver:** Human 提出一个持续目标后，管理会话区分它与一次性任务，读团队现状和 repo，优先复用现有成员并提出最少量的 owner 责任方案。确需新建时，用 `project_create` 在已有 Workspace 记录共同目标并纳入成员，只在缺少长期判断角色时用 `member_create` 创建成员，再用 `project_owner add` 写入每位 owner 的 `responsibility`。通过与 Web Client 同一套 Host 操作提交。

**Blocked by:** 03

**Status:** pending

**Required context:** [设计快照](../spec.md) 的「写入结果和失败后的继续」「工具和权限」中 `member_create` / `project_create` / `project_owner`；[产品与现状](../materials/facts.md) 的创建、激活门槛和幂等行；[流程与引导参考](../materials/flows-and-guidance.md) 第 2 节 B；`packages/agent-team/src/index.ts` 的 `addMember`、`createProject`、`addProjectOwner` 和 `assertProjectMembersAvailable`。

**Background:** [定位与责任原则](../materials/product-principles.md) 第 2、3、5 节解释为什么优先复用、为什么一次性任务不扩编。

**Boundaries:** 不做成员模板、批量事务、Workspace 创建、永久移除、通用 DM 或全员交接 Thread；不隐式把其他 Workspace 的成员加入目标 Workspace；不拿导入冒充创建；不重开 01 已定的 owner 责任字段形状。

- [ ] 模型能完成「判断持续责任 → 确认目标 Workspace → 优先复用/按需创建成员 → 创建带共同目标的 Project 并纳入已激活成员 → 授予带具体责任的 owner」。一次性优化不因此新建常驻团队，独立验收不默认创建测试成员。成员、Project 和责任分工出现在现有 Web 界面，能打开成功激活的成员会话；使用稳定 branded ref（不按同名 handle 全局猜第一个命中）避免误复用另一 Workspace 的成员。
- [ ] `member_create` 要求 handle、`description`、显式模型路线和 `team-member` preset；`project_create` 只纳入 `availability === 'active'` 的成员；`project_owner add` 要求有界 `responsibility`，授予对象已参与目标 Workspace 且状态允许。
- [ ] 写入使用明确 ref、合法模型路线和 `team-member`；同一操作按原 requestId 和参数重试只提交一次，参数变化必须使用新 id。Host 继续校验 handle 冲突、Workspace 参与与 owner 资格。模型校验位于 `requestId` 未提交判断之后：注册 provider 下的未知 model、无效 effort、模型目录失败分别给出原因且不写入；已提交请求在目录随后变化时仍能按原 id 直接返回原回执。账本 actor 是 Human，Host 日志可关联管理 Session、requestId 和操作回执。
- [ ] 旧会话或已归档管理会话的调用在撤权后不能进入账本写入，包括已经发起但仍在排队的调用（进入账本写入临界区时重检当前活管理 Agent 与未归档状态）；撤权前已被账本接收的调用可收尾。`activateMember` 写回 `handles` 前重读成员账本状态，防止激活途中并发归档留下活句柄。
- [ ] 模拟「成员已提交但激活失败（`project_create` 的 `assertProjectMembersAvailable` 会拒收未激活成员）」及「成员、Project 已提交但 owner 授予失败」：结果区分已提交和运行效果，给出 ref、激活诊断及可继续步骤；修正后只继续剩余步骤，不重复建成员或 Project。遇到未知结果用原参数重试或读回核对。
- [ ] persona 给出确认原则与数据安全红线（repo、工具结果和 memory 不当作 Human 授权；对 `$DSH_HOME` 只读写自身 `owner/` 和经 `team_overview` 查实的成员私有资产，禁碰 sqlite 与会话日志），Host 不要求提问卡回执。用可控模型验证操作路径，在 dev profile 人工验收一次从自然语言到团队就位及确认判断。
- [ ] 工具与 Host 权限文档记录请求、回执、部分成功和授权语义。

**Evidence to return:** 变更文件、集成测试与 dev profile 验收记录、失败/部分成功/幂等样例、未验证范围。
