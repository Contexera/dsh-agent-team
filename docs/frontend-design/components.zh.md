# 组件合同

[English](components.md) | 中文

## TeamMessage（消息行）
- Props 有五组：`senderName`、`memberId`、`human`、`body`、`grouped`。
- 可选 `occurredAt`：名字行时间元信息。
- 可选 `mentionHandles`：Human 正文中的 mention chip 集合。
- 可选 `senderTitle`：悬停显示成员描述。
- `children`：渲染进 messageBody 尾部，承载入口行等扩展。
- 分组规则：相邻两条同为消息、sender 相同，才折叠。活动行会打断 run。折叠行隐藏头像与名字。`visibility:hidden` 保持栅格对齐，padding 收紧为 `2px`。
- 头像座位只替一位作者画图片：资料头像只在**这一行就是 Human 本人**时才落座。Agent 行无论上层传下来什么，都保持共享色相 + 发送者首字母。同一个座位替别的作者画读者的脸，等于把两个人画成一个人。头像首字母取 senderName 去掉 `@` 后首个字符大写。
- 行的操作**浮在** Message 旁边的一张卡上，而不是长在行里：复制、引用，以及正文点名读者时的那枚「提到了你」提示。这张卡属于**行**而不是属于某一个动作，所以收起引用（只传 `rowActions`、不传 `onReply`）会保留复制与提示、只去掉引用钮。两者都不传的表面则完全没有卡，Project feed 就是如此；而读同一条 Thread 的两个面——Thread 页与 Project feed 旁边的讨论面板——都提供这张卡，因为它们渲染的是同一批行，否则读者一旦转向面板，就得离开面板才能引用眼前这条 Message。行本身保持扁平，因此一次 hover 只让一条 Message 得到一层底色，而不是让整条时间线长出纹理。
- 回答另一条 Message 的正文，先给出**已解析的引用**（`data-quote-line`）：父消息作者 + 一行带省略号的开头文字。两者都由 Host 从 ledger 解析，而不是从正文里读出来，因此引用永不与它所指向的内容不一致，父消息落在已加载历史窗口之外时也照样填得上。凡是能到达原文的表面，整块引用都是跳转入口；到不了就是惰性文字。不是回复的 Message 不渲染引用。
- 超长正文折叠看 display 字符数。超过 `MESSAGE_COLLAPSE_CHARS`（`team-formatters.ts` 单一权威，600）的正文默认收进限高预览。预览约 8 行 / 176px，底部 alpha 渐隐遮罩，不涂主题底色。预览下方「展开全文」安静文本钮负责展开，展开后同位置「收起」收回。`aria-expanded` 随之翻转。
- 按钮独占一行。反馈是文字级的：变色 + 下划线，无底色框。markdown 根节点的 `font: inherit` 重置选择器按后代匹配（`.messageBody .messageMarkdown > div:first-child`）。夹具容器不得隔断这个选择器，否则预览字号会大于展开态。夹具容器对可折叠正文**常驻**、展开/收起只切换类名。不能出现/消失式包裹。那会重挂载 Markdown 子树，丢掉渲染后注入的 ref 链接与 mention chip。是否折叠只由正文本身决定。这是确定性默认，无需持久化，也不构成 Host 事实。夹具只包正文分支。run 分组、附件条、兜底 chip 行与 children 都在夹具外照常渲染，预览内 ref/mention 照常可点。

  **折叠阈值同时是节奏开关**。夹具容器带 `data-document`。超过 600 字符的 markdown 按文档节奏渲染，短消息保持聊天刻度。节奏的具体刻度是：块间距 16px、列表项 6px、行高 24px、标题边距 24px 0 8px 且 h2 18px、h3 17px，pre/blockquote 外边距 16px。限高也按字号轴 `calc(176px + 8 × delta)` 维持 8 行。

