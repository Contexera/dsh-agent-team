# Client 隐式状态机审计（完成）

基线：`7076dbd`，2026-11-10。范围只读 `packages/client-agent-team`；不改源码/测试，不重复运行主代理已有的 2062 测试基线；本材料的结论来自源码和现有测试阅读，不声称浏览器验收。Client 只拥有临时交互、浏览器偏好与读取缓存；Team、Attention、read cursor 与 durable mutations 的权威始终是 Host。

已完成生产源文件的广读、状态/异步符号扫描和现有测试索引核对；对高风险协调器作定点细读。范围为 67 个 TS/TSX（包含声明文件），不是每个文件都有状态。保守原则：没有复现，不以“统一 FSM”改变可见行为。

## 结论与边界

归并为 **24 个逻辑状态机/协调器**，不是 24 个应抽成库的模块。现有设计最重要的优点是：远端事实由 Host 确认，浏览器只保存导航、草稿和排序；投影刷新不抢走已呈现内容；连接恢复由 Harness 承担，Client 只维护 scope、baseline 与代际边界。UX、DX、AX 的共同收益主要来自让失败原因和恢复入口与真实阶段一致，而不是引入通用 FSM 运行时。

**当前裁决：保留 17、局部显式化 5、延后核实 2；全部是审计建议，没有实施行为变更。** “局部显式化”只指未来在现有 owner 中收敛状态与不变式；不新增领域权威。风险指改动风险，不等于已发现故障。

术语：本文 **AX 指 Agent Experience（Agent 体验）**，关注稳定 branded ref、Host 权威语义、可判别结果与可理解的失败恢复；不是 accessibility（可访问性）。键盘、焦点、ARIA 与辅助技术反馈属于 UX 的重要验收，不替代 AX。

路径缩写：下文源文件相对 `packages/client-agent-team/src/client/`，测试相对 `packages/client-agent-team/tests/`。行号对应基线，源码与测试优先于本材料；具名测试仅表示存在相应断言，不表示本次重新执行。

## 状态机清单

### C01 激活、Remote、槽位与释放｜保留｜高风险

`index.ts:118 registerTeamPanel、235 teamSeatInject、298 registerModeShadow、341 applyUi、509 apply`。状态是未挂载→Remote 已挂载→服务可用→UI 注入→释放；事件为 mount 完成、`remote.agentTeam` 可用、导航模式变化与 context dispose。守卫是公开服务与槽位存在、Team mode，而不是假定插件加载顺序；注册权威属于 Harness，Team 只持有自己的 disposer。副作用包括字典、导航/草稿投影、槽位与远端注册；释放按 context effect 归还。保留 inject/children 所有权，不能用私有 UI 副本“简化”。证据：`slots.client.spec.ts`、`main-panel.client.spec.tsx`，以及 `team-mode-conversation.client.spec.tsx:719` 的恢复、失效 Workspace 和卸载旅程。未启动新 Preview，故不声称当前视觉/键盘验收。

### C02 变更流共享与重连｜保留｜高风险

`team-changes.ts:33 TeamChangeStream` 的状态是无订阅/活动/失败/恢复开流/释放；subscribe、最后一个 unsubscribe、carrier failure、新 Host generation、stream item 驱动转换。按 scope key 共用一个 logical stream；旧 subscription 身份不再匹配就丢弃其结果；每次开流和失败后的首项强制 baseline，不能只比较版本大小。Harness 是 transport/retry owner，Team 不加第二套退避；terminal failure 展示错误，`recover()` 重建失败 scope 而不扰动 live scope。测试 `team-changes.client.spec.ts:43,62,79,98,114,128,142` 覆盖共享、乱序替换、回退 baseline、终止和重建。此处已经是显式的小型协议，不需再套 FSM。

### C03 查询合并、失效与代际｜保留｜高风险

`team-queries.ts:129 TeamQueries`：key 未注册→读取中→短暂可共享结果→过期/被取代；事件是 read、scope invalidation、resolve/reject、newGeneration、dispose。守卫包含 key 的静态 result brand、同 key 同 rule、presence/projection 分域 watermark、issuance 顺序与 dispatch 去重；不能把 presence epoch 与 ledger position 比较。副作用是共享 waiter、重发 superseded read、交付最新已落地结果和计数诊断；失败允许下次重试，释放后不再补发。权威仍是 Host，缓存仅用于协调读取。`team-queries.spec.ts`、`team-shared-reads.client.spec.tsx`、`team-presence-scope.client.spec.tsx` 是核心安全网。保留 branded identity，不用“一个请求状态 hook”抹平协议差异。

### C04 导航、嵌入 Session 与返回｜保留｜高风险

