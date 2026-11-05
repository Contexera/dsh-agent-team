# 03 — 固定 Member 文件工具与换代语义

**What to build:** Member 在 RC 上得到明确、稳定的文件修改行为，普通 Session 不受 Team 影响；Member 换代恢复只使用 Team ledger lineage，不再把普通前序 Session 写成 subagent 关系。
**Blocked by:** 01
**Status:** done

- [x] `team-member` 显式关闭 apply_patch，模型工具清单中没有 `apply_patch`，宿主以后改变默认值也不会悄悄扩大 Member 工具面。
- [x] Team 没有为 Member 或宿主新增文件观察策略；未读文件修改跟随 RC 默认行为，普通 Session 不因 Team bundle 获得额外工具、策略或提示词。
- [x] 新换代 Session 不写 `parentSession`，也不增加 subagent origin；ledger 继续记录完整前序关系。
- [x] durable binding 已提交但 successor 尚未激活的崩溃场景仍能从 ledger 恢复，carried input 不丢失也不重复，历史 Session 无需重写。
- [x] 真实 preset 组合和相关生命周期测试证明上述行为，受影响的架构说明同步更新。
