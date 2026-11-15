# Team Conversation 顶层页面设计优化（channel / thread）

- 状态：archived — 本轮实现、文档和浏览器验收已完成；本文件保留当时的设计与实施记录，不是当前 UI 合同。
- 最后核对：2026-08-22
- 范围：`packages/client-agent-team/src/client/` 中挂在 `conversation` slot 的 `TeamChannelPage` 与 `TeamThreadPage` 及其直接子件（header、时间线、空态、composer 容器行为）。不含侧栏面板。
- 前置：round 1 已合入；round2（时间戳/排版统一/任务卡）已由并行 agent 完成合入（`db47f7a`…`23779a8`），本工作项未触碰其改动面。

## 本轮已实现（用户委托自主决策的组合：A1+A2+C1+D1+E1+F1）

- **A1 Thread header 减负**：`Task #N` 与状态 Pill 同行（`.titleLine`）；Claims 改公共 `DisclosureRow` 折叠为一行摘要（`Claims · N`），展开才渲染 Claim 列表；header 顶部 padding 收紧。风险区保留常驻（需立即注意的信号）。
- **A2 频道返回路径**：`TeamNavigation.backToChannels()` 清除 `channelRef`；频道页补返回行"返回频道列表"，与 Thread 页对称。
- **C1 空态居中**：时间线内容列改 flex column + `min-height:100%`，空/加载态包 `.emptySurface`（`margin:auto`）双向居中。
- **D1 关闭任务提示条**：closed 任务不再渲染禁用输入框，composer 槽位换成解释性提示条 + reopen 动作。三态语义明确化：open=header 验收/关闭；accepted=输入框可用 + header reopen 主按钮；closed=提示条 + 提示条内 reopen（全页唯一）。
- **E1 aria-label 修正**：时间线区域用专用 `timelineLabel` key；移除 publicSection 重复标签与失效的 `participants` key。
- **F1 在线数**：频道 meta 追加 `onlineCount`（available/working 计为在线）。

## 实现中的关键取舍

- reopen 归属两次返工：先只留提示条按钮 → e2e 暴露 accepted 态依赖 header reopen → 最终三态模型。教训：resolution 是三值，不要把 accepted 与 closed 合并处理。
- `.timelineContent` 全局 flex column 已用两档截图回归验证无副作用。
- 空态垂直居中第一版 `flex:1` 失效（容器撑满后 margin auto 无空闲空间），改为纯 `margin:auto`。

## 后续候选（历史记录）

完整调研见 [next-round-survey.md](next-round-survey.md)（P0：日期分隔线、收件人显式化、channel 发送幂等对齐、侧栏频道订阅；P1：深链恢复、Agents 主区视图、成员弹层搜索；P2：未读徽标/Attention/键盘导航/草稿暂存，含 Host 契约阻塞点）。其中 P0 与 round3（run hover/mention chip/排版刻度）均已完成；其余条目只是当时的候选。

## 归档时的完成情况

- `npm run typecheck && npm test && npm run lint && npm run build && npm run test:browser` 已通过。
- 1440×960 与 390×844 截图已核对：Thread header、关闭态提示条、频道返回行/在线数和空态居中均生效。
- `docs/frontend-design.md` 已同步布局骨架、状态胶囊、弹层、时间线及 composer 合同。
- 本文件中列出的 P0 候选已在 `295154b` 实现；P1/P2 仅为历史候选，不构成待办。

## 正式文档出口

长期结论已写入 [`docs/frontend-design/README.md`](../../../../docs/frontend-design/README.md)。新一轮设计应以该文档和当前源码为准，并在 `.scratch/active/` 建立独立工作项。

---

# 以下为 survey 阶段原始记录

## 区域归属（背景事实）

两页渲染进 DSH Shell 的 `conversation` slot，是 Team 模式下三个影子座位之一（priority -100）。路由在 `TeamConversation.tsx`：navigation 快照有 `taskRef+threadRef` → Thread 页；只有 `channelRef` → Channel 页；否则欢迎态。导航流 Workspace → Channel → Task → Thread；localStorage 只持久化 mode + workspaceId，刷新后回到频道列表（现状有意为之）。

## 冲突约束（round2 领地，勿动）

- `channel.module.css` 的 `.taskFooter*` 任务入口卡样式与结构（D3）。
- 消息名行元信息/时间戳、正文字号字族统一（D1/D2，涉及 `TeamMessage.tsx` 名行与 `conversation.module.css` 排版表）。
- 若做依赖 `occurredAt` 的候选项（如日期分隔线），须等 D1 合入后基于其字段设计。

## 候选清单

### A. Header 结构

