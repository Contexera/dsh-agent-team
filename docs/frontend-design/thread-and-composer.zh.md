# 时间线、composer 与入口行

[English](thread-and-composer.md) | 中文

## 时间线滚动（timeline-scroll）
- 策略：读者停留在底部（距底 <48px 视为 pinned）时跟随新内容；不在底部时不打扰。
- 确认合同：Thread 打开期间到达的事实一律自动做持久 `readThread` 确认。pinned 读者当场看见，滚离底部的读者由纯跳转提示引导回底。确认失败时回退为既有 error surface。不存在任何手动读取动作。
- 打开即清零：打开 Thread 直接滚动到最后一条。有界批次若返回剩余未读，Client 以串行循环自动续读（每轮 mint 新 requestId 复用 Host 幂等缓存语义）。连续 50 轮未清零视为异常并显示错误提示。
- 前插更早历史时按 scrollHeight 差值补偿 scrollTop，视口内容不跳动。
- 更旧 facts 由时间线自己的「加载更早消息」入口翻页，首绘的历史读取决定它是否出现。读取被拒或抛错时该入口保持存在，从屏上最旧的 fact 往回翻，并由它自己的 error surface 报告失败，而不是让更旧的 facts 永远卡在一个不会出现的控件后面。
- 跳转：`scrollToBottom` 立即滚到底部；「↓ N 条新更新」提示按钮只滚到底、无读取语义，读者回到底部即消失。
- contentKey 必须随渲染事实变化（当前用 `长度:末位factKey` 组合串）。

## Message 行的身份行

一条 Message 以作者开头：头像座位，以及它旁边的作者名与时间。座位是 `--team-identity-seat`（34px），也是头像尺寸唯一被写下的地方——首字母头像与上传的头像图都从它取宽高，续行的时间在它里面居中，贴着正文列的那两条发丝线也按它起算，所以改头像尺寸不需要第二处修改。它声明在共享对话面上而不是 Thread 页，因为 Project feed 渲染的是同一批 Message 行。

头像与作者行的齐平，靠的是头像从名字行顶部下移 5px，而不是让作者行长到头像那么高。这个数是本方字体的事实：行内盒在字的上方带着字体半行距，所以默认 13px/20px 下，作者行的大写字母从行盒顶部起算在 5.5px 处才开始，取 5px 即与它们齐平。Raft 的头像同样与它自己的作者行齐平，但它的 `mt-0.5` 只有 2px，是因为那一行是 `leading-none` 的 14px/14px、大写字母本来就下移 2px。照抄那个常数会让本方头像浮到名字上方。

名字与它的时间共用一条基线，与 Raft 的 `items-baseline` 行一致。e2e 旅程在已发布内容轴的两端各断一次头像的渲染尺寸与这个下移量：头像是界面件而不是内容，内容轴只挪它旁边的字，从不挪它。

