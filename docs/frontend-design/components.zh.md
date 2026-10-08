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

每条消息的正文都渲染在一个气泡里，**每一条都有**：「有人@我」是加在气泡之上的标记，而不是画出气泡的前提。气泡按自身内容收缩、最多长到整个阅读列：短回复就是一个小气泡，不会铺成一条整行色带；而一段很长的 Agent 回答保留全部宽度，不会被挤进半列。

`data-side` 决定列序：读者自己的发言与其他人分列两侧。所有气泡共用同一种填充与同一种圆角（直接复用 shipped 聊天气泡的那套配方，明暗主题都成立），发送者归属只由列序与昵称行承载 —— 按作者区分底色会让某个人的话看起来是另一种材质，带尖角的「尾巴」在气泡被折叠或展开后会读成渲染故障；同人 run 改由被省略的昵称装饰来体现。
- 超长正文折叠看 display 字符数。超过 `MESSAGE_COLLAPSE_CHARS`（`team-formatters.ts` 单一权威，600）的正文默认收进限高预览。预览约 8 行 / 176px，底部 alpha 渐隐遮罩，不涂主题底色。预览下方「展开全文」安静文本钮负责展开，展开后同位置「收起」收回。`aria-expanded` 随之翻转。
- 按钮独占一行。反馈是文字级的：变色 + 下划线，无底色框。markdown 根节点的 `font: inherit` 重置选择器按后代匹配（`.messageBody .messageMarkdown > div:first-child`）。夹具容器不得隔断这个选择器，否则预览字号会大于展开态。夹具容器对可折叠正文**常驻**、展开/收起只切换类名。不能出现/消失式包裹。那会重挂载 Markdown 子树，丢掉渲染后注入的 ref 链接与 mention chip。是否折叠只由正文本身决定。这是确定性默认，无需持久化，也不构成 Host 事实。夹具只包正文分支。run 分组、附件条、兜底 chip 行与 children 都在气泡内照常渲染；只有夹具与它的展开钮会折叠。

  **折叠阈值同时是节奏开关**。夹具容器带 `data-document`。超过 600 字符的 markdown 按文档节奏渲染，短消息保持聊天刻度。节奏的具体刻度是：块间距 16px、列表项 6px、行高 24px、标题边距 24px 0 8px 且 h2 18px、h3 17px，pre/blockquote 外边距 16px。限高也按字号轴 `calc(176px + 8 × delta)` 维持 8 行。

## 消息块（messageRun）
- 一个 run = 一次发言。同一 sender 连续的消息与其 Thread 入口行包进一个 `.messageRun` 块。活动行与未读边界打断 run。
- 日界同样打断 run。跨天的相邻消息之间插入居中的日期锚：`.daySeparator`，`MM-DD` 格式，跨年用完整 `YYYY-MM-DD`。锚的数字风格与消息时间一致。活动没有自己的时钟 instant。活动继承前一条消息的日界，不触发锚。时间线的第一条消息不带头部锚。分块逻辑统一在 `team-separators.ts` 的 `chunkRunsWithDays`（单一权威实现）。
- 块内分界看折叠行是否自带 Thread 入口行。自带时上方画一条 border-l2 发丝线并稍增间距。自带的判定是 `.messageRow[data-grouped]` 且 `:has([data-thread-entry])`。普通文字接续不加线，避免整块被切碎。锚点是入口行自己的 `data-thread-entry`，不是「正文里的某个 button」。长文折叠的展开/收起钮与正文里渲染出的 Task ref 链接都是 button，按 button 认边界会误判。
- 回合分隔线是 `TeamRunDivider`。同一 sender 的相邻消息间隔 ≥5 分钟，即视为两次独立发言。agent 长发布常间隔小时级，纯折叠会抹掉层次与时刻。run 本身保持一块。两者之间渲染全宽 border-l2 发丝线，线下首行标注后一条消息的时间：`formatMessageTime` 同款格式，`role="separator"`，缩进对齐正文列（38px = 头像 28 + 间距 10）。这条线替代其后折叠行自带的入口行发丝线，相邻选择器覆盖，不叠双线。Channel 页与 Thread 页共用同一判断与组件。
- run 是纯分组块：无 hover 边框/底色/阴影，无常驻边框。回合分隔线、日界锚与未读线承担全部消息边界感。run 自身只保留块间 2px 垂直空隙（`margin: 2px` + `padding: 3px`），不给内容"加笼子"。

