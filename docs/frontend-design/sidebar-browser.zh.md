# 侧栏工作区浏览器

[English](sidebar-browser.md) | 中文

工作区是单行选择器，不是列表。其下的「频道」「Agents」只属于当前这一个 Workspace。收成一个触发器后，侧栏读作「你在 X ＋ 这是 X 的内容」。一个低频切换占据的行数还给下面的列表。

折叠不丢信息。工作区行本就不带未读标记，跨 Workspace 未读由收件箱入口汇总。收件箱入口留在选择器**之上**。入口合计取自每个可见 Workspace，是选择器范围之外、唯一跨范围的目的地。不能被读成「点名某个 Workspace 的那行」下面的一行。没有 Workspace 可写时，名册为空，或选择已不在名册里。浏览器就在选择器自己的座位上说明这件事，而不是画一个死掉的字段。

触发器沿用创建表单里单选字段的带框形态（`.workspaceTrigger`，12px 圆角、34px 行高、`aria-haspopup="menu"` 加 `aria-expanded`）。这行「你在哪」因此不被读成频道列表的第一项。触发器常驻 business 色文件夹图标，因为它始终在展示一个选择。触发器以自身文本写出所选 Workspace，完整路径挂 `title`。点击打开公共 `Menu` 并勾选当前项。

可访问名同时说出这是什么字段、它正显示哪个 Workspace。示例是 `工作区，Alpha`。看不见这个字段的读者，否则拿不到这个值。

这个菜单已是切换 Workspace 的唯一路径，打开即取焦。portal 出去的列表要下一帧才落位，选择器在列表上屏后把焦点放到打开的那一行。`autoFocus` 仍留给原语去管它自己的那份职责：以「当前聚焦行」为基准的方向键移动，以及 Esc 把焦点交回触发钮。

Workspace 概览是当前页时，概览携带 `aria-current='page'`。与原先被选中的那一行一致，取共享 hover 底色作为标记。字段自己的那层底色就是常态。底色才是「当前页」的记号。

骨架：「频道」「Agents」两个常驻分区共用原生 button 折叠头。折叠头是原生 button（`TeamSidebarSection`，`aria-expanded`，默认展开）。两个分区同处一个滚动容器，分区头右侧只放新增按钮。折叠状态是本浏览器偏好，不是 Team fact。两个面板均按工作区分键，经 `sidebar-sections.ts` 写 localStorage。key 是 `dsh.agent-team.sidebar-sections`。刷新与重挂载后保持，不进 ledger。工作区选择器是字段而非分区，自身不存折叠偏好。

刻意保持安静。折叠头无 hover 底色，仅 chevron 变色反馈。不展示分区计数。行形态有两样。频道行保留 `#` 标识。Agent 行复用头像语言并叠加 presence 角标。行内元数据（成员计数、presence 文字）已移除，保持列表简洁。

定位高亮单一化，对齐宿主会话树「父静叶亮」的惯例。任一时刻侧栏只有一行携带 `aria-current='page'` 与 hover 底色。打开 Channel/Thread 时是频道行。Member Session 视图打开时，是被选 Agent 卡片（`.agentSelect[aria-current='page']`）。否则是工作区选择器：选择器的概览为当前页时。

嵌入的 Member Session 是唯一能压在「读者仍身处的 Team 面」之上的覆盖层。那可能是 Inbox 页，也可能是读者打开这个 Agent 时所处的 Channel/Thread。此时高亮归嵌入 Session 自己的 Agent 卡片。下层那个面保留原位，但不携带高亮。覆盖层关闭后原样取回。Inbox 入口同样如此：入口页面在屏上时才是被标记的那一行。

行级 ⋯ 菜单是 `TeamRowMenu`，复用公共 `Menu`。`Menu` 用 `portal` + `closeOnPointerLeave`，锚为裸 ellipsis 图标按钮。hover、focus-within、菜单开启三种状态下可见。菜单开启时该行钉住 hover 底色（`data-menu-open`）。菜单含「编辑」入口，打开对应编辑器。
- error 态成员额外出现「恢复」项，走 `recoverMember` Remote。Host 向这个成员的活跃会话 steer 续作 prompt。这是运行时动作，不落 ledger。历史上的「从全新上下文开始」入口已移除。Member 经 `context_rollover` 工具自管上下文，Host 侧 clear-context Remote 保留为无可见入口的迁移逃生门。

频道编辑器（`编辑频道`）：名称/说明输入框 + 成员增删字段集。保存钮无改动即禁用，这是 dirty 门。提交走 `updateChannel` Remote，幂等 request 同载荷复用。成功后由投影刷新回填行文案，不做乐观行内改名。成员增删仍走既有 join/remove Remote（request 按 方向+成员+Channel 键复用）。

