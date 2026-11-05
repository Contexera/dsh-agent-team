# DSH 0.2.2-rc.1 适配方案

**状态**：已于 2026-11-05 与用户确认。调研依据为 alpha 阶段记录和 rc.1 复核报告；本方案只描述最终行为与验收，不记录被否决的中间方案。

## 问题

让外部 Agent Team bundle 在 DSH `0.2.2-rc.1` 上完整工作：Member 的创建、恢复、模型编辑、换代和持久存储保持可用，Web Client 正常组合，既有 Session 能升级打开。借升级删除已被官方扩展点取代的临时实现，但不把新功能一并变成适配工作。

普通 DSH Session 不得因 Team bundle 获得新的工具、提示词或文件修改约束。适配与认证不等于发布授权。

## 选定形态

以 DSH `0.2.2-rc.1` 为唯一新基线完成源码迁移，在独立候选环境通过认证后，将声明支持区间移动到 `>=0.2.2-rc.1 <0.2.3`。不维护 0.2.1 与 0.2.2 双线兼容分支。

Member 运行时迁移到新的模型选择与 Projection 契约；vendored SQLite 与上游同版实现重新对齐。Member 文件工具跟随 RC 的默认修改策略，换代 lineage 只由 Team ledger 表达。Client 设置图标改用官方 slot。网络抓取跟随宿主能力，不增加 Team 私有过滤。

## 决策与理由

### 1. 版本与发布边界

- 最终只声明支持 0.2.2 线，下界为已认证的 `0.2.2-rc.1`；engines、全部 DSH peer、CI 基线和兼容文档保持一致。
- 认证通过前不扩大声明区间，不宣称兼容。Node 最低要求随宿主为 24.9；当前开发环境已满足。
- 本轮交付适配、文档和认证证据。Team 版本发布、tag、推送另行取得明确授权。

### 2. Member 模型选择

- 使用 `agent.model.select()` 和 `agent.model.current()`，移除可变 `ModelSelectionRef` 与旧的选择 hook；保留切换提示所需的单参安装。
- 创建、恢复、实时编辑、清除自定义模型以及 Host 重启继续使用 ledger 中的模型意图。恢复时按上游规则处理已保存路由与显式推理强度，不能只依赖创建时的 fallback。
- 模型编辑仍在同一 Session 生效，并从下一个模型步骤使用新选择；已准备步骤不被重写。压缩路径只调整输出 token 上限，不改路由或推理强度。
- 上游 rc.1 在换代前加了一道压缩守卫：新窗口装不下当前上下文且压不到阈值以下时，切换被拒绝（`MODEL_SWITCH_COMPACTION_FAILED`）并保留原路由，pending 选择一直留着，直到换回兼容模型，期间每个回合都带同一条错误。这是上游行为，不加抑制逻辑；上面「从下一个模型步骤生效」因此是有条件的——取决于上下文能否压进新窗口。

### 3. Projection 与冷 Session inbox

- 自有 Projection 在 Host 发布依赖它的能力之前完成异步注册并保存 handle；读取走 handle，释放走插件生命周期。
- 删除失效的 StateMap 声明合并，不保留 registry 级弃用读取作为长期路径。
- 冷 Session 的待处理输入由 Team 的窄读取逻辑从公开 `agent/inbox/spliced` 事件重建，仅服务于换代前的普通输入判断。它保持 next-turn/next-step 顺序与去重约束；非法 splice 失败关闭，不猜测修复。Team-only 待处理通知不阻止换代，普通输入继续阻止。

### 4. SQLite 契约

- vendored fork 与 `0.2.2-rc.1` 上游实现重新同步，包括批量删除、版本打戳和错误处理，而不是只补一个让类型通过的方法。
- 对照依赖移动到同一版本，继续保持它仅作源码夹具；发布包不新增对上游 SQLite 包的运行时依赖。
- 既有 Team ledger 不重写、不增加第二套存储或静默回退。

### 5. Member 文件修改与网络

- 不为 Member 增加 `fs-observation-policy`，跟随 RC 允许未读文件修改的默认行为。该策略的事件没有按 Agent 隔离，把它放入 Member preset 可能改变普通 Session，超出 Team 边界。
- `team-member` 的 filesystem 工具显式保持 `applyPatch: false`，避免宿主默认值以后翻转时悄悄增加工具。
- `web_fetch` 跟随宿主，可访问私有目标；不添加只覆盖单个工具的 Team URL 拦截。Member 已有 shell 网络能力，部署级网络隔离应由进程、沙箱或工具组合完成。

### 6. 换代 lineage

- 新换代 Session 不再写 `parentSession`，也不伪装成 `origin: subagent`。该字段已专指 subagent 创建关系。
- Team ledger 的 Session transition 是唯一换代 lineage 依据；崩溃恢复、carried-input replay 和通知继续读取它。历史 Session 不需要重写。

### 7. Client 与可选能力

- 设置导航图标使用 `settings.section.icon`，注册 id 与现有 Team section id 相同；删除 MutationObserver、DOM 标记和覆盖 CSS。
- 本轮不接结构化右键菜单，不增加 Member 会话行 trailing 状态，不补新增语言。这些都有独立产品价值判断，不是兼容工作量。

## 验收接缝

1. **候选环境**：使用不可变的 `dsh-v0.2.2-rc.1` 独立检出，重新安装与构建，不复用日常 Harness 的产物。
2. **Member 运行时**：覆盖创建、恢复、模型实时编辑与清除、显式推理强度、重启、同 Session 后续步骤，以及压缩只改输出上限。
3. **Projection 与换代**：覆盖注册/释放、冷 Session 两类队列、普通输入与 Team 通知、非法 splice、崩溃后续代和 carried input 恰好一次。
4. **存储**：核对 vendored 文件与上游同版差异，只保留明确的本地模块头与必要 lint 标记；运行后端和 Team ledger 的持久化、重放、恢复测试。
5. **真实组合**：确认 Member preset 挂载、普通 Session 隔离、文件工具最终行为、条件工具下的可见性与执行、Cordis 4.1 的 isolate 和延迟表达式。
6. **浏览器**：运行完整浏览器旅程，覆盖 Team 进出与普通 DSH 恢复、设置图标、Member Session、桌面和 390×844、键盘与焦点、错误和空状态。
7. **升级与安装**：打开上一认证线写下的 Member Session，至少包含一次换代；评估当前已发布 Team bundle 在候选 DSH 上的可用性。验证打包安装、单一 DSH 依赖代际和无 peer 冲突。
8. **交付检查**：执行生成物稳定性、typecheck、完整测试、lint、build、pack、artifact 与 diff 检查；任何失败都先修复，不放宽声明区间掩盖。

## 未决事项

没有剩余产品决策。Cordis 4.1 隔离、条件工具和既有格式升级属于必须实测的未知结果，不是可跳过的方案选择。若实测证明所需公开能力不存在，再回到用户确认新的取舍；不私下修改 Harness 或增加兼容层。

## 正式文档出口

实施时同步更新受影响的架构、开发环境、兼容基线和包说明。认证证据留在工作项；完成全部实施票后，将长期结论迁入维护文档，关闭或完成所有票，再按 scratch 生命周期归档本工作项。
