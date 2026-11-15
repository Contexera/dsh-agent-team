# 01 — Workspace 参与关系与授权

**What to build:** Member 与 Workspace 之间从「实体上的单一 workspaceId」变为「显式参与关系」（纯 `{memberId ↔ workspaceId}`，与 channel membership 同形）：Human 能把既有 Member join 进其他 Workspace、从非默认 Workspace 撤回。全部 Workspace 授权判定从单字段相等改为参与集合包含；Channel 入组、DM 资格照旧按 Workspace 作用域但改看参与集合。**本票完全不碰 Session**：Session 永驻默认 Workspace（= 创建地，不可变），跨 Workspace 文件工作走绝对路径。

**Blocked by:** None — spec 经 Human 验收后即可开始。

**Status:** complete（PR #26）

背景与边界（自包含）：

- 参与是投影关系（对齐 `memberships` 形状）：`member-added` 的 workspaceId 天然产生首个参与，既有成员 replay 为单参与，无数据迁移；`member.workspaceId` 语义改为「默认 Workspace」，不可变。
- 撤回（`member-workspace-left`）按 Workspace 释放：该 Workspace 的 active Claims 释放为公开 `claims_released` Activities、Attention 结束、Channel 成员退出——对齐现有 archiveMember 的释放形状但限定作用域。守卫：默认参与不可 leave、参与集合不可清空。
- 归档语义分档在账本层就位：默认 Workspace 上的 `member-archived` 把释放推广到全部参与（现有 archiveMember 的多参与推广）。
- 授权放宽的形状是「参与集合包含」，不是「跳过检查」；未参与 Workspace 的 mutate/view/inspect 照旧拒绝。
- 边界规则（spec §9）：参与的 Workspace 在 DSH 侧被删，分档处理——非默认参与自动撤回（system-authored left，释放其 Claims/Attention），默认 Workspace 被删则 Member 不可用（现有激活失败路径）。

- [ ] `member-workspace-joined` / `member-workspace-left` durable 操作（baseRevision 并发控制 + 幂等 + replay 校验齐全）
- [ ] 既有账本 replay：旧 Member 解码为单参与，全量 projection 重建无差异
- [ ] 全部 Workspace 授权断言点（账本约 44 处 + Host 侧约 4 处 + Channel/mention/membership 判定）改为参与集合包含；每处有测试证明「未参与 Workspace 仍被拒」
- [ ] join 端到端：Member join 第二 Workspace 后在其 join Channel → 读/回/认领/DM 全通，Session 仍驻默认 Workspace
- [ ] 撤回端到端：离开后该 Workspace 的 Claims/Attention/membership 释放，其余参与与身份资产原样
- [ ] 守卫测试钉住：默认参与不可 leave、集合不可清空、join 目标同名 handle 拒绝、workspace 删除分档（非默认参与自动撤回 / 默认 workspace 删除 → 不可用）
- [ ] suspended member 可被 join（纯账本事实，不激活）；撤回与在途回复竞态：leave 先提交则后续回复被拒
- [ ] member 级 Remote（recover/setMemberState）从非默认参与 Workspace 发起按参与集合放行
- [ ] 默认 Workspace 归档 = 全参与释放（多参与推广）
- [ ] view / 成员列表把 Member 呈现在每个参与的 Workspace 下
- [ ] `npm test` 全绿