`navigation.ts:14 TeamNavigationSnapshot、141 TeamNavigation`，`index.ts:147 openMemberSessionImpl`。普通/Team mode 内再分 Inbox、Board、Project、Thread，并允许 runtime-only Member Session overlay；select/back/exit 驱动转换，Workspace/Project 变化清除不再适用的子位置。浏览器只持久化 Team 位置，不持久化 Session overlay；重新选择当前 Member 不覆盖原返回目标。打开 Session 失败不得先假装导航成功，退出 overlay 时只在主选择仍属离开者时恢复原选择。`navigation.spec.ts:21–314`、`agent-row-open-failure.client.spec.tsx`、`main-panel.client.spec.tsx` 覆盖这些边界。`TeamAgentsPanel.tsx:54 useMemberSessionFollow` 还跟踪 observed/pending swap：只在新 Session 为 active 且 seat 仍指向旧 Session 时跟随一次；用户先离开即取消，见 `team-mode-agents.client.spec.tsx:355,505`。保留命令式 action API；改成单一枚举前必须表达并列 discussion panel，而不是丢掉可恢复位置。

### C05 草稿保存与恢复｜保留｜中风险

`drafts.ts:70 TeamDraftStore`：空/有正文或引用/已清空，set、clear、读存储和容量淘汰为事件。key 为稳定 Project/Thread ref；相同值不通知、不刷新 savedAt；最多 50 项，损坏 JSON 与不可用存储降级到内存。只在 committed send 后清空，导航切换不能销毁草稿；浏览器便利数据不是 durable Team fact。`drafts.spec.ts:25–118` 覆盖 round-trip、重建、旧命名兼容、独立清空、相同写入、淘汰和损坏内容；`team-mode-conversation.client.spec.tsx:522,567` 覆盖页面间恢复。保留 store，勿将高频输入提升到整个页面 controller，以免时间线重绘。

### C06 各页面投影加载与 scope 刷新｜保留｜中风险

`TeamWorkspaceBrowser.tsx`、`TeamProjectsPanel.tsx:74 refresh`、`TeamAgentsPanel.tsx:119 refresh`、`TeamProjectPage.tsx:298 refreshSubscriptions、323 refresh、353 refreshMembers`。逻辑状态是首次 loading、已加载（含空）、后台刷新、带旧值的失败、卸载；Workspace/project/presence wake 分别触发其所需读取，而不是所有 scope 都整页刷新。局部 mounted/sequence/loaded 标志与共享查询层分工：前者保护页面 seat，后者保护同 key 的远端读。失败保留已知事实，首次失败给重试；创建/编辑后只在 Host 答复后重读。测试 `team-loading-surface.client.spec.tsx`、`render-isolation.client.spec.tsx`、`team-project-panel-switch.client.spec.tsx`、`team-presence-scope.client.spec.tsx`。不因代码形似就强行抽成全能 loader。

### C07 跨 Workspace Inbox / Board｜保留｜中风险

`TeamInboxPage.tsx:81 refresh` 与 `TeamTaskBoardPage.tsx:16 TeamTaskBoardPage`：等待 Workspace 列表→并发读取→聚合/空/部分失败→重试；订阅 scope-less changes，导航时传稳定 ref 与 Workspace。Inbox 读取不确认已读；只呈现 Host unread、mention、recent 及截断事实，排序和展示裁剪不成为通知权威。Board 同理消费投影，不在 UI 自行重算 Task 生命周期。`team-inbox.client.spec.tsx`、`team-task-board-page.client.spec.tsx`、`board-card-foot.client.spec.tsx` 覆盖真实队列、跳转与状态文案。保留 Host 投影边界；若以后统一聚合加载，要先保留部分失败和“已有内容”的差别。

### C08 Thread 有界已读与自动 drain｜保留｜高风险

`thread-controller.ts:130 useTeamThreadController、190 drainUnread、204 readCurrent`：首次读取→已读投影→remainingUnread 自动续读→完成/错误/达到上限。每轮新 requestId，普通重试复用当前 ID；sequence 和 mounted 是晚到响应守卫。每次最多读取一页，最多 50 轮，remainder 不前进就停止，防止 Host 故障或持续到达产生自旋。成功才调用 onRead，并由 `team-changes.ts:126 TeamReadStream` 通知 badge/Inbox 重读；它的本地 version 只是刷新信号，因为 durable read 不唤醒普通 changes。read cursor 是 Host durable fact，不通过本地滚动位置假定。`team-mode-conversation.client.spec.tsx:606,780,1041,1065` 覆盖 baseline catch-up、未读定位、多轮 fresh ID 和失败恢复。保留已读与 UI jump 提示分离，不把“滚到底”当作唯一确认条件。

### C09 Thread 被动到达、历史和补充数据｜保留｜中风险

`thread-controller.ts:226 refreshPassiveFacts、261 refreshFollowers、347 loadOlder`，`TeamThreadPage.tsx:110 applySupplemental、128 refreshSupplemental`。状态为当前事实/历史可继续/历史加载失败可再点；到达时按 fact key 合并，较老回填不能冒充新到达。observations 只改善 mention 排名，失败不污染主内容；Task、claims、roster 由各自远端结果补充。新事实出现仍进行 durable acknowledgment；离底部的计数只是跳转提示。历史失败不得把 hasMore 清掉。`team-mode-conversation.client.spec.tsx:658,679,880,942,997` 覆盖历史重试、followers 排名和提示生命周期。继续保留不同读取目的，避免被动 history 顺带改变已读含义。