## 消息块（messageRun）
- 一个 run = 一次发言。同一 sender 连续的消息与其 Thread 入口行包进一个 `.messageRun` 块。活动行与未读边界打断 run。
- 日界同样打断 run。跨天的相邻消息之间插入居中的日期锚：`.daySeparator`，`MM-DD` 格式，跨年用完整 `YYYY-MM-DD`。锚的数字风格与消息时间一致。活动没有自己的时钟 instant。活动继承前一条消息的日界，不触发锚。时间线的第一条消息不带头部锚。分块逻辑统一在 `team-separators.ts` 的 `chunkRunsWithDays`（单一权威实现）。
- 块内分界看折叠行是否自带 Thread 入口行。自带时上方画一条 border-l2 发丝线并稍增间距。自带的判定是 `.messageRow[data-grouped]` 且 `:has([data-thread-entry])`。普通文字接续不加线，避免整块被切碎。锚点是入口行自己的 `data-thread-entry`，不是「正文里的某个 button」。长文折叠的展开/收起钮与正文里渲染出的 Task ref 链接都是 button，按 button 认边界会误判。
- 回合边界线是 `TeamRunDivider`。同一 sender 的相邻消息间隔 ≥5 分钟，即视为两次独立发言；agent 长发布常间隔小时级，纯折叠会抹掉层次。**只有 Project feed 画这条线**——feed 陈述的是「块」，Thread 读的是一条连续流，所以 Thread 侧不画。形态是全宽 border-l2 发丝线，`role="separator"`，缩进对齐正文列（座位 + 间距 10，从座位派生，改头像尺寸自动跟随），**线上不写任何时刻**。这条线替代其后折叠行自带的入口行发丝线，相邻选择器覆盖，不叠双线。
- run 是纯分组块：无 hover 边框/底色/阴影，无常驻边框。run 自身只保留块间 2px 垂直空隙（`margin: 2px` + `padding: 3px`），不给内容"加笼子"。Thread 侧不再有任何 run 级分隔线，边界感只剩日界锚与未读线。
- **时刻由行自己说，从不由线说**：有身份行的在名字旁常驻；续行（没有身份行）在头像座（`[data-gutter-time]`）hover 或键盘焦点时出现，同一行永远只说一次。时间线里没有常驻的时刻标签。
- **座位只写时刻**：它 34px 且不裁剪，而带日期的形态同年 57px、跨年 87px。日期留给开这一 run 的身份行与其上的日分隔条，精确瞬间挂在标签的 `title` 上。

