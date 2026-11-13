# Review 01 — implicit-state-machines-deep（全量实现审查）

**Conclusion:** Changes needed
**Work item:** `.scratch/archive/2026-11/implicit-state-machines-deep/`
**Ticket:** Whole work item（01–14）
**Compared:** `796024fc` 的 HEAD + 当前工作区；与本工作项直接相关的 47 个已跟踪修改、4 个未跟踪实现/测试文件，以及整个未跟踪工作项目录
**Commits:** None
**Reviewed:** 2026-11-12

工作项没有 `spec.md` 或 `DESIGN.md`。本次把 `README.md`、14 张票的验收标准及 `materials/` 作为规格来源；票面要求足够明确，因此不判为 Incomplete。工作区另有 `.agents/`、根 `AGENTS.md`、`.scratch/AGENTS.md`、`.scratch/README.md` 等并行改动，未纳入本结论。

## Findings

### 高 — 主对话重开后只恢复引用目标 ID，不恢复可见引用

**Location:** `packages/client-agent-team/src/client/TeamMainStream.tsx:94-102`、`packages/client-agent-team/src/client/TeamMainStream.tsx:166-168`、`packages/client-agent-team/src/client/TeamMainStream.tsx:179-184`、`packages/client-agent-team/src/client/TeamMainStream.tsx:373-376`、`packages/client-agent-team/src/client/main-stream.ts:151-161`、`packages/client-agent-team/src/client/TeamComposer.tsx:304-311`
**Evidence:** 主对话恢复发送尝试时，只从 `ProjectAddress` 取回 `replyToMessageRef`。引用横幅却要求该 ID 出现在当前 `entries` 中；切到看板再回来时，`useMainStream` 重新读取最新 20 条。临时 jsdom 探针使用 25 条消息，先加载更早消息并引用第 1 条，扣住 `postMainMessage` 成功回执后切到看板再返回：草稿恢复，`[data-reply-banner]` 为 `null`，也没有取消引用入口；再次发送时，`postMainMessage` 仍带原来的 `replyToMessageRef`。探针已删除，未进入最终测试套件。
**Impact:** 被引用消息不在重新加载的最新页时，Human 看不到自己正在引用谁、引用了什么，也无法取消；但重试仍会通知被引用作者。这直接违反票 13 的“回复引用、发送模式与附件在重试前可见”。现有 `team-main-reopen` 只检查主消息去重，没有覆盖旧页引用。
**Basis:** 票 13 的交付说明和第一条验收标准；`packages/client-agent-team/src/client/TeamMainStream.tsx` 中 `replyTarget` 与 `replyEntry` 的分离。
**Suggested fix:** 在发送尝试中随 `replyToMessageRef` 保存最小引用展示快照（发送者、成员 ID、摘要），恢复时直接用快照渲染横幅；或增加按 Message ref 读取引用展示信息的路径。补“引用目标在更早页、导航返回后仍可见并可重试”的回归。

### 中 — 同一打开内的旧关注者读取仍可覆盖刚确认的关注结果