Agent 编辑器（`编辑 Agent`）：名称/说明输入框 + 模型选择。模型选择复用公共 `Menu` 原语。触发钮呈 Input 形态：当前值 + 旋转 chevron。选项首行「跟随全局默认」，其后按 provider 分组标题 + 模型行，选中尾勾。目录经宿主级 `llm.models` 取得，不依赖任何活跃会话。提交走 `updateMember` Remote。缺省模型即清除覆盖，回到 Host 默认继承。改模型对活跃 Member 原地更新 live model selection，保持 Agent 与 Session 身份不变。后续请求使用新选择。纯展示编辑不重启。

Agent 卡片会话视图里，Agent 行的头像与文案整体是选择按钮。按钮读作 `打开 {name} 的会话`，点击不再退出 Team 模式。导航快照保留当前 Channel/Thread，并叠加运行时字段 `memberSessionId`。同时附 `returnToSessionId`，两者均不持久化。再调用 `sessions.open(memberSessionId)`。
- `conversation` 影子此时让位。shipped 会话根在 Team 侧栏之间渲染这个 Member Session。任何显式 Team 导航（选工作区/Channel/Thread）都会关闭成员视图，并恢复导航前的 Team 位置。页脚「对话」关闭成员视图，还原 `returnToSessionId`，再离开 Team。普通外壳不会停在成员会话里。

Member 经 `context_rollover` 换新上下文时，Agents 面板观察这个 Member 的旧→新 Session 绑定。Agents 面板仅在嵌入页正是被观察的旧 live Session id 时恰好跟随一次。归档视图不跳转。

窄屏 rail 三个图标按钮自上而下：收件箱（`IconQueueOutline14`，16px）→ 频道（`IconListPenOutline16`）→ Agents（`IconAgentPresetOutline16`）。不复用 checklist（任务）或 user（成员）图标。收件箱图标是目的地。点击打开 Inbox 页并请求展开侧栏。频道/Agents 图标点击请求展开侧栏，并聚焦对应分区头部。

Agent 创建流程没有频道选择页，Agent 编辑器没有成员区块。Channel 成员只在 Channel 侧管理（创建对话框初始 Member、频道编辑器成员行、成员管理对话框）。未入 Channel 的 Member 仍可经 DM 触达。

引入入口（`从其他 Workspace 引入`）是创建对话框内的 disclosure 按钮，它在新建与引入两个视图间切换。引入视图复用共享 `TeamMemberRow` 名册，仅列全局存在且尚未参与此处的 Member。suspended 也在列，因为加入不依赖可用性。确认走持久 `joinWorkspace` Remote。失败保留弹层与请求以便重试，requestId 复用。成功后行经 workspace 重取出现。

Agent 行上的破坏性动作按上下文分档。非创建 workspace 显示「从此 Workspace 撤回」。退出仅针对该参与。确认文案陈述其他 workspace 的工作、session 与私有记忆不受影响。创建 workspace 显示「归档」。全量归档，多参与时注明同时从其他 N 个 workspace 收起。Agent 行上刻意不加按 workspace 的归属徽标。参与关系就在每个已参与 workspace 列表中的出现里，依据 Host 参与投影。Client 不再叠加过滤。

对话框主体只保留一条块节奏。模式切换按钮是主体第一个块，与所切换的内容之间留 16px。名册保持共享的 2px 行距。说明行与加载/空态行走对话框自己的 12/18 说明标尺。这样引入 Member 时不会把同一份名册画成第二种密度，也不会让说明文字顶上标题的字号。

嵌入的 Member Session 输入面就是 shipped composer 本身，不做任何修改。Team 不注册任何 member-session composer surface：没有 shadow、没有 trigger sources、没有 dock strip。键盘契约、命令与引用菜单、附件都与普通会话完全一致。

Team 模式沿同一做法把侧栏的 shipped 全局件一并收起。新建会话按钮与全局面板栏（今天是插件管理入口）指向的是 profile 而不是 Team。模式成立时隐藏，离开即还原。

slot 选举摘不掉别的插件注册的列表行，入口文案又是本地化的。显隐不锚文案而锚模式本身。普通对话保留入口，浏览器测试把转换两端都钉住。进 Team 前可见，进入后仍在 DOM 但已隐藏。

## 收件箱（Inbox）

「收件箱」入口。宽栏是工作区选择器**之上**的一张卡片。入口合计取自每个可见 Workspace，是选择器所命名的那个范围之外、唯一跨范围的目的地。侧栏由入口领起，入口不站在那个范围里面。窄轨没有选择器可领起。收件箱入口就是 rail 第一枚图标。