## Mention 与 Task ref 强调
- 结构化 mention 列表里点名了 Human 读者的**未读**消息，会在自己气泡的顶部先亮出「有人@我」标记：气泡加一道 warn 层级描边，徽标作为气泡的第一行右对齐落在正文上方，读者在读到正文之前就知道这条消息在叫自己。徽标本身就是完整标签，旁边不再画 `@` 图标 —— 标签已经含 `@`，再加图标会读成双重标记。标记是**作者自己气泡**上的装饰，绝不让气泡换列——Agent 提到读者，这条消息仍然是 Agent 的；读者若在自己那一列看到它，会以为是自己写的。它也不会出现在昵称行上，那一行承载作者而不是收件人。标记回答的是「这条现在需要我吗」，所以它跟随未读批次、读过即退场：已被确认的提及在正文里保留内联 chip，但不再索取注意力。两半都是 Host 事实 —— `mentions` 是送达事实、`unread` 是已读事实 —— 所以带标记的气泡恰好就是提及已送达且尚未确认的那条。消息永不提及自己的作者，因此读者自己那一行永远不会带这个标记。Channel feed 只知道 Thread 级未读、不知道单条消息的未读，所以在那里标记跟随该 Thread 最新的顶层消息，直到该 Thread 被读完。
- 尾部兜底行列出正文没有携带的提及，但它永不重复读者自己的名字 —— 那会在一个已经把名字 chip 在正文里、或已经用徽标明说「有人@我」的气泡下面再印一个光秃秃的 `@me`。
- 回答另一条消息的 Message 会在气泡顶部先给出**已解析的引用**：父消息作者 + 一行开头文字。两者都由 Host 从 ledger 解析，而不是从正文里读出来，因此引用永不与它所指向的内容不一致，父消息落在已加载历史窗口之外时也照样填得上。整块引用就是跳转目标；摘要永远只有一行并带省略号，因为引用是原文的把手，不是它的第二份拷贝。不是回复的 Message 不渲染引用块。
- 每条 Message 尾部还带一个回复操作，它**照字面**沿用 shipped 的显隐约定：只在 `@media (hover: hover)` 内隐藏，因此没有 hover 的触屏设备上它常显，键盘则由 `:focus-within` 唤起。它是**浮在**行之上而不是排在行里，因此永不占用时间线高度；凡是上层没有传处理函数的地方它就不存在 —— Channel feed 不提供回复。
- mention chip 挂三处。Human 字面正文在字面分段时挂 chip。Agent plain-prose 正文复用同一条 `splitMentionNames` 分段。Agent 富 Markdown 正文在公共 `MarkdownText` 渲染完成后，于普通文字节点原位替换出 chip。三种路径都只挂 Message 已解析 mention 列表内的 handle。大小写不敏感，书写必须带 `@`。裸名是正文，永不挂 chip。代码段落保持原文。effect 重跑不会对已生成的 chip 再包层。正文未出现的名字才落到尾部兜底 chip 行，不与内联 chip 重复。**chip 按「今天怎么称呼这个人」显示**。Human 改名前的 `human` 是 Host 仍会送达的别名。所以正文写着 `@human` 的旧消息在原位挂 chip，显示当前名。正文从没写过的名字不会掉进尾部兜底行。这与 member ref 一律按当前 handle 命名是同一条规则。
- 已知的 branded Task ref（`task:*`）通过 Host 的 `resolveTaskRefs` 批量解析。Task ref 在 Human 字面文本、Agent plain-prose 和 Agent 富 Markdown 的原出现位置渲染为可点击的 `Task #N`。富 Markdown 正文下方不再重复补入口。富 Markdown 在公共 `MarkdownText` 完成渲染后替换普通文字节点和"整段恰好是一个 ref"的行内代码。模型把 ref 当标识符加反引号样式是常态。代码围栏、缩进代码、混合内容的行内代码和已有链接保留原文。模型输出的双冒号/大写拼写（如 `task::…`）在 `splitBrandedRefs` 解析口统一归一化为 ledger 铸造的单冒号小写 ref 后再解析与导航。
- 点击当前视图未加载的 Task ref，Client 解析 Task ref 所属 Workspace、Channel 和 Thread，再跨 Channel 跳转。解析失败的 ref 保留为非导航原文。已解析链接用原始 ref 作为 tooltip。Task number（如 `Task #12`）是 Task 在其 home Channel 内的创建序号。Host 侧单一派生（`taskNumbers`）。Channel 任务卡、Thread 标题、跨 Channel ref 解析与 Agent inbox 标注共用同一口径。序号跨 Channel 不唯一，稳定导航身份始终是 branded Task ref。
- 已知的 branded Thread ref（`thread:*`）走同一条路，经 Host 的 `resolveThreadRefs` 批量解析。解析结果在原出现位置渲染为可点击 Thread chip：带所指 Thread 首行摘要，中文为`讨论 · …`。taskless Thread 之间不再长得一模一样。只有 Host 确认过的 ref（缩写拼写同样要过解析）才会成链。点击按解析出的完整 ref 导航。解析失败的保留为非导航原文，永远不会静默无响应。
- 已知的 branded Channel ref（`channel:*`）在原出现位置渲染为带频道名的可点击 Channel chip，中文为`频道 · …`。点击跳到这个 Channel。已知的 branded Member ref（`member:*`）渲染为带 handle 的 Member chip（中文为`成员 · @…`）。它与会发通知的 `@mention` chip 刻意区分。引用永不发通知。点击活跃 Member 的 chip，按 agent card 同款行为打开这个 Member 的 session。被暂停的 Member 与 Human 只渲染为带名但不可点的文本。两者都直接复用已加载的 Channel/Member roster 解析，不新增 Host 接口。落在已加载窗口之外的 ref 按解析失败同规则保留原文。