## Mention 与 Task ref 强调
- mention chip 挂三处。Human 字面正文在字面分段时挂 chip。Agent plain-prose 正文复用同一条 `splitMentionNames` 分段。Agent 富 Markdown 正文在公共 `MarkdownText` 渲染完成后，于普通文字节点原位替换出 chip。三种路径都只挂 Message 已解析 mention 列表内的 handle。大小写不敏感，书写必须带 `@`。裸名是正文，永不挂 chip。代码段落保持原文。effect 重跑不会对已生成的 chip 再包层。正文未出现的名字才落到尾部兜底 chip 行，不与内联 chip 重复。**chip 按「今天怎么称呼这个人」显示**。Human 改名前的 `human` 是 Host 仍会送达的别名。所以正文写着 `@human` 的旧消息在原位挂 chip，显示当前名。正文从没写过的名字不会掉进尾部兜底行。这与 member ref 一律按当前 handle 命名是同一条规则。
- 读者自己的 handle 是唯一离开 business 族的 chip。`[data-mention-human]` 用 success 档着色（error 与 warn 两族分别意味着失败与警示，其它 chip 一律保持 business）。尾部兜底行永不重复读者自己的名字 —— 那会在一个已经把名字 chip 在正文里的消息下面再印一个光秃秃的 `@me`。它也不重复上方引用行已经点名的作者，因为那一行本身就说明了这次投递。引用不再可解析时不点名任何人，那里的 chip 就是这次投递唯一还看得见的地方。
- 已知的 branded Task ref（`task:*`）通过 Host 的 `resolveTaskRefs` 批量解析。Task ref 在 Human 字面文本、Agent plain-prose 和 Agent 富 Markdown 的原出现位置渲染为可点击的 `Task #N`。富 Markdown 正文下方不再重复补入口。富 Markdown 在公共 `MarkdownText` 完成渲染后替换普通文字节点和"整段恰好是一个 ref"的行内代码。模型把 ref 当标识符加反引号样式是常态。代码围栏、缩进代码、混合内容的行内代码和已有链接保留原文。模型输出的双冒号/大写拼写（如 `task::…`）在 `splitBrandedRefs` 解析口统一归一化为 ledger 铸造的单冒号小写 ref 后再解析与导航。
- 点击当前视图未加载的 Task ref，Client 解析 Task ref 所属 Workspace、Project 和 Thread，再跨 Project 跳转。解析失败的 ref 保留为非导航原文。已解析链接用原始 ref 作为 tooltip。Task number（如 `Task #12`）是 Task 在其 home Project 内的创建序号。Host 侧单一派生（`taskNumbers`）。Project 任务卡、Thread 标题、跨 Project ref 解析与 Agent inbox 标注共用同一口径。序号跨 Project 不唯一，稳定导航身份始终是 branded Task ref。
- 已知的 branded Thread ref（`thread:*`）走同一条路，经 Host 的 `resolveThreadRefs` 批量解析。解析结果在原出现位置渲染为可点击 Thread chip：带所指 Thread 首行摘要，中文为`讨论 · …`。taskless Thread 之间不再长得一模一样。只有 Host 确认过的 ref（缩写拼写同样要过解析）才会成链。点击按解析出的完整 ref 导航。解析失败的保留为非导航原文，永远不会静默无响应。
- 已知的 branded Project ref（`project:*`）在原出现位置渲染为带项目名的可点击 Project chip，中文为`项目 · …`。点击跳到这个 Project。已知的 branded Member ref（`member:*`）渲染为带 handle 的 Member chip（中文为`成员 · @…`）。它与会发通知的 `@mention` chip 刻意区分。引用永不发通知。点击活跃 Member 的 chip，按 agent card 同款行为打开这个 Member 的 session。被暂停的 Member 与 Human 只渲染为带名但不可点的文本。两者都直接复用已加载的 Project/Member roster 解析，不新增 Host 接口。落在已加载窗口之外的 ref 按解析失败同规则保留原文。

## 计数胶囊（count capsule）
- `TeamCountBadge.tsx` 配上 `countBadge.module.css .badge` 是**唯一**一枚计数胶囊，读者能看到的每一处计数都穿它。三处是：Project feed 的 Thread 入口、Inbox 队列行，以及 Project 看板上的 Task 卡。同一套声明每面各写一份，共享之前就是如此。正是 feed 那一份落到与队列行不同的行盒、数字彼此差出一个像素的原因。侧栏「收件箱」入口有意不用胶囊。入口把未读说成一个点，而不是一个数字（见「Inbox（收件箱）」）。读者扫侧栏问的是「有没有东西在等」。数量随每一条 fact 变动，是专门去问才要的答案。数字留在控件自己的可访问名里。
- 这份规则是：高 18px、`min-width: 18px` 配 `box-sizing: border-box`（平台没有全局 border-box reset，否则内边距会把一位数字撑成椭圆）、`border-radius: 999px` 配 `corner-shape: round`、`display: inline-flex` 双向居中、11px/600 配 `font-variant-numeric: tabular-nums`（两位计数不会推动墨迹）、`line-height: 18px`。行盒就取胶囊自己的高度，而不是各面碰巧继承到的值。一面的入口行继承 `normal`，另一面自己设了高度。再加 `flex: none`：座位被挤时 Inbox 行不会把圆圈压小。定位仍留在挂胶囊的那个面上。窄轨要把胶囊钉在 36px 图标盒内，挂载点是 `className`。
- 计数为 0 不渲染任何东西：计数的缺失不是「一枚写着 0 的胶囊」。超过 99 显示 `99+`。`tone` 只换墨色。Thread 点名了这位读者时是实心底色。只是有新动静时，用完全相同的几何画成 `--dsw-alias-border-l2` 发丝线。发丝线那 1px 边框从发丝线自己的内边距里出。4px + 1px 就是实心那份的 5px。于是两种墨色在任何计数下都是同一个边框盒、同一个内容盒，同一 Thread 再次被点名时行不会跳动。`label` 决定计数如何抵达读屏。有 label 时胶囊是 `role="img"`，由胶囊的可访问名与 `title` 承载数字。没有 label 时是 `aria-hidden`，因为外层控件已经说了这个数。
- 数字墨迹落在盒中心偏右约半个像素处。十个数字皆然。这是字形在自身 advance 里的落点，不是布局问题，任何声明都改不了。规则真正负责的是「一个字符保持 18px 的盒子」与「两处共用同一条规则」。`scripts/audit-ui-parity.mjs` 直接审计这条规则。重新引入第二份拷贝会让审计报错。

