# 实施记录

日期：2026-10-29。起点 HEAD：`deaa671`。Human 已授权推进代码实施，由 subagent 实施、主线程审查；不包含模型付费调用、提交或发布。

## 本轮检查清单

- [x] 01：真实累计 Session 的背景分类更新、memory 基线/提示、压缩恢复、异常与撤销。
- [x] 02：真实工具结果进入 Session 后满足 Thread Message 阅读条件；裁剪、同文和新事实不会误放行。
- [ ] 审查完成后再解锁后续票，不以 subagent 自报完成代替主线程审查。
- [ ] 修改对应双语正式文档及 CHANGELOG；描述范围限于已实现行为。
- [ ] 窄测试、类型与规则检查；按实际影响面扩大验证。
- [ ] 保留原有性能修改，不改变 Harness 仓库，不手改生成物。
- [ ] 更新工作项入口及各票实际状态；未做模型评测须明确记录。

## 已执行检查

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 起点 `npm run typecheck` | 通过 | 包括 Typert 生成和三个包的 TypeScript 检查；不代表后续实现已验证 |
| 起点 `thread-read-progress.spec.ts` 与 `main-stream.spec.ts` | 36 tests 通过 | 读取、精简 receipt 与 Main 基线；不代表新读取行为已实现 |
| 原有工作区差异 | 已记录 | `package.json` 的基准命令、Host 同次通知 delivery plan 复用、性能基准脚本 |

临时输出在 `.scratch/local/agent-context-implementation/`，不进入版本控制。

### 01/02 完成时证据（2026-10-29）

- Host/tools 完整测试：82 files passed、1 skipped；1081 tests passed、1 原有 skipped。日志 `host-tools-docs-suite-final.log`。
- 补充部分拒绝→read→提交闭环后：recovery/shipping/rejection payload 3 files、24 tests passed。长正文 fixture 比较持久规范化后的文本，避免尾随空格造成假失败。
- `npm run typecheck`、`check:docs`、`check:core-skills`、`check:comments`、`check:boundaries`、`git diff --check HEAD` 通过。core domain skill 7815/7850 字符。Host/tools 先 build 再测真实 Harness，以免 loader 使用旧 lib。
- 固定场景脚本已重跑：memory 修改输出 8242→355 字符，ownership 变化 8301→154；新实现注入次数 `[4,0,1,0,1,4,0]`，index 全文次数 `[1,0,0,0,0,1,0]`。初始分类包装略增，压缩后完整恢复；数字是 UTF-16 字符，不是 token 或费用。
- surface binding 使用生产者输出的整条实际文本 hash，加 Thread/Message/body hash；只沿真正 tool call source 或 Team notice 验证。真实投影裁剪、metadata 保留、相同短正文、外部工具、未知 revision、超过20条拒绝均有覆盖。没有持久第二状态。
- 双语 boundaries 为完整规则入口，tools/Host README、Host authority、persona、core skill、工具 description 和通知短提示已同步。Main/Activity 仍走显式 read，未提前声称 03–07 已完成。
- 已核对原有通知 deliveryPlan 三处性能改动保留。package.json、scripts/README.md、三个性能脚本的并行改动未由本工作项修改。
- 随后全 `npm run build` 与 `npm test` 通过：124 files passed、1 skipped；1461 tests passed、1 skipped（含 Client）。日志 `build-01-02.log` / `full-suite-01-02.log`。双语文档精简后的长度上限已下调，`check:docs` 再次通过。
- `npm run test:browser` 完成：11 files / 11 tests passed，日志 `browser-01-02.log`；`lint` exit 0，但有既有 scripts 的 unused/import-assign warnings。截图随后被另一浏览器任务清理重建，未将当前文件冒充本次截图证据。
- Human 随后授权阶段性 commit 自己的修改与继续使用 subagent。01 已以 `56e5a92 feat: update member context by category` 提交到 `feat/agent-context-reading`，只含13个本票文件/片段，不含性能或 Client mention picker 的并行修改。未付费调用、推送或发布。

### 03 Thread 读取实现中

