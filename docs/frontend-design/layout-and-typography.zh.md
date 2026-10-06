# 布局、排版与身份

[English](layout-and-typography.md) | 中文

## 布局骨架
- 对话面（channel/thread）：`display:grid; grid-template-rows: auto 1fr auto`——header / 可滚动时间线 / composer 三段，`height:100%`，内部滚动 `overscroll-behavior: contain`。
- 内容列 `max-width: 880px` 居中；时间线左右 padding `clamp(18px, 3vw, 36px)`。
- 断点 `@media (max-width: 600px)` 收紧 padding、header 纵排；验收必须覆盖 390×844 无横向溢出。
- 侧栏由宿主 `sidebar` slot 决定宽窄（wide/rail 二态）；rail 模式下 Team 只渲染图标按钮列。
- Team 的 mode、Workspace、最后选中的 Channel/Thread 以及 Inbox 页位置（navigation 事实，不是未读事实）写入浏览器缓存；切回 Team 或刷新后恢复最后位置。未读和 Attention 不写入浏览器缓存。
- 欢迎态是独立居中 surface（eyebrow + h1 + 引导文案），不进入三段骨架。
- Thread 是导航终点；Task 只在存在时叠加为 header/card。taskful Thread 的头部将 `Task #N` 与状态 Pill 放在同一行（`.titleLine`），任务标题为副行；Claims 用公共 `DisclosureRow` 折叠为一行摘要，展开才渲染 Claim 列表；header 动作区只在 open 任务出现（验收/关闭），accepted 任务保留 header 重新打开主按钮。taskless Thread 显示 Thread 标题与唯一的「转为任务」动作，不显示状态、Claims 或 Task resolution controls。
- 关闭任务是终态：composer 槽位换成解释性提示条（`.closedBar/.closedNotice`，文案 + 唯一的重新打开动作），不再渲染禁用的输入框。taskless Thread 保持普通 reply composer。
- Channel 页与 Thread 页对称：Channel 页有返回行（`backToChannels` 清除 `channelRef` 回到频道列表）；时间线空/加载态在自由空间内居中（`.emptySurface` + `margin:auto`）。
- 侧栏两个面板（Agents/Channels）都订阅 `{kind:'workspace'}` 变更；`TeamChangeStream` 在每个页面内按 scope 共享一个流式订阅，每次开场或重连基线都触发补读，之后响应匹配的通知。Channel 刷新成功后清除加载错误，不清除无关的操作错误。
- 发送幂等：Channel 顶层发送与 Thread reply 一致按 requestId 幂等。Channel composer 的「作为任务」是默认关闭的原生 pressed control（自绘 chip，任何宽度都保留文字，选中态为 primary 底色，hover 不改变按压底色；形态与座位见设计语言表的「模式控件」行）；新发送显式携带 taskless 意图，选中时才原子创建 Task。`committed` 与确定性拒绝（如 `unread_required`、`stale_revision`）后换新 id；`confirmation_required` 保留同 id 续发同一操作；传输异常保留 id 以便安全重试（Host 按 requestId 去重并返回原结果）。成功发送后「作为任务」复位为关闭。

## 排版与身份
| 元素 | 规格 |
| --- | --- |
| 页头 h1 | 20px/28px, weight 600 |
| 发送者名 | 13px/20px, weight 600, primary——字号走内容轴的次级档（默认字号下即 13px/20px），设置调大时作者名与正文一同变大；右侧同行跟随时间元信息 |
| 消息时间 | 11px/20px, tertiary；当天 HH:mm，同年 MM-DD HH:mm，跨年完整日期（`formatMessageTime`，本地时区） |
| Inbox 行时间 | 11px/18px, tertiary, `tabular-nums`；今天只显示 `HH:mm`，上一个本地日历日显示「昨天 HH:mm」，更早回落消息时间形态，精确本地时刻挂在元素的 `title` 上。Thread 入口行在工作尚未走完时借用同一个标签表示后续动态时间。Inbox 身份行窄到装不下计数与时刻两者时，它整个不绘制（见下文「收件箱」） |
| Human 正文 | 14px/22px（默认字号；两种正文都跟 Settings 正文字号轴——`--dsh-content-font-size` + 其 px delta 加到每个字号与行高，表中为默认值。`.messageText` 容器统一 pre-wrap/break-word，正文由 `TeamMessage` 自行渲染） |
| Agent 正文 | markdown 原语渲染；根节点 `font:` shorthand 被重置为继承，与 Human 共用同一文字网格（14px/22px）。标题用聊天刻度（h1 17px、h2 16px、h3–h6 15px，margin 12px 0 4px），页面 h1 保持最高层级；段落/列表 margin 6px、`li + li` 间距 2px、strong 600；pre 8px 外边距 + 10px 12px 内边距、13px；表格 cell 纵向 padding 5px。**超过折叠阈值的长正文改走文档节奏**：块间距 16px、列表项 6px、行高 24px、标题边距 24px 0 8px 且 h2 18px、h3 17px（pre/blockquote 外边距同 16px）；短消息保持聊天刻度 |
| 任务/活动行 | 11–12px, tertiary, 活动行居中 |
| Thread 入口行 | 12px/18px tertiary，`fit-content`；hover/focus-visible 只提亮文字并把 chevron 前推 2px |
| 入口状态簇 | 11px/18px，领起入口行：18px 头像圈、8px 状态点、状态词、18px 未读胶囊（11px/600） |
| 空/加载态 | 13px tertiary；加载点 8px 脉冲动画（reduced-motion 下关闭） |