**A1 Thread header 减负（渐进披露）** —— 推荐
- 现状：back 行 + h1 + 任务标题 + 状态 Pill + 动作按钮 + 运行风险区 + Claims 区全部堆在 `surfaceHeader`（auto 行），时间线被压低；390×844 下首条消息出现在约 300px 处，Claims 区占近半屏。
- 方向：Claims 收敛为一行摘要（`Claims · N · 状态计数`）+ 展开（details/disclosure 或弹层）；风险区保留但紧凑化（它是需要立即注意的信号）；任务标题与状态合并为一行。
- 取舍：展开多一次点击；Claims 在任务生命周期中低频变化，折叠收益大于成本。符合 frontend-design.md 设计原则 4（渐进披露）。

**A2 两页 header 对称**
- 现状：Thread 有返回行（返回频道/workspace），Channel 没有任何"回到频道列表"的路径——`TeamNavigation` 没有 clearChannel action，用户只能切 tab 或点别的频道。
- 方向：给 Channel 补返回行（新增 navigation action 清除 channelRef），或两页统一改面包屑。补返回行成本低、与现有 backToWorkspace 模式一致。

**A3 Header 信息层级整合**
- 现状：h1(20px) + 描述(13px) + meta(12px) 三层纵排；Thread 侧 h1 + 标题 + pill 又三层。桌面 header 顶部 padding 18px 偏大。
- 方向：meta 信息一行化（成员数 · 描述）；Thread 的 `Task #N` 与状态 Pill 同行；收紧垂直 padding。

### B. 时间线

**B1 Task 入口卡** —— round2 D3 领地，跳过。

**B2 日期分隔线** —— 依赖 round2 D1 的 `occurredAt` 字段，暂缓；D1 合入后可作后续增量。

**B3 未读/新更新模式** —— sticky 胶囊 + boundary 跳转已较成熟，低优先级，不动。

**B4 "加载更早"改无限滚动** —— 可行（IntersectionObserver sentinel）但手动按钮更可控、无意外网络开销；建议维持现状，不列入本轮。

### C. 空态 / 加载态

**C1 Channel 空消息态居中引导** —— 推荐
- 现状：左对齐两行小字贴在内容列顶部，下方大片空白（见 ui-01/empty-channel.png）。
- 方向：垂直居中的引导空态（主句 + hint，语气与 welcome surface 一致），仍用 tertiary 弱化，不引入新组件。

**C2 Agents tab 主区死胡同**
- 现状：选中 Agents tab 且未选 agent 时主区只有一句"选择一个 Agent"；Agent 信息只在侧栏面板里。
- 方向（较大）：主区渲染 Agent 详情视图（presence、描述、参与的 channels/claims）。属于新功能而非纯样式，需单独确认信息架构后再立项。

### D. Composer 区

**D1 关闭任务的 composer 禁用解释** —— 推荐
- 现状：closed thread 中 textarea 直接 disabled，placeholder 不变（仍显示"写一条消息…"），无任何解释；窄屏截图里输入框灰置原因不明。
- 方向：disabled 时替换为说明文案（"任务已关闭，重新打开后可继续讨论"）+ 内联重开入口或指引；复用 locale key 机制。

**D2 错误语义分区**
- 现状：所有错误（含 accept/close/reopen 等 Task 动作失败）都走 TeamComposer 的 error prop 显示在输入框下方，语义错位。
- 方向：页面级 banner/toast 承载动作类错误，composer 内仅保留发送相关错误。成本中等，收益中等。

### E. 可访问性

**E1 timeline aria-label 文案错位** —— 推荐（小修）
- 现状：Thread 时间线 `aria-label={t('participants')}`、Channel 时间线 `aria-label={t('channels')}`，读屏播报与内容不符；thread 的 publicSection 同样误用 participants。
- 方向：新增专用 locale key（如"消息时间线"）并替换三处。

### F. Header 元信息增值

**F1 成员 presence 摘要**
- 现状：channel headerMeta 只有"N 位成员"；members 数据已含 presence。
- 方向：追加"N 在线"或 presence 点摘要，低成本。可选。

### G. 导航持久化

**G1 刷新恢复 channel/thread 选择**
- 现状：`readSnapshot` 故意丢弃 channelRef/threadRef/taskRef，刷新回频道列表。
- 方向：持久化并校验恢复深链（ref 失效时回退欢迎态）。属行为变化，涉及"刷新落点"的产品决策，需单独确认。

## 推荐组合（本轮）

高价值低成本优先：A1（Thread header 减负）+ A2（Channel 返回路径）+ C1（空态引导）+ D1（关闭态解释）+ E1（aria-label 修正）；F1/A3 作为顺带项。C2/G1/B2 另行立项。

## 结束条件（挑选并立 spec 后填写）

- [ ] 用户从候选中确认本轮范围，写入 spec.md
- [ ] 实现后 `npm run typecheck && npm test && npm run lint && npm run build && npm run test:browser` 全绿
- [ ] 1440×960 与 390×844 截图人工过目，键盘/focus 检查通过
- [ ] `docs/frontend-design.md` 同步受影响章节

## 正式文档出口

完成后更新 `docs/frontend-design.md`（布局骨架/组件合同中受影响条目）；本目录归档至 `.scratch/archive/YYYY-MM/team-conversation-page-design/`。
