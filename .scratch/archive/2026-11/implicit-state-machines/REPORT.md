# 应用隐式状态机全面审计报告

**日期：** 2026-11-10

**基线：** `7076dbd2578641ef5b20a773a8191a7178d1b937`；审查包含随本报告提交的修复。

**目标：** 同时改善 UX（用户体验）、DX（开发体验）、AX（Agent Experience，Agent 体验），保留现有行为与权威边界。可访问性是 UX 的必要部分，但不以 accessibility 代替本报告的 AX。
**性质：** 源码/测试证据驱动的审计与最小修复，不是形式化验证，不把历史文档或本报告当实现规范。

## 1. 结论先行

**最优决策不是全仓引入 FSM 框架，而是保留已有的深 module 与唯一权威，只修复已复现的转移错误。** 当前应用已经有明确的 ledger、纯决策器、Session reducer、共享 query、scope stream 和生命周期队列。最大的风险不是“缺少状态枚举”，而是混淆意图与生效、接收与完成、提交与刷新、通知与消费、版本与可见性。

本次实际交付：

1. 完成三个 package 的 **129 个 TS/TSX 源文件**责任归属/状态与异步符号盘点：Host 56、工具6、Client 67；高风险协议细读关键分支与相关测试。逐文件索引见 [COVERAGE.md](COVERAGE.md)。这不等于129个文件都有状态机，也不等于所有异步交错都已执行。
2. **修复两处已复现取消错误：** 读取容量查询吞掉取消；备用摘要被取消却错误打开路由断路。生产代码合计新增3行守卫，各自先红后绿；正常降级/摘要失败策略不变。
3. **修复初始化：** `scripts/hoplite-setup.sh` 默认给予 Node 4096MiB 堆，保留显式 `NODE_OPTIONS`，中英环境文档同步。`.hoplite/settings.json` 已正确调用此脚本，无需修改。
4. **明确不做：** 不引入 FSM 依赖、不新增 Team/已见/成员关系状态仓、不修改相邻 Harness、不改 UI、不恢复已撤下的旧工具或 slash-command adapter。
5. 收录待验证风险及下一步验收，不把静态可疑分支说成用户事故，也不把建议说成已经实现。

## 2. 方法、范围与证据等级

### 2.1 什么才算状态机

状态机至少有跨事件保留的信息、事件、合法转移/守卫及效果。此次按**生命周期和恢复边界**分组，不按 `useState`、Map、Set 或 union 数量计数；状态名是审计记号。

| 类别 | 示例 | 本次处理 |
| --- | --- | --- |
| 持久领域协议 | Member、Task、Claim、Attention、request receipt | 列出合法转移、原子关联效果与重放约束 |
| 隐式异步/资源协议 | 生命周期 promise 链、摘要重试、上传、关闭、stream | 列出等待、失败、取消、晚到与 cleanup |
| Session 派生 reducer/cache | continuity、cold Inbox、event cursor | 明确可重建，不新增 durable authority |
| 浏览器偏好/局部交互 | 草稿、导航、菜单、IME、拖动 | 保留局部 owner，不升级成业务事实 |
| 纯决策/投影/类型 | Task status、formatter、schema、CSS、图标 | 作为 guard/表示登记，不虚构独立机器 |

源码与测试优先，维护文档用于理解边界，`.scratch` 只保存调查。generated `lib`、依赖内部及 Harness 全产品不属于此次应用源码覆盖；只核对必要公共接缝，不擅改其实现。

### 2.2 证据不能混用

- **已执行复现：** 两个取消问题都有 failing regression，最小修复后重新通过。
- **局部实验记录：** Client材料C21另记有子代理的Node stdin头像loader拒绝实验；未纳入最终集成回归、未实施修复，真实浏览器表现未验证，不与上述红绿回归混为同等证据。
- **已静态确认：** 例如 paused 仍可发布已接受事件、ledger 是唯一事实权威、编辑保存与刷新共用 catch；不等于已出现事故。
- **待验证风险：** 例如跨表迁移故障窗口、滚动锚定、send 响应丢失后的附件重试；列出所需证明，不猜结果。
- **现有测试锚点：** 各材料的文件/行号用于定位；只有第8节的实际命令结果才是本次执行证据。行号以基线为主，新测试会使后续行漂移，应同时按符号查找。

