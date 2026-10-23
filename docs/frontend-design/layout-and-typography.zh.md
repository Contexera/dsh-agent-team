# 布局、排版与身份

[English](layout-and-typography.md) | 中文

## 布局骨架
- 对话面（project/thread）：`display:grid; grid-template-rows: auto 1fr auto`——header / 可滚动时间线 / composer 三段，`height:100%`，内部滚动 `overscroll-behavior: contain`。
- 内容列 `max-width: 880px` 居中；时间线左右 padding `clamp(18px, 3vw, 36px)`。Project 页的 feed stage 一并取内容行与 composer 行（`grid-row: 2 / 4`），打开的讨论面板因此能横跨两者。
- 断点 `@media (max-width: 600px)` 收紧 padding、header 纵排；验收必须覆盖 390×844 无横向溢出。
- 侧栏由宿主 `sidebar` slot 决定宽窄（wide/rail 二态）；rail 模式下 Team 只渲染图标按钮列。
- Team 的 mode、Workspace、最后选中的 Project/Thread，以及 Inbox 页位置写入浏览器缓存。这些是 navigation 事实，不是未读事实。切回 Team 或刷新后恢复最后位置。未读和 Attention 不写入浏览器缓存。
- 欢迎态是独立居中 surface（eyebrow + h1 + 引导文案），不进入三段骨架。
- Thread 是导航终点；Task 只在存在时叠加为 header/card。taskful Thread 的头部将 `Task #N` 与状态 Pill 放在同一行（`.titleLine`），任务标题为副行。header 动作区只在 open 任务出现（验收/关闭），accepted 任务保留 header 重新打开主按钮。taskless Thread 显示 Thread 标题与唯一的「转为任务」动作。它不显示状态。
- 关闭任务是终态：composer 槽位换成解释性提示条（`.closedBar/.closedNotice`，文案 + 唯一的重新打开动作），不再渲染禁用的输入框。taskless Thread 保持普通 reply composer。
- Project 页与 Thread 页共用顶层栏、发丝线与 880px 居中阅读列。Project 页的顶层栏取 shipped session 页头的形状与节奏：10px 顶距下一条 30px 身份行，下面接页签行。身份行是 Project 标题，description 跟在标题同一条基线上，单行截断（完整文本在 `title`）。
- 顶层栏是**面板 chrome，不与阅读列共用左边缘**。shipped 会话页头左缩进 20px（`padding: 10px 28px 0 20px`），其正文列居中，所以那个页面上标题与标题下面的正文刻意不在同一条 x 上。Team 各面照搬这个安排，而不是把页头居中对齐到阅读列。该栏也不带返回行：侧栏本来就列出全部 Project，页内再放一个返回控件是重复入口。Project 页另在页头收口线上加一条 `项目 | 看板` 页签行；taskless 讨论在右侧 360px 面板里打开，座位只在面板打开时预留。看板是唯一被允许超出阅读列的 Team 表面，上限 1240px。时间线空/加载态在自由空间内居中（`.emptySurface` + `margin:auto`）。
- 侧栏两个面板（Agents/Projects）都订阅 `{kind:'workspace'}` 变更。`TeamChangeStream` 在每个页面内按 scope 共享一个流式订阅，每次开场或重连基线都触发补读，之后响应匹配的通知。Project 刷新成功后清除加载错误，不清除无关的操作错误。
- 发送幂等：Project 顶层发送与 Thread reply 一致按 requestId 幂等。Project composer 的「作为任务」是默认关闭的原生 pressed control。chip 自绘，任何宽度都保留文字。选中态为 primary 底色，hover 不改变按压底色。形态与座位见设计语言表的「模式控件」行。新发送显式携带 taskless 意图，选中时才原子创建 Task。`committed` 与确定性拒绝（如 `unread_required`、`stale_revision`）后换新 id。`confirmation_required` 保留同 id 续发同一操作。传输异常保留 id 以便安全重试（Host 按 requestId 去重并返回原结果）。成功发送后「作为任务」复位为关闭。

## 排版与身份
| 元素 | 规格 |
| --- | --- |
| 页头 h1 | 20px/28px, weight 600 |
| 发送者名 | 13px/20px, weight 600, primary——字号走内容轴的次级档（默认字号下即 13px/20px），设置调大时作者名与正文一同变大；右侧同行跟随时间元信息 |
| 消息时间 | 11px/20px, tertiary；当天 HH:mm，同年 MM-DD HH:mm，跨年完整日期（`formatMessageTime`，本地时区） |
| Inbox 行时间 | 11px/18px, tertiary, `tabular-nums`；今天只显示 `HH:mm`，上一个本地日历日显示「昨天 HH:mm」，更早回落消息时间形态，精确本地时刻挂在元素的 `title` 上。Thread 入口行在工作尚未走完时借用同一个标签表示后续动态时间。Inbox 身份行窄到装不下计数与时刻两者时，它整个不绘制（见下文「收件箱」） |
| Human 正文 | 14px/22px（默认字号；两种正文都跟 Settings 正文字号轴——`--dsh-content-font-size` + 其 px delta 加到每个字号与行高，表中为默认值。`.messageText` 容器统一 pre-wrap/break-word，正文由 `TeamMessage` 自行渲染） |
| Agent 正文 | markdown 原语渲染；根节点 `font:` shorthand 被重置为继承，与 Human 共用同一文字网格（14px/22px）。标题用聊天刻度（h1 17px、h2 16px、h3–h6 15px，margin 12px 0 4px），页面 h1 保持最高层级；段落/列表 margin 6px、`li + li` 间距 2px、strong 600；pre 8px 外边距 + 10px 12px 内边距；表格 cell 纵向 padding 5px。**超过折叠阈值的长正文改走文档节奏**：块间距 16px、列表项 6px、行高 24px、标题边距 24px 0 8px 且 h2 18px、h3 17px（pre/blockquote 外边距同 16px）；短消息保持聊天刻度。**markdown 盒被限宽在阅读列内**：≥4 列表格在列内横滚而非画到列外，且该上限须在正文链两层都声明（长正文多出 `data-document` 包裹层） |
| 围栏代码块 | 跟 Settings 的代码字号轴，而不是钉死的聊天刻度：13px 是默认 11px 设置下的渲染值，设置调大时整块随之变大（走 `--dsh-code-font-delta`，与内容轴同一个 px delta 手法）。因此文字与承载它的行高不会各自走开 |
| 任务/活动行 | 11–12px, tertiary, 活动行居中 |
| Thread 入口行 | 12px/18px tertiary，`fit-content`；hover/focus-visible 只提亮文字并把 chevron 前推 2px |
| 入口状态簇 | 11px/18px，领起入口行：18px 头像圈、8px 状态点、状态词、18px 未读胶囊（11px/600） |
| 空/加载态 | 13px tertiary；加载点 8px 脉冲动画（reduced-motion 下关闭） |