### C10 主流读取与到达短标｜保留｜中风险

`main-stream.ts:56 mergeMainStream、81 mergeMainRead、92 useArrivalMarks、135 useMainStream`。首次 history、刷新、older page、markRead、短时 arrival mark 是相互协调但不同的阶段；刷新 sequence 防旧结果覆盖，mounted 保护卸载，markRead 以 newest sequence 和 unread standing 的组合限制重复尝试。Host 返回 standing 才更新已读；新到达标记 3 秒后移除，不能变成业务未读。失败保留现有 entries，并由页面展示重试。`main-stream.spec.ts`、`team-main-stream.client.spec.tsx` 覆盖合并、到达、阅读与分页；不把 timeline 动画状态同步到 Host。

### C11 Thread 回复与 Task mutation fence｜保留｜高风险

`thread-controller.ts:416 commit、443 applyTaskCommit、462 sendReply`，`TeamThreadPage.tsx:445 convertToTask、459 mutateTask`，`TeamProjectPanel.tsx`。idle→pending→committed / unread_required / stale_revision / 传输失败；shared pending gate 协调回复和 Task 写，requestId 按操作保留，fence 后重读而非盲重发。commit 后合并的是 Host 已接受的 receipt/projection，尽管局部变量写作 optimistic，它不是持久 mutation 乐观提交。发送失败保留草稿和文件；成功清空；unread fence 读进度，revision fence 刷新事实，再由人重试。`team-mode-conversation.client.spec.tsx`、`team-project-board.client.spec.tsx`、`team-project-panel.client.spec.tsx` 是回归入口。最高风险是改动请求 ID 与“已提交”的分界。

### C12 Attention 与 Task 转交｜保留｜高风险

`thread-actions.ts:64 useThreadFollow、161 useTaskTransfer`。follow 的 unknown/following/not-following/pending/error，transfer 的 idle/pending/refusal/landed 分开；Host observations 与 commit 是事实来源，不根据其他 Member 的 follow 推断 Human 已关注。按 intent 缓存 requestId，卸载不回写；转交遇 unread_required/stale_revision 回调读刷新，已提交位置显示 receipt，下一次操作清除旧回执。`team-human-attention.client.spec.tsx:54,73,111` 及后续拒绝/重复提交用例覆盖。保留两个领域化 hook；它们比一个通用 toggle 更清楚地表达权限与恢复。

### C13 Composer mention、输入法与附件预览｜保留｜中风险

`TeamComposer.tsx:20 findMention、71 TeamComposer`，`mention-presentation.ts:77 buildMentionGroups`。正文/光标→候选关闭或打开→高亮→提交 mention；composition、Escape、箭头、Enter、失焦和 draftKey 变化触发转换。ASCII 单词内的 @ 不打开，CJK 后允许；候选按 owner/follower/project/other 分组，不提供伪 @all；pending 禁止提交与文件编辑。listbox、option、aria-activedescendant 与保持 textarea 焦点是 UX 可访问性不变式，输入法期间不能误发。AX 则要求 mention 的稳定 Member ref 与 Host 投递语义不被展示排序替代，Agent 不必从候选分组猜测谁实际被通知；拒绝及恢复以 Host 结果为准。图片 object URL 随文件移除/卸载释放。测试 `team-composer-mention.client.spec.tsx`、`team-composer-mention-weight.client.spec.tsx`、`team-mode-conversation.client.spec.tsx:487,679`。保留局部状态和独立 draft 订阅，重构必须检查键盘与中文 IME。

### C14 发送、附件与引用解析｜延后核实｜中风险

`requests.ts:9 uploadComposerFiles`、`TeamMainStream.tsx:144 send`、`attachment-preview.ts:24 loadAttachmentDataUrl`、`refs.ts:63 createRefStore`。附件为待上传→逐个成功/失败→发送；引用为未知/读取中/缓存结果，合并 unknown lookup 并在 finally 释放 in-flight 标志；预览缓存区分未读、data URL 与不可展示。正文发送 ID 和每次 upload 的 ID 并非同一生命周期：网络不确定后重试可能重复上传，最终影响取决于 Host 请求指纹/回放契约，不能仅凭 Client 推断消息会重复。已有 `attachment-preview.spec.ts`、`roster-refs.spec.ts` 与 conversation:463/487；建议有复现再加“上传成功但 send 响应丢失”测试，暂不改传输协议。