## 成员花名册（member rosters）
- `TeamMemberRow.tsx` 是「画一个人」的唯一实现。实现由 `TeamMemberIdentity`（带 presence 角标的 `TeamMemberAvatar` + handle 与 description）加一个可选动作构成。跨 Workspace 的引入花名册渲染这一行，侧栏 Agents 则把同一个 `TeamMemberIdentity` 放进自己的选择按钮里。同一批 Member 因此在不同面之间不会出现身份、字号或截断口径的漂移。
- 行是网格：34px 头像、`minmax(0, 1fr)` 文案、`auto` 动作轨。圆角取 shipped 圆角刻度的 md 档（12px）、8px/10px 内边距、最小高度 50px，hover 用 `--dsw-alias-interactive-bg-hover`。handle 为 12px/18px、weight 500、主色。description 为 11px/16px、tertiary，且在文案轨内省略号截断，不去顶宽网格。动作轨只在真有动作时声明，没有动作的行把那份宽度还给 description，不留空洞。
- membership 动作是整行唯一的控件。一个 `Button size="sm" variant="outline"`，至少 64×28。标签在添加/移除/更新中…之间变化，外形不变。行自身的失败信息作为 `role="alert"` 渲染在行内文案轨下方。窄于 600px 时动作落到身份下方并与文案左对齐。被压窄的弹层放不下第三列。
- membership 语义跟随 Host。加入要求 `availability === 'active'`。Host 会拒绝其他 availability。退出只要求 membership 事实本身。所以已经加入但暂时不可用的 Member 仍然保留可用的 移除。
- 只有侧栏 Agents 在写法上不同。它像目录那样直呼 `builder`，其余花名册按 composer 的称呼写 `@builder`。