## 3. 必须守住的权威地图

```text
Human Client / Member tools
           │ typed request + stable refs + requestId + revision
           ▼
Team Host ── ledger commit ──► Team facts / projections
   │            │
   │            └─ 可重放，关联清理与责任变更是同一 operation
   ├─ Session events/files ──► context、continuity、private memory
   ├─ durable admissions ────► HTTP 202 后仍欠执行的外部工作
   └─ runtime handles/queues/timers ──► 可释放、可重建的执行协调
           │ invalidation（可合并，不是另一条业务账本）
           ▼
Client query cache / local drafts / navigation / transient interaction
```

关键区别：

1. **配置已保存 ≠ live 能力已应用。** ledger intent 与 runtime proof 分开；失败不能假报生效。
2. **HTTP 202 ≠ 脚本成功 ≠ 输出已接受 ≠ 已发布 ≠ 已写诊断。** admissions/replays 是恢复承诺，不能当可随手清理的日志。
3. **当前看得到 ≠ durable 已读 ≠ revision 新鲜。** surface 豁免只放行本次写，仍需 revision fence，不消费 unread。
4. **入通知队列 ≠ turn claimed ≠ consume 落盘。** 崩溃允许同一 occurrence 重送，不承诺 exactly-once wake。
5. **Host commit 成功 ≠ Client refresh 成功。** 不得因后续呈现失败鼓励再次提交业务写。
6. **Task status 是 resolution 与 Claims 的派生。** 不能让 UI 独立写 todo/in_progress/in_review，或用某个标签反推完整领域事实。
7. **projection sequence ≠ presence epoch ≠ Client request issuance。** 三种版本不可相互比较。

## 4. 全域逻辑机清单

下表是导航摘要；每组的状态、事件、guard、权威、副作用、重启/失败语义和测试锚点见链接材料。计数有跨层观察同一流程的重叠，不把各域数字相加宣称“独立 FSM 总数”。

### 4.1 持久领域与可重建投影：19组

详细证据：[materials/domain.md](materials/domain.md)。

| 编号 | 逻辑机/协议与关键转移 | 权威/最重要守卫 | 裁决 |
| --- | --- | --- | --- |
| D01 | 初始化→规则采纳→提交/receipt→重放 | append-only ledger；同 requestId 不可换 payload，先持久再 apply | 保留 |
| D02 | invariant pending/检查/故障闩锁/清理 | 进程监控；pending 与 latched 可并存，mount 重验 | 保留 |
| D03 | Member enabled↔suspended；→archived/inactive | ledger；退出原子释放 Claim/责任/Attention，archive 无 restore 入口 | 保留 |
| D04 | Workspace participation 加入/退出 | default 不可 leave，不迁 Session，范围清理不能误伤其他 Workspace | 保留 |
| D05 | Project active→archived | 归档保历史、阻新写，关联清理同 operation | 保留 |
| D06 | owner grant/revoke | Human 固有权限；revoke 不等于 unfollow，责任资格另判 | 保留 |
| D07 | Session 绑定旧代→新代 | Host-only，旧绑定精确匹配；旧 transition 类型有 replay-only 部分 | 保留兼容 |
| D08 | discussion Thread→Task-bearing Thread | 单向 promotion，保持 Thread ref，权限/unread/revision fence | 保留 |
| D09 | Task open/accepted/closed；责任转移 | status 派生；Agent 不能验收自己曾持 Claim 的工作 | 保留；纯规则可局部归拢 |
| D10 | Claim 新建 active→done/released | direction active 占用唯一；终态不原地复活，只能新 Claim | 保留 |
| D11 | Thread Attention 建立/撤销/新关注期间 | 自有 active Claim 时不可 unfollow；direct marker 可独立存在 | 保留 |
| D12 | Main Attention 建立/撤销 | 与 Thread 独立；Human 固有 Main Attention 不可 unfollow | 保留 |
| D13 | Thread 有界 read/连续水位/稀疏 marker 消费 | 队列内选完整前缀；旧 direct marker 不倒退水位；no-op 不写 | 保留 |
| D14 | Main read/普通与稀疏未读合并 | 不顺带确认 Thread 正文；private read 不推进共享投影版本 | 保留 |
| D15 | Task reminder baseline→raised→消费 | planner 无状态；episode 在 ledger，同 baseline 不反复造提醒 | 保留 |
| D16 | Member reminder active→done/cancelled；occurrence 替换/消费 | reminderRef+occurrence sequence，旧通知不吃新 occurrence | 保留 |
| D17 | context intent/checkpoint/携带输入 fold | Session events；匹配真实 tool call，同 turn/end 才释放 | 保留 |
| D18 | cold Inbox splice fold | 越界/重复身份 fail closed，合法空与不可重建分开 | 保留 |
| D19 | event cursor 冷起→增量→失配重建 | Session/fork/anchor 边界；不是完整日志内容完整性证明 | 保留 |

