# 订阅、Webhook 与主机设置：隐式状态机审计

状态：限定范围审计完成（2026-11-10）；仅审计，不修改生产代码/测试。基线由父任务提供为 `7076dbd`、2062 测试通过（本子任务未重跑）。

本材料把领域账本、订阅持久化接收、运行诊断日志、内存队列分开；不把纯解析/格式化函数计作状态机。按状态、事件、守卫、权威、效果、重启恢复、现有测试与保留/局部显化/延后整理。

## 1. 权威分层：四种「成功」不能折叠

- **领域账本**保存订阅定义/状态、accepted 事件与 published 结果，是 Team 事实权威。脚本退出 0、run 日志写入、HTTP 202 均不等于事件已进入 Thread。调度器依赖 `SubscriptionRuntimePorts.current/pending/publish`（`subscription-runtime.ts:46–81`），不能从最近一条 run 重建领域事实。
- **持久接收队列 admissions**是已经回答 202 后仍欠执行的工作，schema允许 `queued/running/retrying`；当前生产写点为 `queued → retrying → 移除`，执行占用由内存 admission 管理（`subscription-admissions.ts:13–47`）。虽不产生 Team 领域事实，删除它会丢失已对外承诺的工作；不能把 subscription store 所有表一概称为「可删诊断」。`subscription-store.ts:1–7` 的总述与 v4 admissions 的 202 恢复契约（同文件末尾版本注释）存在语义张力，应局部修正文案，而不是增加另一权威。
- **checkpoint**持久保存 dueAt、连续失败和发布窗口预算（`subscription-runtime.ts:29–43`）；丢失不抹去领域事实，但会改变何时执行、何时暂停和限流。因此「非领域权威」不等于「无行为影响」。
- **runs / deliveries / replays**分别是诊断历史、等待 owner 的失败 payload、请求级重放承诺；它们与内存 scheduler queue 不同。scheduler 的 `queue/running/runningDue/inFlight/publishing`（`:116–130`）只描述本次 Host 执行；重启不能把这些集合当待办权威。

## 2. 定时调度与统一 admission：保留，局部显化策略

`SubscriptionScheduler` 的控制态不是单个布尔值：手动驱动初态（stopped=true, draining=false）、运行、停机排空（stopped=true, draining=true），叠加 tick 未运行/运行、每 ref 排队/执行/发布中。`start/tick/runTick/stop`（`subscription-runtime.ts:134–177`）分别启动 tick、禁止重叠、依次 settleBoot→publishPass→timerPass→admit、拒绝未启动 trial 并等待在途任务。stop 等待 publication 超出 run slot 的部分后 Host 才能关闭存储；不要简化成清空 timer 即停机。

`runAdmitted/runTrial`（`:185–197`）把 create/update/test/resume 的试跑与 timer/webhook/replay 放入相同容量：全局四个执行槽、同订阅至多一个执行，按 due/request 时刻 FIFO；忙 ref 不堵塞其他 ref（`:258–285`）。**trial 可进入 paused，run 不可**；排队时的 snapshot 不是权限。`admissionRefusal`（`:298–314`）启动前重新读当前账本，deleted / archived 一律拒绝，真实 run 还要求 stored 且 active；从未持久化的 draft 才能用自带快照。不要用一个笼统 `isEnabled` 取代此策略。

`timerPass`（`:212–255`）将暂停、删除、归档、pending 达上限、已消费 due 时刻分开处理；`runningDue` 防止脚本结束但 checkpoint 尚未写回时重复执行同一 due。`settleOutcome`（`:385–410`）将 accepted/empty 视为成功、failed/backlog/deferred 累加失败，三连失败调用领域 pause；dropped 不写回，不复活已删除 checkpoint。accept 时清零失败，scheduler 成功后仅推进 due，避免并发全记录覆盖。保存使用锁内 change(current) 而非旧快照替换（`:72–81`）。

`publishOnePass`（`:446–476`）是独立的 accepted→published 机器：每订阅串行、每分钟最多20条、失败保留 pending，下一轮续投；窗口仅向前重置，防时间倒退重复发预算。**paused 仍可发布已接受事件；deleted/archived 不再发布**。执行成功仅等预算时不得重跑脚本。保留现有 scheduler seam 与 fake clock/executor；局部增强命名/不变式说明比引入通用 FSM、全局 actor 或新队列表更小、更符合 DX/AX。