宽窄两处用同一套方式标记未读：图标左上角一个点。数值取各可见 Workspace 的整片未读 Inbox 合计，mention 只是其中一类。为 0 时不渲染。没有未读就是没有这个记号，而不是画一个空点。点是 8px 的 `--dsw-alias-state-business-primary`。队列给「点名了这位读者」的 Thread 用的是同一种实心墨。于是同一个颜色走到哪里都还是「这需要你」。点外加 2px 所在表面的描边，描边是 `--team-mark-ring`。规则是：凡是自己上底色的表面，都把当下这层底色交出来。卡片在悬停与当前页时交，rail 按钮在悬停、聚焦与当前页时交。

这层底色是半透明的。环画两层：上层是这层底色，下层是所在表面不透明的底色。叠加结果正好等于控件此刻的真实表面。只画上面那层，等于在已经加深过一次的底上再加深一次，读者看到的是一圈晕而不是描边。叠放胶囊守同一条规则（`avatar-stack.module.css`），两边各自报上自己所在的表面。侧栏的点是 `--dsw-specific-sidebar-fill`（与 Agent 角标同色），Inbox 页行与 Channel feed 入口行的胶囊是页面底色 `--dsw-alias-bg-base`。没有底色可交时两层同色，等于什么都没画。因此，点读起来是压在图标笔画上的一个记号，而不是与笔画糊在一起。卡片有底色时也一样。

点挂在图标自己的包裹层上。包裹层是 `.inboxMark`：`position: relative`、`flex: 0 0 16px`。两轴各 `-2px`。因此无论那枚图标坐在 34px 卡片里还是 36px rail 按钮里，点都落在同一个字形的同一个角上。在窄轨上，点也始终留在 rail 区域会裁剪到的那个 36px 控件盒内部。

数字住在宽窄两处的可访问名（`收件箱，6 条未读`）与窄轨悬停提示里。一次 hover 即得，侧栏本体永远不印数字。

Inbox 页作为屏上面孔时卡片/图标携带 `aria-current='page'`。窄轨那枚图标还带上卡片同款当前页底色。rail 没有文字，底色是 rail 唯一能说「你在这」的东西。被嵌入的 Member Session 覆盖期间，入口只是被记住的位置，不携带高亮。

`TeamConversation` 第四个面：Thread | Channel | Inbox | welcome。选 Inbox 清掉 Channel/Thread 面。选 Workspace、Channel 或 Thread 清掉 Inbox。从 Inbox 行进入 Thread 后，Back 落在该行 Thread 的 Channel。Inbox 不进返回栈。再进 Inbox 走左侧卡片或窄轨图标。

### 页面框架与页头

页面走**共享对话座位**。座位包括：与 Channel/Thread 相同的页头带、880px 居中阅读列、`clamp(18px, 3vw, 36px)` 边距、稳定 scrollbar gutter。页头除 h1 外还有一行计数。形态是分段而不是句子。分三段：Thread 数、页面真正关心的整片未读数、提及总数。未读数是 primary 600 墨色，两侧保持 secondary。提及总数仅当队列里真有提及时才出现。

分段之间只靠间距分隔，窄座位换行时不会把标点拖到行首。每一段本来就自带单位词。

### 两片与合并顺序

对每个可见 Workspace 发一次 Inbox 调用，合并成 **Host 自己的行序**：先提及、再最新、Thread ref 破平。合并不能另起一套顺序。靠提及挤进截断线的行，合进来之后不能沉到更新、但没被提及的行下面。各 Workspace 切片本来就是这个顺序发到的。

页面按 Host 的两片渲染。上段「需要我」是未读队列，页头那段计数只数上段。下段「最近活跃」是读者写过 Message 的 Thread：按最新活跃降序，跨 Workspace 合计上限 5，与上段不重复。两段共用同一个行组件。下段的行没有未读计数：零意味着不渲染胶囊，而不是渲染一枚写着 0 的胶囊。下段的行保留每一行都有的那条领起簇。打开页不确认任何内容（见 [Thread Attention 与 Inbox](../team-collaboration/)）。点开行的 durable Thread read 才清 marker 与徽标。

### 行结构

行是整宽的 8px 圆角队列行，形态取自 shipped 双行结果行。左右 8px 内缩，共享 `--dsw-alias-interactive-bg-hover` 底色，焦点环内缩。排布是一个 grid。第一轨属于这条 Thread 上的人，宽度就等于画出来的那个簇，另加行内 8px 间距。

领起簇挂在行里面，每一行都有，无论有没有未读。为计数预留的槽位在没有未读的 Thread 上永远是空的。簇与所领起的身份行按几何中心对齐，不按基线。Human 那一枚画的是图片，浏览器把替换元素的基线读成图片下边缘。按基线对齐会把这行身份行压下去 4px，整行也跟着高 4px。首字母领起的行纹丝不动。shipped 双行结果行的 `.searchResultHeading` 也是把自己的标记居中在自己的标题行上。