## 团队设置页（团队）
- 设置面板里 Team 只有这一面：`settings.section` 的 `team-settings` 条目（「团队」），只在普通模式提供。Team 模式接管侧栏后，设置面板不可达。导航轨与内容列由 shell 画，所以本段自己画 18px/600 标题。其余行沿用 shipped 设置语言：16px/0 内边距配 border-l2 发丝线、14px/22px 标题叠 12px/18px tertiary 说明、控件间距 12px。按钮与输入框直接用 shipped `Button` 与 `Input`，不另起一份声明。因为导航轨把这个条目与 Harness 自己的页面排在一起，标题下方加一行 13px tertiary 引言，写明这一页属于谁、改动作用在哪里。这行页头在**每个状态**都渲染。读取失败时也在。页面不会把「这是谁的 Team」晾着不答。脚注写出版本号并链接仓库。升级提示行只在 Host 报告有时才出现。
- 这一页写两样东西。身份——显示名与头像——走 Team Remote，由它拥有 Client 本来叫不出名字的 profile 条目。压缩阈值则是 Team Host 行自己的配置组，经共享的配置表单（`configForms.get(<行 id>)`）读写，所以这一页只点名 `memberCompaction.tokens` 这一条子路径，而不是整组重述一遍。
- 这一组落在身份行与环境检查之间，自带 13px/600 分组标题（shipped 设置卡片的分组标签），以页面的发丝线开场。它的字段与保存都是 shipped 的 `SettingsForm` 与 `SettingsValueField`。阈值按容量书写（`256K`、`1M` 或纯数字）。字段读不懂的草稿（`2GB`）保留原文并阻塞保存。留空则暂存一次 `unset`，让这一组回落到组合层与其 256000 默认值。只写这一条子路径，所以页面从不显示的兄弟 `enabled` 开关在每次保存后都还在。
- `human-identity.ts` 是这份资料的唯一读取方。`TeamHumanIdentity` 在多个订阅者之间共用一次在途读取。引用未变时复用已经解码好的头像。后续读取失败时保留上一次已接受的值。只有从未加载成功才是 unavailable。这时整面 `role="alert"` 并自带重试。它还在每次写入被接受后刷新。写入走 Team Remote 自己的 `setHumanProfile` 与头像调用，由它们拥有 profile 条目：Client 从不替身份字段写 settings 文档，所以也不必给那些字段起名。
- `team-config.ts` 是阈值的唯一读写方。共享设置表单只寻址命名空间的顶层字段，而阈值住在这一行的 `memberCompaction` 组里，所以一层小小的 `SettingsFormScope` 适配器把该组摊平给表单，再把表单的编辑映射回子路径。`TeamConfigController` 把这层适配器包进 `SettingsFormModel`，对外发布页面渲染的那一份快照。Client 注入 `configForms`——每个设置消费方都在用的 shipped 服务——并在每个 Client 上构造一次控制器；服务缺席时整组不渲染，控制器随其余 navigation 服务一起销毁。
- 写入被拒绝时绝不把「正在保存…」晾着。身份行在原位置显示 Host 的 message；配置组就是 shipped 表单，部署拒绝的保存会保留草稿，并在保存按钮旁给出共享的「本部署没有接受这些值」一行。
- 名字行是一个 form：36×200px 输入框，主色「保存」按钮持有 submit。脏字段里按 Enter 即保存，Tab 的下一站就是「保存」按钮。头像行画 40px 身份圆（`border-radius: 50%` 配 `corner-shape: round`）呈现图片或首字母。一个「更换头像」按钮驱动视觉隐藏的 `input[type="file"] accept="image/*"`，上限 10MB。只有在存有 `avatarRef` 时才多出「移除头像」。两处头像座位只在**这些字节真的能解码**时才画图。Host 按声明的 media type 收头像，不解码内容。手机拍的 HEIC 或传入途中损坏的字节会被存下来，再以画不出任何东西的 data URL 交回。`useAvatarImage` 按 URL 记住字节能否解码。画不出就与「已移除」一样显示首字母；而新上传的字节是另一个 URL，会自动重试。
- 390×844 下 shipped 面板保留 188px 的导航轨，没有 media query。内容列只剩约 106px。所以本段自带 `@container (max-width: 420px)`。每行文案叠在控件上方，去掉宽版为控件预留的 48px 右内边距，输入框与按钮占满整列。浏览器验收在窄宽度断言无横向溢出。

## 环境检查（environment check）
版本脚注之上，页面陈述这次安装的事实，不是 Human 的事实：这个 bundle 正跑在哪条 DSH 线上，以及那条线是否落在 bundle 自己声明的支持范围内。它是第二个投影：`environment-check.ts`、`TeamEnvironmentCheck`。第二个投影刻意不放进身份 store。投影只读一次，从不写回。唯一的渲染方就是设置页。

它以页面其余行同一条发丝线开场。这条判定答的是这次安装，而不是 Human 本人的事实。没有这条线，本块会被读成身份行自己的一部分。