**Location:** `packages/client-agent-team/src/client/TeamThreadPage.tsx:425`、`packages/client-agent-team/src/client/thread-controller.ts:303-309`、`packages/client-agent-team/src/client/thread-controller.ts:396-400`、`packages/client-agent-team/src/client/thread-actions.ts:111-130`、`packages/client-agent-team/src/client/thread-actions.ts:148-150`
**Evidence:** Thread 页面把 controller 的 `followerIds` 作为 `observed` 交给 `useThreadFollow`。controller 的 `refreshFollowers` 只校验仍是同一次打开，没有记录同一打开内多个读取的先后；订阅 tick 可并发启动新的读取。关注写入成功后，钩子自己的有序读回确认 `following: true`，但更早发出、更晚返回的读取仍会更新 `followerIds`，再通过 `observed` 分支无条件 `setFollowing(false)`。临时 jsdom 探针先传入旧空观察集，关注成功变为 `true`，再传入一个返回更晚的旧空集，结果变回 `false`。探针已删除，未进入最终测试套件。
**Impact:** Host 已确认关注成功，按钮却可能退回“关注”并显示 `aria-pressed="false"`；Human 会看到错误状态，并可能再发一次关注。现有 hook 测试只覆盖一次打开内由 hook 自己发起的读取，没有覆盖 controller 提供的 `observed` 与写后读回交错。
**Basis:** 票 10 第二条验收标准：“写后读取也不会被较早发出、较晚返回的读取覆盖。”
**Suggested fix:** 给 controller 的 follower 读取增加同一打开内的序号，并在关注写入成功后提升观察代次；hook 忽略早于最近一次确认写入的 `observed`，只接受当前代次的读回。补 controller + hook 集成的“旧观察晚于写后读回”用例。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 01-1 同一请求 ID 并发上传不同内容拒绝，相同内容重放 | Met | `attachments.spec.ts` 的并发上传与 requestId 重放用例通过。 |
| 01-2 同名同大小不同内容并发发送不覆盖首个附件，已提交字节可读 | Met | `attachments.spec.ts` 的 concurrent sends 用例通过。 |
| 01-3 过期无 metadata/损坏孤立目录可回收，新条目、已引用条目、外来目录和符号链接保留 | Met | `attachments.spec.ts` 的 orphan、partial upload 和引用保护用例通过。 |
| 01-4 提交前暂停清理，成功发送后上传与路径副本仍可读 | Met | 路径附件冲突、失败清理和已引用字节保留用例通过。 |
| 01-5 回归先失败后通过，既有重启、读取错误和保留期测试通过 | Met | `attachments.spec.ts` 全量通过；最终工作区测试为 2,679 项通过、1 项跳过。 |
| 02-1 已知更新、检查失败、确认无更新的刷新序列 | Met | `human-update-check.spec.ts` 的 known update → failed check → not newer 用例通过。 |
| 02-2 关闭开关只停新请求，读取设置不等待网络 | Met | kill-switch 与 disabled/offline 用例通过。 |
| 02-3 回归先失败后通过，缓存和停用测试通过 | Met | 更新检查全量用例通过。 |
| 03-1 已观察终态等待落账有时限，重复停止不绕过确认或写第二次 | Met | `worker-stop.spec.ts` 的 bounded ending 与 repeat refusal 用例通过。 |
| 03-2 注入写入失败后，Agent、Human 回执和 Thread/列表投影不报告确认结束 | Met | `worker-stop.spec.ts`、`team-worker-actions.spec.ts` 通过。 |
| 03-3 Worker 工具保留结构化拒绝码，续跑回执区分回执时刻与当前状态 | Met | `team-worker-actions.spec.ts` 的结构化拒绝与续跑文案用例通过。 |
| 04-1 准入读取失败不丢排队调用，下一轮返回原结果且无未处理异常 | Met | `subscription-runtime.spec.ts` 的 injected admission failure 用例通过。 |
| 04-2 明确删除、暂停、归档仍拒绝，已发布 v5 读取格式不变 | Met | 订阅 runtime、host 和 store 的终态/重放用例通过。 |
| 04-3 耗尽 webhook 留到下一轮，收尾不占执行槽；卸载等待且队列清除 | Met | `subscription-host.spec.ts` 与 `subscription-runtime.spec.ts` 的 shutdown/publication 用例通过。 |
| 05-1 同名替换被执行守卫拒绝，并出现在 Agent 可用性提示 | Met | `member-tool-policy.spec.ts` 的同名替换用例通过。 |
| 05-2 特殊工具名不破坏提示结构，授权工具和基线不多报拒绝 | Met | `member-tool-grants.spec.ts` 的转义、大小写、去重和 malformed-name 用例通过。 |
| 05-3 回合冻结、撤销、无额外许可回退保持；文档区分 capabilityState 与 profile 许可 | Met | `member-tool-policy.spec.ts` 的 turn-boundary/install-failure 用例与双语维护文档通过。 |
| 06-1 恢复指令排队后新 Thread 事实不被覆盖、不抢占，之后仍可投递 | Met | `member-reminder-delivery.spec.ts` 的 recovery coverage 用例通过。 |
| 06-2 被容量省略的 Thread 不计覆盖，空间释放后可投递，提醒在实际 claim 时消费 | Met | `member-reminder-delivery.spec.ts`、`notification-context.spec.ts` 通过。 |
| 06-3 既有重试预算与 Agent 唤醒顺序保持 | Met | 通知和 reminder 回归通过。 |
| 07-1 A 历史读取挂起后打开 B，A 的晚到响应不进入 B | Met | `team-project-panel-switch.client.spec.tsx` 的 late-history 用例通过。 |
| 07-2 历史翻页、未读读取和关注者读取都受同一次打开约束，无新增持久状态 | Met | `thread-controller.ts` 的所有读取均校验 opening generation；切换用例通过。 |
| 07-3 真实 Web 回归并查看 1440×960、390×844 截图 | Met | 浏览器套件 28 个场景通过并生成两档截图；本次未逐张再看，见限制。 |
| 08-1 延迟 A 的成功或失败，B 的输入、消息、报错和发送状态不受影响 | Met | `team-project-panel-switch.client.spec.tsx` 的 committed/failed reply 用例通过。 |
| 08-2 A→B→A 时原回复仍占用原讨论，重开后的新编辑不被旧回执清除 | Met | 同文件的 A→B→A 与 reopened-draft 用例通过。 |
| 08-3 正常发送、打开期间重试、附件和失败保留草稿继续通过 | Met | `team-mode-conversation.client.spec.tsx`、`team-project-panel-switch.client.spec.tsx` 通过。 |
| 09-1 延迟 A 成功不把 B 跳走，新 Task 仍可从 Project 打开；留在 A 时正常跳转 | Met | `team-project-panel-switch.client.spec.tsx` 的 conversion 用例通过。 |
| 09-2 延迟 A 失败只影响 A，B 可独立转换，两次请求 ID 不复用 | Met | 同文件 conversion committed/failed 用例通过。 |
| 09-3 Host 写入协议和校验规则无改动 | Met | 仅 Client 提交路径和展示状态有变化，Host promote 契约未改。 |
| 10-1 延迟 A 的关注写入与写后读取不进入 B，旧讨论不保留 pending | Met | `thread-actions.client.spec.tsx` 的 late A write、late A failure 和 one-write 用例通过。 |
| 10-2 A→B→A 的旧读/写不覆盖新 A，写后读取不被更早读取覆盖 | Partial | 跨打开的旧读/写隔离通过；同一打开内的旧 `observed` 读取仍可覆盖写后确认，见 Findings 第 2 条。 |
| 10-3 A 的失败只显示在发起写入的那次打开，切走后及重开 A 不回放 | Met | `thread-actions.client.spec.tsx` 的 late A failure 用例通过。 |
| 10-4 正常关注/取消、读回失败保留确认结果、请求 ID 不复用、同事件轮不重复写入、reload 读回通过 | Met | `thread-actions.client.spec.tsx` 与 `team-human-attention.client.spec.tsx` 通过。 |
| 10-5 独立 hook 回归先失败后通过，不改浏览器 fixture | Met | 新增 `thread-actions.client.spec.tsx`；浏览器 fixture 未为本票新增分支。 |
| 11-1 Main 直接更新被省略后仍可经 Project 地址和 `team_inbox` 读取，Inbox 保留全部事实 | Met | `notification-context.spec.ts` 的 Main omission/read/rewake 用例通过。 |
| 11-2 Task reminder 被挤出后仍提供 Thread 地址，Inbox 保留提醒，显式读取才确认 | Met | `notification-reminder-context.spec.ts` 通过并复用真实 Harness 回归。 |
| 11-3 未发现需要改投递行为，现有唤醒规则保留 | Met | 实现无投递策略改动；通知测试通过。 |
| 12-1 真实 Host 已提交但 Client 未见回执，关闭重开再提交只记一条回复 | Met | `team-reply-reopen.e2e.ts` 的 delayed receipt 场景通过。 |
| 12-2 回执丢失后安全重试，原附件保留，旧结果不吞新编辑或锁住另一讨论 | Met | 同文件 lost receipt 场景及 `team-send-retry.client.spec.tsx` 通过。 |
| 12-3 覆盖仅限同一 Client 生命周期，不把未确认 UI 请求写入 ledger 或浏览器存储 | Met | `ComposerSends` 仅保存在 Client 内存 WeakMap；ledger 与 localStorage 未增加发送状态。 |
| 13-1 扣住主消息回执后导航返回仍只落一条，且原引用在重试前可见 | Partial | 去重通过 `team-main-reopen.e2e.ts`；旧页引用横幅在返回后丢失，见 Findings 第 1 条。 |
| 13-2 Task 丢回执后恢复原模式与附件并只创建一个；普通讨论仍为讨论；有效打开内创建 Task 正常进看板 | Met | `team-main-reopen.e2e.ts` 的 lost-ack Task 场景及 `team-send-retry.client.spec.tsx` 通过。 |
| 13-3 明确拒绝可重发，新编辑不被旧回执清除，晚到 Task 回执不劫持订阅页 | Met | `team-send-retry.client.spec.tsx` 的 edit/rejection/superseded 用例通过。 |
| 13-4 两种输入框复用提交归属与重试判断，发送状态不持久化 | Met | `ComposerSends` 同时服务 Project 和 Thread composer；新增测试通过。 |
| 14-1 Host 读取在途时拖动，旧缓存迁移不写回旧顺序 | Met | `sidebar-order.spec.ts` 的 empty Host read + drag 用例通过。 |
| 14-2 同列表快速拖动保持最新顺序，旧成功不确认新失败，另一列表可独立保存 | Met | `sidebar-order.spec.ts` 的 serialized rapid drags 与 per-list failure 用例通过。 |
| 14-3 保留最后写入、离线回退和设置格式，无后台重试 | Met | `sidebar-order.spec.ts` 的 offline/fallback 用例通过。 |

