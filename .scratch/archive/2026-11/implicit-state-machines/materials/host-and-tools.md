# Host 总协调与模型工具审计

状态：审计完成；2026-11-10；基线 `7076dbd2578641ef5b20a773a8191a7178d1b937`。补齐其他四域之外的总协调、恢复、通知、存储资源与工具接缝。状态名是审计记号，不声称仓库已有同名 enum；源码与测试是行为权威。

## H1 — Host 启动、服务、排空与关闭

- **状态/事件：** 初始化存储/注册投影/恢复 Member 与订阅 → 服务 → effect dispose 排空 → 关闭。`packages/agent-team/src/index.ts:958 [Service.init]`、`:1029–1068`。
- **守卫/权威：** `accepting/requireAccepting` 是进程准入，不是领域状态；`openTeamStorage`（`:595`）在 Team 自己的 realm 挂存储，不替换全局 facility。
- **副作用/恢复：** 先 stop scheduler 等在途结果，再释放 shutdown/turn waits、清 timer、唤醒变化订阅、排空 lifecycle/reminder，最后释放 handles、关 domain/backend。不能简化为清 timer；重启从 ledger、Session、admissions 重建，不保存 promise。
- **测试/裁决：** `subscription-host.spec.ts` 的 shutdown/in-flight、`member-lifecycle-core.spec.ts`。保留框架 effect 和顺序；不宣称原子启动，不引入平行 Host store。

## H2 — 按 Member 隔离的生命周期链

- **状态/事件：** 无链 → 等前序 → 执行 → fulfilled/rejected → 清尾；同 key 可重入，不同 key 独立。`index.ts:5246–5267 enqueueLifecycle/enqueueAddition/chainLifecycle`，key 为 Member 或 add requestId。
- **守卫/权威：** enqueue 检查 accepting；AsyncLocalStorage 防同链自锁；返回原 result，保存吸收 rejection 的 tail，失败到调用者但不毒死后续操作；仅当前 tail 可删 map entry。
- **副作用/恢复：** 能力应用/暂停/删除/换代由各域实施，链 settled 不等于 commit 或应用成功；关闭排空，重启按 ledger 意图协调。
- **测试/裁决：** `member-execution-isolation.spec.ts`、`member-tool-policy.spec.ts`。保留：UX 不让 A 的长 turn 卡 B，DX 错误不毒队列，AX 保每个 Member 的顺序；不加全局锁。

## H3 — 变化流监听与失效合并

- **状态/事件：** 注册 waiter → baseline → 等待/合并 version → yield → abort/dispose/finally 注销。`index.ts:1211–1244 changes` 先订阅后 yield，防初次读取期间漏提交。
- **守卫/权威：** pending 只是失效提示，可合并中间版本；`emitChanged/changeVersionOf`（`:5217–5236`）区分 durable projection sequence 与 process-local presence epoch。
- **副作用/恢复：** abort 唤醒，finally 删 waiter；重连拿 baseline 后重读 projection，不能按通知次数推算业务事实。
- **测试/裁决：** Host `change-scopes.spec.ts`、Client `team-shared-reads.client.spec.tsx`。保留；不把实时流当第二份持久账本，不因实时流存在删除 mutation 回读。

## H4 — Inbox 覆盖、投递、消费与重试

- **状态/事件：** durable 欠账 → 规划 notice → queued/coverage → claimed/discarded/失败 → 清 coverage 再派生。`index.ts:4937–5065,5094–5121,5183–5211`；`inbox-delivery.ts:75`、`inbox-notice.ts:84` 是纯 planner/renderer。
- **守卫/权威：** ledger unread/reminder occurrence 才是欠账；covered 只表示某通知回答的具体事实，不是 signature 或已读。自己的 discard 与未预期丢弃分开；queued 不等于模型已消费。
- **副作用/恢复：** 失败清 coverage 保留 attempt；reminder 在 inbox claimed 才写消费，写失败保持 owed 并有界重导（`:4654–4698`）。重启由 durable 欠账重建，允许通知重派，不重复造领域事实。
- **测试/裁决：** `inbox-delivery.spec.ts`、`member-reminders.spec.ts` 及 `member-lifecycle-core.spec.ts` 集成测试。保留：UX 不丢提醒，DX 区分 enqueue/claim/commit，AX 不把摘要当全文。不加通知账本，不乐观清 unread。

## H5 — 运行错误恢复 episode

