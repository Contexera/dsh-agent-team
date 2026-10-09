# 05 — 通知失败与自动恢复可追踪

**What to build:** 一次消息已提交但 Member 未收到通知时，能够由请求或 Member 标识查清提交结果、通知尝试、失败原因及后来是否恢复；自动恢复停止也有明确记录。
**Blocked by:** 01 — 成员配置保存与生效一致
**Status:** complete

- [x] 在真实提交后通知路径注入失败，使用日志关联同一次请求、账本操作、Member 和 Session，确认业务已提交而非回滚。
- [x] 后续重试或新的提交引发再次通知时，可以追溯原有未读事实及本次执行尝试；业务 requestId 与执行尝试身份不混为一谈。
- [x] 区分通知未尝试、已排队、投递失败与恢复停止；排队成功不声称模型已经读取或处理。
- [x] 自动恢复的错误分类、次数、等待、触发、停止与清除有可解释的结果；捕获 wake 异常不能只静默停止跟踪。
- [x] 核对 Session 转换、启动补做和人工恢复的关联信息，既能定位当前代，也能找到相关上一代，不用可改名的 handle 代替稳定标识。
- [x] 复用既有 logger / exporter，保留脱敏后的错误码、调用栈与原因链；不新增业务账本、正文副本或日志平台。
- [x] 常态日志有界，重复通知不会产生无界日志；必要细节可按诊断级别读取，失败记录不依赖开启全部调试输出。
- [x] 保持 Thread Inbox、DM 与模型处理各自的交付语义；用失败、重复通知、恢复成功和恢复停止的行为测试验收，并更新诊断与通知维护说明。

## 完成记录（2026-10-09，提交 `63a9e623`，树 `1fd385f632596a31eb8f5ae36c8c820b019576b0`）

一笔落地（实现＋测试＋双语维护文档）：`feat: trace notification delivery and automatic recovery outcomes`。

**改了什么（三个关联组，都用同一套稳定标识：`memberId` ＋ `sessionId`，handle 只作可读附注）**

1. **通知一次投递一行结论**（`notifyMember` 现带 `cause`）：`commit`（receipt 的 `requestId`／`operationId`／`operation` kind／`sequence`）、`transition`（rollover 的 `requestId` ＋ `previousSessionId`）、`activation`（启动补做／重启，带 `previousSessionId` 时说明上一代）、`running`（Member 自己开跑时的再次派生）。四种结论分级显式区分：
   - **未尝试**（debug）：Agent 不是 Member、Member 非 enabled、无未读事实、或未读事实未变（"already have a delivery attempt"）；
   - **已排队**（info）：写明 `attempt N`、lane（`next step`／`follow-up turn`）与未读事实身份（`N unread Thread(s), newest unread fact sequence S`），结尾固定 `not yet read by the model` —— 排到队不等于模型已读；
   - **折进恢复通知**（info）：steerResume 已把同一批事实并进恢复指令，不再单独排队；
   - **投递失败**（warn）：`attempt N` ＋ `cause` ＋ `failureDetail`（错误名／稳定 code／message，无 stack），并声明 `the operation is committed and stands` 与"签名已清、下一次触及该 Member 的提交会重新派生并重试"。
2. **执行尝试与业务 requestId 分离**：新增 per-Member `notificationAttempts` 计数，只在真正发起投递时 +1；失败不清计数（所以重试是 `attempt 2`，同 `memberId`／`sessionId`，而 `requestId` 是新的那笔）。`notifyMember` 不再把投递异常抛给提交边界：非 invariant 异常就地记 warn 并返回（提交已是既成事实，不该读成回滚）；只有 `AgentTeamInvariantError` 仍按原样抛给调用帧。这同时替掉旧路径上那条无关联信息的 `post-commit notification for '…' failed` 泛化 warning。
3. **自动恢复的每一步都上报**（`RecoveryCoordinator` 新增 `report(fact)`，取代只有 stand-down 的 `onStandDown`）：`scheduled`（错误族、`occurrence k/N`、`wait Nms`）、`woke`（等待到点，debug）、`stood-down`（`k/N` ＋ 不再自动唤醒直到 clean turn 或人工恢复）、`cleared`（`reason` ∈ clean-turn／non-recoverable／wake-failed／session-disposed／manual／host-disposed，带剩余 pending wakeup 数与 stand-down 标记）。wake 抛异常时捕获并带 `failureDetail` 清除跟踪 —— 不再静默。每次 `agent/error` 的分类结论（含"不可自动恢复"与 stand-down 后的重复）落到 debug，default 输出只由状态变化驱动。
4. **人工恢复与转换关联**：`recoverMember` 的各分支日志、`steerResume`（`automatic recovery`／`operator recovery` 两种触发）与全部 `stopTracking` 调用点都改走 `memberScope()` —— Member id ＋ Session id ＋ handle；`finishing the recorded Session transition` 那行额外给出 `previousSession`，人工恢复不再只写可改名的 handle。