判定只有三档，不新增第四档，也从不猜测。Host 建立不起来的事实就是 `undetermined`，这是一个落定的回答、而不是一次失败的请求。本块没有重试。Host 联系不上时整块什么都不渲染，而不是借用这个词。

**判定的先后顺序就是契约**。运行版本读不到，给 `undetermined`。运行版本违反任何一条已声明的 `@deepseek-ai/dsh-*` peer，给 `out-of-range`。真实的违反不会因为此刻已没有一条能对外陈述的区间，就被降级成 `undetermined`。只有在什么都没违反之后，问题才变成「已声明的区间是否收下这个版本」。

对外只陈述一条区间，因此要求每个 DSH peer 声明同一条。前缀是 `@deepseek-ai/dsh-`。`@deepseek-ai/cordis` 同 scope，但不在 DSH 版本线上。声明漂移或集合为空时整行不显示，而不是挑一个 peer 代表其余。

只有 `out-of-range` 这一档取面：`--dsw-alias-state-warn-tertiary` 底配 `--dsw-alias-state-warn-label`，半径取行级表面的 12px。因为这一档是读者可能需要据以行动的，另外两档保持为行。每一档都用「文本 + 图标」表态，因此读者分不清颜色时状态依然成立。

区间用人话写，不打裸 semver range。range 字符串读者无法核对，要的是一句话。实测认证组合（`Agent Team <bundle> × DSH <certified>`）只在两个版本都**推导得出**时才打印。一个是已装 manifest 自己的版本，一个是区间下界。后者就是本仓门禁钉住的认证基线。读不到的版本会让整行不显示，而不是请一个手写版本上页面。

因此，读者容易混淆的两个版本被分开放置。运行中的 DSH 版本是环境，认证版本是声明的那条线。只有安装正好落在基线上时，两者才是同一个字符串。

本块用 `data-environment` 携带自己的判定。验收 journey 因此等待一个状态，而不是一段文案。

