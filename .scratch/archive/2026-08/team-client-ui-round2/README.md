# Team Client UI Round 2 — 时间戳、排版统一、任务卡重设计

- 状态：done（已实现并合入，长期结论沉淀至 docs/frontend-design/README.md）
- 最后核对：2026-08-21
- 前置：round 1 已合入（`e34524b`），设计基准见 `docs/frontend-design/README.md`

## 当前前沿

用户已确认三项优化方向，尚未开始实现：

1. **消息时间戳**：Host 投影目前不暴露 `occurredAt`；确认的展示位置是发送者名字同一行（名字右侧，tertiary 小字）。
2. **排版统一**：Human 字面文本与 Agent markdown 正文字号/字族不一致（markdown 根节点 `font:` shorthand 覆盖了容器设定），需要统一到同一档正文规格并理顺名字行层级。
3. **Task 入口卡重设计**：现全宽按钮在多条堆叠时过重、箭头横向位置依赖 `width:100% + margin-left:auto` 导致不一致；方向是 fit-content 紧凑胶囊、箭头位置由构造保证一致、默认安静 + hover 渐进反馈（含箭头位移）。

## 已确认决策快照

见 [spec.md](spec.md)。

## 结束条件

- `AgentTeamMessage` 携带 `occurredAt` 并经 typert 再生成到达 Client；channel 与 thread 的消息名行渲染时间。
- 排版统一后 1440×960 与 390×844 截图检查通过，正文字号一致。
- 任务卡新样式在单条与多条堆叠两种形态下均通过浏览器截图验收。
- `npm run typecheck && npm test && npm run lint && npm run build && npm run test:browser` 全绿。

## 正式文档出口

完成后更新 `docs/frontend-design.md`：排版表（时间元信息行）、组件合同（任务卡新样式、消息行时间字段），并删除其中对应的两处 `> TODO:`。本目录随后归档至 `.scratch/archive/2026-08/team-client-ui-round2/`。
