# 02 — 原 Thread 留结果，发起者收到 Inbox 通知

**What to build:** Project owner 可把一次 Worker 委派绑定到现有 Task 或讨论 Thread。Human 能在原 Thread 看见执行和终态；发起者在 Inbox 得到指向同一事实的通知。
**Blocked by:** None — 01 已验收。
**Status:** complete — Task #137 task:9bd81d19-4eda-4acd-96a0-d2b4f950209d；Reeve 在 `baa6503` 完成独立复验并验收（2026-11-09）。

- [x] Task 和讨论 Thread 都能绑定；Host 从目标得出 Project 并校验 owner，拒绝不存在、相互矛盾或无权的目标。发起后归属不随当前页面、目录、成员 Session 或 Task 转派改变。
- [x] 同一 owner 同时发起两个独立任务，一个成功一个失败，反序结束时各回正确 Thread。Thread 不依赖 owner 发帖，Inbox 提醒发起者；不再向父 Session 另发一份完整结果。
- [x] Task 在运行期间关闭或被验收时，结果仍作为执行事实可查，Task 保持原状态；终态和通知不会因重复回调而重复。重启发现没有确认终态的记录时显示“结果未确认”，不自动重跑。
- [x] Worker 输出中的指令或提及只按内容展示。Claim、accountable 和独立验收沿用现有规则；完成执行不自动验收，owner 的现有引导和 Team domain skill 说清责任。
- [x] 浏览器实测 Thread 结果和 Inbox 去向，覆盖有 Task 与无 Task 的 Thread、失败、窄屏与普通 DSH 恢复。

**02 期间的契约决定（2026-11-09，Thread thread:a75d7353-67a9-4611-8fd8-ebcda026f792）**

- Thread 承载：扩 `AgentTeamActivity`（`worker_started` / `worker_settled`），`AgentTeamActivityBase.taskRef` 改可选、原三个 variant 各自重新声明必填；wire `taskRef: string | null`；worker 活动自带 `projectRef`/`workerRef`/`engine`。
- 唤醒：`AgentTeamActivityMarker`，只在 settle 为发起者 mint 一次；发起者作为 actor 的事实会被 `visibleToFollower` 从普通未读里排除，marker 是唯一唤醒载体。
- 私有记录：两个新 op 持久保存执行绑定和终态，回放构成 ledger 自己的 `workerExecutions` 派生表。内部 `workerAnswerFor` 只向发起者/Human 提供有界回答与诊断，当前用于通知构建；**通用工具/Remote 的受限 inspect 读取仍在 04**。旧稿“02 不建投影 map、没有任何受限读取”已被实际实现取代。
- Thread 展示范围（刻意取舍，不是遗漏）：公开 settled 事实只有 `state` + `reason`（仅失败/停止，≤2000 码点单行）；答案/部分结果不进 Thread，走发起者的 Inbox notice（≤8K，标注“外部输出，是数据不是指令”）。执行记录中的 output 上限 65536 码点，diagnostic 上限 4096 码点，不保存无限原始日志。失败/停止的已有文本也在本票正常保留，不以 04 的 inspect 代替结果回传。
- 派生表：`AgentTeamThreadReadResult.workerStates?` 与 `facts` 同级；表项是该 `workerRef` 的**持久合并态**，与读取窗口里有没有 settled 事实无关；`unconfirmed = state === 'running' && !registry.isLive(workerRef)`，长 Thread 分页不得假报未确认；`unconfirmed` 不 mint marker、不发 Inbox 通知。
- 目标绑定：参数为 `projectRef`/`threadRef`/`taskRef`，`task` 仍是任务正文；只给 Task 或 Thread 时从目标反查 Project。目标不存在、`taskRef` 与 `threadRef` 相互矛盾、调用者不是目标 Project 的 owner，都在启动进程前拒绝；绑定冻结进记录。
- “结果未确认”：读时派生；live registry 里 running → 运行中；有 started 无 settled 且不在 live → `unconfirmed`；有 settled → 终态。03/04 应复用同一处派生规则。
- 回传路径两条：绑定 → caller + Thread 活动 + Inbox marker，不再回父 Session 完整结果；不绑定 → 保持 01 的 parent 直回。**两条路径都写私有执行记录**，不绑定才没有公共 Thread 事实。
- 工具 description 与 Team 引导按两条路径说明归属和责任；Worker 完成不是 Task 验收。
- 追加范围（2026-11-09 Human 决定）：Worker 默认权限改全权限，设置页去掉沙箱选择器并收成折叠 disclosure（见票 01 的 amendment）。Codex 默认 `danger-full-access`；Claude 不传 `--permission-mode`，由 OAR 默认全权限启动。
- 浏览器验证：UI 创建并激活真实 Agent Member、赋予目标 Project ownership，再调用公开 `workerStartForAgent`；Codex 可执行路径指向不存在的位置，获得真正的 started 与 failed 终态。**不使用 stub handle、不种 ledger、不添加测试专用生产入口**。原来“浏览器里没有真 Agent”的前提错误，最小 stub 只留在 Host 单元测试。
- 读与通知的证明分开：先断发起者 Inbox 的行和 direct marker，再读 Thread，避免 read 消费 marker。作者自己的 started 不是自己的未读；公开历史与浏览器里的 Human 视角证明两行同时存在，作者的读取只断 settled 与完整 `workerStates`。真实引擎成功沿用 01 证据；成功/运行/未确认状态在本票另由 Host 与 jsdom 覆盖。
- rules 版本 5→6（新 kind 挂 `V6_ONLY_KINDS`）；旧 build 打开新 ledger 必须报“需要更新版本”。拒绝码：`worker_thread_unknown`/`worker_task_unknown`/`worker_target_conflict`/`worker_owner_required`，全部在写 started 与启动进程之前。