## 3. Webhook：HTTP 生命期与持久工作分开

`webhook.ts:35–77 handleWebhookRequest`：POST/路径 token/encoding/headers 前置检查 → 读取原始 body → fatal UTF-8 解码 → Host 持久 intake → 空 body HTTP 应答。202 是入队；404 未找到、409 paused、429 队满并带 retry-after、503 存储失败；413 超 body、431 超 header、415 encoding、400 非 UTF-8 由入口决定。`readBody`（`:94–123`）具有 unsettled→body/too-large/timed-out/broken 的一次性 settle，10秒 read deadline，超限先答后断开；不是领域状态机，但确有异步终态竞争，`settled` 守卫承重。路径包含 bearer token，不应记录原路径。

`webhook-ingress.ts:32–37 apply` 是 Cordis 资源生命周期：独立 realm 挂 listener 与 route，route 由 effect 释放。不要挪回主 browser listener，也不要为了「显式状态」复制框架 resource state。禁用入口与删除订阅不是同一事件：禁用阻止后续网络接收；已持久化队列仍由 Host 的明确领域门禁决定去向。

跨层复核仅为了校准接口（主审计负责 index）：`index.ts:3651–3689 intakeWebhookDelivery` 在 subscription 写锁内重读 writable/token/paused/容量，持久 put 成功才返回 queued。reset 地址在等锁期间提交，则旧 token 必须404；网络 request 进入早不构成排队权。记录冻结 receivedRevision/script hash/脚本/凭据引用/header/body，后续编辑不改已接收工作。`subscription-admissions.ts:49–92` 提供稳定 attempt requestId、Host admission identity、provider failure delivery ref 和公平 due 排序；这些是纯 key/排序函数，不是各自独立机器。

`index.ts:3702–3759 pumpWebhookAdmissions/runWebhookAdmission`：pump 不重叠，paused 保留但不执行；先查账本 attempt requestId 是否已接受，已接受则只补删 admission；heldEvents 则只重试 accept，不重跑脚本；否则按 received 定义执行并经同一 scheduler admission。关停 admission 拒绝不算脚本失败，记录留待重启。应把「provider redelivery 新 admission」和「同 admission retry/replay 保持身份」讲清，不能承诺外部脚本 exactly-once；本系统确保 accepted 领域结果幂等，外部脚本副作用仍由脚本/外部系统按 delivery id 去重。

## 4. 执行报告、重试与人工重放：保留，不能拿日志代替承诺

`runSubscriptionScript`（`subscription-runner.ts:291–358`）是一次执行的异步流程：验证 executor/shell/workspace/credentials → 构造环境 → 执行 → 捕获完整 stdout → timeout/容量/exit/解析判定 → report。60秒执行、64KiB stdout 的限制来自 `subscriptions.ts:25–27`；失败尾部8KiB来自 runner `:64`。categories（`:143–169`）属于结果分类，不是一个会跨时间自行迁移的 FSM；`verified` 是试跑通过但不发布，accepted/empty 是运行成功。`invalid-utf8` 仅为旧持久行兼容，当前执行不得据枚举存在推断仍会产生。`parseSubscriptionOutput`、snapshot/hash、env、baselineIdsOf、scheduleAction 都是纯决策/转换，状态由其调用者拥有。

Webhook 自动 retry 时间梯为1/5/30**分钟**，不是秒（`subscription-webhook.ts:24–27,138–139`）。`index.ts:3833–3866 retryOrFailWebhookAdmission` 每次结算增加 attempts，尚有重试则持久 nextAttemptAt，耗尽或不可恢复大批次转失败 delivery；只有仍 writable 才能写，删除/归档不复活记录。held batch 在 backlog 暂满时保留，若单批超过500则直接失败，不能永远保留一个不可能接受的批次。暂停仅阻止新执行；已经在途的合法输出不是取消事务，迟到提交仍要按终态门禁和账本事实判断。

`subscription-runs.ts:21–25`：每订阅最近50条 run，最多10个失败 delivery，失败 payload 保留7天。`runRecordOf/runSummaryOf/deliveryRecordOf/deliveryEntryOf/evictedDeliveries` 是构造/投影/淘汰决策，不自行调度。`SubscriptionReplayRecord`（`:280–309`）才有持久 running→settled：**先写 intent，再执行**（`index.ts:4113–4138`），requestId 同时绑定 subscription/delivery/version，不能更换目标后当重试。中断 running 不应直接重跑；先看账本有没有该 request 已接受的结果，再返回可解释的已完成/未完成答复。run 历史写失败不能撤销已接受领域事实。