设计复核（`4af67bb2`）：`TeamMainStream.tsx:153–158` 的两种提交在 Remote 返回错误时都会丢掉请求标识；`thread-controller.ts:484–498` 保留标识但重新上传，并读取当前修订。账本 `ledger.ts:8487–8497` 将原修订和附件列表纳入同一回复的判断。附件预览方面，`attachment-preview.ts:24–34` 虽只缓存缺失错误，却把其他 Remote 错误也返回成 `null`；`TeamMessage.tsx:538–555` 显示同一个过期标签，且未处理读取 Promise 拒绝。实测 `attachments.ts:156–163`：让临时目录的元数据路径返回 I/O 错误，与文件不存在都得到 `undefined`。这是读取函数的实证；实际预览和发送仍按 05、07 的入口验收。

### C15 时间线跟随与定位｜延后核实｜中风险

`timeline-scroll.ts:13 useTimelineScroll`，`thread-controller.ts` opening jump/pulse 与 `TeamMainStream.tsx` quote jump。pinned/unpinned、待定位/已 pulse、历史 prepend 是独立状态；48px 阈值决定跟随，手动 jump 恢复 pinned，卸载清理定时与定位状态。值得核实：未 pinned 时，effect 对任何 scrollHeight 增长都补偿 scrollTop，并未在 API 区分 prepend 与 append；静态阅读不能证明真实页面发生位置跳跃，因为浏览器 anchoring 与容器高度会介入。已有 conversation:880/942/997 验证 jump hint 而非所有视觉锚定。先在当前 Preview 对“向上读时尾部到达/加载更早”各录一次 scrollTop，再决定是否局部加入变更意图；不以假设改 UX。

### C16 Sidebar 拖动、分区与面板宽度｜局部显式化｜中风险

`sidebar-drag.tsx:22 useSidebarRowDrag、68 SortableRow`，`sidebar-order.ts`、`sidebar-sections.ts`、`TeamPanelHandle.tsx:13`、`panel-width.ts`。drag idle→active/over/marker→drop committed 或 cancel；committed ref 防 drop/end 双提交。排序及开合是 localStorage 偏好，与 Remote 默认合并，不修改 Team ledger；宽度 pointer capture、requestAnimationFrame、clamp 与 cleanup 是单 owner 的 transient 机。测试 `sidebar-order.spec.ts`、`sidebar-sections.spec.ts`、`panel-width.spec.ts`。可把取消/释放不变式就地命名，不新建排序领域。原生拖动不等于键盘重排已验收；若要新增键盘排序是明确 UX 功能，另立验收，不混入“零行为变化”。

### C17 新建 Member / Project 与导入｜保留｜高风险

`TeamAgentsPanel.tsx:165 provision`、`TeamProjectsPanel.tsx:150 submit`、`TeamAgentImport.tsx:10 TeamAgentImport`。closed/editing/submitting/refused/committed；变化后的表单对应新请求，不变请求重试保留身份。导入有 busy ref 和 generation，避免并发写与离开后晚到读取；新建成功后刷新 Host 投影、关闭并恢复 trigger，失败继续保留输入。Model/Member 可用性以远端校验为准，本地 disabled 只是避免错误操作。`team-mode-agents.client.spec.tsx`、`team-project-board.client.spec.tsx`、`team-project-panel-switch.client.spec.tsx` 相关创建旅程可定位。保留分域表单而非统一 CRUD generator，避免抹平成员创建与已有成员入 Workspace 的不同语义。

### C18 编辑对话框提交与提交后刷新｜局部显式化｜中风险

`team-dialog-save.ts:4 useEditDialogSave`，`TeamMemberEditor.tsx:338 AgentEditorDialog`，`TeamProjectsPanel.tsx:357 ProjectEditorDialog`。editing→saving→Host refusal/transport failure 或 committed→refresh→close；pendingRequest 使未改表单可复用 ID，invalidate 表示新 intent。**具体机会：目前 Host 成功后先清 pendingRequest，再 await onCommitted，整个过程共用 catch；因此“提交已成功，但刷新抛错”落到与“写失败”相同的 error 面。** 这是可确认的分支合并，不等于已复现用户事故：调用方可能内部吞掉刷新错误。建议先补局部 hook 断言，以 committed/refresh-failed 区分阶段，再决定只重试刷新、不重新写；不先改变 close 行为。当前 `team-member-editor.client.spec.tsx` 主要覆盖 ModelPicker，并不证明此故障路径已有测试。

### C19 行菜单、归档、Owner 与恢复｜保留｜中风险

`TeamAgentsPanel.tsx:282 AgentRow`、`TeamProjectsPanel.tsx:266 ProjectRow`、`TeamProjectOwners.tsx:44 write`、`TeamRowMenu.tsx`。menu closed/open、edit/archive confirmation、pending/error/accepted；recover/archive/owner add-remove 都先等待 Remote，不由 UI 直接更改成员或项目事实；归档请求可复用 ID，失败在当前行或 dialog 报告。Project owners 的权限/成员有效性仍由 Host 决定。`team-mode-agents.client.spec.tsx`、`team-owner-seat.client.spec.tsx`、`team-project-board.client.spec.tsx` 与 `agent-row-open-failure.client.spec.tsx` 是相关断言。保留公共 Menu/Modal 的焦点、Escape 与 dismissal，不复制一套弹层基础设施。