## Project 页与讨论面板（project page / discussion panel）
- Project 页把同一条时间线读成两种视图。头部下方一条页签行在两者之间切换：`项目` 是 feed，`看板` 是按 Task 状态投影的四列看板。看板是第二种**读法**，不是第二个表面。它重排同一份投影，所以一个 Task 的状态、所有者、标题不会在两个视图之间出现分歧，也不会有哪个视图去拉另一个没拉过的东西。
- 看板只读 feed 已经加载的那一段窗口，不读 Project 的全部历史。为了填满四列而一直翻到 `hasMore` 为假，等于把每一条 top-level Message 都并进时间线，为了四列而废掉 feed 自己的分页；同时会把「打开一个页签」变成一次无界读取。看板拿更早工作的方式就是 feed 的 `加载更早消息`：一个入口、一个页大小，两个视图永远描述同一批事实。
- 四列是 `待处理` / `进行中` / `待验收` / `已完成`。五个 Task 状态里 `done` 与 `closed` 合进「已完成」一列。已了结的卡片降透明度而不是隐藏。看板的职责是让在动的工作最响，同时让已完的仍可找到。空列只在列头写自己的 `0`，不画占位行：在计数已经说清的列里再放一行占位，是把同一件事说两遍。
- 看板是唯一被允许超出 880px 阅读列的 Client 表面，上限 1240px。四个状态列是扫描型表面，压到阅读列宽度会让每一列都失去卡片宽度。四列等宽（`flex: 1` 配 `min-width: 0`），所以某一列标题更长也换不来更多宽度；底色用 `--dsw-alias-bg-module-platform`（shipped 给分组模块的凹陷底色），卡片自身的底层色因此读起来是浮起的。
- 页签行是复合控件：`role="tablist"` 加两个 `role="tab"` 按钮，整组只有一个 tab stop（未选中那个 `tabIndex` 为 -1），每个页签通过 `aria-controls`/`aria-labelledby` 指明自己控制的 panel，Left/Right/Home/End 同时移动选中与焦点。它取 shipped 会话页自己那套页签语言：13px/16px、weight 500、36px 间距、`--dsw-alias-state-business-primary` 的 2px 下划线。下划线走伪元素并伸出盒底 1px，正好压在页头收口线上，两者读成同一条边（shipped 同款做法）。未选中页签取 tertiary，选中页取 business blue 而非墨色，因为 `--dsw-alias-brand-primary` 在这张 token 表里解析成中性黑；shipped 在自己那条页签上也陈述了同样的理由。
- taskless Thread 在 feed 右侧的面板里打开，而不是替掉整页。面板就是讨论的全部：头部点名并给出「转为 Task」与关闭，正文用与任何时间线相同的日分隔与消息块读事实，脚部是普通 composer 且共用同一个 `thread:<threadRef>` 草稿键，所以写到一半的回复在面板与 Thread 页之间往返不会丢。Task 的入口照旧走 Thread 页，验收在那里。
- 面板是 surface 自己的子元素，不是 feed 的：它与上方的页头带、下方的 feed 同处一列，从页顶贯到页底。正因如此，它的头部才能与身份行同带——与 `# name` 及描述共享同一个 10px 上内边与 30px 行高——而不是从页签行下方才开始；也正因如此，头部自己没有收口线：带自己的那条线已经结束了这一行，再并排画一条，等于在什么都没围住的地方声明边界。同一个理由，面板的 composer 与 feed 的 composer 站在同一条线上，上方不画线。
- 面板的座位只在它打开时预留，且只预留在 feed 旁边。常驻的预留会长期把一条空带花在阅读面上，并让 feed 的每一行都为它付费；释放它的代价是读者开/关面板那一刻的一次重排，而那时读者的注意力已经移到面板上。
- 打开面板是「决定在哪里读」，所以宽度归读者：打开时面板取 stage 的较大部分（52%，钳在 420–960px 之间），两道面之间的接缝可以把这份份额拖向任一侧。两侧读同一个变量，所以 feed 让出的正好是面板拿走的，面板也永远画不到 feed 上；一次拖拽只重绘，不重渲染任何一侧。座位按浏览器记住，重新打开时再按当时的 surface 钳一次，所以在宽窗口选定的宽度不会在窄窗口溢出。面板打开时页头带也让出同一份宽度，所以长描述会在接缝旁省略，而不是钻到接缝下面。接缝是真正的 separator 控件并带键盘路径——方向键微调、Shift 加大步长——否则纯指针的交互会把那些读者留在他们改不动的座位上。面板与 feed 共用 surface 的整个高度：头部坐在页头带的身份行里，两条 composer 站在同一条脚线上。
- 窄于 600px 的共享断点下，面板整块盖住 feed，而不是并排站在一个窄到读不了的 feed 旁边：两者占 surface 的同一条列与 feed 自己的行区，于是面板画在 feed 之上，上方的带仍然可见且保持自己的宽度。把任一方放到这条列之外，会多开出一条隐式列，结果是把 feed 挤成一条窄缝，而不是盖住它。
- 面板里的「转为 Task」与 Thread 页跑同一套 Human-only durable mutation，成功即结束面板的任务：面板关闭，读者直接进入新 Task 的 Thread 页。在面板里完成的读取立即清掉它在 feed 行上的未读胶囊，不必等下一次 Inbox 读取落地。