## 计数胶囊（count capsule）
- `TeamCountBadge.tsx` 配上 `countBadge.module.css .badge` 是**唯一**一枚计数胶囊，读者能看到的每一处计数都穿它。两处是：Channel feed 的 Thread 入口，以及 Inbox 队列行。同一套声明每面各写一份，共享之前就是如此。正是 feed 那一份落到与队列行不同的行盒、数字彼此差出一个像素的原因。侧栏「收件箱」入口有意不用胶囊。入口把未读说成一个点，而不是一个数字（见「Inbox（收件箱）」）。读者扫侧栏问的是「有没有东西在等」。数量随每一条 fact 变动，是专门去问才要的答案。数字留在控件自己的可访问名里。
- 这份规则是：高 18px、`min-width: 18px` 配 `box-sizing: border-box`（平台没有全局 border-box reset，否则内边距会把一位数字撑成椭圆）、`border-radius: 999px` 配 `corner-shape: round`、`display: inline-flex` 双向居中、11px/600 配 `font-variant-numeric: tabular-nums`（两位计数不会推动墨迹）、`line-height: 18px`。行盒就取胶囊自己的高度，而不是各面碰巧继承到的值。一面的入口行继承 `normal`，另一面自己设了高度。再加 `flex: none`：座位被挤时 Inbox 行不会把圆圈压小。定位仍留在挂胶囊的那个面上。窄轨要把胶囊钉在 36px 图标盒内，挂载点是 `className`。
- 计数为 0 不渲染任何东西：计数的缺失不是「一枚写着 0 的胶囊」。超过 99 显示 `99+`。`tone` 只换墨色。Thread 点名了这位读者时是实心底色。只是有新动静时，用完全相同的几何画成 `--dsw-alias-border-l2` 发丝线。发丝线那 1px 边框从发丝线自己的内边距里出。4px + 1px 就是实心那份的 5px。于是两种墨色在任何计数下都是同一个边框盒、同一个内容盒，同一 Thread 再次被点名时行不会跳动。`label` 决定计数如何抵达读屏。有 label 时胶囊是 `role="img"`，由胶囊的可访问名与 `title` 承载数字。没有 label 时是 `aria-hidden`，因为外层控件已经说了这个数。
- 数字墨迹落在盒中心偏右约半个像素处。十个数字皆然。这是字形在自身 advance 里的落点，不是布局问题，任何声明都改不了。规则真正负责的是「一个字符保持 18px 的盒子」与「两处共用同一条规则」。`scripts/audit-ui-parity.mjs` 直接审计这条规则。重新引入第二份拷贝会让审计报错。