续行没有身份行，它的时间按上面[时间线滚动](#时间线滚动timeline-scroll)所述坐在头像座位里。

## Composer 与 @mention
- textarea 自增高（上限 336px），Project / Thread composer 出现时自动聚焦且不滚动时间线。Enter 发送、Shift+Enter 换行。IME composition 期间 Enter 不触发发送。发送期间输入框保持聚焦但只读，避免重复提交。发送按钮点击不抢走焦点，发送完成后可直接继续输入。未关注 Member 的首次发送返回确认提醒时，保留草稿与收件人。输入框自动恢复焦点，第二次 Enter 可直接确认发送。composer 卡片沿用 DSH 默认静态表面描边（`border: 0` + l2 elevation 发丝线 + `--dsw-elevation-soft`）。`focus-within` 不改它的颜色。
- mention 弹层向上展开，`role="listbox"`。textarea 以 `aria-controls/aria-activedescendant/aria-expanded` 关联弹层。↑↓ 循环、Tab/Enter 接受候选、Escape 关闭。外点关闭复用 `useDismissOnOutsidePointer`。高度钳制复用 `useAnchoredMaxHeight`（cap 320px）。高亮行始终通过 `scrollIntoView`（`block: 'nearest'`）保持在弹层可视区内，Member 多时键盘选中的候选不会被折叠隐藏。Thread 面通过 Human-only 的 `threadObservations` 读取当前关注者集合。读取时机是首屏并行一轮，加每次 thread 域 wake。
- 候选集是整个 Workspace 的参与者，与 Host 的点名口径一致，并按「点中后多直接地送达」排序：本 Thread 的关注者 → 通过别的 Thread 参与本 Project 的 Member → Workspace 其余。所有档位都可选——账本对它们都能寻址，排序只是提示不是筛选。只有 `@all` 保持更窄的 Project 口径，因为 Host 就是这么展开它的。接受候选后光标落点精确到插入文本之后；删除提及文本会同步收缩 recipients。
- 一行只带一个事实：「浓淡」，落在 `data-mention-inside` 上，回答该 Member 是否在这个正在写的会话里。为 false 时名字降到 secondary label 档，行本身的对比度不变。浓淡就是这一行的全部区分——行写清这位 Member 是谁，不声明这次点名会做什么。
- 两个表面对同一档位的判断相反。Thread 面的边界是「关注本 Thread」，所以通过别的 Thread 参与本 Project 的 Member 在它之外；Project 顶层发送则把任何 Project 参与者都算作在里面。逐行写出后果在两个表面上都没有增加信息：Thread 面上它标记的正是浓淡已经标记的那些行；Project 顶层发送没有确认步骤，而每个收件人都会加入它新建的 Thread——这对每一行都成立，逐行写出来只在写着的那一行是噪音、在不写的那一行制造假的差异。
- 这份沉默不藏起任何东西：Host 会停下来确认的那次点名，由 composer 在发送后弹出的状态行（`mentionConfirmation`）说明。行负责说清谁在这个会话里，确认由发送后的状态行陈述。浓淡是这一行唯一的区分载体，因此必须扛住宽度变化：窄于 600px 时身边的 description 被丢弃，浓淡留下。
- 表面语言：mention 弹层画的是共享的半透明菜单 token。按 shipped 毛玻璃配方补 `--dsw-menu-backdrop-filter` 与 elevation 描边/阴影，而不是当实底用。0.1.7 把这个 token 改成半透明却没改名。实底弹层会真实地读不清，而存在性检查全绿。配方本身见「设计语言对齐」表。
- 模式 chip（「作为任务」）：任何宽度都保留可见文字标签。窄于 560px 时改为缩工具组间距（`@container (max-width: 560px)`），而不是藏字。`aria-label`、`title`、`aria-pressed` 照旧承载模式语义。
- Member Session 输入面即 shipped composer 本身，不做任何修改。Team 不注册任何 Member Session 的 composer 表面：无接管、无 trigger sources、无 dock 提示条。键盘合同、命令与引用菜单、附件与普通会话完全一致。
- 收件人提示行：通知集合非空时在草稿与工具栏之间渲染 quiet 提示行（`.notifyRow`，`composerNotify` 文案 + `{ids}` 句柄列表）。发送前即可看到"将通知谁"。集合是菜单选中的 recipients 与正文手打 `@Handle` 的并集。`mentionedMemberIds` 从草稿派生，与 Host 同一套大小写不敏感、Unicode 词边界的规则。`@all` 按菜单的展开口径列出全部可投递 Member。空集合不占位。派生集合只用于显示，不进发送 payload。Project 之外的名字在正文里只是散文，作为显式 recipients 会被拒绝。
- 读者自己的 handle 是唯一一个必须「不读也能找到」的 mention chip，所以它是唯一离开 business 族的 chip。`[data-mention-human]` 用 success 档着色（error 与 warn 两族分别意味着失败与警示）。正文里写的是读者改名前的 handle 时，该 chip 同样被标记 —— 标记跟着身份走，不跟着拼写走。
- `view.rulesVersion >= 2` 时 Project composer 发到 Main stream，工具区用 `讨论/任务` 取代「作为任务」pill。它是 pressed button；打开后出现原生复选框 `作为任务`。关闭时发 `postMainMessage`（引用 Main 消息时带 `replyToMessageRef`）；打开时发 `startThread`，勾选则建 Task，否则建讨论；Task 提交后页面切到 `看板` 页签并把焦点放上去。引用会关掉开关，打开开关会丢掉引用，因为新 Thread 没有引用目标。Host 返回 `main_unread_required` 时保留草稿，刷新并读取主对话，用状态行提示 Human 先看一下再发；重发是新的 operation。版本 2 的回复不再要求确认；Main stream 与 Thread composer 都不提供 `@all`，也不把它展开为 recipients，手打的 `@all` 就是普通文本。
- 草稿缓存：draft/recipients 不在页面局部。它们按 `project:<projectRef>` / `thread:<threadRef>` 键存放。每 Client 上下文存一份 `TeamDraftStore`（`drafts.ts`）。它用单一 localStorage 键 `dsh.agent-team.drafts.v1`，写穿持久化，按 savedAt 淘汰最旧 ~50 条。切换视图或刷新后草稿与收件人原样恢复。发送提交成功即清除对应键，失败保留。Composer 挂载收敛会剔除不再匹配文本/已失效的收件人。Project 的「作为任务」意图不进入草稿缓存：默认关闭，成功提交后再次复位关闭。
- taskless Thread 的「转为任务」是 Human-only durable mutation，不做乐观 overlay。成功后重新读取 Thread 与补充 Project/Member 投影；unread/stale fence 时保留 Host 返回错误并重新读取相关事实。

## 引用一条 Message
Thread 里的一条 Message，可以通过「选中它所回答的那条 Message」来回答。这个入口无条件存在：回复动作、已存的引用行与 composer 引用条是同一个功能，Host 一律完整提供，没有哪个表面需要先问一句「引用是否可用」。

选中一条 Message 时，目标在读者正在看的两处同时被说明。该行**保持**指针刚刚给它的那层扁平交互底色，因此指针移开后选择依然可见；composer 里出现一条引用条，写明父消息及其第一行，旁边紧跟取消，取消会同时清掉两者。引用条落在 composer 卡片内部、输入框上方，目标与草稿因此被读成一个动作。它不重复声明投递：被引用者与其它收件人一样并入同一行「将通知」，因为引用像 mention 一样投递，而一次投递只读一遍。

有一个作者永远不进这一行：Host 既不投递给 Human（Human 直接读 Thread，没有可投递的 Session），也不投递给消息作者本人。所以被引用的 Human、以及读者引用自己消息时的那位作者，在投递发生之前就已从收件人集合里去掉。这一行陈述的是**将要发生什么**，而不是选中了什么，因此它对这次投递保持沉默，而不是把读者自己念回给读者看，说成那个会收到通知的人。

发送时带上父消息的 ref，Host 因此记录这条引用并向父消息作者送达。发送成功会清掉目标，切换 Thread 同样会清掉，所以过期的引用永远不会跟着下一次 Enter 一起出去。

时间线里，这条引用领在它所归属的 Message 之前，用的就是读者已经熟悉的 Markdown 引用形式。那是 2px 竖线后一行安静文字，写明作者与父消息第一行，整行都是跳回原文的入口。它是指向原文的把手而不是副本 —— 长父消息不会被粘贴第二遍，引用也不可能与它指向的 Message 不一致。composer 的引用条与它是同一种对象、同一种语言，这正是两者能被读成同一句话的原因。

## Thread / Task 入口行（project 时间线内）
- 语义：每个 top-level Project 消息进入其 Thread 的唯一入口，形态是正文下方**一行**安静的行——既陈述状态，也负责开门。`Task #N` 是 home Project 内 durable Task creation 的展示编号，不是稳定身份。跨视图导航使用 branded Task ref。
- **开门之后去哪，取决于门后是什么**：taskful 入口走 `selectThread` 进 Thread 页（那里承载验收与完整历史）；taskless 讨论不进新页，而是在 Project 页自己的右侧面板里打开，读者身边仍留着 feed。见「Project 页与讨论面板」。
- 方位（本条的硬约束）：入口的任何状态都**不放在身份行上**。一个 run 里的后续消息没有自己的身份行内容，状态簇停在那里只会孤零零地悬在行尾；而任何靠右的落点都要读者为真正想看的价值横穿整列。状态改为**领起入口行**：与上方正文同一个左缘，且整条 feed 的所有入口共用一个 x。shipped DSH 的行也是这么做的（`SkillRow` 折叠态的首位槽、`JobListAction` 触发钮「点在前、计数在后」）。
- 状态簇（`.stateCluster`）：**未走完的** taskful 入口依次是三样东西。第一，Task 在办 Claim 的所有者头像叠放。第二，`taskStatusDot(status)` 对应的 8px `TeamStateDot`。第三，本地化状态词。`in_progress`→ongoing、`in_review`→warning、`done`→done 走共享 `StateDot`。`todo` 是空心圆环、`closed` 是 tertiary 安静点。五个状态共用同一套形态语言。Claim 是 Host 事实而非装饰。只有 `in_progress`/`in_review` 的 Task 才有所有者。`released` 的 Claim 已不是工作，所有者按 Claim 顺序去重。taskless 入口不虚构状态点。
- **已了结（done / closed）的 Task 整个簇退位，只领一个未读胶囊**：扫描已了结工作交给看板；在完工的行上画所有者叠放，回答的是没人问的问题。
- `TeamAvatarStack` 是 18px 交叠圆圈，用共享成员色相，最多 3 枚 + `+N` 一枚。相邻两面靠 2px 环分开，环把自己从叠放所在的表面上切出来。取值与两层画法见下文「收件箱」入口段。Inbox 页行与 Project feed 入口行都落在页面底色上。圆圈本身是装饰，所以整个叠放是一个 `role="img"`，标签写出完整名单（`claimers`）。
- 入口行的其余部分：12px/18px tertiary、`fit-content`、自身无底色无边框。hover 与 `:focus-visible` 只做两件事：文字提亮到 primary，chevron 前推 2px（120ms，reduced-motion 下关闭）。焦点环 2px 主题色。 状态之后接「这条入口是什么」。taskful 是 `Task #N`。taskless 在有后续动态时是本地化 Thread label，入口消息仍是最新事实时是 `replyAction`（回复）。 未走完的入口追加 `· 最近活动 <HH:mm>`，与 Inbox 行共用同一个近度标签。今天就是裸时刻。「不是今天的第一天」才带日子词（`昨天 HH:mm`）。判据是 Host 的 `lastActivityAt` 不同于入口消息自己的 `occurredAt`，即「这条消息之后事情又动过」。精确本地时刻挂控件的 `title`。
- `done` / `closed` 的 Task 换成脚注形式：`Task #N · <状态词> · <MM-DD>`，落款日是它了结的那天，取 Inbox 老行同样的日期形态，跨年时印完整日期。近度在这里只会在每一行重复一次「什么时候了结的」；精确时刻仍留在控件的 `title` 上，一次悬停即可看到。

  taskless 的 Thread 没有终态，所以讨论照旧印出近度：它没有状态词、没有状态点、没有所有者叠放，近度就是它全部的状态行。 **消息计数已退场**：这里读者真正要行动的量是未读，不是正文有多少。 390 窄列下入口行整体换行（`flex-wrap`）：门文案落到状态下一行，而不是把行撑出阅读列。
- 未读胶囊：计数「这条 Thread 上有多少需要**我**」的动态，也是 taskless 讨论唯一能携带的簇成员。数据来自 Project 本次 refresh 本就要发的 Workspace Inbox 整片未读。Host 的三类合并判断才是权威：我 follow 的 Thread 上的活动、提到我的、我的 Task/Claim 变化。Client 用 `threadRef` join 进列表，**绝不**用 `item.mentions` 自行推导。未读为 0 是「没有徽标」而不是「显示 0」，超过 99 显示 `99+`。它就是共享计数胶囊（见「计数胶囊」），因此不会与侧栏入口、Inbox 行之间产生漂移。未读读取失败时**清空徽标**，而不是展示读者已不能信任的计数。失败文案走其他读取失败同样的 inline 失败行。
- `aria-label` 依卡型与计数而定。未读为 0 用 `openTask`/`openThread`，带计数用 `openTaskUnread`/`openThreadUnread`。胶囊本身 `aria-hidden`，计数经这枚「开门」控件自己的 label 抵达读屏。这个通道把数字和数字所属的 Thread 绑在一起。状态簇留在控件**外面**：带 label 的 button 会把后代从可访问性树上剪掉，放进去等于让所有者叠放自己的名字沉默。

### 状态胶囊与弹层
- Thread 状态用公共 `Pill`（与 `Task #N` 同行）。
- 所有弹层走公共 `Modal`：打开时焦点入内容区，关闭后焦点回到触发按钮（`queueMicrotask` 延迟聚焦模式）。