消息时间来自 Host 投影：`AgentTeamMessage.occurredAt` 与包裹它的 ledger 操作同源（旧账本在回放时归一化）。分组 run 只在 run 头部渲染名字与时间；run 内被折叠的消息由**行自己**说时刻——hover 或键盘焦点落在该行时，时刻出现在头像座，时间线上没有任何常驻时刻标签。间隔 ≥5 分钟的相邻消息，只有 Project feed 在两者之间画一条不写时刻的 `TeamRunDivider` 发丝线。判据是 `team-separators.ts` 的 `RUN_GAP_MINUTES`，`isRunGap` 是单一权威判断（见下）。

**身份行与头像座写的不是同一个标签**。身份行独占正文列，用完整墙上时钟形态（`formatMessageTime`：当天只写时刻、同年带月日、跨年写完整日期）。

头像座是 34px、既不裁剪也不撑宽的盒子，因此只写**时刻**（`formatClockTime`）。带日期的形态同年实测 57px、跨年 87px，足以画到旁边的字上。run 在每个日历日切换处断开，所以续行必与它 run 的首行同天，日期已由上一行写出。精确瞬间仍挂在座位标签自己的 `title` 上（`formatAbsoluteTime`），与 Inbox 行、Project 入口行同一约定。

- **Agent 头像**：按 `memberId` 字符串哈希出稳定色相（`hash*31+charCode mod 360`）。`hsl(var(--team-avatar-hue) 42% 46%)` 底 + 白色首字母。同一 Member 跨页面、跨会话颜色不变。侧栏 Agent 行复用同一身份语言，取会话时间线身份座的 34px，与两行文案块（20px 标题 + 17px 注释行）基本齐平。presence 指示叠在头像右下角。描边环取 `--dsw-specific-sidebar-fill`，与侧栏底色同色。
- **Human 头像**：`--dsw-alias-state-business-primary` 强调底色，与所有 Agent 区分。这一底色与首字母同时是该 Human 的兜底。资料里存了头像图片之后，Human 出现的每一处座位都换成图片。显示名来自同一份资料投影。`TeamConversation` 里只解析一次（`name ?? t('human')`），以 `humanName` 传给两个页面。因此消息发送者、花名册行、mention 兜底名与 `member:human` ref 不会各走各的，也不会各自退回字面 `human`。DOM 上以 `[data-human]` 标记。
- **presence 圆点**：available=done 绿、working=ongoing、error 红、unavailable 用灰色叉点。映射在 `TeamPresenceDot` 的 `presenceDotState`。这一映射有两种呈现。凡是「把 Member 列成行」的地方都用 `TeamMemberAvatar` 的角标（首字母 + 右下角圆点），而 composer 的收件人菜单用裸 `TeamPresenceDot`。那是菜单行，不是花名册行。所以花名册行统一靠头像角标，菜单保留圆点。这个不对称是有意的，不是遗漏。
- **Thread 入口头像叠放**：`TeamAvatarStack` 复用同一套色相哈希，但不挂 presence 圆点。它回答「谁在做这件事」，不回答「谁现在在线」。画到读者本人时，那**一枚**胶囊改画 Human 的图片。几何是同一份 18px，环是同一个 2px，`object-fit: cover`。色相留在图下，当解码期间的底。其余所有者照旧是首字母。Inbox 行的领起簇与 Project feed 的 Thread 入口行都按这条规则接线。
- **叠放里的 Human 座位**：Agent 座位从不画图片。色相 + 首字母就是 Agent 的全部身份，所以叠放里只有「是 Human 的那一枚」走真实身份。座位从 Host 拿到 Human 的 Member id（`AgentTeamInbox.humanMemberId`，与 `AgentTeamView` 同一条 initialization 记录）。再由 `namedAvatarOwners(owners, human)` 把那一枚所有者换成 `humanName`/`humanAvatarUrl`。名字与图片都来自 Client 这一份投影。所以改名时胶囊首字母与叠放标签里的名字一起动。它们不会停在资料已经不用了的旧首字母上。解不开的字节与其它座位一样经 `useAvatarImage` 回落到显示名首字母。Host 在 Inbox 行上也用这个运行时显示名来称呼 Human。称呼不用 Agent 花名册里从来没有的 durable `member:human` id。
- 错误一律 `--dsw-alias-state-error-primary` 并配 `role="alert"`。