## 成员花名册（member rosters）
- `TeamMemberRow.tsx` 是「画一个人」的唯一实现。实现由 `TeamMemberIdentity`（带 presence 角标的 `TeamMemberAvatar` + handle 与 description）加一个可选的 membership 动作构成。Channel 的「管理成员」弹层、编辑频道里的成员区、底栏只读成员列表都渲染这一行。侧栏 Agents 则把同一个 `TeamMemberIdentity` 放进自己的选择按钮里。同一批 Member 因此在不同面之间不会出现身份、字号或截断口径的漂移。
- 行是三轨网格：24px 头像、`minmax(0, 1fr)` 文案、`auto` 动作。圆角取 shipped 圆角刻度的 md 档（12px）、8px/10px 内边距、最小高度 40px，hover 用 `--dsw-alias-interactive-bg-hover`。handle 为 12px/18px、weight 500、主色。description 为 11px/16px、tertiary，且在文案轨内省略号截断，不去顶宽网格。
- 只读花名册不渲染动作。第三轨随之塌缩，把宽度还给 description，不留空洞。membership 动作是整行唯一的控件。一个 `Button size="sm" variant="outline"`，至少 64×28。标签在添加/移除/更新中…之间变化，外形不变。行自身的失败信息作为 `role="alert"` 渲染在行内文案轨下方。窄于 600px 时动作落到身份下方并与文案左对齐。被压窄的弹层放不下第三列。
- membership 语义跟随 Host。加入要求 `availability === 'active'`。Host 会拒绝其他 availability。退出只要求 membership 事实本身。所以已经加入但暂时不可用的 Member 仍然保留可用的 移除。
- 只有侧栏 Agents 在写法上不同。它像目录那样直呼 `builder`，其余花名册按 composer 的称呼写 `@builder`。

## 团队设置页（团队）
- 设置面板里 Team 只有这一面：`settings.section` 的 `team-settings` 条目（「团队」），只在普通模式提供。Team 模式接管侧栏后，设置面板不可达。导航轨与内容列由 shell 画，所以本段自己画 18px/600 标题。其余行沿用 shipped 设置语言：16px/0 内边距配 border-l2 发丝线、14px/22px 标题叠 12px/18px tertiary 说明、控件间距 12px。按钮与输入框直接用 shipped `Button` 与 `Input`，不另起一份声明。因为导航轨把这个条目与 Harness 自己的页面排在一起，标题下方加一行 13px tertiary 引言，写明这一页属于谁、改动作用在哪里。这行页头在**每个状态**都渲染。读取失败时也在。页面不会把「这是谁的 Team」晾着不答。脚注写出版本号并链接仓库。升级提示行只在 Host 报告有时才出现。
- 这一页装着两组可写字段，各自答不同的文档，而且**从不把一组渲染成另一组**。身份走 Team Remote 读写。jev 端点是 Team Host 行 settings 节里的一组，经 settings 提供方写入。整份渲染该命名空间的表单会把身份字段塞进 jev 组，也会把扁平的 `apiBase` 寻址到错误的路径。
- 名字行是一个 form：36×200px 输入框，主色「保存」按钮持有 submit。脏字段里按 Enter 即保存，Tab 的下一站就是「保存」按钮。头像行画 40px 身份圆（`border-radius: 50%` 配 `corner-shape: round`）呈现图片或首字母。一个「更换头像」按钮驱动视觉隐藏的 `input[type="file"] accept="image/*"`，上限 10MB。只有在存有 `avatarRef` 时才多出「移除头像」。两处头像座位只在**这些字节真的能解码**时才画图。Host 按声明的 media type 收头像，不解码内容。手机拍的 HEIC 或传入途中损坏的字节会被存下来，再以画不出任何东西的 data URL 交回。`useAvatarImage` 按 URL 记住字节能否解码。画不出就与「已移除」一样显示首字母；而新上传的字节是另一个 URL，会自动重试。
- `human-identity.ts` 是这份资料的唯一读取方。`TeamHumanIdentity` 在多个订阅者之间共用一次在途读取。引用未变时复用已经解码好的头像。后续读取失败时保留上一次已接受的值。只有从未加载成功才是 unavailable。这时整面 `role="alert"` 并自带重试。它还在每次写入被接受后刷新。写入走 settings 命名空间。经由一个可选的 `ctx.inject(['remote.settings'])` 绑定取得的有两样：`remote.settings.update(namespace, patch, expectedRevision)` 与 `mutate(…, [{ op: 'unset', path: ['avatarRef'] }])`。未声明就读 `ctx.remote.settings` 会抛错。硬性激活依赖会在 settings 服务缺席时把整个 Client 拖下水，服务缺席只报不可用。写入被拒绝时在原位置显示 Host 的 message，而不是让「正在保存…」一直挂着。Client 侧的 namespace 常量由测试钉在 Host 自己的常量上，两半不会静默漂移。
- 390×844 下 shipped 面板保留 188px 的导航轨，没有 media query。内容列只剩约 106px。所以本段自带 `@container (max-width: 420px)`。每行文案叠在控件上方，去掉宽版为控件预留的 48px 右内边距，输入框与按钮占满整列。jev 的答复另起一行并与行首齐平，图标领在句首。宽版图标是行尾那一行的收束。浏览器验收在窄宽度断言无横向溢出，并把图标与图标所领那一行的首句实测对齐。

