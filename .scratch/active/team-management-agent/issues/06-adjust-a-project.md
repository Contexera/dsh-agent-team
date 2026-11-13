# 06 — 通过团队管理调整 Project 与 owner 责任

**What to deliver:** Human 可用管理会话调用 `project_update`（改名、改描述、archive）和 `project_owner`（update responsibility / remove）。复用现有 Host 操作、权限检查及回执规则；局部字段在账本队列内合并；owner 责任更新使用 01 定义的只追加操作。

**Blocked by:** 01, 03

**Status:** pending

**Required context:** [设计快照](../spec.md) 的「工具和权限」中 `project_update` / `project_owner` 行和「写入结果和失败后的继续」；[产品与现状](../materials/facts.md) 的 Project、owner 和归档行；`packages/agent-team/src/ledger.ts` 的 `updateProject`、`archiveProject`、`changeProjectOwner`、`accountabilityReturnsFrom`。

**Boundaries:** 不编辑 Project 订阅（引导使用现有 Web 界面或由 Project owner 处理）；不切换 Worker 全局开关；不提供永久移除；不新增 DM 或全员交接 Thread；不改 01 的 owner 责任字段形状。

- [ ] `project_update` 的 `name` / `description` 改为可选，Host 在账本串行队列内读取当前 Project 并只合并传入字段；未传字段不会被调用前快照覆盖。改名或改描述后，Project 的共同目标和 owner 责任仍一致可见。
- [ ] `project_update archive` 按 Host 规则释放活跃 Claim、清理相关 Attention、停止并清除该 Project 下的全部订阅私有状态，保留历史；归档后 Project 从 Team 各界面隐藏，开放 Task 按 v3+ 规则交回 Human。验证重复归档和已归档 ref 的拒绝语义。
- [ ] `project_owner update` 只改变指定 Project 关系中的 `responsibility`，不改 Member 全局 description，并在后续 ownership context / `team_view` / `team_overview` 一致替换旧责任；更新走 01 的只追加操作，不通过 remove+add 模拟。
- [ ] `project_owner remove` 撤回 owner 关系；v3+ 账本下仍参与 Project 的成员保留 Task 责任；如果 owner 是唯一参与关系，开放 Task 交回 Human。验证并发撤权、过期 ref 和已归档 Project 的拒绝。
- [ ] 同步工具契约、`docs/team-collaboration/tools.md` 和受影响的维护文档；dev profile 人工验收一次 Project 改名/归档和一次 owner 责任更新/撤回。

**Evidence to return:** 变更文件、账本/归档/并发测试命令及结果、dev profile 验收记录、未验证范围。