**不另造机器：** Project membership 是参与资格的派生，历史 membership operation 不意味着当前仍有 CRUD writer；surface visibility 是严格 guard，不能变成持久 seen 表。退出/归档与责任图清理不能拆成多次独立提交。

### 4.2 Member 执行、预算与连续性：9组及4类 helper

详细证据：[materials/member-runtime.md](materials/member-runtime.md)。

| 编号 | 关键状态/事件 | 效果与恢复约束 | 裁决 |
| --- | --- | --- | --- |
| M1 | 能力意图→工具/技能挂载→新意图待应用→成功/保旧面 | applied proof 区分未知与已应用 undefined；失败保留 durable 新意图 | 保留局部 owner |
| M2 | turn boundary 无需等待/等待→settled | 非 running、Session disposed、Host shutdown 释放；不等于应用成功 | 保留 |
| M3 | private memory 未准备/legacy/twin→目录可用→移除 | 不覆盖现有 memory；archive/rm 部分失败可报告，非原子清理 | 保留 |
| M4 | frozen route→assemble/prepare→prune/compact→clamp→header证实 | 计 pending input/真实 prompt/tools；abort 不复活输入；clamp 不粘住 | 保留 |
| M5 | primary summary→最多一次 alternative→成功/degraded | 取消不记能力失败；route断路与 step补试预算不同 | **补试取消已修复** |
| M6 | memory/context 读取→新鲜度判定→注入/保持 | 文件权威与当前 surface 分开，不用旧快照替代最新内容 | 保留 |
| M7 | transition lock→settle/换代/continuation恢复 | settled 不等于 activation成功；回读绑定，稳定身份防多造代 | 保留 |
| M8 | idle 首次观察→running/error/forget 清除 | 进程观察，重启空，时钟回退夹零，不替代 durable activity | 保留 |
| M9 | 当前 generation 时间上下文事件 fold | 不沿用祖先/前代时间基线，游标属当前 Session | 保留 |

无自身 durable 状态的 helper 为 wake-recycle 决策、reminder schedule/候选、stored-session 读/close/错误分类、context source/codec。它们是深 module 的内部接缝，不应为“统一”变成四个新 store。

### 4.3 Host 总协调与工具：8组

详细证据：[materials/host-and-tools.md](materials/host-and-tools.md)。