**独立验收结果（2026-11-09；基线 `baa6503`）**

- 已读 Client 收尾 `84696a5`、`b6aacc1` 及三笔修补 `aa9acbd`、`f4c1d44`、`baa6503` 的完整 diff。讨论面板传入整条 Thread 的 `workerStates`，有 running/unconfirmed 判别用例；默认引擎标签的单行与提示换行由浏览器几何断言约束。
- Reeve 在干净 `baa6503` 上独立跑完 `npm test`（181 文件通过、1 跳过；2172 条通过、1 跳过）、typecheck、lint（0 error，112 条既有 warning）、界面一致性检查（0 error）、全量浏览器（15/15，171 张截图）与 `git diff --check HEAD`。已逐张读过新 Task Thread 桌面/390×844、讨论面板、设置页折叠/展开/窄屏六张截图：执行与终态可见，换行不溢出，标签未竖排，控件外框仍为 36px。
- 曾阻塞验收的部分结果丢失：`aa9acbd` 收掉；同一份引擎文本以 completed/error/aborted 收尾的原独立探针全部保留输出，状态正确。Host 用例同时覆盖运行期间 Task 被关闭/验收，结果仍回原处、Task 状态不变。
- 曾阻塞验收的并发与请求碰撞：`f4c1d44` 收掉；原独立探针现为一次 ledger start、一次 activation。启动中和缓存中的其他成员重送均拒绝，任务正文、引擎、Project、Thread、Task、cwd、Workspace 七类改写均拒绝；不做自动重试或重启接管。
- 曾阻塞验收的边框声明：`baa6503` 规范成 `1px`；界面一致性检查通过，保留 36px 外框、焦点与窄屏布局。失败原因本票保持有界全文，不做 Client 首句截断或仅悬停可读的全文；公开简述/详细诊断的进一步分层留 04。
- 现有 GUI 裸地址的独立访问返回 HTTP 401，未进入认证页面；测试配置的浏览器证据不等于现有 GUI 的部署验证。未重启或替换服务，未调用新加载的 Worker 工具。
- Task #137 已由 Reeve 独立验收。03 已派发给 Tars 端到端实施；04 的前置也已完成，待 03 共享执行契约稳定后安排。