## 环境检查（environment check）
版本脚注之上，页面陈述这次安装的事实，不是 Human 的事实：这个 bundle 正跑在哪条 DSH 线上，以及那条线是否落在 bundle 自己声明的支持范围内。它是第二个投影：`environment-check.ts`、`TeamEnvironmentCheck`。第二个投影刻意不放进身份 store。投影只读一次，从不写回。唯一的渲染方就是设置页。

它以页面其余行同一条发丝线开场。这条判定答的是这次安装，而不是上方那个端点。没有这条线，本块会被读成 jev 组自己的一部分。

判定只有三档，不新增第四档，也从不猜测。Host 建立不起来的事实就是 `undetermined`，这是一个落定的回答、而不是一次失败的请求。本块没有重试。Host 联系不上时整块什么都不渲染，而不是借用这个词。

**判定的先后顺序就是契约**。运行版本读不到，给 `undetermined`。运行版本违反任何一条已声明的 `@deepseek-ai/dsh-*` peer，给 `out-of-range`。真实的违反不会因为此刻已没有一条能对外陈述的区间，就被降级成 `undetermined`。只有在什么都没违反之后，问题才变成「已声明的区间是否收下这个版本」。

对外只陈述一条区间，因此要求每个 DSH peer 声明同一条。前缀是 `@deepseek-ai/dsh-`。`@deepseek-ai/cordis` 同 scope，但不在 DSH 版本线上。声明漂移或集合为空时整行不显示，而不是挑一个 peer 代表其余。

只有 `out-of-range` 这一档取面：`--dsw-alias-state-warn-tertiary` 底配 `--dsw-alias-state-warn-label`，半径取行级表面的 12px。因为这一档是读者可能需要据以行动的，另外两档保持为行。每一档都用「文本 + 图标」表态，因此读者分不清颜色时状态依然成立。

区间用人话写，不打裸 semver range。range 字符串读者无法核对，要的是一句话。实测认证组合（`Agent Team <bundle> × DSH <certified>`）只在两个版本都**推导得出**时才打印。一个是已装 manifest 自己的版本，一个是区间下界。后者就是本仓门禁钉住的认证基线。读不到的版本会让整行不显示，而不是请一个手写版本上页面。

因此，读者容易混淆的两个版本被分开放置。运行中的 DSH 版本是环境，认证版本是声明的那条线。只有安装正好落在基线上时，两者才是同一个字符串。

本块用 `data-environment` 携带自己的判定。验收 journey 因此等待一个状态，而不是一段文案。

