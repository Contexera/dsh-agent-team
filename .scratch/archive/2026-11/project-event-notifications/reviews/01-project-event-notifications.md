# Review 01 — project-event-notifications（Member 提醒与 Project 订阅，工作项全量）

**Conclusion:** Changes needed
**Work item:** `.scratch/archive/2026-11/project-event-notifications/`
**Ticket:** Whole work item（01–06 与 Bug-Check-Fix #43）
**Compared:** `ab174c0..07f9217`（master）
**Commits:** 08c3e4b docs · 81c27a1 fix(mention picker，范围外) · dacac94 01 · c6aef03 02 · 6def0c0 03 · 400c016 04 · 1ee5090 #43 · 56275ae 05 · 07f9217 06
**Reviewed:** 2026-11-04

master 与组合分支 `feat/project-event-notifications`（`03c99ed`）内容一致（diff 为空）。审查期间 HEAD 又前进了一个与本工作项无关的 `d2f11c6`（仅动 `.scratch/`），不在本报告范围内。

## Findings

### 高 — 提醒唤醒定时器超过 24.8 天时溢出为 1ms 自旋

**Location:** `packages/agent-team/src/index.ts:4610-4619`（`armMemberReminderTimer`）
**Evidence:** `delay = at - Date.now()` 直接传给 `setTimeout`。Node 对 >2^31-1 ms 的 delay 静默改为 1ms 并刷 `TimeoutOverflowWarning`（本机探针实测：请求 2,308,964,700ms，实际 `_idleTimeout === 1`）。`{kind:'cron', expression:'0 9 1 * *'}` 在 2026-11-04 的下次唤醒约 26.7 天，即触发；`once` 远期与长 `every` 同理（`every` 无上限校验）。
**Impact:** 建"每月 1 号"提醒后，Host 进入约每毫秒一轮的 重新评估→重排定时器 循环，CPU 空转、持续告警日志，直到距到期不足 24.8 天。提醒本身不会误触发（plan 会挡），属可用性缺陷而非数据错误。现有测试全部使用已过期时间，该路径零覆盖。
**Basis:** ticket 01"到时间后唤醒"；正确性推理（Node `setTimeout` 溢出语义）。
**Suggested fix:** `delay` 截断到 `2^31-1`（到期前再重排一次），或超限时改为粗粒度轮询。

### 中 — `subscription-webhook-reset` 在 Main stream 渲染为"删除了订阅"

**Location:** `packages/client-agent-team/src/client/TeamMainStream.tsx:186-192`；`packages/client-agent-team/src/client/locales.ts`（中英均无 reset 键）
**Evidence:** kind 三元链只枚举 created/updated/paused/resumed，`subscription-webhook-reset` 落入 else 分支渲染 `mainSubscriptionDeleted`。`ledger.ts:1210` 为 reset 写入该 kind，`ledger.ts:5073` 投影进 Main stream；无任何 client 测试覆盖 reset 的渲染。
**Impact:** 重置地址这条 durable 生命周期事实在 Human 审计面上被改述为"删除了订阅"，且 `'agent-team'` 字面量会作为 actor 名漏进中文界面。
**Basis:** 根 AGENTS.md"UI 不维护平行权威 / 一个领域概念一个权威 formatter"的实质；正确性（对 durable fact 的错误陈述）。
**Suggested fix:** `locales.ts` 中英各加 `mainSubscriptionWebhookReset`，三元链加一个分支。

### 中 — 暂存的 webhook 批次按"当前"revision/scriptHash 接受

**Location:** `packages/agent-team/src/index.ts:3741`（配合 `holdAdmissionEvents` 3705-3712、`acceptFreshEvents` 3324-3365）
**Evidence:** `holdAdmissionEvents` 只把 `heldEvents` 写回 admission 行，不保存 `receivedRevision`/`receivedScriptHash`；腾出空间后 `enqueueHeldAdmission` 以 `writableSubscription()` 的**当前**记录调用 `acceptFreshEvents(live, fresh, …)`，账本接受操作取 `subscription.revision` 与 `subscription.script.sha256`。
**Impact:** 投递在 r1（脚本 A）跑出的事件，若期间 owner `update` 到 r2，会被记成 r2/B 的产出——违反 spec §4.8"每次运行固定 subscriptionRevision 与 scriptHash；迟到结果按 r1 基线处理并标注"。账本由此认可一对从未共存的 revision/hash 组合。现有 hold→accept 测试（`subscription-host.spec.ts:821` 起）没有在中间插一次 update。
**Basis:** spec §4.8；ticket 02 第 6 条。
**Suggested fix:** 暂存时把接收时的 revision/scriptHash（或整个 `replaySource` 快照）一并写入 admission 行，接受时用它构造 source。

