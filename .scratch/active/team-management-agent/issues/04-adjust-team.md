# 04 — 通过团队管理调整现有团队

**What to build:** Human 可用管理会话调用 `member_update`（description、model、capabilities）、`member_state`（suspend / resume / archive）、`member_workspace`（join / leave）和 `project_owner remove`。复用现有 Host 操作、权限检查及回执规则，暂停和恢复复用 Host 已有操作，首版不新增相应 Web 按钮，也不提供永久移除。
**Blocked by:** 03
**Status:** pending

- [ ] 工具只更新指定字段；例如调整 model 不会把 Human 刚改的 handle 或 description 改回去。更换模型沿用 03 的目录校验；只改其他字段不重新校验已配置的模型。清除能力覆盖和不改能力能区分，沿用现有 allow-list 与缺失能力诊断；已保存但未生效的配置，或激活/应用失败，都有可核对的结果。
- [ ] 加入另一 Workspace 不移动 Session；不能退出创建 Workspace。归档和退出 Workspace 按 Host 规则释放相关 Claim、清理参与并处理 Task 责任；撤回 owner 时，仍参与 Project 的成员保留 Task 责任；如果 owner 是唯一参与关系，开放 Task 交回 Human。
- [ ] 已归档、过期 ref 和不满足操作条件等拒绝给出可恢复说明；归档保留私有数据。没有永久移除工具；问到永久移除时说明首版不支持，不指向不存在的 Web 操作。
- [ ] dev profile 人工验收一次跨 Workspace 调整；同步工具契约和受影响的维护文档。