- 已按两次 red→green 实现：direct notice完整正文在read中省略但仍确认；普通新增全文正常给；压缩后没有未读也补anchor与近期原文，再次read不重复、operationCount不增。
- Host返回仅Agent用的visibleMessageRefs，不改Human read、ledger确认批次/receipt/schema；背景选anchor+未读前4事实中的Message（无未读取tail）。省略正文的结果不绑定那条Message为完整，保留read结果但移除原notice的真实Session测试已通过。
- renderer区分Background、Acknowledged facts与Current Task cards；当前Task/active Claims保留。原来依赖firstRead/full-anchor分支的测试已更新，history仍时间分页。
- 真实Task read→board→claim也通过，当前新测试3个。typecheck通过。完整Host/tools最近一次仅persona超15000字符失败，文档agent已压缩至14967，shipping6/6通过；最新完整回归运行中。
- 03尚未标complete：Main read背景/省略还没实施；需与04/05按依赖衔接，不把Thread部分当整票完成。长消息续读未实施。独立审查完成，未发现已核实的问题；审查者另外运行Host 940 passed/1 skipped、tools 144 passed及两个包的tsc，通过。
- 最新Host/tools回归：83 passed files、1 skipped；1084 passed tests、1 skipped。提交前窄读取/重放/probe/rejection测试33/33通过。此前两次全回归遇到另一个会话build清理lib导致Module not found/Member unavailable；等外部build结束并重建后通过，不是无解释略过失败。
- 并行Client mention picker以`b48f3b5`提交在共享分支上，不属于本工作项，不改写。02+03 Thread代码、文档与测试已提交`241f8f8 feat: recover thread context from complete visible facts`（33文件）；Host index中的原deliveryPlan性能三处和ledger新增notificationReadSet缓存均从提交排除，工作树保留。
- 提交前最终`npm test`通过：125 files passed/1 skipped，1470 tests passed/1 skipped；日志`full-suite-thread-stage.log`。比01/02阶段总数增加包含并行Client新增测试，不全归因于本工作项。提交后仅原有性能文件和Host性能片段未提交。
- 下一步：03的Main read当前上下文背景与省略；再04长消息续读与精确确认，05扩Main/Activity写前完整性，06通知预算优先级，07联合验收。没有活动后台任务或subagent。

### 03 Main / 04 长消息完成（2026-10-29）

- Main read：查询/直接通知的完整正文省略但确认；无未读压缩后补最近4事实中的Message，再次read不重复；卡片不代表Thread已读。额外复现并修正“旧未读被25条Task卡挤出页面后仍确认”的问题，Agent预览补齐确认区间的未读来源；Human页面规则不变。
- read/message 共用32768 UTF-16总输出预算，预留64单位给最终水位/计数变化；先缩小批次，再对单条分段。重复同一请求从当前surface最早缺段继续，未新增offset/limit参数；持久Message不变，无第二已读库。
- 每段绑定真实输出hash、Thread或Project、Message/body hash与范围；完整覆盖才允许read确认。中文/emoji拼接、后消息阻塞、message不确认、补缺中段、单独末段、长背景不新增确认、Session restore/retained-meta裁剪都有测试。
- ledger select同步运行在操作队列内；Thread receipt保存内部selectedThroughSequence，默认Human/旧receipt仍20条；Main复用原readThroughSequence。独立审查指出选择性read重试会虚报后续确认、末段仍提示续读，已加测试/修正。审查的reminder问题已由make清空/Host非提交结果过滤覆盖；旧threadFacts绑定为本工作项未发布的中间版本，按单一实现换teamFacts，不增加兼容层。
- 容量保护是保守字符限制，不是token实测：已知模型min(262144, contextWindow-16384)，未知262144；超限给Message身份与拆短/换模型入口，不确认。附件保留body中的既有[attachment]路径，不把完整Message当附件全文。history仍原分页，不宣称总字符预算已实现。
- 最终typecheck与npm test通过：127 files passed/1 skipped，1489 tests passed/1 skipped。build与test:browser通过11/11；并行性能browser场景清空常规截图，随后单独重跑Main Web流程通过并实际检查1440×960/390×844截图。lint exit0，仍有既有scripts warnings。
- 日志：typecheck-main-long-final.log、full-main-long-final.log、browser-main-long.log、browser-main-focused.log、lint-main-long.log。全部在.scratch/local/agent-context-implementation。没有付费调用、push或发布。
- 文档、README、persona/core skill已同步，core skill 7846/7850；docs/core-skills/comments/boundaries/diff通过。所有本阶段subagent均完成；下一票05：Main/Activity写前完整事实恢复，06通知，07联合验收。