## Checks run

| Command or check | Result |
| --- | --- |
| 临时 jsdom 引用恢复探针（已删除） | 失败：重开后 `[data-reply-banner]` 为 `null`，发送仍携带 `replyToMessageRef`。 |
| 临时 jsdom 关注观察顺序探针（已删除） | 失败：确认关注后传入更晚返回的旧空观察集，`following` 从 `true` 变回 `false`。 |
| `npx vitest run`（移除临时探针后的最终工作区） | 207 个文件通过、1 个跳过；2,679 项通过、1 项跳过。 |
| `npm run generate:typert` | 通过。 |
| `npm run check:facades` | 通过。 |
| `npm run check:docs` | 通过。 |
| `npm run check:core-skills` | 通过。 |
| `npm run check:boundaries` | 通过。 |
| `npm run check:versions` | 通过。 |
| `npm run check:comments` | 通过。 |
| `npm run typecheck` | 通过。 |
| `npm run lint -- --quiet` | 环境失败：`corepack` 不存在；未据此判定代码失败。 |
| `npx --yes oxlint@1.76.0 --disable-typescript-plugin packages scripts --quiet` | 通过，作为 lint 的等价检查。 |
| `git diff --check HEAD` | 通过。 |
| `PATH=/tmp/review-bin:$PATH CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:browser` | 通过：26 个文件、28 个场景，生成 195 张证据截图；Harness checkout 无改动。 |