### 中 — create/update/resume 的 requestId 幂等重试会重新执行试运行脚本

**Location:** `packages/agent-team/src/index.ts:4268-4276`（create；update/resume 同构）
**Evidence:** `trialSubscriptionRun` 在 `ledger.createSubscription(requestId, …)` **之前**执行；账本的幂等去重发生在试运行之后。同 requestId 重试（工具侧 requestId 为 `agent-team:tool:<agentId>:<callId>`，同 call 重试即同 id）会把脚本真实再跑一遍（最长 60s、有网络副作用），然后账本才返回存量对象。
**Impact:** ①"创建/更新只执行一次"对脚本副作用不成立；②若第二次试运行偶发失败，工具返回 `trial-failed` 而订阅其实已建成功——Agent 很可能换 requestId 再建一个，造成重复订阅并误耗每 Project 20 个上限。
**Basis:** spec §4.5"响应丢失时按 requestId 幂等重试……不得静默新建订阅"；正确性推理。
**Suggested fix:** 试运行前先查 `ledger` 中该 requestId 是否已提交，命中则直接返回存量写结果（并说明地址不可再取回）。

### 中 — 暂停/积压的 interval 订阅每秒一次 durable checkpoint 写

**Location:** `packages/agent-team/src/subscription-runtime.ts:236-243`（skip 分支无条件 `saveDue`）；`subscriptions.ts:421`（paused → 'skip'）；`TICK_MS = 1_000`
**Evidence:** `scheduleAction` 对 paused 在到期判断之前就返回 'skip'，skip 分支每个 tick 都执行 `saveDue(live, now + interval)`（durable put）。注释自述"A paused or backlogged subscription does keep moving its due instant, or every tick would re-decide it"，未计写入成本。
**Impact:** 每个暂停（含自动暂停，可能长期）或积压满的 interval 订阅每天约 8.6 万次落盘，磁盘写放大、checkpoint 写锁被持续占用；UI 的 nextRunAt 永远显示"10 分钟后"的假象。现有测试只断言单次 skip 不计失败，无连续 tick 断言。
**Basis:** 正确性/资源推理；spec §4.6"连续失败计数是独立持久化的运行 checkpoint"不要求每秒维护 dueAt。
**Suggested fix:** skip 分支仅在 `now >= checkpoint.dueAt` 时推进 dueAt（与积压满的语义一致），或恢复时再计算 dueAt。

### 中 — 同一到期点可能在结果落盘前被下一 tick 再次执行

**Location:** `packages/agent-team/src/subscription-runtime.ts:343-356`
**Evidence:** `launchTimer` 的 finally 在 `settleOutcome`（内含 `saveDue` durable 写）之前就 `running.delete`/`runningDue.delete` 并 `void this.admit()`；此窗口内 1s tick 的 `timerPass` 读到旧 `dueAt`、`busy === false` → 同一到期点再次入队执行。
**Impact:** 一次到期偶发执行两次脚本。事件靠 id 去重不会重复发布，但多一条运行记录；两次结果不一致时（一次瞬时失败一次成功）会扭曲连续失败计数，可能导致提前自动暂停或错误清零。`scheduleAction` 注释显式承诺"到期的运行只发生一次"，无测试覆盖 settle 窗口。
**Basis:** spec §4.3"定时触发时，如果上一次还在运行，本次跳过"的语义边界；正确性推理（时序竞态，未跑并发验证）。
**Suggested fix:** 把 `runningDue.delete(ref)` 移到 `settleOutcome` 完成之后。

### 中 — 输出中合法的 U+FFFD 字符被判为非法 UTF-8