| 编号 | 流程 | 不可删的不变式 | 决策 |
| --- | --- | --- | --- |
| H1 | init→serve→drain→close | 停准入/等在途/释放等待与timer/排空链后才能关store | 保留 |
| H2 | 每Member生命周期 promise链 | 同key可重入，不同key隔离，失败不毒尾，旧tail不删新tail | 保留 |
| H3 | changes 注册→baseline→合并唤醒→注销 | 先订阅后yield；版本分域；流不是业务事件权威 | 保留 |
| H4 | durable欠账→notice覆盖→queued→claimed/discarded→重导 | coverage不是read；消费写失败仍owed，有界重试 | 保留 |
| H5 | recovery episode→timer/wake→stood-down/clean清除 | 有界、按Member隔离、dispose取消timer，不无限花turn | 保留 |
| H6 | SQLite opening/usable/failed/closing/closed | 同名unit同步占位；close幂等；单次写不等于跨写事务 | 保留vendor约束 |
| T1 | 参数/寻址→Host请求→结构化结果/恢复 | 稳定ref/requestId；多Workspace不猜；DM已记账不等于wake成功 | 保留 |
| T2 | 容量→分片预览→确认完整前缀→输出 | history/message不确认；取消不能退默认容量 | **取消已修复** |

### 4.4 订阅、Webhook 与外部资源：8个责任分组

详细证据：[materials/subscriptions.md](materials/subscriptions.md)。这些分组含多个正交状态，并非8个互斥 enum。

| 分组 | 转移/守卫/恢复 | 裁决 |
| --- | --- | --- |
| S1 调度与统一 admission | start/tick/drain/stop；全局4槽、每ref至多1执行；trial与run门禁不同 | 保留 shared admission |
| S2 accepted→published | 独立发布、限流、失败保pending；paused仍可发布，deleted/archived阻止 | 不把执行/发布合并 |
| S3 HTTP intake与持久队列 | request一次性settle；put成功才202；body/token/容量门禁；重启续队列 | 保留承诺边界 |
| S4 执行/自动重试/人工replay | 冻结接收定义；heldEvents仅重试accept；replay先写intent；重读终态门禁 | 保留；优先核实跨写窗口 |
| S5 更新检查cache | unknown/旧值 × fresh/stale × idle/inFlight；single-flight，失败保旧值 | off契约先澄清，不擅改 |
| S6 设置迁移/环境判定 | 新字段优先、历史安全迁移；环境verdict是纯分类不是持久生命周期 | 不造迁移布尔store |
| S7 附件/头像文件 | prepare bytes/meta→切引用→GC/旧entry清理；半写与commit分开 | 保留；韧性风险登记 |
| S8 schema/解析/恢复话术 | snapshot/hash/输出解析/恢复registry是纯转换或契约 | 不独立状态机化 |

特别注意：**撤 Webhook trigger 不撤已202接收工作；paused 不等于取消已接受结果；外部脚本副作用不承诺 exactly-once。** admission schema 的 running 与 replay intent running 不是一回事，当前生产写点不能仅从 enum 推断。

### 4.5 Client：24个局部逻辑机/协调器

详细证据与67/67文件表：[materials/client.md](materials/client.md)。所有 durable mutation 仍由 Host 确认，局部 success 不提前造领域事实。