### C20 Member 模型目录与提醒｜局部显式化｜低至中风险

`TeamMemberEditor.tsx:31 sharedCatalog、66 ModelPickerField、224 MemberRemindersSection`。目录缓存/读取中/已知值 revalidate/失败可 retry，按 loader 共享并发读取；同步 throw 和异步 reject 均须从 loading 退出。菜单选择与 effort 是局部状态，不成为模型配置权威。提醒读取→显示 active projection→withdrawing→重读，Host 拥有取消与 schedule/时区含义，pending occurrence 文案不能误写成未调度。`team-member-editor.client.spec.tsx:33–90` 和 `team-member-reminders.client.spec.tsx` 覆盖。可就地命名“已有目录+失败”的组合，避免 future UI 把缓存成功与重新验证失败混成空列表；不改现有行为。

### C21 Human 身份、头像与环境检查｜局部显式化｜低至中风险

`human-identity.ts:47 TeamHumanIdentity`、`environment-check.ts:21 TeamEnvironmentCheck`、`avatar-image.ts:18 useAvatarImage`、`EnvironmentCheck.tsx`。首 subscriber 启动单共享 read；identity loading/ready/unavailable，失败保留上次值及 error；avatar loader 返回 null 或图片解码失败时退回 initial，broken 标志按 URL 隔离，换新 URL 可恢复；但 loader 抛错不在 profile 的 catch 内，见下述已复现机会。environment loading→ready(report 或无 report)，失败不无限 loading，已有报告不被覆盖；这是安装事实而非用户 profile。`human-identity.spec.ts`、`human-profile-seats.client.spec.tsx`、`team-member-avatar.client.spec.tsx`、`environment-check.spec.ts` 与其 client 测试覆盖。不可强行统一两类 failure 状态，环境无结果的低干扰降级是现有 UX 契约。

### C22 Settings 名称、头像与配置暂存｜保留｜中风险

`TeamSettingsSection.tsx:89` 的 name draft 明确为 follow/edited；保存名、上传/移除头像与 notice 各自协调，空名字/超限/非图片在本地拒绝，其余由 Host 判定。成功重新读共享 identity，所有头像 seat 收敛；不可提前只改某个组件名字。`team-config.ts:teamConfigScope、TeamConfigController` 复用 Harness SettingsFormModel：accepted/staged/invalid/saving/conflict 由公共 form owner 管，Team 只映射 memberCompaction 子路径，保留 expectedRevision 和 siblings。`team-settings.client.spec.tsx:64–190`、`team-config.client.spec.tsx`、`capacity.ts` 的 parse/format 测试是证据。保留公共暂存模型，不另加 Team Config store。

### C23 订阅展示、暂停恢复、删除与日志｜局部显式化｜中风险

`TeamSubscriptionsTab.tsx:52`、`:229 SubscriptionLogsDialog`、`:274 SubscriptionDeleteDialog`、`:317 RunRow`。列表 loading/error/empty/ready 与单卡 pending/failure 分离；paused/running/deleted 等业务状态只读 Host projection，操作携带 expectedRevision。脚本、日志、删除是独立对话框；日志展开只是 UI，withheld stdout/stderr 不等于空输出；删除失败留在确认框。`team-subscriptions.client.spec.tsx:87,134,170,211,233` 覆盖。可把互斥 overlay intent 合成局部判别联合，消除同时可开的理论组合，但未复现前不改打开/关闭行为；schedule/webhook/delivery lifecycle 不属于 Client owner，不在此重复造 FSM。

### C24 Message 展开、复制与菜单选择｜保留｜低风险

`TeamMessage.tsx` 的 clamp 展开、附件 image 读取/预览与复制提示，`TeamWorkspaceSelector.tsx:19`、`multi-menu-field.tsx:18 MultiMenuField`、`TeamRowMenu.tsx` 的 open/close/selected。事件来自键盘、pointer、共享菜单关闭与 props 更新；selected/导航和 durable message body 由上层/Host 提供，组件不推导领域事实。复制原始 Markdown、引用跳转传稳定 ref；正常的不可预览/缓存过期答复有文件 chip，不能将图片失败当作消息不存在；`TeamAttachment:534` 的 loader rejection 没有在此 effect 内 catch，未做额外复现，不将它算作已验证的恢复路径。`team-message.client.spec.tsx:458,556,619,656`、`team-mode-conversation.client.spec.tsx:739` 覆盖相关行为。保留简单局部状态与公共 primitives，二态开合无须为形式完整引入 reducer。

## 不应被“状态机化”的部分

一个组件渲染了 `active`、`unavailable`、`done` 的标签，不代表它拥有这些领域状态的转换权。`TeamPresenceDot`、`TeamStateDot`、`TeamOwnerSeat`、`BoardCardFoot` 只把 Host 投影映射到字形、文案与辅助技术标签；即使有多个 if 分支，也不能据此提议 Client 再维护一份 Member/Task 生命周期。头像组件有图片故障回退，但拥有者是共享的 `useAvatarImage`，不是每个外观组件各造一台业务机。