schema admissions 声明 `running`，但本次查到的 Host admissions 写点为 queued（`index.ts:3685,3786`）和 retrying（`:3848`），`running` 写点 `:4172` 属于 **replay intent**；不能把枚举图当实际转移图。`dueAdmissions` 会排除 running，当前没有充分证据解释谁会生成/恢复这样的 admission；标为局部澄清/覆盖缺口，而非断言生产发生卡死，也不建议在没契约测试前删除兼容状态。

late-result 三道门：排队到开始前读当前 runTarget/admissionRefusal；脚本结束后 `commitRunOutput` 在写锁内检查 `writableSubscription`（`index.ts:3371–3385`）；日志/失败 delivery/replay settle 也独立检查终态，防删后写回。replay 若账本早已接受但随后删除，返回语义仍必须尊重已经发生的 accepted（`:4138–4146`），不能因为私有 answer 行没留下就虚报未交付。保留这些门，不合并成一个早读布尔值。

## 5. 更新提示缓存：小机器，停用语义需先定约

`createHumanUpdateChecker`（`human-update-check.ts:92–129`）隐式态为 unknown/有旧值 × fresh/stale × idle/inFlight，再叠 env kill-switch。snapshot 同步读缓存，过期触发共享后台请求；刷新最多一个，成功只记更新版本，失败记 checkedAt但保留旧值。12小时 TTL、5秒 timeout；Host 重启全部重置。fresh 表示检查已结算，不保证网络成功，更不保证「没有更新」。这是提示缓存，不应阻塞 profile 或引入 durable ledger。

**已确认行为，不直接裁定 bug：** disable 只在 `refresh()` 开头判断；env 在请求中改为 off，不 abort、不设 generation，迟到结果仍更新 `latestVersion`；关闭后 snapshot 也仍返回已有缓存（`:108–128`）。如果 off 的契约只是「不再 outbound」，当前行为自洽；若产品希望「关闭即隐藏/作废迟到结果」，需要一个最小 enabled/settlement gate 与对应测试，而不是引入通用 FSM。现有 `human-update-check.spec.ts:112–129` 只覆盖初始 disabled/offline，没有运行中关闭再完成测试。优先局部定约，暂不扩大成配置订阅/取消框架。

`parseVersionCore/isNewerVersion`（`:34–59`）故意忽略 prerelease/build 后缀，是纯帮助函数，不是环境兼容判据；不要用它取代 Harness 的 compatibility evaluator。`fetchLatestVersion`（`:63–77`）吸收失败，不在此层定义重试机器。

## 6. 环境判断与 Human 设置迁移：权威明确，不造新状态仓

`environment-check.ts:28–86`：supportRangeOf/evaluateEnvironment/verdictFor/reportEnvironment 基于 installed manifest 与运行 DSH 版本给出 ok/out-of-range/undetermined。这是一次取证后的**纯分类**，不是三态生命周期；真实 compatibility violation 优先于无法归一 support range，未知不能偷换成 ok。兼容比较复用 Harness `evaluatePluginCompatibility`。`installed-manifest.ts:13–28` 安全读取/版本提取，失败 unknown，不持有异步状态；`human-profile.ts:12` 的版本常量才是模块加载时快照，重启/重载更新。

`host-row-settings.ts:91–146 planHostRowWrite/carriedField` 与 `human-profile.ts:43–145` 是迁移策略/解析，不拥有迁移事务。实际生命周期是 legacy-only → 部分采用 → 当前 namespace 已存储：当前 USER layer 的显式字段优先（即便值等于默认），只填空字段；旧默认 name 不被当作用户事实；schema 补齐旧版嵌套 group；无效、重复 row、解析错误、含 `!!js` expression 的字段不迁。不要将 resolved/default 配置拿来判断「用户是否写过」，否则会吞掉或覆盖设置。