| 编号 | 流程与关键恢复 | 裁决 |
| --- | --- | --- |
| C01 | Remote可用→slot注入→Team mode→释放/普通DSH恢复 | 保留公开inject/children所有权 |
| C02 | scope共享stream、失效重开、首项baseline、dispose | 保留；transport重连归Harness |
| C03 | query合并/失效/issuance/generation/晚到丢弃 | 保留；不混presence与projection版本 |
| C04 | 导航/Session overlay/返回/换代跟随 | 保留；先确认打开成功，不偷走用户已离开的seat |
| C05 | 草稿空/有值/清空/恢复/淘汰 | 保留；仅commit后清，不随导航丢失 |
| C06 | 首读loading/loaded/后台刷新/带旧值失败 | 保留；不把失败画成空列表 |
| C07 | 跨Workspace Inbox/Board聚合/部分失败/重试 | 保留；Inbox列表本身不确认已读 |
| C08 | Thread bounded read→续读drain→完成/不前进/上限 | 保留；fresh requestId、最多50轮、防自旋 |
| C09 | 被动到达/历史/补充投影/失败可再点 | 保留；历史不冒充新到达，失败不清hasMore |
| C10 | Main history/read/合并/短时arrival mark | 保留；3秒标记不是durable unread |
| C11 | 回复/Task写 idle→pending→commit或fence | 保留；草稿/文件失败保留，Host回执后合并 |
| C12 | Attention follow与Task transfer | 保留；拒绝后读刷新，不盲目重写 |
| C13 | Composer mention/光标/候选/IME/附件预览 | 保留局部状态；键盘与IME是UX验收 |
| C14 | 上传→发送、引用读取/cache/预览 | 延后故障注入；不先改请求身份协议 |
| C15 | 时间线 pinned/unpinned/定位/prepend/append | 延后真实浏览器锚定实证，不凭静态疑点改滚动 |
| C16 | Sidebar drag/drop/cancel/单次commit/宽度 | 可就地显化cleanup，不新增排序领域 |
| C17 | 创建/导入editing→pending→refused/committed | 保留；不变表单重试复用身份，失败保输入 |
| C18 | 编辑save→Host committed→refresh→close | 优先验证commit与refresh失败分界 |
| C19 | 行菜单/归档/Owner/恢复 | 保留公共Menu/Modal；不乐观改事实 |
| C20 | 模型目录cache/revalidate/error；reminder撤销 | 可局部命名旧值+失败组合，不造配置权威 |
| C21 | 身份/头像解码/环境报告共享read | 保留不同降级；头像loader拒绝的局部实验另列后续风险 |
| C22 | Settings草稿/staged/invalid/saving/conflict | 保留Harness form model与expectedRevision |
| C23 | 订阅列表/单卡pending/日志与删除dialog | 可局部互斥overlay intent，不复制Host scheduler |
| C24 | Message展开/复制/图片/菜单选择 | 保留简单局部状态，无需FSM库 |

纯图标、badge、status dot、controlled props、locale、formatter、fact merge、CSS与声明不拥有领域转换权，不重复计数。“局部显化”是未来具体修改时的方向，不代表本次已重构。

## 5. 已修复问题与 UX / DX / AX 收益

### F1 — 读取取消被容量降级吞掉

**源码：** `packages/tool-agent-team/src/reading-budget.ts:7–23`；调用接缝为 `index.ts` 中 `team_thread` 容量查询及read preview selector。

原路径在预取消但无metadata时直接返回默认容量；metadata await期间取消的异常若不匹配特定 `LlmError('aborted')`，catch也会降级。await后已有检查仍可被自己的catch吞掉。现只在入口与catch降级前检查signal，保留调用者reason。普通metadata故障仍保守降级，已知窗口仍预留16384。

新增五项回归；原实现3项失败，修复后五项通过，并与寻址/拒绝测试共22项通过。测试证明capacity取消语义，不冒称端到端所有取消时刻都可撤销已提交read。

- **UX：** 停止请求不会因fallback继续正常阅读路径。
- **DX：** 取消与可容错metadata失败区分，异常语义一致。
- **AX：** Agent取消不被伪装成成功容量答复；不继续调用后续Host read/ack分支。

### F2 — 备用摘要取消误打开route断路

**源码：** `packages/agent-team/src/member-compaction-engine.ts:83–114`；测试 `member-compaction-flow.spec.ts` 的新增 alternative cancellation 用例。

primary catch原有取消保护，alternative catch却直接 `recordFailure`。新用例在第二次摘要时真实cancel Agent，原实现 `degraded` 得到true；现alternative catch先检测aborted并重抛，不记录route失败。使用truthy检查避免TypeScript沿用第一次catch的false窄化而报TS2367，不用类型断言绕过。

回归同时证明turn为aborted、degraded=false、无summaryFailure残留，以及下一轮同route仍能摘要并completed；该文件37项通过。真正摘要失败仍按原有有界补试/断路处理。

- **UX：** 人为停止不导致下次摘要莫名不可用。
- **DX：** 主/备用取消出口一致，现有真实请求seam可锁定回归。
- **AX：** caller cancellation不污染模型能力判断，不逼Agent无谓换route或人工compact。