### 05 Main / Activity 完成（2026-10-29，提交`6b6b7f2`）

- Main写前检查接受当前真实Session中的完整Message/Activity；完整通知或拒绝结果可支持post，但不写已读水位或消费marker。Main不新增revision token。新普通Message到达后再次拒绝，真实工具闭环已验证。
- Activity统一按不可变事件投影，绑定actor、Thread/Project与Task身份、Claim refs、transfer from/to及refollowedMembers；不从当前Task/Claim状态补历史。通知、history、read与拒绝共用格式及真实输出hash。完整混合拒绝提供Thread token；不完整不给token。
- read确认已可见Activity时仅重复身份，不绑定省略内容。真实通知→read、拒绝→write→read、Main history/rejection→post→read及裁剪旧完整结果后不伪造Activity可见性通过。
- 拒绝总输出16KiB，read固定32KiB。超大单Activity不分段、不确认，错误明确换模型/重复调用不能解决固定输出限制，交Human检查。history沿用既有按条分页、无总字符预算契约，未扩入本票。
- 最终全量typecheck/test：129 files通过/1原有跳过，1505 tests通过/1原有跳过。首次全回归有35个Member启动失败（诊断preset未启动），原两文件单独复跑65/65通过，随后完整复跑通过；首次具体原因未查明，未隐去失败日志。
- `test:browser` 10/10通过（并行性能工作把其场景移出常规browser套件）；Main单独再跑1通过/9跳过，并实际检查1440×960与390×844截图。最后Host/tools175/175通过，通知省略追加检查1/1通过。docs/core-skills/comments通过，core skill7836/7850；lint通过，有原有warnings，新增unused fixture参数已移除。
- 日志位于`.scratch/local/agent-context-implementation/`：full-activity-final.log、typecheck-activity-ready.log、browser-activity.log、browser-activity-main.log、activity-last-check.log、notice-activity-omit.log。未付费调用、push、发布。
- 本票32文件通过index-only blob分离Host性能改动；共享工作树性能缓存、deliveryPlan、running-edge优化与scripts/team-performance均保留。独立审查未发现错误事实绑定或权限放松；Main retry已通过两条临时真实工具测试核实：单批最多20，原receipt+当前快照、不确认新事实，符合既有契约，审查者撤回缺陷判断，不新增snapshot cache。
- 最后完整回归`full-activity-ready.log`仍1505通过/1原有跳过；额外Task权限/读取重放49/49与包产物检查通过。

### 06 通知完成（2026-10-30，提交`05bf168`）