同样，`TeamConversation` 读取导航快照后选页面，`TeamSidebarSection` 和 `TeamThreadStartControls` 消费 controlled props；它们是上层机的投影，不应重复存储 selected/open。`capacity`、`thread-facts`、`team-separators`、多数 formatter 与 mention grouping 是确定性变换，虽然参与事件处理，其自身没有跨事件记忆；把每次函数调用描述成一个状态转换会淹没真正要保护的并发边界。`slots.ts`、声明文件和 locales 是契约或数据；CSS Modules 只定义样式，此次按要求纳入周边分类，但不算入 67 个 TS/TSX 的状态机数量。

## UX / DX / AX 一起保住的验收约束

1. **不可把失败都画成空白。** 首次读失败、已有数据时刷新失败、真的空列表、被 Host 隐去的输出是不同事实。页面可以复用同样的边框或警告样式，但不能把“尚不知道”写成“没有”。重试入口应作用于失败的 read，而不是附带创建或确认已读。当前身份、环境和订阅日志的失败面刻意不同，应先理解其产品含义，再讨论统一类型。
2. **不可把点击等同提交。** pending 可立即禁用重复操作并反馈进度；成员、Owner、Attention、Task 和消息的 durable 结果须等 Remote。只有 committed receipt 才能合并事实，才能清草稿或更新成功提示。UX 的辅助技术 live feedback 也必须说“正在发送”或 Host 的拒绝原因，不能先朗读“成功”再悄悄回滚。对错误码保持判别，不通过翻译后的错误字符串判断恢复路径。
3. **读进度与滚动位置分家。** 打开 Thread 和到达自动读由 Host bounded read 产生事实；滚动到底、引用跳转和三秒 arrival 标是观看便利，不是第二个 unread 模型。修改时间线必须分别验“正读旧消息”“在底部看新消息”“从 Inbox 定位未读 mention”“历史补页失败后再试”；只验 badge 数字不够，只看截图也不能证明 Host cursor 正确。
4. **导航位置可恢复，临时控制权不可误恢复。** 重载保留 Workspace/Project/Thread 与 discussion 位置是 UX 资产；Member Session overlay 和进行中的操作不该从旧存储凭空复活。异步 Session rollover 要再次检查当前 seat，而不是只用发起读取时闭包里的选中值。对话框关掉后不能因为晚到目录结果再次抢焦点，正常 DSH 模式不能受 Team 的槽位残留影响。
5. **本地状态应贴近副作用 owner。** Composer 订阅 draft，输入不必让所有 timeline entry 重绘；query owner 管并发合并与版本，页面 owner 管 mounted/位置，Host 管 durable 权限与 idempotency。为了缩短组件而把它们塞进一个“大 reducer”，通常只把跨层约束藏得更深。真正可读的显式化是对事件、guard、结果与清理命名，而不是把全部布尔值换成框架术语。
6. **公共 primitive 承担已有的 UX 可访问性交互状态机。** Menu/Modal 的 focus、Escape、outside-dismiss 由 Harness 承担；Team 保持 label、disabled、error、pressed 与 active-descendant 的语义。不要为了“统一”改成 div/button 自制弹层。若改 mention 机，必须同时验中文 IME、上下选择、空结果、Escape、回车发送及触屏；若新增键盘拖排，须明确宣布新增能力而非声称纯重构。
7. **清理是终态，不是遗漏的分支。** scope 最后一个 listener 离开要释放 stream，hook 卸载要拒绝晚到 UI 更新，预览 URL 与帧/计时器有对应释放；但不要未经证据把每个不支持取消的 Remote 改成取消协议。共享 read 仍可能被其他消费者需要，取消单页不能伤到别的 seat。释放与“旧结果忽略”是不同机制，两者都必须由实际 owner 负责。

8. **AX 保持 Agent 可理解的领域协议。** Client 展示名称、排序、缓存和动画不得改写稳定 branded ref 或 Host 语义；Attention、已读、权限、revision 与 idempotency 仍以 Host 为准。Agent 消费的结果须能区分 committed、unread_required、stale_revision 与传输失败，使其理解应先读、刷新后重试，还是操作已提交而只需恢复读取；不依赖 DOM、ARIA 文案或本地 UI 状态猜测领域事实。DX 的局部显式化应让后续 Agent 修改代码时也能找到唯一 owner 和恢复路径，而不是创造第二套权威。

## 推荐顺序与不回归门槛