**Location:** `packages/agent-team/src/subscription-runner.ts:277-281`
**Evidence:** `stdout.includes('\uFFFD')` 即判 `invalid-utf8`。注释自述这是"拒绝脚本从未以 UTF-8 打印的输出"的唯一手段——但真 U+FFFD（EF BF BD）本身是合法 UTF-8；脚本抓取的外部标题若本就含"�"，整次运行失败。
**Impact:** 该数据永远无法投递；连续 3 次即自动暂停订阅。spec §4.4 要求"按原始字节校验合法性"，执行器只回已解码文本，当前启发式把合法字符与替换痕迹混同。
**Basis:** spec §4.4；正确性。
**Suggested fix:** 优先用执行器原始字节校验；不可得时把 U+FFFD 降级为"需要 owner 注意的告警"而非整次失败，或仅在该行 JSON 解析失败时报错。

### 中 — 定时运行的 `deferred`（单批 ≤500 但余量不足）计 1 次连续失败

**Location:** `packages/agent-team/src/subscription-runtime.ts:377-387`；测试 `subscription-runtime.spec.ts:235` 固化
**Evidence:** webhook 侧 `deferred` 明确不计失败（`index.ts:3692-3693`）；定时侧同语义计 1 次失败并有测试固化。
**Impact:** 订阅 5 分钟一次、每批 ~150 条、余量 400 时，每次 `deferred` 都计失败，15 分钟后健康订阅被自动暂停并通知全部 owner。spec 只把"总量已达 500"定义为跳过不计失败，"余量不足"在定时侧未定义——这是未收敛的语义边界，需产品判断。
**Basis:** spec §4.4（"单批不超过 500 条、只是现有余量不足时……也不计失败"该句主语是 webhook 投递；定时侧缺定义）；ticket 02 第 7 条可支持现状。
**Suggested fix:** 判定是否为设计意图；若否，定时 `deferred` 走"推进 dueAt、不计数"路径，并补 spec 侧定义。

### 中 — 归档 Project 读订阅列表直接报错，与 CHANGELOG/文档声明相反

**Location:** `packages/agent-team/src/ledger.ts:1369`（`activeProject` 对归档抛错）→ `assertSubscriptionReadAuthority`（`ledger.ts:3673`）→ `listSubscriptions`（`index.ts:3412`）；声明见 `CHANGELOG.md:10`、`docs/frontend-design/components.md:208` 段
**Evidence:** Host 对归档 Project 的订阅列表读取抛 `Project '…' is archived`，页面 `loadSubscriptions` 失败后只渲染错误行（`TeamSubscriptionsTab.tsx:137-143`）。CHANGELOG 写"an archived Project reads the list read-only"、components.md 的"防御形态"段落描述归档后仍可只读——均不可达。
**Impact:** 归档后审计面丢失订阅列表（连只读都不可得），与三处维护文档/发布说明相矛盾。
**Basis:** ticket 04"非 owner 只能看到只读视图"的防御形态描述；根 AGENTS.md"文档不得定义代码未实现的行为"。
**Suggested fix:** 二选一：读路径对归档放行只读（写路径已拒）；或修正 CHANGELOG 与 components.md 的声明。

### 中 — 维护文档"表单只提供定时触发"已过时

**Location:** `docs/frontend-design/components.md:208`、`docs/frontend-design/components.zh.md:119`
**Evidence:** 文档写"The form offers the interval trigger only until webhook ingress exists / 表单只提供定时触发，直到 webhook ingress 落地"，而本范围已落地 webhook ingress，表单提供两种触发（`team-subscriptions.client.spec.tsx:231`、browser e2e `team-subscription-webhook` 均从表单建 webhook-only 订阅并通过）。
**Impact:** 维护文档与同范围发布的实现相反。
**Basis:** ticket 05 第 11 条（表单展示 webhook 触发方式）；根 AGENTS.md 文档纪律。
**Suggested fix:** 删掉或改写这两句。

### 中 — 页面 replay 没有版本选择

**Location:** `packages/client-agent-team/src/client/TeamSubscriptionsTab.tsx:498`
**Evidence:** 页面 `replaySubscriptionDelivery` 从不传 `version`；Host/Remote/工具已实现 `version: 'current' | 'received'`（`index.ts:3966-3975`、`tool-agent-team/src/subscription.ts:225`）。
**Impact:** 页面只能按当前版本重放，"接收时版本"一档对 Human 不可达；spec §4.6 写明"Host、Remote 和页面同一契约"。
**Basis:** spec §4.6；ticket 03 第 6 条（工具层已满足）。
**Suggested fix:** 失败投递行的重放入口加版本选择（默认当前版本）。