### F3 — 初始化失败与 `.hoplite` 的结论

原失败位于相邻Harness的Client编译，直接现象为Node堆耗尽；不是缺API key、端口问题或 `.hoplite` 的setup命令错误。实际入口是 `.hoplite/settings.json → sh scripts/hoplite-setup.sh`。

脚本新增 `export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"`：未设或空值默认4096MiB，显式值完整保留。此前已重跑完整setup成功；本轮另检查shell语法与unset/empty/explicit三种分支。环境文档中英同步，不改Harness、不改loader/peer版本、不升级依赖。**无需修改 `.hoplite/settings.json`。** 若操作者显式指定过小堆，脚本尊重它，不暗中覆盖。

## 6. 风险登记：不是已修复清单

| 优先级 | 已有证据与不确定点 | 最小下一步/验收 | 本次决策 |
| --- | --- | --- | --- |
| P1 恢复承诺 | 已静态确认retry耗尽先持久删除admission、再独立写failed delivery；内存锁无回滚，公开Domain无跨表事务，未发现保证恢复本次payload的其他内部durable来源 | 在现有Host seam让failed-delivery写失败；重启后已202工作仍能自动续作或供owner恢复，且不重复已accepted结果 | 已定位非原子恢复缺口；实际丢失结果待故障注入，未改迁移协议 |
| P2 身份读取 | Client材料C21记录子代理用Node stdin拒绝头像loader后identity仍停在loading；不是最终集成回归或浏览器证据 | 正式回归隔离avatar失败，确认profile可呈现、initial降级与后续刷新重试，再做浏览器验收 | 本轮未修改Client，保留实验来源与待验证边界 |
| P2 提交/呈现 | `useEditDialogSave`清pendingRequest后await onCommitted，共用catch；刷新失败可能被显示为保存失败，但调用方可能吞refresh错误 | save成功、refresh拒绝；证明下一步只刷新不重复业务写，且真正写失败仍可重试 | 不改UI，不将分支合并说成已复现事故 |
| P2 观看位置 | unpinned时scrollHeight增长补偿未显式区分prepend/append；浏览器anchoring可能已保证正确 | 当前Preview测“读旧消息时尾部到达”和“加载更早”，检查scrollTop/目标行矩形 | 无浏览器实证，不改算法 |
| P2 上传/发送 | upload与send请求身份生命周期不同，响应丢失可能重复准备附件；不能仅从Client推断消息重复 | 注入upload成功/send响应丢失，确认Host幂等与重试/孤儿回收 | 不改协议/不声称exactly-once |
| P3 更新关闭契约 | off阻后续refresh，但已有cache/在途迟到结果仍可见 | 先确定off是网络开关还是撤销/隐藏，再加settlement测试 | 现行语义自洽，保留 |
| P3 模型/兼容 | admission schema可含running，当前写点未生成；replay running是另一机器 | 确认兼容来源/恢复政策后再决定保留或收窄 | 不凭enum删兼容态 |
| P3 文件韧性 | payload/meta分写、破损sidecar、未引用头像清理 | 若有故障/容量证据，再做原有IO seam单点失败测试 | 不引入跨文件事务或新GC框架 |

P1/P2是后续验证顺序，不是宣称安全漏洞、线上数据丢失或已发生用户故障。P1的非原子写序与存储契约已核实，但没有执行中间失败点/重启的故障注入；不能用正常重启测试排除该缺口。详细调用点与证据强度见订阅材料末尾追加核实。F2原风险已转为第5节已复现修复，不留作“未验证”。

## 7. 决策规则与后续实施门槛

### 立即保留

- ledger唯一权威、原子责任图、规则版本与历史重放；schema版本≠行为规则版本。
- 稳定branded refs、requestId与payload绑定、revision/unread fence的顺序。
- 纯决策器和可重建reducer；内存队列/缓存不变成durable事实。
- 非乐观durable mutation、真实失败原因、输入/草稿保留、可执行恢复提示。
- Harness公开Remote/slot/settings/transport资源所有权；Team只拥有自己的effects。