`human-settings.ts:7,16` 给当前/历史 namespace 常量，Remote 上下文不能拿 `ctx.fiber.entry` 当 Host row；该文件仅常量，不是机器。profile name NFKC+trim 非空（`human-profile.ts:23–30`）也是纯验证。保留现有 Host settings authority 和 migration seam；不加「已迁移」平行布尔仓。重启按已存储字段自然收敛；缺头像 bytes 时只迁 name，不制造失效 avatarRef。

## 7. 附件和头像：文件准备与领域引用两阶段

附件存在 absent → payload-only/半写 → 可读 cache → ledger 引用/孤儿 → TTL 删除的文件生命周期（`attachments.ts:136–169,177–223`）。write 顺序是 payload 后 meta；读不到 meta/payload 返回 absent，损坏 JSON/读 payload 错误不由 `readAttachment` 全部吞掉，扫描则跳过不可读 sidecar。request-scoped id（`:34–40,96–123`）使相同请求同 bytes/name/mediaType 重试复用，改 payload 拒绝碰撞；它不是第二份 Message 权威。账本保留元数据，缓存 bytes 是临时材料；已引用72小时、孤儿24小时，按 uploadedAt 而非首次引用计龄。GC删除 bytes 并不删除历史 Message，UX 需要呈现「附件已过期」而不是消息失败。

`validatePathAttachment`（`:86–94`）在缓存写入前检查绝对路径、普通文件、非空、≤10MiB；sanitizeFileName、sanitizeMediaType、mediaTypeForPath、requestScopedAttachmentId 是纯帮助函数。不要因为有顺序就全改成 FSM，也不要把文件副本准备误报为消息已提交。

头像 `human-avatar.ts:34–72` 是 immutable payload+meta → settings ref 切换 → 旧 entry 删除的准备/引用生命周期，写入要求 image MIME、非空、≤10MiB，UUID 每次新建；无附件式TTL。文件写成功不等于 settings 已切换，客户端应等待 Host 确认而非乐观永久显示。此层文件写非原子，半写、破损 sidecar 和未引用头像清理是**可复核韧性风险**，目前正常/半写附件已有测试；不在本次只读审计里引入跨文件事务或清理守护进程。是否值得修取决于真实故障/容量证据。

## 8. 恢复话术不是运行态，现有测试与结论

`recovery-hints.ts:25–266` 的 registry/recoveryFor/assertRecoveryCoverage/forbidHandWrittenRecovery 管理情况→具体动作和值的统一恢复指引；它本身无时间/身份/持久转移，不计为状态机。unknown kind 抛错和精确 coverage 是 AX/DX 防回退护栏，应保留；不能通过增设运行状态消除话术重复，也不能让一句「重试」替代 owner/权限/版本门禁。

本次核对的是**现有源码与测试内容**，未运行任何测试、构建或浏览器；2062绿为父任务提供的基线，不是本子任务新证据。关键契约锚点（均位于 `packages/agent-team/tests/`）：

- `subscription-runtime.spec.ts:190–288` 排队合并/backlog/三失败/字段级结算；`:305–409` 发布限流、重启、重叠、时间倒退、deleted/archived/paused；`:419–648` shared slots、trial、late barrier、due fairness；`:648–728` 排空和存储失败。
- `subscription-host.spec.ts:826–878` 接收身份与 pinned definition；`:906–1013` 撤 trigger 仍完成已接收/held accept/地址 reset；`:1044–1176` retry、large batch、已接受补账、删后迟到；`:1200–1304` archive、retry success、paused replay、重启队列。`subscription-retry.spec.ts:20` 请求重试仍校验当前 ownership。
- `webhook-entry.spec.ts:131–177` durable202、原样 body/encoding/status；`webhook-ingress.spec.ts` listener/disable realm；`webhook-settings.spec.ts:21–53` 未配置/迁移/配置错误/地址构造。`subscription-webhook.spec.ts` token、headers、retry 纯决策；`subscriptions.spec.ts` 输出解析与限制；`subscription-runner.spec.ts` 执行分类；`subscription-runs.spec.ts` 记录/淘汰/replay shapes；`subscription-ledger.spec.ts` 接受、幂等、发布；另核对 `subscription-directory.spec.ts` 的读取接口覆盖。
- `human-update-check.spec.ts:81–129` 同步快照、single-flight、TTL、初始关闭/offline，未证明动态关闭迟到屏障。`environment-check.spec.ts:31–134` support range、三种 verdict 与真实违规优先。
- `human-profile.spec.ts:91–104,136–256,350–499` avatar IO、两类 legacy parse、当前字段优先、表达式隔离和迁移收敛；`attachments.spec.ts:127–165,274–336` immutable IO/TTL、请求碰撞、重启与半写收敛；`recovery-hints.spec.ts:57–130` 精确覆盖、可执行恢复路线、禁重复话术。