行说的每一句都从下一列起。身份行、身份行下方的摘要、上方的段标题共用同一条左缘，距行缘 34px。每一行只画一张脸时如此，段标题也内缩到这一条。真带叠放的行按每多一张脸右移 12px。这是行自己画出来的宽度，而不是别行为最宽簇预留的宽度。而改前一行有两条（计数与摘要 8px、溯源 34px），段标题还有第三条。

### 信息顺序

行承载 Human 定死的信息顺序。

(0) 每行以**「谁在这条 Thread 上」**领起。Task 有活跃 Claim 所有者时画那套叠放。叠放用 Channel feed 的原话 `claimers`。判定与上文 Thread 入口行同一条：未 released 的 Claim、Task 处于 in_progress/in_review、按 Claim 顺序去重。没有活跃所有者时回落到这一行时刻背后的人。`newestActor` 是关于这条 Thread 唯一已知的事。两者都由 Host 解析好，行不必自己拿 Member 名册。同一 Thread 在两段里画的是同一个簇。

(1) 身份行——Channel 用 13px/20 primary 600 领起。屏幕上的行跨了不止一个 Workspace，前面才加 `workspace / `。taskful 时后面接同一枚发丝线 chip `Task #N`，再接这个 Task 当下的状态。

状态画在号码已经在的位置，说的是 Task 自己的状态，不是 Thread 的：8px 状态点 + 11px 状态词，相隔 4px。Thread 头部那枚 Pill 用的就是这一对。它跟溯源同处一个被压成一行的文本串，所以窄座位把它和 Channel 名、号码一起缩短，而不是给它单独挖一个洞；只作讨论的 Thread 既没有 chip 也没有状态。

这一行**保持为一个文本节点串**。分隔符本身就是独立文本节点。拆成多个样式化子项会丢掉控件可访问名里的空格。同时身份行用省略号压成一行。窄座位缩短溯源，不把一行折成三行。`overflow: hidden` 保证比座位还宽的 Channel 名不会把滚动条推进共享 timeline。

身份是队列读者扫读的对象，整行的墨色由身份承担。改前摘要拿着最重的墨，身份反而最轻。一页读下来是十段黑字，而不是十个条目。

(2) 计数胶囊收在身份行右端、与时刻相隔一个行内间距。身份行右端用的是共享计数胶囊（见「计数胶囊」）。Thread 点名了这位读者时是实心底色，只是有新动静时用**完全相同的几何**画成 `--dsw-alias-border-l2` 发丝线。于是两种未读共用一套语法，只靠墨色区分。Thread 再次被点名时行也不会跳动。计数超过 99 显示 `99+`，其中的提及拆分经胶囊自身的 label 抵达读屏与 hover。行的可见文本始终是 Thread 本身，不再有第二枚可见计数。

(3) 下方的摘要——直接渲染 Host `previewText`。120 字帽，13px/20 secondary。落在身份行自己那一列，只占一行。

(4) 最新时刻跟在计数之后收在身份行末端，11px tertiary `tabular-nums`。时间形态见「排版体系」表的 Inbox 行时间。精确本地 `YYYY-MM-DD HH:mm` 挂在元素的 `title` 上。

这条身份行自己是 size container。计数胶囊下限 18px、8px 间距与时刻 28px，合计 62px。两位计数时 70px。线宽不足时整个不绘制时刻。装不下两者的队列行留住计数与自己的边界，不把时刻挂到边界之外。行仍是两行形态，精确时刻由 Thread 给出。

### 段计数与行激活

每个段标题自带本段的条数：队列的条数，以及被截到五条的「最近活跃」实际在屏上的条数。条数同样内缩到 34px 的列上。点击行选择该行 Workspace 并打开 Thread。

### 状态与订阅

空态讲共享空态语言：与 Channel/Thread 同一套 13px `strong` 标题 + 12px 提示。文案是「收件箱是空的」+「你参与的 Thread 有新活动、或有人提到你时，会出现在这里」。loading/error/retry 复用共享对话类。后台刷新失败保留行，以 `role='alert'`、`--dsw-alias-state-error-primary` 报告。

Inbox 页打开时订一次无 scope 的 changes，唤醒重拉列表，离开即停。徽标同法订阅，唤醒只重拉合计（`limit: 1`），绝不拉列表。徽标还会在每次 durable Thread read 完成后直接刷新。Host 的 changes 对 read 刻意不唤醒：read 不改变任何共享 projection。这个 read 消费了读者自己的未读，含 mention marker。