## jev 端点组
- 页面第二组装的是 jev 要用的端点：三个控件（apiBase、model、只写的 key）收在一个默认折叠的披露行之后。那一行本身就是控件。行上带着状态与箭头，展开才出现字段。展开后的组带 `role="group"`，以行标题为无障碍名。这一页有两个保存按钮，任何一个都不该在没有上下文的情况下被念出来。
- 默认折叠。端点设一次就不再动，端点状态每次打开这一页都值得看见。折叠时控件**不在 DOM 里**、而不是被藏起来。只把内容藏起来的披露仍能被 Tab 摸到，也能被读屏念到。所以浏览器验收钉的是这种「不在场」：没有 `[data-team-judge]` 组体，没有字段。验收不只看样式。
- 状态就是这一行、不是字段上方另起的一行。`remote.agentTeam.contextJudge` 回答 jev 此刻是否可达。这一行用「文本 + 14px 图标」陈述 Host 自己的答复，并由 `data-context-judge` 携带。三种值是 `enabled`、`no-key`、`unavailable`。只有 `unavailable` 取警示色：缺 key 是一个待做的步骤，端点不可达才是要去修的事。首次读取落定前这一行什么都不说。`detail` 始终是 Host 诊断，不变成用户文案。
- 门控的三个阈值与 key 的环境变量同处一行，刻意不上页面。它们是 Team 自己管的行配置，部署仍可在自己的 patch 层设置。Client 只读 `jev` 这一组。中间一层投影适配器拍平该节的 `value`、`base`、`user` 三层，把每个控件名映射到控件真正的路径（`['jev','apiBase']`）。
- 表单用的是 shipped 设置栈：`SettingsFormModel` 配 `SettingsForm`、`SettingsValueField`、`SettingsSecretField`。草稿、覆盖徽章、重置与保存的行为与 Harness 自己的设置页完全一致。所有写入都经 `ctx.configForms.get(namespace)`。revision 栅栏由写入通道持有，Host 的答复也由写入通道折回 mirror。没落地的保存保留草稿并如实说明，落地的保存会重读状态。
- key 是**只写**的。Host 会 redact 字面值。这个控件每次加载都从空开始。空草稿不写任何东西。打开这一页永远不可能清掉已存的 key。「已配置」徽章来自 describe mirror 的 `secrets` 列表：这份状态唯一可读的地方。移除字面值是一次**显式的清除写入**，只在没有暂存草稿时才提供。写入会推动文档 revision，暂存的保存被文档 revision 栅栏住。
- 这一组只在这次部署提供 settings 文档时才出现。段落本身照常注册：身份不依赖 settings 文档也能读写。settings 服务缺席时这一组直接不渲染。文档在场时这一组也自己答自己。只读文档禁用全部控件并说明。命名空间没被提供时，渲染表单自带的那行「没有提供」，而不是画出一堆没人接受的字段。
- 表单是以**可观察的 seat**、而不是一个值交给页面的。slot entry 的注入 props 只算一次，并缓存到该 entry 的生命周期。首次渲染之后才应答的 settings 服务，本来会让这一组一直不出现，要刷新。页面自己的测试钉的就是「渲染之后再填 seat」。

## 失败态呈现（failure surfaces）
- 投影失败的呈现只有两种，选哪一种等于声明「屏幕上还剩什么」。**整面失败**（从未加载出投影）用 `errorState`。`errorState` 与所替代的 loading / empty 面共用同一份空白区居中（`margin: auto`、`padding: 32px 0`）。整面失败保持在 880px 阅读列内，取 12px/18px 的 error 字号与 `--dsw-alias-state-error-primary`。内容是 Host message 加一个重新发起读取的 `重试`，message 与按钮同在一个 `role="alert"` 里。**行旁失败**（行还在）用内联 `error`。在内容列内 `margin: 0`，读作所属列表的最后一行，而不是让已有内容的面重新居中。
- 两种失败都不充当空态。空的判定要求「投影成功返回且确实为空」：`view !== undefined`、无 error、里面没有东西。所以断连永远不会被读成「这个工作区是空的」。
- 侧栏用同一套形状的 rail 尺度。Panel 自身的失败行是 11px/16px 的 `--dsw-alias-state-error-primary`，左侧缩进 12px。文字落在失败行所替代的行标签上：列表缩进 4px + 行缩进 8px。文字不落在 Panel 边缘。行自身的失败（`rowAlert`）在行内保持同一尺度。
- Panel 失败按 Panel 记：每个挂载中的 Panel 各自报告自己看到的那次断连。所以一次断连会在侧栏出现同一条消息，正文自身读取也失败时再在页面上出现一次。
- Panel 失败行不带重试按钮：侧栏靠 change stream 自愈。断连只上报一次，传输恢复后唤醒全部 listener（见 [`host-authority.md`](../architecture/host-authority.md)）。