- **状态/事件：** 无 episode → 可恢复错误/计数/timer → wake 或上限 stood-down → clean-turn/不可恢复错误/wake失败/释放/关闭清理。`recovery.ts:125–219 RecoveryCoordinator`。
- **守卫/权威：** 分类决定重试；stood-down 不自动花 turn；clean turn 才结束连续错误 episode。每个 Member 独立，不改变 Task/Claim。
- **副作用/恢复：** timer settle 删自身；stop/dispose 清 timer 并报告原因；错误预算是进程级，重启不保留，不能冒称跨重启限额。
- **测试/裁决：** `packages/agent-team/tests/recovery.spec.ts:57–177`。保留有界恢复与可解释原因；不把无限自愈当 UX，不引入 FSM 框架。

## H6 — SQLite backend/unit 资源协议

- **状态/事件：** opening → usable/failed；unit 同步占名 → materialized/撤占；close → closing → closed。`vendor/storage-sqlite/index.ts:75–186`、`unit.ts:38–218`；schema 迁移是存储版本协议。
- **守卫/权威：** closing/failed 拒绝 open；占名防并发 double-open；缓存 close promise，等已打开 unit 后关 DB。存储失败不能当空 Team。
- **副作用/恢复：** SQLite 文件持久，promise 不持久；单次写/batch transaction/两个独立 await 不同，同一个锁不能推出跨写原子性。
- **测试/裁决：** `storage-sqlite-compat.spec.ts`。保留 vendored fork 的上游一致性约束；不为风格重写，不改 Harness。订阅转 failed-delivery 的风险另见订阅材料。

## T1 — 工具寻址、执行身份与拒绝恢复

工具包六个源码文件全部纳入：`index.ts`、`host-access.ts`、`reading-budget.ts`、`subscription.ts`、`main-stream.ts`、`activity-view.ts`。九工具为 `team_inbox/attention/thread/dm/message/task/view/reminder/subscription`；定义、schema、renderer 不是九个持久状态仓。

- **状态/事件：** 参数归一 → Agent/Host/Member/Workspace 寻址 → query/Host mutation → structured result → 模型输出。`host-access.ts:10–55`、`index.ts:216–218` 与各 execute。
- **守卫/权威：** 多 Workspace 必须指定，缩写必须足长唯一，不按 cwd 猜；`agent-team:tool:${agentId}:${callId}` 进入 Host 幂等协议。旧 channel ref 只做归一；工具不维护 revision/membership 平行权威。
- **副作用/恢复：** 修改经 Host；stale/unread/ownership 拒绝带具体下一步，同 requestId 不可换 payload。DM 已持久但 wake 失败不同于未发送（Host `AgentTeamDmDeliveryError`）。main-stream/activity-view 是纯投影；subscription 是 adapter，不另建 scheduler。
- **测试/裁决：** `team-addressing.spec.ts`、`team-rejection-payload.spec.ts`、`team-tools-render.spec.ts`、task/reminder/subscription action 测试。保留稳定 ref、结构化拒绝与非乐观修改；清晰 interface 优于新状态缓存。

## T2 — 有界读取、分片、确认与取消（已修复）

- **状态/事件：** 求模型容量 → 预览 → 输出预算内选完整事实/首个缺片 → Host 确认完整前缀 → 呈现；取消/超大/不可分事实在确认前拒绝。`reading-budget.ts:7–23,63–137`、`index.ts:725,778–785,881–886`。
- **守卫/权威：** history 不解析模型容量/不确认；message 查询恢复分片但不确认；read 只确认可呈现完整前缀。当前 context surface 决定缺片，不新增持久读取进度。UTF-16 保守限额不冒称 tokenizer；固定输出32KiB与模型容量是两约束。
- **已复现缺陷：** 已取消且缺元数据原逻辑直接默认容量；元数据请求取消 reason 非 `LlmError('aborted')` 时 catch 当普通失败降级。现于入口及 catch 降级前加 `signal.throwIfAborted()`，保留 await 后检查。普通失败仍降级256KiB，取消保留 caller reason，不继续到 Host read/ack 路径。
- **回归证据：** 新增 `reading-capacity.spec.ts` 五项：预取消、resolve时取消、reject时自定义reason、普通失败降级、窗口预留。先红后绿日志在忽略的 `artifacts/state-machine-audit/reading-capacity-{red,green}.log`；连同寻址/拒绝共22项通过。完整套件见综合报告。
- **裁决：** 最小 guard，不改正常容量/工具输出/已读协议；UX 停止即停止，DX 取消与降级分流，AX 不因取消继续阅读/确认。不扩展成框架全局取消改造。

## 完成边界

这是静态协议审查加 T2 红绿证据，不是任意异步交错的形式化证明。没有 UI 改动、新浏览器验收或真实模型调用。纯 text/time-format、类型、生成 Remote facade、CSS 不因含 kind/status 就计为机器；跨域风险与最终验证由综合报告收口。