- 本轮nmem搜索及status均返回502，检索不可用；依据已确认spec/06票推进，未把服务失败当无记忆。
- 核对性能线已四项在途优化（新增notificationSnapshot共享Main派生）；已将开工前Host/ledger差异保存在local/performance-before-notification.diff，不覆盖或混入提交。
- 完成标准：新缺失direct/责任变化优先；旧完整Message/Activity只保留身份且不绑定省略内容；含恢复前缀/计数/入口的整体通知<=32768 UTF16；重要省略有明确提示；既有合并/失败重试/未读与markers不变。
- subagent负责通知选择与自身真实Session测试；主线程补Activity→新direct去重、Main省略后裁剪原文不能放行、24条direct压缩后恢复与未展开提示测试。已先复现旧Activity重复与恢复丢最新direct，新的省略裁剪测试在实施代码上直接通过，未宣称它经历red。
- 原投递/恢复基线65/65通过；加入Session读取后post-commit-delivery fake Agent缺Session失败，fixture补真实空Session后9/9通过。生命周期/acceptance/恢复59/59，读取与surface回归35/35通过。
- 主线程先复现并修正两处预算问题：先截8Thread会漏最新第9Thread，改为全局排序后选scope；100Thread×7000正文时全量footer路由超预算，改最多4条加其余数量。新增测试真实red→green。notificationText必传真实Agent，移除不必要的缺Agent分支。
- 第一轮完整验证：typecheck通过，Host/tools1127通过/1原有跳过；npm test共1513通过/1原有跳过，lint exit0且改动文件无新增警告，docs通过。尚不能视为最终验收，后续审查补测和修改需再跑。
- 独立review发现Main非目标ownership误写you、全局排序后Main计数归属不明、已可见reply丢回复关系；实现agent正逐项真实测试验证修正。review中的文档缺失是过期判断，文档agent已完成双语说明，主线程更正字符单位与Main普通计数表述。
- reminder超20详细事实后原只剩通用省略说明，真实Session已复现；reminder本就计入public inbox directCount，现加入现有明确direct省略计数和路由。reminder仍未读，显式read才消费，14项测试通过；不改covered或新增自动重试。最初Task尚未in_progress导致fixture超时，补真实Claim后才成功复现，未把超时当缺陷证据。
- 恢复边界补491repeat：同批4条能装入普通notice，含恢复指令只能装3条；与70/570长度及reminder合测5/5通过。完整正文/截断/身份绑定原规则不变。
- 2026-10-30 Human告知nmem恢复并再次要求合理利用subagent。检索已成功，已核对现行实施/阶段提交授权，并将仍写“仅设计”的旧记忆标为历史。07七工具盘点已交另一agent只读进行，不重复06修复。
- 归属修复4个新测试red→green。主线程再加强：先裁掉原完整notice，用真实message查询仅取正文，再触发通知验证reply关系；两Project测试增加direct使header确实被全局排序打散。4/4通过；Main普通Activity与Message统一计数且标明Project。
- 最终`typecheck-notification-reviewed.log`通过；`full-notification-reviewed.log`133 files/1519 tests通过，1原有跳过；`lint-notification-reviewed.log`exit0，原有warnings保留，改动文件无新warning。docs/core-skills/comments/boundaries/facades/versions由npm test通过。仅Agent通知内容改变，不影响UI、Remote或Web组装，本票未重复browser。
- 16个本票文件以`05bf168 feat: prioritize bounded notification context`提交。通过index-only stage-notification.py隔离同文件性能优化；提交后工作树仅四类性能文件与scripts/team-performance，全部原样保留。未付费调用、push、发布。
- 07只读盘点及F1–F6现有验证定位见`materials/2026-10-30-acceptance-plan.md`。旧live-eval runner不走真实Session，不能直接证明新的surface恢复；不得把参数形状评测当完整验收。既有合成Member量测已重跑，数字与此前一致。

### 07 实现与确定性验收完成（2026-10-30，提交`b1af731`）