## Thread 顶层栏与 Claim 面板（header band / claim panel）
- Thread 顶层栏装的是返回行、Task 身份、运行风险区与 Claims 区，整条带由 `.surfaceHeader` 自己那一条底边收口。因此带内两个分区**只靠间距分层**。分区级 `border-top` 会在什么都没围住的地方再画一条线，带上方的组已经由带自己的边线结束。这里「分隔线条数」是可量测的设计属性而非口味问题。shipped DSH 的分隔线只画在组与组之间，见 `PluginInventorySettingsTab.module.css` 的 `.group + .group { border-top: 0.5px solid … }`。所以原先每个分区各带一条 `1px solid var(--dsw-alias-border-l2)` 既不合房规也是多余的。保留的是：页头带自己的 `border-bottom`（真实结构边界）与时间线里的未读边界线（语义边界）。
- 顶层栏是**有高度预算**的，不只是「整齐」问题。两个 Member 处于错误态时，顶层栏占到 960px 视口里的 426px，把对话内容整个推到首屏以下。改成分区间距分层后同样内容只占 360px。
- 一行 Claim 是**三条网格轨道且都有内容**：presence 点、身份加状态一组、direction。身份与状态共用第一行、direction 独占第二行。handle 因此不会变成在宽行尽头漂着的后缀。880px 下，旧单行布局会把 handle 放到 handle 所属 direction 之后 158px 处。状态也不会飘在行尾，离开状态所限定的那条 Claim。**窄屏不重排模板**。一套 `14px minmax(0, 1fr) auto` 模板在 1440 与 390 都成立，两端因此不会各自漂移。14px 的点列加上列表 22px 缩进，让每个点都落在上方 `Claims · N` 标题的同一条竖轴上。
- 行首的 presence 点是这一行**唯一**的活跃指示器。在 handle 旁再加一个「可用」徽标，等于把同一件事说两遍。这类重复读者会先察觉、后命名。已完成的 Claim 带 `claimRowDone`。完成 Claim 的 direction 降到次级色，完成的工作不再与进行中的抢注意力。Claim 本身仍然可见。
- 运行风险行每个出错 Member 一行。行首是诊断结构化 class 的本地化名称：`session-refused`、`session-unreadable`、`preset-composition`、`rollover`、`runtime`、`activation`。这就是 `AgentTeamMemberDiagnostic.class` 这条策略轴。`restartOffered` 早已按这条轴分支。这条轴回答可本地化的「这是哪一类问题」。Host 的 `detail` 天生是英文，行内只截取 `detail` 首句。完整原文留在风险行 `title` 上。`AgentTeamClientMemberStatus` 本来就把整份 diagnostic 带到浏览器，因此这条轴不需要改 Host 协议。
- 每个 class 一个句子 key，让可见行留在界面语言里，而不是把 Host 字符串直接贴进本地化界面。完全没有 diagnostic 的 Member 回落到 `runtime` 文案，而不是留空。
- Task / Thread 身份下方那句开篇文字**在任意宽度、任意 Thread 类型下都只占一行**。实现是 `-webkit-line-clamp: 1`，同时写标准属性 `line-clamp`。完整原文留在 `title`。Task 标题本来就长且夹着不可断的 ref。讨论的开篇就是自己的锚消息，正文时间线里紧接着完整重复了一遍。所以别给开篇在页头带里留第二行。那等于把页头高度花在读者已经能看到的文字上，还让页头高度取决于别人当初打了多少字。压成一行后，很长的开篇与两个字的开篇页头同高（实测 taskless Thread 两种都是 114px）。