## 失败态呈现（failure surfaces）
- 投影失败的呈现只有两种，选哪一种等于声明「屏幕上还剩什么」。**整面失败**（从未加载出投影）用 `errorState`。`errorState` 与所替代的 loading / empty 面共用同一份空白区居中（`margin: auto`、`padding: 32px 0`）。整面失败保持在 880px 阅读列内，取 12px/18px 的 error 字号与 `--dsw-alias-state-error-primary`。内容是 Host message 加一个重新发起读取的 `重试`，message 与按钮同在一个 `role="alert"` 里。**行旁失败**（行还在）用内联 `error`。在内容列内 `margin: 0`，读作所属列表的最后一行，而不是让已有内容的面重新居中。
- 两种失败都不充当空态。空的判定要求「投影成功返回且确实为空」：`view !== undefined`、无 error、里面没有东西。所以断连永远不会被读成「这个工作区是空的」。
- 侧栏用同一套形状的 rail 尺度。Panel 自身的失败行是 11px/16px 的 `--dsw-alias-state-error-primary`，左侧缩进 12px。文字落在失败行所替代的行标签上：列表缩进 4px + 行缩进 8px。文字不落在 Panel 边缘。行自身的失败（`rowAlert`）在行内保持同一尺度。
- Panel 失败按 Panel 记：每个挂载中的 Panel 各自报告自己看到的那次断连。所以一次断连会在侧栏出现同一条消息，正文自身读取也失败时再在页面上出现一次。
- Panel 失败行不带重试按钮：侧栏靠 change stream 自愈。断连只上报一次，传输恢复后唤醒全部 listener（见 [`host-authority.md`](../architecture/host-authority.md)）。

## Thread 顶层栏（header band）
- Thread 顶层栏装的是返回行、Task 身份与运行风险区，整条带由 `.surfaceHeader` 自己那一条底边收口。因此带内分区**只靠间距分层**。分区级 `border-top` 会在什么都没围住的地方再画一条线，带上方的组已经由带自己的边线结束。这里「分隔线条数」是可量测的设计属性而非口味问题。shipped DSH 的分隔线只画在组与组之间，见 `PluginInventorySettingsTab.module.css` 的 `.group + .group { border-top: 0.5px solid … }`。所以原先每个分区各带一条 `1px solid var(--dsw-alias-border-l2)` 既不合房规也是多余的。保留的是：页头带自己的 `border-bottom`（真实结构边界）与时间线里的未读边界线（语义边界）。
- 顶层栏是**有高度预算**的，不只是「整齐」问题。两个 Member 处于错误态时，顶层栏占到 960px 视口里的 426px，把对话内容整个推到首屏以下。改成分区间距分层后同样内容只占 360px。
- 顶层栏只点名 Task 并说明它出了什么问题，**不装这个 Task 的工作队列**。Claim 以「记录它的那条事实」抵达读者：时间线里的活动行，以及 feed 入口行上画出的所有者。提前验收的确认弹窗仍会列出将一并完成的 Claim，因为那份清单就是验收据以判断的东西。没有哪个面按需列出 Claim，顶层栏因此只剩身份与真问题。
- 运行风险行每个出错 Member 一行。行首是诊断结构化 class 的本地化名称：`session-refused`、`session-unreadable`、`preset-composition`、`rollover`、`runtime`、`activation`。这就是 `AgentTeamMemberDiagnostic.class` 这条策略轴。`restartOffered` 早已按这条轴分支。这条轴回答可本地化的「这是哪一类问题」。Host 的 `detail` 天生是英文，行内只截取 `detail` 首句。完整原文留在风险行 `title` 上。`AgentTeamClientMemberStatus` 本来就把整份 diagnostic 带到浏览器，因此这条轴不需要改 Host 协议。
- 每个 class 一个句子 key，让可见行留在界面语言里，而不是把 Host 字符串直接贴进本地化界面。完全没有 diagnostic 的 Member 回落到 `runtime` 文案，而不是留空。
- Task / Thread 身份下方那句开篇文字**在任意宽度、任意 Thread 类型下都只占一行**。实现是 `-webkit-line-clamp: 1`，同时写标准属性 `line-clamp`。完整原文留在 `title`。Task 标题本来就长且夹着不可断的 ref。讨论的开篇就是自己的锚消息，正文时间线里紧接着完整重复了一遍。所以别给开篇在页头带里留第二行。那等于把页头高度花在读者已经能看到的文字上，还让页头高度取决于别人当初打了多少字。压成一行后，很长的开篇与两个字的开篇页头同高（实测 taskless Thread 两种都是 114px）。