### 中 — check:comments 的 agent-team 预算被设为当前精确计数，零余量

**Location:** `scripts/check-comments.mjs:104-110`
**Evidence:** 实测 `packages/agent-team/src 4162/4162`。`ab174c0` 时该 scope 为 2609/4150（余量 1541）；本范围把计数推到 4162 并把预算同步改成 4162。脚本头部两处把"零余量"记为历史事故（"sat at exactly 1900/1900 … went over on the first two following commits"），并写明预算应为"审计计数 + 约 3% 余量"。
**Impact:** 下一条新增注释的提交即触发 `check:comments` 失败；预算从此不再度量漂移。
**Basis:** `docs/development/start-and-checks.md` 的 check:comments 规则与脚本自述。
**Suggested fix:** 按脚本自己的公式把预算落到 ~4285（4162 + 3%），或把注释压回 ≤4150。

### 低（汇总）

- **注释引用不可解析的 `spec.md`**：`index.ts:3322,3660,3665`、`subscription-webhook.ts:119,153`、`subscription-admissions.ts:3,24`、`scripts/e2e/support.ts:81` 共 7 处引用只存在于 `.scratch` 归档的 `spec.md` §x。机械规则只拦字面 `.scratch/`，但规则理由（"published package 的读者解析不了"）同样适用。改为指向 `docs/architecture/host-authority.md` 等维护文档或删除出处。
- **host-authority.md 私有表数错**：`host-authority.md:157,161`（及 zh:139）写"three tables"，实际 `subscription-store.ts` 有 `runs`/`deliveries`/`replays`/**`admissions`** 四张非 checkpoint 表，admission 队列的恢复语义散在散文里。补第四张表。
- **package README 缺新契约**：`packages/tool-agent-team/README(.zh).md` 8 条工具 bullet 缺 `team_subscription`（`team_reminder` 已加）；`packages/client-agent-team/README(.zh).md` 只写了 `memberReminders`，11 个订阅 Remote 全部缺席。AGENTS.md 要求公共契约变更同步 package README。
- **死代码与重复权威**：`subscription-runs.ts:24-29,265-272` 的 `SUBSCRIPTION_DELIVERY_RETRY_MS`/`ATTEMPTS`/`deliveryRetryDelayMs` 全仓零引用，与 `subscription-webhook.ts:24-27` 的生效常量重复（两份写法已不同）；`subscription-admissions.ts:96-113` 的 `failedDeliveryOf`/`failedDeliveryKeyOf` 零引用，且其 `body` 字段语义与生产路径（`webhookStdin` 信封）不符，复用会喂错 stdin；`member-reminders.ts:422-427` 的 `reminderWallClock`/`REMINDER_HORIZON_DAYS` 死导出；`subscription-webhook.ts:106` 的 `WEBHOOK_HEADERS_LISTED` 空数组是无消费者的扩展点。删除即可（替代物：nothing / 生效常量）。
- **单 Host 部署约束未落地**：spec §7"禁止共享 home 同时启动两个 Team Host，并提供启动前检查或醒目告警"与 §9 文档出口——全仓无检查、无告警、无文档。
- **cron 搜索地平线 5 年**：`member-reminders.ts:31`（`5 * 366` 天）。2 月 29 日 cron 的下次匹配可跨 8 年（2096→2104），期间 `nextOccurrenceAt` 返回 undefined，提醒静默不再触发、不武装定时器、无日志。地平线放宽到覆盖下一个 2 月 29 日即可。
- **状态码超出契约表**：实现返回 431（header 超长）/415（非 identity 编码）/400（非 UTF-8），spec §4.5 表与 `host-authority.md:203` 的契约表均未列。行为合理，补表。
- **发布额度并发可超发 1 条；时钟回拨重置窗口**：`subscription-runtime.ts:427-434`，两个并发 pass 用锁外读数算预算；窗口用 `floor(now/60000)`，回拨跨分钟即清零可再发 20 条。影响小，锁内判定即可。
- **create/reset 幂等重试不说明"地址不可再取回"**：`index.ts:4276` 重试命中返回 `changed` 且无 `webhookAddress`、无说明；spec §4.5 要求结果本身说明。目前只有工具描述与页面文案承担。
- **spec 两条设计约束未实现**（不在任何 ticket checkbox 内）：积压总预算（条目+字节，§4.4）；自动重试受控 jitter（§4.5，现为固定 1/5/30 分钟）。

### 低（简化项，reviewer 定位、损失评估为"无"）

- 五处"按订阅前缀扫 key"同一约定（`subscription-runs.ts:66,230,328`、`subscription-admissions.ts:62`、`index.ts:3073`）→ 收敛为 `subscription-store.ts` 一个导出。
- 提醒 schedule 的模型可见文本两份且已漂移（`index.ts:5290` vs `tool-agent-team/src/index.ts:1563`）→ `member-reminders.ts` 导出一个共用。
- client 手写 `formatUtc8`（`TeamSubscriptionsTab.tsx:910-916`，魔法数 `8*3_600_000`），与 `time-format.ts` 模块文档"Web Client 不用此模块"的声明冲突 → 用已有导出或移入 `team-formatters.ts`。
- 表单硬编码 Host 上限（`TeamSubscriptionsTab.tsx:634,636,729,742,820,821`：`>= 5`、`16*1024`、`maxLength 80`）→ 经类型/能力下发或删预判，让 Host 拒绝语显示。
- 11 个订阅 Remote 三层逐字段透传（`TeamProjectPage.tsx:37-47` → `:460-463` → `TeamConversation.tsx:27`）→ `slots.ts` 已有 `TeamSubscriptionHost` 类型，props 收成一个对象。
- `notificationText` 第 7 个位置化可选参数（`index.ts:5030`）→ 收成 options 对象。
- 注释残留：`subscription-runs.ts:166-171` 同字段双 docblock（删旧）；`types/entities.ts:392` 孤儿注释 + `:594-595` 多余空行。
- `subscriptions.ts:149-156` doc 自称"在此解码原始字节"，实际调用点传的是 `Buffer.from(stdout,'utf8')`（解码后再编码）→ 对齐注释，说明真正兜底是 U+FFFD 检查。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 01 Member 提醒（8 条） | 8 Met | `member-reminders.ts`、`ledger.ts:1596-1762`；`member-reminder-{ledger,delivery,host,reminders}.spec.ts` 逐条对应（occurrence 消费、替换不叠加、至少一次、补发一次、50/10 分钟、状态变化、详情只读+取消、文档与九工具断言） |
| 02 定时订阅（14 条） | 13 Met, 1 Partial | 13 条落代码+测试（快照/试运行/基线独立/超时与 65536+truncated/4 运行位/UTF-8 启发式/去重跨订阅/revision 固定/500 三段/env 清除与注入/随机启动延迟/归档停止/生命周期入账）。Partial：macOS/Windows/pwsh 真机 sandbox enforcement——ticket 自述为发布前门槛，`materials/harness-sandbox-executor.md` 仅 Linux 实测 |
| 03 运行记录与失败（8 条） | 8 Met | `subscription-runs.ts`、`index.ts:3324-3365,3925-4110`；50 条保留、owner/非 owner 裁剪、唯一线性化点、失败计数规则、update 保基线、replay 契约（工具/Host/Remote 层）、test 不变基线、删除清记录。页面 replay 版本缺口记为 finding |
| 04 订阅标签页（6 条） | 5 Met, 1 Partial | 列表/运行记录展开/试运行后保存+非乐观+失败保留输入/三态与无障碍/Main stream 事件卡片/文档（含过时句 finding）。Partial：390×844 截图与无障碍人工核验——本次 browser 套件通过并产出 153 张截图（含 15 张 subscription 截图），未做人工核图 |
| 05 webhook 触发（11 条） | 10 Met, 1 Partial | 公网配置拒绝/202 durable/独立 WebServer+token 哈希+地址一次/状态码（表外三码记 finding）/stdin 白名单/双通道去重/暂存重试接受/稳定 admission ID/退避与失败投递/重置语义。Partial：页面 replay 同一契约缺版本选择（finding） |
| 06 Agent 指引（4 条） | 2 Met, 2 Partial | 技能文档与 persona 落地；`check:core-skills` 本次随 `npm test` 通过；真实 GitHub CI 验收只有 README 记录（task、事件 ref、33 行日志自述），仓库内无证据文件，本复核无法独立验证 |
| #43 cron 时间窗 | Met | `member-reminders.ts:193-247` 从日程日内间隔与相邻匹配日推导；测试覆盖跨月/跨年/Vixie union |

## Checks run

| Command or check | Result |
| --- | --- |
| `npm run build` | 通过 |
| `npm test`（含 generate:typert、check:facades/docs/core-skills/boundaries/versions/comments + Vitest） | 159 文件：158 通过 / 1 跳过；1953 测试：1952 通过 / 1 跳过 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 0 errors / 100 warnings |
| `npm run check:artifact` | 干净（98 个运行时相对导入全部解析） |
| `node scripts/audit-ui-parity.mjs` | 0 warnings（1 条豁免 info） |
| `git diff --check HEAD` | 干净 |
| `npm run test:browser` | 12/12 通过，153 张截图 |
| node 探针 | setTimeout 溢出（确认 1ms）；`parseSubscriptionOutput` 错误前缀（单前缀，否决一条 candidate）；诊断 spec 确认 activation diagnostic 后已删除 |

首次 `npm test` 曾有 151 个失败（24 个 realHarness 文件）：诊断为本地 `packages/tool-agent-team/lib/` 构建过期（构建于 11-02 22:42，早于新工具提交），realHarness 经 node_modules 自链接加载旧构建导致 `tools.restrict() names unknown global tools`。`npm run build` 后全量通过。非代码缺陷；但"新增工具后不先 build 直接 `npm test`"会以难懂的方式整批失败，值得在 `docs/development/start-and-checks.md` 写明顺序（或让测试 preset 解析 src）。

## Unverified scope and residual risk

- macOS / Windows / pwsh 真机 sandbox enforcement：ticket 02 明确保留为发布前独立门槛。
- 真实 GitHub CI 订阅唤醒（ticket 06 第 4 条）：README 记录了 task id、事件 `ci-run:41171647624` 与 33 行 Session 日志结论，日志本体在 profile 存储中、不在仓库，本复核未独立复演。
- 浏览器截图与无障碍人工核验：README 称验收时已人工核过；本次仅确认套件通过与截图产出，未重做人工核图。
- `81c27a1`（mention picker 修复）在工作项 9-commit 范围内但与 01–06 无关（README 与 tickets 均未提及），本报告未深审其实现，仅确认全套检查通过。归档叙述如引用"9 个 commit 完成本工作项"应剔除它。
- `d2f11c6`（avatar preset 归档整理）在审查期间落到 HEAD，仅动 `.scratch/`，未纳入范围。
- 简化项各条由审查 agent 给出定位，主审抽样核实了死代码/常量重复/文档缺项/预算计数，其余（前缀扫描收敛、Remote 透传等）未逐行复核，实施前按位置确认。
- 三条只读子审查（规格/正确性/标准）各读文件与引用见其报告；主审对其全部关键发现做了代码级复核，其中一条（"line N: 前缀重复"）经探针否决，未列入 findings。
- 本报告首次写于 16:0x，`reviews/` 目录在其后的一次 `.scratch` 并行整理中被整体清掉（未跟踪文件），本文件为按原内容重建，编号不变。

## Review record

- Spec sources: `.scratch/archive/2026-11/project-event-notifications/{README.md,spec.md,issues/01..06}`；spec 自述"实现以 packages/ 源码和测试为准"。
- Standards sources: 根 `AGENTS.md`、`docs/AGENTS.md`、`docs/development/start-and-checks.md`（check:comments 规则）、`docs/architecture/{host-authority,tools-and-preset,client-and-remote,package-ownership}.md`、`docs/frontend-design/components.md`。
- 方法：三个只读子审查（Spec / Correctness / Standards+simplicity）并行 + 主审运行全量检查并对每条关键发现做代码级/探针级复核；范围固定 `ab174c0..07f9217`，`81c27a1` 单独标注为范围外。
- Uncommitted and untracked changes included: 否（工作树干净；`.scratch/…/reviews/` 为本报告新建，未跟踪属预期）。