- Human继续授权推进；nmem现行验收约定已检索。两个agent分别改工具包及双语规则/core skill，主线程负责量测、联合流程及review；性能四项保持不动。
- 已核实并清理不存在的reply设置开关、v1模型未送达mention出口、DM body提及Human误导、地址说明矛盾；recovery registry不再被描述为所有错误都有下一步。persona检查后不改，避免无价值重写。
- core skill unfollow规则明确是读者自己的active Claim阻止取消关注，不是任何人的Claim；7838/7850。docs最长块从562下调556，补own表述时一度超限561，精简措辞后通过，未提高上限。
- 工具agent初版擅加message拒绝额外taskRef的guard，改变既有合法输入。主线程已移除：Thread message要求threadRef，额外taskRef原被忽略，单taskRef缺threadRef会拒绝；只改说明不扩行为。agent正同步README/测试。初版mock Host拒绝只证明透传，不证明真实权限，已要求改为真实Host公开接口覆盖同/异Thread与own/other Claim。
- F1–F6及重放/隔离联合9files/73tests通过。F2原例没有其他Claim，主线程补已有打包Claim再read→board→领取另一方向；fixture最初错取Project字段，后补Human读取新Claim事件，最终6tests通过。未把fixture错误称生产缺陷。最新typecheck通过。
- 合成context-scenarios经真实Agent loop串联F3/F5/F6、检查未读与提交，导出1Session/10检查点/16请求。新版context-volume.mts显式输入、派生当前surface，分开累计文本/分类注入/分段绑定/每请求GenerateOptions。无输入拒绝、重复文件仍1Session、脚本类型检查均通过；旧默认扫描个人日志的context-volume.mjs删除，历史研究记录不改。
- 独立07 review已完成。确认并修正core skill的Thread/Main取消关注范围、当前v2回复Human的投递说明、已取消的参数文案重复要求。主线程进一步纠正“任意Claim”遗漏own限定、“除此没有通知机制”和“回复自己不通知任何人”的泛称，明确显式mention仍投递。persona既有写作规则及测试保留，不为旧测试恢复重复文案。
- 第一次最终全回归1524通过/1失败/1原有跳过：shipping.spec仍要求已删除的两段参数写作提示，删除过时断言后shipping/addressing/main-stream 36/36通过。第二次同样1524通过/1失败/1原有跳过：core skill精简把never current state改成not current state，而member-skills固定此契约原文，恢复never措辞。两次失败日志分别full-guidance-final.log与full-guidance-reviewed.log，未隐藏失败。
- newaddressing改用真实Host，不mock拒绝；删除Claim后补follow的测试fallback。自己Claim阻止Thread unfollow，不阻止Main unfollow。随后把message的额外taskRef改为别的Thread，真实测试失败揭示先前主线程和独立审查的共同误判：readMessage只用threadRef，但后续orientation lookup仍用双ref并校验一致。最终说明改为message需要threadRef，同Thread额外taskRef合法、异Thread拒绝；增加同/异目标和taskRef单独使用三项真实断言。只修正说明，未更改既有行为。
- 最新Host/tools构建和真实Session组合场景通过，日志context-scenarios-built.log；快照量测仍1Session/10检查点/16请求，当前surface和累计输出分别统计，重复输入2文件仍1Session。此前typecheck-guidance-reviewed.log与lint-guidance-reviewed.log通过，改动文件无新warning，旧warnings保留。
- 最终`full-guidance-ready.log`134files/1525tests通过，1原有跳过；`typecheck-guidance-ready.log`和`lint-guidance-ready.log`通过，本工作项改动文件无新增warning。docs/core-skills/comments/boundaries/facades/versions全过，core skill7814/7850。最终地址/渲染/skill窄测71通过。Host/tools已构建，未改Client、Remote、manifest或Web组装，按影响面未重复browser与全量Web build。
- 07的实现、文档和确定性验收已完成；真实模型配置和费用未获授权，07保持in-progress，不归档。待运行固定场景的真实模型重复样本，比较目标完成、收到新事实后改变行动及误调用恢复；合成字符数不作为模型质量或费用收益。

### 文档独立审查补正（2026-10-30，提交`805394f`）

- Human要求subagent审查本工作项全部文档更新，scratch review另行进行。只读审查完成，主线程核实两项：无未读facts但有reminder的read仍可能提交确认；taskRef别名不是仅供released Client使用。
- 同步修正双语tools文档、domain model及Host/tools README，动作级寻址规则集中链接到工具契约。不改运行代码、权限或既有参数行为。中文段落超预算后精简至508，并下调510→508，未提高上限。
- check:docs与diff检查通过，read/reminder/address/render四文件74tests通过。本次纯文档修正未重跑全量、build或browser。原性能工作树保持，未push或发布。
- 审查附带的分段措辞细节和旧host-authority双语结构差异未当成已确认缺陷或借机扩展修订。未进行scratch review，也未运行真实模型评测。

## 实施与审查

- 01 与 02 从互不冲突的文件开始并行实施，共享文档和 Host wiring 由主线程统一处理。三次实施 subagent 均已结束，后续由主线程修正并完成。
- 02 第一位实施 agent 因 API 输入过长停止，未留下代码修改；重新启动时只允许定位后读取短片段，代码和测试优先，文档交主线程。
- 性能工作项 README 记录同次通知 delivery plan 复用已完成、规模验证未完成；工作区确有对应三个改动。06 前须再次核实，不以这次检查当成永久写入锁。