**第一优先是 C21 已复现的头像读取拒绝边界。** `human-identity.ts:79 read` 的 try/catch 只包住 loadProfile，`:94` 再 await avatarUrlFor，`:110` 的 loadAvatarUrl rejection 直接逃出。用 Node 原生 TypeScript stripping 在 stdin 中构造成功 profile（带 avatarRef）和拒绝的 avatar loader，调用 refresh 并捕获拒绝；实际输出为 `refresh=rejected`、`snapshot.status=loading`、`snapshot.name=undefined`。未改任何源码或测试文件，未订阅以免产生未处理拒绝；生产 subscribe 的 `void refresh()` 则同样没有把该失败转为 ready/unavailable。此处名字本已读到，却因装饰性头像 transport 失败无法提交快照，明确违背“不可读头像退回 initial”的正常降级意图。已有 `human-identity.spec.ts:86` 只覆盖 profile loader 的 carrier throw，不覆盖 avatar loader throw。建议未来加该最小单测并在身份 owner 内隔离 avatar 读取异常，让已成功 profile 可呈现、图片降级且后续刷新可重试；不动 Host、权限或持久化。当前只交付审计，未实施修复，真实浏览器表现仍待主代理验收。

**C18 的提交与刷新分界。** 设计复核以 Team `4af67bb2` 为准：`TeamAgentsPanel.tsx:123–137` 和 `TeamProjectsPanel.tsx:74–99` 把 Remote 返回的读取错误留在面板，Project 仍应用成功的一侧；抛异常时才会进入 `team-dialog-save.ts:25–33` 的保存错误分支。Harness `66491b05` 的 `api/gateway/src/client/index.ts:454–473` 通常把网络错误转成 Remote 结果，但无活跃连接等准备失败可抛出。应从实际对话框验证两条路径；hook 实验不能证明用户会看到保存失败。

再后是 C15 的滚动实证：读取当前 Preview 中同一 Thread 的 scrollTop 与目标行矩形，分别执行尾部新到达和头部补历史。它们都增加高度，但保持观看位置的算法不同。现阶段只有可疑条件，材料明确保留未证实，不把它写成已知缺陷；若浏览器和布局实际保持正确则不改。最后才是互斥 dialog intent 和 catalog state 的类型整形，它们应以现有交互完全不变为验收，不以代码行数下降为成功标准。

本材料没有发现需要立刻用大型 FSM 库替换现有 Client 的证据。现有共享 query、scope 流和 Thread controller 已经形成较深的模块；最容易回归的反而是把它们“统一”成一个忽略 requestId、revision、baseline 和页内 seat 的普通异步 hook。未来实施应按具体已复现问题成小步提交，保留现有测试，并由主代理对真正受影响的组件与组装 Web 旅程做当次验证。

## 完整文件覆盖（67/67）

枚举包含 65 个 Client 文件与 2 个包级入口/声明文件；以下每个文件均完成符号及状态/异步扫描，有真实协调行为者再归到上述逻辑机，纯组件、纯函数和契约明确单列。没有把类型、样式或常量计作独立机器。

