# 01 — Member 运行时迁移到 RC 契约

**What to build:** Member 在 DSH 0.2.2-rc.1 上能够创建、恢复、实时切换模型、重启和换代；自有 Projection 使用正式 handle，冷 Session 不再通过弃用 API 判断待处理普通输入。
**Blocked by:** None — can start immediately
**Status:** done

- [x] 模型选择不再依赖 `ModelSelectionRef` 或旧 hook；创建、恢复、实时编辑、恢复宿主默认和 Host 重启均使用 ledger 中的最新模型意图。
- [x] 恢复 Session 时按上游规则保留或替换显式推理强度；模型编辑从下一个模型步骤生效，已准备步骤不被重写，压缩请求不发生路由固定错误。
- [x] 自有 Projection 在消费者可用前完成异步注册并保存 handle，读取和释放都经过 handle；失效的 StateMap 增强和自有 registry 级 `stateOf` 读取消失。
- [x] 冷 Session 的 next-turn/next-step 由公开 splice 事件重建；普通输入继续阻止换代，Team-only 通知不阻止，非法或重复历史失败关闭。
- [x] 针对上述行为的窄测试和 RC typecheck 通过，不保留旧 API 兼容分支。