消息时间来自 Host 投影：`AgentTeamMessage.occurredAt` 与包裹它的 ledger 操作同源（旧账本在回放时归一化）。分组 run 只在 run 头部渲染名字与时间；run 内被折叠的消息若与上一条间隔 ≥5 分钟（`team-separators.ts` 的 `RUN_GAP_MINUTES`，`isRunGap` 单一权威判断），由回合分隔线补回它的时刻（见下）。

- **Agent 头像**：按 `memberId` 字符串哈希出稳定色相（`hash*31+charCode mod 360`），`hsl(var(--team-avatar-hue) 42% 46%)` 底 + 白色首字母；同一 Member 跨页面、跨会话颜色不变。侧栏 Agent 行复用同一身份语言（24px 缩版），presence 指示叠在头像右下角，描边环取 `--dsw-specific-sidebar-fill` 与侧栏底色同色。
- **Human 头像**：`--dsw-alias-state-business-primary` 强调底色，与所有 Agent 区分。这一底色与首字母同时是该 Human 的兜底：资料里存了头像图片之后，Human 出现的每一处座位都换成图片；显示名则来自同一份资料投影——在 `TeamConversation` 里只解析一次（`name ?? t('human')`）、以 `humanName` 传给两个页面，所以消息发送者、花名册行、mention 兜底名与 `member:human` ref 不会各走各的，也不会各自退回字面 `human`。DOM 上以 `[data-human]` 标记。
- **presence 圆点**：available=done 绿、working=ongoing、error 红、unavailable 用灰色叉点（`TeamPresenceDot` 的 `presenceDotState` 映射）。这一映射有两种呈现：凡是「把 Member 列成行」的地方都用 `TeamMemberAvatar` 的角标（首字母 + 右下角圆点），而 composer 的收件人菜单用裸 `TeamPresenceDot`——那是菜单行不是花名册行。所以花名册行统一靠头像角标、菜单保留圆点，这个不对称是有意的，不是遗漏。
- **Thread 入口头像叠放**：`TeamAvatarStack` 复用同一套色相哈希，但不挂 presence 圆点——它回答「谁在做这件事」，不回答「谁现在在线」。画到读者本人时，那**一枚**胶囊改画 Human 的图片：同一份 18px 几何、同一个 2px 环、`object-fit: cover`，色相留在图下当解码期间的底，其余所有者照旧是首字母。Inbox 行的领起簇与 Channel feed 的 Thread 入口行都按这条规则接线。
- **叠放里的 Human 座位**：Agent 座位从不画图片（色相 + 首字母就是 Agent 的全部身份），所以叠放里只有「是 Human 的那一枚」走真实身份。座位从 Host 拿到 Human 的 Member id（`AgentTeamInbox.humanMemberId`，与 `AgentTeamView` 同一条 initialization 记录），再由 `namedAvatarOwners(owners, human)` 把那一枚所有者换成 `humanName`/`humanAvatarUrl`——名字与图片都来自 Client 这一份投影，所以改名时胶囊首字母与叠放标签里的名字一起动，而不会停在资料已经不用了的旧首字母上；解不开的字节与其它座位一样经 `useAvatarImage` 回落到显示名首字母。Host 在 Inbox 行上也用这个运行时显示名来称呼 Human，而不是退回 Agent 花名册里从来没有的 durable `member:human` id。
- 错误一律 `--dsw-alias-state-error-primary` 并配 `role="alert"`。
