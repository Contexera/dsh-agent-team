# 05 — 通过团队管理调整成员

**What to deliver:** Human 可用管理会话调用 `member_update`（description、model、capabilities）、`member_state`（suspend / resume / archive / recover）和 `member_workspace`（join / leave）。复用现有 Host 操作、权限检查及回执规则，暂停和恢复复用 Host 已有操作，首版不新增相应 Web 按钮，也不提供永久移除。

**Blocked by:** 03

**Status:** pending

**Required context:** [设计快照](../spec.md) 的「工具和权限」中 `member_update` / `member_state` / `member_workspace` 行和「写入结果和失败后的继续」；[产品与现状](../materials/facts.md) 的局部更新、`adoptMemberRouteFromRequest` 和生命周期队列行；`packages/agent-team/src/index.ts` 的 `updateMember`、`suspendMember`、`resumeMember`、`archiveMember`、`recoverMember`、`joinWorkspace`、`leaveWorkspace`。

**Boundaries:** 不改 Project 名称、描述、归档或 owner 关系（06）；不提供永久移除；不新增暂停/恢复 Web 按钮；不移动 Session；不能退出创建 Workspace；不重开 01 的 owner 责任字段。

- [ ] Host 在 `enqueueLifecycle` 队列内读取成员最新记录并只合并指定字段（Member 会话自身的 `request/header` 模型回写也一并入队合并），确保调整 model 不会把 Human 刚改的 handle 或 description 改回去。更换模型沿用 04 的目录校验（位于 `requestId` 未提交判断之后）；只改其他字段不重新校验已配置的模型。清除能力覆盖和不改能力能区分，沿用现有 allow-list 与缺失能力诊断；已保存但未生效的配置，或激活/应用失败，都有可核对的结果。
- [ ] `member_state recover` 作为运行态操作复用 `recoverMember`（不写账本，需要 Workspace ref），验证「成员因模型不可用或激活失败掉线 → `member_update` 换好模型或修复条件 → `member_state recover` 恢复为可用」闭环；非 enabled 成员或不可重启的拒绝原因原样清晰返回。
- [ ] 加入另一 Workspace 不移动 Session；不能退出创建 Workspace。归档成员按 Host 规则释放相关 Claim、清理参与/Attention 并处理 Task 责任。
- [ ] 已归档、过期 ref 和不满足操作条件等拒绝给出可恢复说明；归档保留私有数据。没有永久移除工具；问到永久移除时说明首版不支持，不指向不存在的 Web 操作。
- [ ] dev profile 人工验收一次跨 Workspace 调整与故障成员恢复闭环；同步工具契约和受影响的维护文档。

**Evidence to return:** 变更文件、Host 队列/并发/恢复测试命令及结果、dev profile 验收记录、未验证范围。