| 相对 `packages/client-agent-team/src/` 的文件 | 归属与性质 |
| --- | --- |
| `client/BoardCardFoot.tsx` | C07；纯投影，无转换权 |
| `client/EnvironmentCheck.tsx` | C21；环境报告渲染，无独立机器 |
| `client/TeamAgentImport.tsx` | C17；导入读取与写入守卫 |
| `client/TeamAgentsPanel.tsx` | C04/C06/C17/C19；列表、创建、行操作与换代跟随 |
| `client/TeamAvatarStack.tsx` | C21；装饰呈现，图片回退委托共享钩子 |
| `client/TeamComposer.tsx` | C05/C13/C14；输入、候选、文件与草稿订阅 |
| `client/TeamConversation.tsx` | C04；导航投影路由，无平行导航状态 |
| `client/TeamCountBadge.tsx` | C07；纯计数与可访问标签 |
| `client/TeamInboxPage.tsx` | C07；聚合读取与跳转 |
| `client/TeamMainStream.tsx` | C10/C14/C15；主流发送与定位 |
| `client/TeamMemberAvatar.tsx` | C21；头像/在线投影，无 Member 生命周期 |
| `client/TeamMemberEditor.tsx` | C18/C20；编辑、共享目录、提醒 |
| `client/TeamMemberRow.tsx` | C19；受控行/错误渲染，无自主业务转换 |
| `client/TeamMessage.tsx` | C14/C24；展开、复制、引用、图片预览 |
| `client/TeamOwnerSeat.tsx` | C19/C21；纯 Owner 投影 |
| `client/TeamPanelHandle.tsx` | C16；宽度拖动与键盘调整 |
| `client/TeamPanelIcon.tsx` | 纯图标，无状态机 |
| `client/TeamPresenceDot.tsx` | C21；状态翻译与提示，不拥有在线转换 |
| `client/TeamProjectOwners.tsx` | C19；Owner 写入与拒绝 |
| `client/TeamProjectPage.tsx` | C06/C10/C15/C23；投影、主流、侧面板和订阅 |
| `client/TeamProjectPanel.tsx` | C08/C09/C11/C15；discussion 消费共享 Thread 协调器 |
| `client/TeamProjectsPanel.tsx` | C06/C17/C18/C19；项目列表、创建、编辑、归档 |
| `client/TeamRowMenu.tsx` | C19/C24；委托公共菜单原语 |
| `client/TeamRunDivider.tsx` | 纯分隔渲染，无状态机 |
| `client/TeamSettingsNavIcon.tsx` | 纯图标，无状态机 |
| `client/TeamSettingsSection.tsx` | C21/C22；身份和配置编辑 |
| `client/TeamSidebarSection.tsx` | C16；受控开合渲染，不重复存储 |
| `client/TeamStateDot.tsx` | 纯状态字形，无转换权 |
| `client/TeamSubscriptionsTab.tsx` | C23；操作、脚本、日志、删除确认 |
| `client/TeamTaskBoardPage.tsx` | C07；跨 Workspace 看板聚合 |
| `client/TeamThreadCard.tsx` | C07；纯卡片与受控跳转，无领域机 |
| `client/TeamThreadPage.tsx` | C08/C09/C11/C12/C15；Thread/Task 表面协调 |
| `client/TeamThreadStartControls.tsx` | C14；受控发送模式，不另存选择 |
| `client/TeamWorkspaceBrowser.tsx` | C04/C06/C07/C16；侧栏组合与加载 |
| `client/TeamWorkspaceSelector.tsx` | C24；工作区选择菜单 |
| `client/attachment-preview.ts` | C14；附件缓存；字节编码/大小格式为纯函数 |
| `client/avatar-image.ts` | C21；按图片地址隔离解码故障 |
| `client/capacity.ts` | C22；纯解析/格式化，无状态机 |
| `client/drafts.ts` | C05；浏览器草稿 store |
| `client/environment-check.ts` | C21；共享安装事实读取 |
| `client/human-identity.ts` | C21；共享身份投影 |
| `client/index.ts` | C01/C02/C03/C04/C21/C22；Client 激活与接线 |
| `client/locales.ts` | 本地化数据/表单标签映射，无状态机 |
| `client/main-stream.ts` | C10；合并、已读和短时到达标记 |
| `client/mention-presentation.ts` | C13；纯候选排序/分组，无状态机 |
| `client/multi-menu-field.tsx` | C24；局部菜单开合与受控选择 |
| `client/navigation.ts` | C04；浏览器位置与临时 Session overlay |
| `client/panel-width.ts` | C16；偏好读写与纯宽度约束 |
| `client/refs.ts` | C14；解析缓存与稳定 ref 跳转 |
| `client/requests.ts` | C14；请求身份和顺序上传协调 |
| `client/sidebar-drag.tsx` | C16；原生拖放和单次提交 |
| `client/sidebar-order.ts` | C16；浏览器顺序与 Remote 默认合并 |
| `client/sidebar-sections.ts` | C16；浏览器分区偏好 |
| `client/slots.ts` | 类型与 Cordis 公开槽位契约，无运行时机器 |
| `client/team-changes.ts` | C02/C08；变更流与已读刷新通知 |
| `client/team-config.ts` | C22；委托公共暂存模型与路径映射 |
| `client/team-dialog-save.ts` | C18；编辑提交协调 |
| `client/team-formatters.ts` | 纯投影、Markdown、mention/文案辅助，无转换权 |
| `client/team-mark.ts` | 图标几何常量，无状态机 |
| `client/team-queries.ts` | C03；共享查询 owner |
| `client/team-separators.ts` | 纯时间/段落/卡片布局变换，无状态机 |
| `client/thread-actions.ts` | C12；关注与转交 |
| `client/thread-controller.ts` | C08/C09/C11/C15；Thread 页内协调 owner |
| `client/thread-facts.ts` | 纯事实键、合并、排序、mention 定位，无状态机 |
| `client/timeline-scroll.ts` | C15；观看位置协调 |
| `css-modules.d.ts` | CSS 模块类型声明，无运行时状态 |
| `index.ts` | Host 空适配入口；无 Node 行为，无状态机 |

## 本次验证与未完成项

已核对基线提交、源文件总数、上述 owner/关键分支、相关测试名称与行号，并机械核对覆盖表无遗漏。额外用 Node stdin 做了一次 C21 最小故障注入，成功复现头像 loader 拒绝后身份仍停在 loading；没有创建测试文件。只写本材料，没有修改生产源码、测试或维护文档，也没有提交。并行 worktree 中其他代理的改动不属于本审计，未撤销、未整理。2062 通过是父任务给定的基线，本次未重跑；没有以测试索引阅读冒充执行结果。

未完成的是建议的正式回归测试、其他故障注入、真实滚动复现和任何实施后的浏览器验收；这不是当前文档审计的阻塞。若父任务只交付审计，可在明确这些边界后结束；若要改动 Client，则由主代理在整合后启动/使用受管 Preview，覆盖 Team 项目页、Thread、Inbox、成员编辑、设置和订阅，保留普通 DSH 恢复，并检查桌面与 390×844、焦点/键盘、加载/错误/空态。测试构建不能替代外观验证。