**判据 1／2／3（失败、重试、四种结论）**：`post-commit-delivery.spec.ts` 在测试桩上注入真实提交后的投递失败，断言 warn 行同时含 `memberId`／`session 'session:post-commit-delivery'`／`requestId 'wake-fail'`／`operationId …`／`operation 'team/message-sent'`／`sequence N`／`attempt 1`／`Error: wake failed (test seam)`／`committed and stands`，且**没有**泛化 post-commit 行、**没有**任何"已排队"行；同一用例继续走到第二笔提交（新 `requestId`）成功投递，断言 info 行是 `attempt 2`、同一 Member／Session、新 `requestId`、`not yet read by the model`。第二个用例证明事实未变的再次派生**不消耗 attempt、不加 info 行**（只有 debug 的"未尝试"），队列不变。

**判据 4（恢复解释与不静默）**：`recovery.spec.ts` 的 6 个上报用例逐条覆盖 `scheduled`／`woke`／`stood-down`／`cleared` 的 reason 与计数（含"不可恢复错误只在真有 episode 被取消时上报"与 `dispose` 的 host-disposed）；Host 侧 `member-lifecycle.spec.ts` 在真实 Harness 上跑完整序列：一次可恢复错误 → `scheduled … errorKind 'transient network' occurrence 1/3 wait 120000ms` → 到点后 `automatic recovery continuation steered … not yet read by the model` → 连续三次错误 → `automatic recovery stood down … 3/3`。

**判据 5（两代可定位）**：启动补做在 `reissues a needed hint from durable unread state after Host remount` 里断言 `cause Member activation`；Session 转换用 renewal 用例（`reports a renewed generation with the retired Session and the current one`）断言同一行给出 `session '<当前代>'` 与 `previousSession '<退出的那一代>'`；人工恢复在既有用例里断言 `operator recovery continuation steered` 带 Member／Session 并说明"已排队、未被读取"。

**判据 6／7（有界与复用）**：只走既有 Host logger，没有新增账本字段、正文副本或日志通道；错误细节经 `failureDetail()` 统一成"错误名／稳定 code／message"，不含 stack 或凭据；default 级别每状态变化一行，逐次发生的细节（分类结论、事实未变的再次派生）落在 debug，因此重复通知不会产生无界日志；排队行明确不外推模型已读。DM 走它自己的 `dmForAgent` 记录-未投递错误，本次未改其语义。

**未覆盖／边界（如实记）**：① `wake-failed` 这条 reason 在 Host 侧近乎不可达（挂起、归档、移除、转换都会先 `stopTracking`），因此只在 `recovery.spec.ts` 的 coordinator 层断言，Host 模板由 clean-turn 那条 cleared 行覆盖；② `recoverMember` 里"完成已记录的 Session 转换"分支的 `previousSession` 只有代码路径核对，没有对应日志断言；③ 旧的 `hit a recoverable … error; recording a consecutive error occurrence` warn 行被换成分级更清楚的 debug 行（分类结论仍然每次都留痕，只是默认级别改由状态变化驱动）。

**闸门（树 `1fd385f632596a31eb8f5ae36c8c820b019576b0`，即 `63a9e623` 的树；本记录笔只碰 `.scratch/`，`git diff 63a9e623 HEAD -- packages/ docs/` 为零 ⇒ 读数随树转移、不重跑）**：typecheck ✓；`npm test` 1012 通过 / 1 跳过（1013）；lint 0 error、3 条既有 warning；`npm run build` ✓；`npm run test:browser` 6/6；`npm run check:docs` ✓（`memory-and-context.md` 最长块仍 581/581，未抬上限）。
