# 刷新、文案、可访问性与演进

[English](refresh-copy-accessibility.md) | 中文

## 数据刷新语义
- channel 视图：change 事件触发 `refresh()` 时按 `messageRef` 去重合并新窗口与已加载历史（`mergeChannelView`），cursor 取更旧者，`hasMore = fresh.hasMore || current.cursor < fresh.cursor`。新窗口对它覆盖到的每条消息**权威**——change 唤醒必须让该行的活字段（Task 状态、最新时刻、未读）跟着新事实一起动——而更早加载的历史消息保留而不是丢弃。每次 refresh 还会读一次 Workspace Inbox 切片并据此重建「threadRef → 未读」映射；该读取失败则清空映射。
- thread 视图：被动事实合并进 currentFacts。打开与到达的读取全部自动推进 durable read pointer（有界批次余量由串行续读循环清零），`newFactsCount` 仅驱动纯跳转提示。
- `loadOlder` 有并发保护（loadingOlder 状态禁用按钮）。

## 文案与本地化
- 全部用户可见文案经 locale key（`locales.ts` zh/en 同构，key 类型取自 zh）。禁止在组件里拼接英文句子。
- 参数化 key 的约定：`{count}` 数量、`{ids}` 成员句柄列表、`{kind}` 内部种类、`{number}` 任务号、`{actor}`/`{direction}` 活动主体。
- 错误文案跟随 Host：有明确补救动作的拒绝走 locale key（`staleRevision`、`memberNotFollowing`），而 Client 无法更好地措辞的失败——例如传输断开——直接展示 Host 自己的 message。

> TODO：原始 transport message 应该换成本地化文案，还是保持 Host 的原话？当前各面是原样展示。

## 可访问性基线
- 侧栏分区折叠头是原生 button（`aria-expanded`），键盘 Enter/Space 由原生行为保证。
- 长消息的「展开全文/收起」是原生 button 并携带 `aria-expanded`，键盘 Enter/Space 原生可达。
- 行内 ⋯ 菜单按钮带 `aria-label`（`{name} 的操作`）与 `aria-expanded/haspopup`；菜单项由公共 `Menu` 提供完整键盘与外点关闭路径。
- listbox/option 完整键盘闭环（见 composer 一节）；Channel composer 的「作为任务」使用原生 button 的 `aria-pressed`，Space/Enter 均可切换。
- 图标按钮均有 aria-label；装饰元素 `aria-hidden`。
- Thread 入口的「开门」控件是一枚原生 button，label 同时携带 Thread 与它的未读数。旁边画出的胶囊 `aria-hidden`，头像叠放是单个带标签的 `role="img"`，且刻意留在按钮之外以保住它自己的可访问名。
- 消息时间线区域使用专用 `timelineLabel`（"消息时间线"），不误用频道/参与者标签；Thread 内部事实分组段不带重复的区域标签。
- 未读分界线 `role="separator"` 仅作信息展示（不再驱动滚动定位）；run 内回合分隔线同样 `role="separator"`，可访问名称即其标注的时刻。
- 新增可见 UI 必须通过 `npm run test:browser` 的桌面 1440×960、窄屏 390×844 和键盘检查（见 `development/README.md`）。

## 验证与演进流程
- 影响可见 UI、Client bundle、slot 或 Remote activation 的改动：`npm run typecheck && npm test && npm run lint && npm run build && npm run test:browser`。Thread-first 变更的 browser 验收还须覆盖默认 taskless 发送、default-off 「作为任务」键盘切换、promotion 后 Host reread、taskless header/Claim gating，以及桌面与 390×844。
- 截图写入 Git 忽略的 `artifacts/browser/`，仅供本次审查；少量能说明验收结论的代表图复制进 `.scratch/archive/YYYY-MM/<work>/validation/` 并附 README 说明。
- 本文档描述的行为变化必须在同一次改动中同步更新；历史设计来由归档到 `.scratch/archive/`，正式文档只链接不转述。
- CSS Module 里 TSX 引用了、但模块没定义的 class 会解析成 `undefined`，元素因此**无样式渲染**，且 build、类型检查、测试都不会报错。当某条规则的存在与否决定布局时，要到组装后的 bundle 里取证（computed style、offset 或截图），不要只读 TSX；把依赖它的状态写成断言，而不是写成注释。