## Unverified scope and residual risk

- 浏览器截图只由套件自动生成，本次没有逐张人工查看 195 张图；桌面和 390×844 的视觉验收仍沿用工作项记录。
- 浏览器套件没有覆盖“引用目标在更早页、导航返回后重试”和“同一打开内旧 follower 读取晚于写后读回”这两个交错，因此 28 个场景全绿不能证明上述两项已满足。
- 工作项没有 `spec.md`/`DESIGN.md`；README、票面和材料是本次可用的规格来源。
- 所有交付均在未提交工作区；没有提交可供按票拆分。无法验证提交信息和 ticket 级提交边界。
- 本机 `npm run lint` 的默认执行链因缺少 `corepack` 不可用；等价 oxlint 通过，但不等同于包装脚本本身的环境验证。
- 工作区存在与本工作项无关的 `.agents/`、根 `AGENTS.md`、`.scratch/AGENTS.md`、`.scratch/README.md` 等修改，未纳入本审查，也未回滚。

## Review record

- Spec sources: `.scratch/archive/2026-11/implicit-state-machines-deep/README.md`、`issues/01`–`14`、`materials/08-verified-round.md`、`materials/09-discussion-write-evidence.md`、`materials/10-recovery-and-closure.md`、`materials/11-closure-audit.md`。
- Standards sources: 根 `AGENTS.md`、`.scratch/AGENTS.md`、`docs/AGENTS.md`、`docs/development/start-and-checks.md`、`docs/architecture/package-ownership.md`、`docs/architecture/client-and-remote.md`。
- Uncommitted and untracked changes included: yes。包含 47 个与本工作项直接相关的已跟踪修改、4 个未跟踪实现/测试文件（`composer-sends.ts`、`thread-actions.client.spec.tsx`、`team-main-reopen.e2e.ts`、`team-reply-reopen.e2e.ts`），以及整个未跟踪工作项目录。