### 仅在真实问题接缝局部显化

可以用小判别联合、命名清楚的结果/事件或纯transition plan，消除某个owner内部确实无效的组合；先有可失败测试，再改最小分支。每个实施切片必须同时证明：用户行为/反馈更准确、维护知识更集中、Agent接口与恢复更可理解。不能只凭代码行数或“更像FSM”立项。

### 明确延后

统一FSM/actor运行时、全仓reducer迁移、统一万能async hook、独立membership/seen/config store、对旧兼容态的清扫、把所有失败统一成error/empty、外部副作用exactly-once承诺。本次没有证据证明它们同时改善三种体验，反而扩大回归面。

### 未来有UI修改时的验收

需组件检查与 `npm run test:browser`，检查新鲜桌面及390×844截图、键盘/focus/IME、Menu/Modal语义、loading/error/empty、Team退出后的普通DSH恢复；滚动/重试/已读等行为另做交互验证。**本次没有UI修改，未运行新Preview/浏览器验收，不把历史截图或单测当视觉证据。** 真实模型行为、网络不确定与进程崩溃组合也未穷尽验证。

## 8. 执行验证与交付状态

最终代码的typecheck与完整suite均已完成并返回 exit 0。以下记录针对两项取消修复后的最终代码，不沿用修改前绿灯；本轮审计、最小修复与验证已完成。

| 检查 | 当前证据 |
| --- | --- |
| 阅读取消红→绿 | 原实现5项中3项失败；修复后相关3文件22项通过 |
| 备用摘要取消红→绿 | 新用例原实现degraded=true导致失败；修复后flow文件37项通过 |
| setup完整执行 | 前序修复阶段已成功；本轮未重复执行重型依赖安装/编译 |
| setup shell与选项 | `sh -n`通过；unset/empty默认值、explicit保持值均通过 |
| 最终typecheck | `npm run typecheck` exit 0，包含生成typed Remote与三个package及scripts的TypeScript检查；直接 `=== true` 的TS窄化报错已通过truthy guard修正 |
| 最终npm test | exit 0；2068项通过、1项跳过；172个测试文件通过、1个跳过；耗时240.77秒。包含facades/docs/core-skills/boundaries/versions/comments前置门禁 |
| diff审查 | 已复核全部源码、测试、setup与中英文档差异；`git diff --check HEAD`及`sh -n scripts/hoplite-setup.sh`通过。交付仅包含预期修复、回归、文档与 Changelog；本审计材料保留为 active 工作项，没有生成物或临时日志入库 |
| UI/真实模型/崩溃及存储故障注入 | 未运行；没有UI变更，不宣称视觉验收或全状态组合证明。C21局部Node实验仅保留子代理记录，未纳入最终集成回归或实施修复 |

原始临时日志在忽略的 `artifacts/state-machine-audit/`，不进入版本控制。完整报告、覆盖表与五域材料在原审计阶段留在 active；后续验收结果见归档的 [README](README.md)。这些材料只记录历史证据，不定义当前产品行为。PR 与 CI 实时状态以 GitHub 为准。

## 9. 材料入口

- [README.md](README.md)：状态、续接/审阅与文档出口。
- [COVERAGE.md](COVERAGE.md)：129文件的逐项责任归属与覆盖深度说明。
- [领域与账本](materials/domain.md)：19组协议/状态/guard/重放/测试。
- [Member Runtime](materials/member-runtime.md)：9组机制、4类helper、F2红绿与恢复边界。
- [Host与工具](materials/host-and-tools.md)：8组协调协议、F1红绿及工具interface。
- [订阅与外部资源](materials/subscriptions.md)：admission、调度、发布、replay、设置/文件、风险证据。
- [Client](materials/client.md)：24组协调器、67文件分类、UI未来验收门槛。

**本次报告的价值是把隐藏的时间/所有权约束变成可定位的地图，并锁定两处真实错误；不是用新框架覆盖已有正确行为。**