**裁决：** 保留 scheduler/Host ledger 分工、shared admission、持久 intake、replay intent、字段锁与 late gates；局部显化四种成功语义、store 可删性文案、暂停与撤 trigger/禁用入口差异、admission running 的真实生产者，以及更新提示 off 的精确定义；延后通用 FSM 框架、全仓 tagged-union 改造、跨文件事务和新清理框架。UX 优先不给202/试跑/暂停过度承诺，DX 优先让权威/等待/重启在一个 seam 可追踪，AX 优先稳定身份与可执行恢复，不增平行状态真相。

### 追加交接：优先核实的故障窗口与源码清单

耗尽 retry 时先 `admissions.delete`，再 `recordFailedDeliveryLocked`（`index.ts:3854–3855`）；后者在 `:3902` 才 `deliveries.put`。定点复核已确认当前 Domain 不支持跨表事务，这里是两次独立持久写，锁只排序并发。删除后到写入成功前的 crash/写失败窗口存在静态证据，尚未故障注入复现；恢复来源和API限制见文末补证。该窗口与正常重启队列测试不同，不能由其绿灯直接排除。

本分工覆盖的生产源文件全部位于 `packages/agent-team/src/`：`subscription-admissions.ts`、`subscription-runner.ts`、`subscription-runs.ts`、`subscription-runtime.ts`、`subscription-store.ts`、`subscription-webhook.ts`、`subscriptions.ts`、`webhook-ingress.ts`、`webhook.ts`、`human-update-check.ts`、`environment-check.ts`、`host-row-settings.ts`、`human-settings.ts`、`human-avatar.ts`、`human-profile.ts`、`attachments.ts`、`installed-manifest.ts`、`recovery-hints.ts`。另只抽查 `index.ts` 的订阅接线/接收/结算调用点以校准这些文件，不接管主代理的 index 审计。


## 交付判定：证据强度与下一步

| 分类 | 具体结论 | 处理 |
| --- | --- | --- |
| 已证实文本问题 | store 总述称删除所有行不改变领域结果，对 ledger 事实成立，但没有说明删除 admissions 会丢失202已承诺待办；checkpoint 丢失亦会影响调度/限流。不是已复现运行时故障。 | 局部澄清非领域权威≠可安全删除。 |
| 已证实现行行为 | paused 阻止新执行，不阻止已接受事件发布；删订阅/归档是 late-result 终态门禁；撤 trigger 不撤已接收工作。 | 保留并在 UX 文案/状态命名中区分。 |
| 已证实现行行为、缺陷定性待契约 | 更新检查 off 不撤销在途请求、不屏蔽缓存；只有初始 off 测试。 | 先决定 off 是网络开关还是撤销/隐藏，再补最窄门禁测试。 |
| 已确认非原子转移；丢失结果未故障注入复现 | retry耗尽先持久删除 admission，后独立持久写 failed delivery；当前Domain没有跨表事务。 | 保留为已静态定位的恢复风险；故障注入验证丢失结果，勿凭正常重启绿灯排除。 |
| 模型/覆盖待澄清，不是卡死实证 | admission schema 接受 running，当前生产写点未生成该态；replay running 属另一机器。 | 澄清兼容来源与恢复政策，不贸然删状态。 |
| 延后 | 文件 payload/meta 非原子和遗留头像清理，仅发现韧性缺口，没有现场故障或容量证据。 | 不扩大成通用FSM、跨文件事务/GC框架。 |

**本子任务没有确认或复现运行时缺陷，也没有交付行为修复。** 已完成限定范围的状态/事件/守卫/权威/副作用/重启/现有测试盘点；Domain事务边界已完成静态补证；新测试及任何后续代码修改由主代理按总审计优先级决定。


### 定点补证：retry耗尽转移的实际事务边界（2026-11-10）

**结论：不是同一事务；当前公开 Domain API 不能把 admission删除与failed-delivery写入包在一个跨表事务内。** Team `7076dbd` 的 `index.ts:3854–3855,3902` 是先 await admission delete，再 await delivery put。Team `serializeSubscriptionWrite`（`:3623–3631`）只有内存 Promise tail，没有 begin/commit/rollback，也没有持久重做意图。两表虽属于同一个 `agent_team_subscriptions` Domain（`subscription-store.ts:146–162`；接线 `index.ts:3016–3023`），同域只保证写入排队，不保证整个回调原子。

静态依据来自当前实际解析到的 Harness `66491b05`，未修改该仓库：

- `../deepseek-harness/packages/storage/storage-domain/src/domain.ts:43–108,115–137`：公开表接口是 put/delete/deleteMany/update，Domain只有global/table/close；没有跨表transaction/batch接口。deleteMany仅同表多key删除，update仅单key纯同步变换，均不能表达删admission+写delivery。`README.md:147` 明确列出 **No cross-table transactions**。
- 同文件 `:340–357`：put与delete分别调用一次 `host.enqueue`，分别 await `unit.putRecord` / `unit.deleteRecord`，持久完成才改内存和发事件；`:283–300` 的chain只是串行任务。不会在后一job失败时回滚前一job。底层 `storage/src/backend.ts:88–141` 的KvUnit也未提供能给这两次Domain操作复用的事务句柄。
- `require.resolve('@deepseek-ai/dsh-storage-domain')` 实际指向相邻Harness的 `storage-domain/lib/index.js`；该运行产物 `:270–284` 同样是两个独立enqueue/单次backend调用，已交叉核对，并非只根据源码或README猜测。不能靠同名Domain、外层锁、Promise.all或私有backend句柄让当前两写成为事务；本任务不提出或实施Harness更改。

**crash后的其他durable来源：未发现能保证恢复本次payload的内部来源。** 启动只重挂已有表并清除dead-subscription残留（`index.ts:3016–3028,3200–3215`），随后pump从admissions现存行取due（`:3058–3065,3635–3640,3702–3711`）。删除已持久完成且delivery尚未持久写入时，pump再无该行；外层catch只记录警告，不重建admission。runs即便已落盘也只有诊断尾部、hash、ref等，没有完整header/body/script快照（`subscription-runs.ts:28–50`），没有从runs重建待办的启动路径。ledger的acceptedRequestEvents（`index.ts:3978–3988`）恢复的是已接受成功，不是此处失败payload；manual replay依赖delivery行（`:3941–3944`）。旧的同provider delivery记录可能本来存在，或者provider未来重新投递，但都不保证包含/恢复这一次payload，不能算这次202承诺的内部durable retry。

证据分级：**两次独立持久写、无公开跨表事务、无保证恢复此payload的内部来源，均已静态确认；实际注入“delete成功后、delivery put前/失败”的进程中断/存储错误及重启结果，未运行。** 因而记录为“已静态定位的非原子恢复缺口，丢失结果待故障注入验证”，不是现场已复现事故。`subscription-host.spec.ts:1044–1082`验证正常耗尽迁移，`:1304–1320`验证队列仍在时的关闭重开；两者都不覆盖该中间失败点。只补材料，未改生产代码、测试、Harness或启动重型检查；本分工到此收口。

设计复核（Team `4af67bb2` 加工作树中的 01）：接收记录现在先落盘为耗尽，再写失败记录和移除待办（`index.ts:4360–4392`）。现有故障注入覆盖失败记录写入或接收记录删除失败。新增验收是另外两个断点：失败记录已写、checkpoint 计数未写（`index.ts:4427–4442`）；计数已写、ledger 暂停未写（`:4444`）。恢复会把已有失败记录当作计数完成，因此这两个断点都可能留下错误的订阅状态。编辑的 ledger 写入不经过失败收尾的锁（`:4967–4971`）；人工恢复先写 ledger 再清零，原请求重试走回执分支（`:5150–5158`）。09 的故障注入须覆盖这些边界。

已发布 Team `v0.2.7` 的接收状态不含 `exhausted`，订阅存储为 v4。Team 自带 SQLite 后端冷开时先检查单元版本，再由 Harness 校验记录；现有 `storage-sqlite-compat.spec.ts:177–216` 只验证通用的版本升级机制。08 仍须用历史订阅数据验证格式升级，不能由这个通用测试代替。
