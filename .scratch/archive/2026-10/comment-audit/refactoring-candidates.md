# 注释审查带出的重构候选

**来源**：2026-10-15 全量注释审查（本目录；归档后为 `.scratch/archive/2026-10/comment-audit/`）
**状态**：A、B、C 三档**已实施并 rebase 到 master**（2026-10-19，分支 `refactor/comment-audit-candidates`，单 commit `19f8f79c`）。**未推送**
**性质**：候选清单，不是计划。每条都可独立评估，没有依赖顺序。

## 实施结果（2026-10-19，rebase + C 档）

分支 rebase 到 master `48e50043`（原基于 `1db10e49`，落后 30 个提交、9 个文件冲突），随后实施 C 档，最后把 9 个提交压成一个 `19f8f79c`：99 个文件、+2208/−1582。

| 项 | 结果 |
| --- | --- |
| A 档 12 条 | 全部保留（原分支实施结果经 rebase 后仍成立） |
| B 档 80 行 | 全部保留；`MENTION_TIER` 数值改成字符串字面量联合、`data-mentioned-tier` 仍输出数值 |
| C1.1 `tokenUnrecognized` | 改为 `staleTokenKind?: 'unknown' \| 'unrecognized'`（缺省 = 真实竞态） |
| C1.2 `ActiveTaskThread.status` | 收窄为 `AgentTeamLiveTaskStatus`（`in_progress` \| `in_review`） |
| C1.4 `updateAvailable` | 删除；`latestVersion` 单独表达（缺省 = 未观察到/已关闭/离线/失败） |
| C1.6 `claimOwners` | 改名 `liveClaimOwners`，与产生它的规则同名 |
| C2.1 judge status | `AgentTeamContextJudgeResult extends TeamContextJudgeStatus`，形状单一定义 |
| C2.3 `planLegacyAdoption` | 收紧为可选属性形式，删掉解释绕开 `exactOptionalPropertyTypes` 的散文 |
| C4.1 `changes` double | 新增 `changeSubscriptionsReady()`；删掉 21 处"一次性 publish 预热"的重复调用 |
| C4.2 `threadHistoryFailure` | 保留粘性语义、文档改写真话（原文档声称 one-shot 不成立：首屏 effect 会读两次） |
| 跳过 C1.3 | 收益最弱、churn 最大；类型已用 doc 说明零值语义 |
| 跳过 C1.5 | 前提不成立：`addMember` 按 requestId 去重，重试可返回两个 Workspace |
| 跳过 C2.2 | 前提不成立：10s 是 gate 的产品决策，不是意外覆盖 |
| 跳过 C2.4 文档项 | 已在 `701a4d33` 完成 |
| C3 `tools.allow` | 保留。Remote 写入路径是真实消费方；删除要动 5 个文件与约 30 条测试，换不到用户可见收益 |

**验证**：`npm run typecheck` exit 0；`npm test` 1142 passed / 1 skipped；`npm run lint` 3 条既有 warning；`npm run test:browser` 6 passed。测试名称逐文件比对，无丢失。

**rebase 期间的语义适配**：`team-host-fixture.ts` 扩展 `workingDirectory: 'stub' | 'real'` 与 `otherProjects`，让 master 新增的工作目录测试跑在真实 owner + tool 上；`TeamChannelPage` 同时保留 master 的 resolved footnote 与分支的 `data-thread-entry-door`。

## 实施结果（2026-10-16，原分支）

分支 `refactor/comment-audit-candidates`，基于 master `1db10e49`，6 个 commit、84 个文件、+2022/−1457。**未推送**。

| commit | 内容 |
| --- | --- |
| `ae5444ee` | A 档 12 条：缺陷结构化 |
| `6a01242e` | B1–B3：Host 源码改名 / 抽函数 |
| `58828f85` | B4–B5：Client 与测试 / 脚本 |
| `c185c856` | 子 agent 复审后补漏（见下） |
| `5879b5e3` | 投递尝试并入 wake record |
| `5b643210` | release replay 步骤具名化 |

**档位进度**：A 档 12/12 实施。B 档 B1–B5 表格共 **84 行**（本文件原估 "~95"），除下表 4 行外全部实施，即 **80 行**。C 档 0 行——未获授权，仍待 Human 决策。

**驳回的条目**（复核后判定前提不成立、或不值得为它改动代码）：

| 条目 | 理由 |
| --- | --- |
| B3 `session-event-cursor.ts` 改名 + `SessionLogOffset` branded 类型化 | 23 处调用点只为复述 Harness 的 append-only 外部契约，模块 doc 已拥有该契约；上游 branded 类型可用，但类型化收益不足 |
| B4 `TeamMessage` 的 `renderResolvedMarkdownText` | Markdown primitive 没有 per-node renderer 接口；要做需先扩展上游 primitive，是跨包设计不是机械重构 |
| B5 `readCountCapsule` | 静态规则检查代替不了渲染尺寸断言；按建议替换会删掉真实覆盖 |
| B5 `LedgerInternals` 双重断言 | `as unknown as` 是跨类型边界访问 private 所必需（单 `as` 实测报 TS2352）；typed seam 需要新的公开测试面 |

**子 agent 复审发现并已修复的问题**（`c185c856`）：

| 问题 | 处理 |
| --- | --- |
| `AUDIT_ONLY_KINDS` 用 `Set` 检查，早退后的三条 per-kind 分支成了不可达死代码（与"检查一次"相悖） | 改成 `isAuditOnlyOperation` **对象级类型谓词**：规则一处、窄化仍在、三条分支删除（`kind` 级谓词无法窄化，实测过） |
| `environment-check.ts` 的 `verdictFor` 抽取改变了 `undetermined` 报告的字段：base 用 `{...base}` 不含 `dshVersion`，重构后变成 `{...running}` 会带上 | 恢复 base 形状，并补测试钉住（该测试在旧实现上确实失败） |
| `human-profile.ts` 重新导出了 `HUMAN_PROFILE_SETTINGS_NAMESPACE`，同一常量两条导出路径 | 删掉该 re-export，三个消费点改为直接 import `./human-settings` |
| 公开契约变更（`./member-skills` 的导出 API）未更新维护文档：4 处仍写 "live selection ref" | 双语对 + 两个 README 改为 "live selection swap on the mounted provider" |
| `judgeCallBudget` / `releaseSnapshotSchema` 被导出但无外部消费者 | 收回为模块私有 |
| `attachments.ts` 五处重复的拒绝句式、`_meta.json` 侧车字面量散落 | 抽 `refuseAttachment(subject, fault)` 与 `ATTACHMENT_SIDECAR_NAME` |
| `member-runtime.ts` 一个 mount 拆成两个 Map，可能漂移 | 合并为 `skillProviderMounts`，存整个 `MemberSkillProviderMount` |
| `team-ui.e2e.ts` 注释仍引用已删的 `boundedThreadTitle` | 改为陈述 40 字符上限 |
| B5 `taskEntrySelector` 因需改 Client 源码而搁置（子 agent 不越界） | 主线补上：`ThreadEntryRow` 加 `data-thread-entry-door` 稳定标记，e2e 不再按可访问名解析；浏览器 journey 复跑通过 |

**验证**（`58828f85` + 后续 3 个 commit 之上）：`npm run typecheck` exit 0；`npm test` **1131 passed / 1 skipped**（基线 1125，新增 6 条）；`npm run test:browser` 6 passed；`npm run lint` 回到 4 条既有 warning；`npm run build` + `check:artifact` OK（52 个运行时相对导入全部可解析）；`check:docs` / `check:core-skills` / `check:boundaries` / `check:versions` / `check:public-baseline` 全部 OK。

## 怎么读这份清单

审查的判据是：**注释在解释我们自己代码里的意外行为时，注释是错的解法**——正确的修法是改代码让行为本身可见（改名、抽函数、加类型、把散文规则变成断言），然后注释自然消失。

所以下面每条的形状都是：*某个符号现在的名字/类型表达不了它的行为，于是一条注释替它解释*。

按价值分三档：

| 档 | 含义 | 数量 |
| --- | --- | --- |
| **A. 顺带修掉的缺陷** | 过程中发现的实际问题：死代码、重复、注释与代码不符、可能漂移的常量 | 11 |
| **B. 改名与抽函数** | 名字或结构说清楚就不需要注释；改动局部、风险低 | ~95 |
| **C. 改类型/接口形状** | 需要改公开类型或跨模块契约，收益大但要设计 | ~34 |

`(未解析)` 的条目表示原报告没给出可核对的行号，需要先定位。

---

## A. 顺带修掉的缺陷

这些是审查过程中发现的、值得单独处理的实际问题。

### A1. `ledger.ts` 两个函数逐字节相同

`boundedInboxPreview`（448）与 `boundedReplyExcerpt`（468）函数体完全一致（都是 120 字符截断 + `…`）。第三个 `boundedThreadTitle`（458）只差一个 40/39 的界。

**做法**：合并成一个 `boundedOpeningLine(body, max)`，把界收成常量。
**收益**：三条几乎相同的注释一起消失，界只有一处。

### A2. `surface-visibility.ts` 两个死导出

`isDirectMentionNotice`（117）和 `isDmRelay`（122）全仓库没有调用点、测试或诊断使用（grep 验证）。它们的 doc 写着"for tests and diagnostics"——不成立。

**做法**：删掉两个导出。
**风险**：低。删前再 grep 一次确认。

### A3. `tool-agent-team/src/index.ts` 的 `noun` 参数是死的

`rejectionLines` 的 `noun` 参数只出现在签名和注释里，调用方一律传 `'message'` / `'Claim mutation'`。

**做法**：删参数和两处调用实参。

### A4. `member-runtime.ts` 注释说 "four maps"，实际有六个

`MemberRuntime` 的类注释写 "the four maps dispose together"，实际有 6 个 `Map`。

**状态**：**原判断不成立**——实施时发现类注释仍在（且仍写 "four maps"），并非"已被本次审查删除"。
**实施**：类注释改写为逐 Member 释放的不变式；`disposeAll` 改为遍历 `trackedMemberIds()` 再逐个 `forgetMember`，让"哪些 map 一起释放"成为代码。

### A5. `ledger.ts` 归档规则重复七次

"Archived Channels do not exist on Team API surfaces" 这条规则在 `ledger.ts` 里以注释形式重复了 7 处（1535、3765、4015 等），每处都在 feed、ref 解析、inbox 里手写同样的判断。

**做法**：抽一个 `visibleChannel(channelRef)` 谓词（或用一个 `ARCHIVED` 守卫类型），三处调用它，七条注释一起消失。
**风险**：中。改动点在读路径，需要确认没有第四种语义。
**实施**：8 处读路径改用它；3 处抛错守卫（`requireActiveChannel` / `assertThreadChannelActive`）按判断保留原样——它们抛错而非过滤，不是同一种语义。

### A6. `context-judge.ts` 的 "pinned rather than inherited" 不成立

`JUDGE_RETRY_DELAY_MS`（43）的注释说这个值是"固定而非继承"，但 jev 的 `DEFAULT_RETRY_DELAY_MS` 本来就是 500，值相同。

**做法**：删掉常量、直接继承；或从 `deadlineMs` 推导退避。
**顺带**：`judgeMountConfig`（58）的三个字面量应该收成一个 `judgeCallBudget(deadlineMs)` 返回值，让"gate 与 judge 必须一致"成为类型而不是散文。

### A7. 跨包重复的常量

| 常量 | 位置一 | 位置二 | 风险 |
| --- | --- | --- | --- |
| `AVATAR_MAX_BYTES` | `TeamSettingsSection.tsx:31` | Host `ATTACHMENT_MAX_BYTES` | 会漂移：Client 允许的上传大小与 Host 接受的不一致时，用户看到的是失败而不是拒绝 |
| `TEAM_SETTINGS_NS` | `client/index.ts:69` | `human-profile.ts:35` (`HUMAN_PROFILE_SETTINGS_NAMESPACE`) | 同一字面量两处；改名会静默错位 |
| `TRUNCATION_MARKER` | `surface-visibility.ts:38` | `index.ts:3864` (`boundedNotificationBody`) | 截断标记必须逐字一致，否则"是否截断"判断失效 |
| 通知摘要字面量 | `context-projection.ts:114` | `index.ts:175` (`RECOVERY_NOTICE_SUMMARY`) | 同一摘要两处定义 |

**做法**：每对抽一个共享常量，从两边都 import。跨包的走公开子路径。
**风险**：低（纯常量搬移），但要注意包边界规则（`check:boundaries`）。

### A8. `spec.ts` 的 `releaseSnapshotFields` 注释已过期

`releaseSnapshotFields`（282）的注释描述的字段列表与代码不符。

**核查勘误**：原注释写 "All four release kinds"，本文件"核查"节把它改成"实际只有 2 个 kind"——**两个数字都不对，实际是 5 个**：`member-archived`、`member-removed`、`member-workspace-left`、`channel-archived`、`channel-member-removed`。
**实施**：提升为具名 schema + 新公开类型 `AgentTeamReleaseSnapshot`，5 个 op 接口改为交叉该类型；模块私有（无外部消费者，不导出）。已实测：往该类型加一个字段，`tsc` 立即在 ledger 的全部分支报错——形状现在真的由类型强制。

### A9. `check-core-skills.mjs` 静默读首行

`frontMatter`（74）对折行的 `key: value` 只读第一行，注释承认了这一点。

**做法**：要么正确解析折行，要么在遇到折行时抛错。静默读首行是注释在为一个不完整实现道歉。

### A10. `recovery.ts` 边遍历边改

`RecoveryCoordinator.dispose`（238）在遍历 `this.episodes.keys()` 的同时清空它，靠注释说明这是安全的。

**做法**：先快照 `[...this.episodes.keys()]`，或抽 `clearAll(reason)`。
**风险**：低，但这是"靠注释解释的巧合正确性"，值得修。

### A11. 三处空 `catch` 块失去解释

本次审查删掉了三处空 `catch` 的唯一说明。这三处**是本次改动引入的可读性回退**，应优先处理：

| 位置 | 原注释说的理由 | 建议形状 |
| --- | --- | --- |
| `attachments.ts:207`（`scanAttachmentCache`） | "半写入或外来的目录不归我们判断，跳过" | 抽 `const isForeignEntry = ...` 或显式 `ignoreForeignEntry(id)`，让跳过是主动决定 |
| `index.ts:787`（`syncHumanHandle`） | "Service.init 之前 ledger 不存在；open 后的同步会补上" | 抽 `ignoreAbsentLedger()`，或让 `ledger` 在该点非空 |
| `navigation.ts:70`（local persistence） | "本地持久化是便利功能；隐私模式与配额失败不阻断导航" | 抽 `persistLocallyBestEffort(payload)`，让"尽力而为"进名字 |

`attachments.ts` 那处最需要处理：现在是一个完全无说明的空 catch。

### A12. `invariant.ts` 吞掉 emit 异常

commit 路径的不变式闩锁（`invariant.ts:45`，注释 48-64、82-83）用 try/catch 吞掉 `emit`，靠注释说明"仍然闩住"。

**核查勘误**：**前提不成立**——现码里没有任何 `try/catch` 包 `emit`，闩锁已由下一次 commit 的 throw 断言表达。无需拔除。
**实施**：只做降噪——拆成具名的 `validateAtMount` / `watchCommits`。

---

## B. 改名与抽函数

改动局部、风险低、收益是"名字说清楚就不需要注释"。按文件分组。

### B1. `packages/agent-team/src/ledger.ts`（12 条，Host 核心）

| 符号 | 要求的形状 |
| --- | --- |
| `pair` / `mirror`（1467） | 改名 `sentByOther` / `sentByReader` |
| `apply`（2872） | 改名 `applyAndBumpProjectionVersion`，或把 bump 移到 `changeScopesOf` 的调用方 |
| `recordClaim`（3121） | 抽 `upsertKeepingPosition(bucket, claim, key)`，让"首次写入定位置"成为名字 |
| `recordAttentionObservations`（3138） | 拆成 `recordUnfollowObservations` / `recordFollowObservations` |
| `occurredAtForFactFrom`（3408） | 在 `Projection` 上带一个 `occurredAtBySequence` map，替代 `ordered[sequence - 1]` |
| `directMarkersForFrom`（3568） | 改名 `frozenMarkerSnapshot`，或返回 readonly 类型 |
| `tokenNeverReached`（3660） | 改名 `revisionNeverExisted`，并返回 `'before-first-fact' \| 'known-absent' \| 'raced'` 枚举，替代 `false` 兼表未知 |
| audit-only kinds（3301、3309） | 四条 per-kind 注释换成一个 `AUDIT_ONLY_KINDS` 集合，检查一次 |
| `applyReleaseSnapshot`（3050） | 把"必须的顺序"变成类型化的步骤序列（`applyClaims` → `applyActivities` → `applyInbox`），而不是散文规则 |
| `prepareReadReceiptFrom`（3247）/ `prepareReadFrom`（3280）/ `readPicture`（4672） | 把 receipt 形状与 picture 形状的读拆成两个具名类型，去掉"frozen legacy shape"这类免责声明 |

### B2. `packages/agent-team/src/index.ts`（5 条）

| 符号 | 要求的形状 |
| --- | --- |
| `liveMemberContext` 闭包（500-508） | 抽一个声明的访问器 `liveContextFor(memberId): Context`，让"调用时解引用"成为函数契约 |
| `memberStatus`（3398） | 把"五种状态"散文换成真正的 `NO_LIVE_SURFACE_STATES` 表，被三处 return 消费 |
| `notificationAttempts` / `NotificationCause`（554-557、3705-3708） | 把投递尝试并进 wake record，让"attempt ≠ request"成为结构 |
| `replayCarriedInput`（2620） | 把三类跳过编码成类型化分类（corrupt / refused / started-generation），由 reader 返回，替代 2599-2618 的散文列表 |
| `applyCapabilityEdit` + `deferred:generation-changed`（1788） | 删掉不可达守卫；若该结果必须保留（它在 `AgentTeamMemberEffect` 里导出），就在队列层断言不变式 |

### B3. `packages/agent-team/src/` 其余（14 条）

| 文件 | 符号 | 要求的形状 |
| --- | --- | --- |
| `attachments.ts` | `sanitizeFileName`（61） | 抽 `reserveSidecarName(cleaned)` 或 `SIDECAR_NAME` 常量 |
| `attachments.ts` | `validatePathAttachment`（94） | 抽 `refuseAttachmentPath(raw, fault)`，让"先说明拒绝、再给出口"的顺序结构化 |
| `context-projection.ts` | `isTeamNotice`（169） | 改名 `isRedeliverableTeamNotice`，把排除条件写进名字 |
| `context-projection.ts` | `TEAM_ATTENTION_TOOL_NAME` + `LEGACY_TEAM_THREAD_TOOL_NAME` + `isAttentionToolName`（62、72、178） | 合并成一个 `ATTENTION_TOOL_NAMES: readonly string[]`，即 `TEAM_ROLLOVER_TOOL_NAMES` 已有的形状 |
| `environment-check.ts` | `evaluateEnvironment`（92） | 命名优先级：`verdictFor({ satisfied, range, running })`，不要用散文排序 |
| `installed-manifest.ts` | `readInstalledManifest`（18） | 抽 `installedPackageRoot()`，让 `'../../../package.json'` 这跳成为具名代码 |
| `invariant.ts` | `apply`（45） | 抽 `createCommitInvariantCheck(ctx)`，让闩锁与 `setImmediate` 合并成为具名单元 |
| `member-runtime.ts` | `awaitTurnBoundary`（257） | 返回 `'waited' \| 'idle'`，不要用只有 doc 能解释的裸 boolean |
| `member-runtime.ts` | `reapplyMemberToolPolicy`（196） | 抽出回滚 `restoreEnforcedToolAllow`，让恢复的状态成为值 |
| `member-runtime.ts` | `appliedCapabilities`（126） | 用带标签的类型区分"从未应用"与"应用了空能力"，替代 `… \| null` 哨兵 |
| `member-skills.ts` | `MemberSkillSelectionRef.swap`（23，赋值于 54、62） | 让 mount 返回 `{ swap, dispose }`；54 行的 no-op 占位只因调用方持有 config 字段才存在 |
| `member-time-context.ts` | `renderClockSnapshot`（125） | 用具名 `nonNegativeDuration(elapsedMs)` 做钳制；不要用注释解释回滚 |
| `recovery.ts` | `classifyRecoverableError`（60） | 抽 `kindFromProvenance(code, status)`，让"结构化优先于措辞"成为结构 |
| `request-scoped-id.ts` | `requestScopedUuid`（16） | 改名让"重试稳定"进名字（如 `stableRequestUuid`），删 doc 块 |
| `session-event-cursor.ts` | `advanceSessionEventCursor`（95） | 改名 `advanceAppendOnlySessionEventCursor`，并把 `logFrom`/`logEnd` 类型化为 branded `SessionLogOffset` |

### B4. `packages/client-agent-team/src/client/`（18 条）

| 文件 | 符号 | 要求的形状 |
| --- | --- | --- |
| `TeamAgentsPanel.tsx` | `followRollover`（86）+ 三个 ref | 抽 `useMemberSessionFollow(seatSessionId, openMemberSession)`，状态类型化 `idle \| pending \| followed` |
| `TeamAgentsPanel.tsx` | 空 roster 条件（270） | 抽 `const showEmptyRoster = !loading && error === undefined && members.length === 0` |
| `TeamChannelPage.tsx` | `mergeChannelView`（56） | 抽 `hasOlderBeyondFreshWindow(current, fresh)`，让 `current.cursor < fresh.cursor` 读作保留规则 |
| `TeamChannelPage.tsx` | `printedActivityAt`（88） | 改名 `unresolvedFollowUpAt`，或把 `done/closed` 判断提到调用点 |
| `TeamChannelPage.tsx` | `followUpAt`（74） | 改名 `newerActivityAt` |
| `TeamChannelPage.tsx` | `refresh` 里的未读更新（221） | 抽 `applyInboxRead(previous, result)`，让"读失败保留上次计数"成为代码 |
| `TeamComposer.tsx` | `MentionTier`（26） | 把 `0 \| 1 \| 2` 换成具名联合（`'thread-follower' \| 'channel-peer' \| 'workspace'`） |
| `TeamComposer.tsx` | `replyTo` prop 类型（117） | 抽具名 `ReplyTarget` 类型；当前"排除 Human"在匿名内联形状里不可见 |
| `TeamComposer.tsx` | `notifiedIds`（233） | 抽 `deliverableRecipients(recipients, draft, members, replyTo)`，替代 13 行注释 |
| `TeamComposer.tsx` | `draftPreviewUrls`（71） | 抽 `revokeDraftPreviewUrl(file)` 并在 422 调用，让 WeakMap 生命周期成为调用 |
| `TeamInboxPage.tsx` | `compareInboxRows`（50） | 改名 `compareByHostInboxOrder` |
| `TeamMessage.tsx` | `TeamMessage`（101） | 把 ref/mention 解析抽成 `useResolvedBodyRefs`，调用方不再手写 memo |
| `TeamMessage.tsx` | `renderResolvedMarkdownText` / `renderResolvedMarkdownCodeRef`（437、459） | 用 React 节点渲染 chip，而不是渲染后改写 DOM |
| `TeamMessage.tsx` | `rowActions?: boolean`（70） | 缺省会静默继承 `onReply`；改成必填或 `'inherit' \| 'always' \| 'never'` |
| `TeamMessage.tsx` | `fallbackNames` 过滤（126） | 抽到 `team-formatters.ts` 的具名 helper |
| `TeamSettingsSection.tsx` | `draft`（88） | 改成判别联合 `{ kind: 'follow' } \| { kind: 'editing'; text: string }`，替代 `string \| undefined` 兼表两种意思 |
| `TeamSettingsSection.tsx` | `judgeForm`（84） | 抽 `useObservedJudgeForm(source)` hook |
| `TeamWorkspaceBrowser.tsx` | inbox 总计合并（76-81） | 抽 `mergeInboxTotals(results, previous)`，让"刷新失败保留上次好值"成为签名 |
| `avatar-image.ts` | `useAvatarImage`（24） | `src: undefined` 混表"无 URL"与"字节解码失败"；返回判别结果 `{kind:'image';src} \| {kind:'initial'}` |
| `drafts.ts` | `TeamDraftStore.write`（127） | 抽 `sameDraftEntry(previous, next): boolean`，让"不 bump"规则无需注释 |
| `human-identity.ts` | `TeamHumanIdentity.read`（118） | 两处 catch 提成一个 `recordReadFailure(error)`；avatar 复用分支成为 `avatarUrlFor(ref)` |
| `client/index.ts` | `leaveTeamFromUi`（111） | 让"清面板 + 退出模式"成为一个原子导航操作，而不是靠注释维护顺序的一对 |
| `client/index.ts` | `membersQuery`（190） | 把覆盖范围表达成数据，而不是靠注释引用 `.scratch/` 里的 issue 编号 |
| `mention-presentation.ts` | `mentionSurfaceOf`（16） | 让 `TeamDraftKey` 成为判别联合并 switch 其判别式，替代 `startsWith` |
| `navigation.ts` | `setMemberSession` 守卫（134） | 抽 `isReselectingActiveMember(snapshot, sessionId)` |
| `refs.ts` | `hostRefLookup` 遍历（176） | 抽 `rememberAliasedResolutions(entries, refs)` |
| `team-dialog-save.ts` | `useEditDialogSave`（12） | 去掉返回的 `pendingRequest` ref，自己拥有失效逻辑（返回 `invalidate()`），让调用方无法忘记清 |
| `team-queries.ts` | `answeredFailure`（62） | 把 payload 失败规则并进 `failed` 计数器的契约 |
| `team-queries.ts` | `settle`（230） | 抽 `dropStale` / `deliverSuperseded`，让每个分支的规则就是它的名字 |
| `team-separators.ts` | `timelineDayKey`（24） | 纯转发别名，删掉包装，导出并用 `localDateKey` |

### B5. 测试与脚本（13 条）

| 文件 | 符号 | 要求的形状 |
| --- | --- | --- |
| `agent-team.spec.ts` | `replayLedger`（131） | 改名 `ledgerAtBoot()`，并给 `AgentTeamLedger` 一个显式 `refresh()`/live 视图 |
| `change-scopes.spec.ts` | `addLedgerMember`（52） | 改名 `commitMemberRecordDirectlyOnLedger`，让"绕过 service 写 Member 记录"可见 |
| `change-scopes.spec.ts` | `staysPending`（94） | 改名 `staysPendingAcrossMacrotask` |
| `context-projection.spec.ts` | `legacyRolloverPair`（108-113） | 改名 `legacyNewContextPair`：doc 存在只因 helper 藏了它发的是哪个名字 |
| `helpers/legacy-thread-read.ts` | `snapshotReadData`（10） | 改名 `fabricateLegacyThreadReadSnapshot`，legacy 形状必须是具名类型 |
| `helpers/legacy-thread-read.ts` | `receiptReadData`（32） | 改名 `counterfactualReceiptReadData` |
| `helpers/memory-backend.ts` | `failNextWrites`（45） | 改名 `injectedWriteFailuresRemaining`，让倒计数语义进名字 |
| `member-time.spec.ts` | `replayLedger`（85） | 改名 `replayLedgerAtConstruction` |
| `member-tool-policy.spec.ts` | `vi.setConfig`（13） | 把超时策略移进 `vitest.config.ts` |
| `member-tool-policy.spec.ts` | `buildSharedHarness`（151） | 抽到 `tests/helpers/` 成为可复用 fixture |
| `member-tool-policy.spec.ts` | `EmptyAdapter.resolveModel`（58） | 改名 `StablePressureAdapter` 并暴露 `CONTEXT_WINDOW`，让大窗口是意图 |
| `member-tool-policy.spec.ts` | `ctx.provide('tokenMeter', …)`（189） | 抽 `provideQuietTokenMeter(ctx)` |
| `operation-protocol.spec.ts` | `internals` / `LedgerInternals`（541） | 用类型化测试接缝替代 `as unknown as` 双重断言 |
| `operation-protocol.spec.ts` | `ensureFollow`（1190） | 改名 `followThreadForLegacyRepair` |
| `scripts/team-ui.e2e.ts` | `taskEntrySelector`（95） | 按可访问名的字符串前缀解析是坏味道：给门一个稳定标记 `data-thread-entry-door` |
| `scripts/team-ui.e2e.ts` | `readCountCapsule`（170） | 用一条共享徽标规则替代定制的 box/inset/shape 读取 |
| `scripts/audit-ui-parity.mjs` | `bareSelector(rule)`（401、429、510、546、594） | 同一段 `rule.selector.replace(/^[\s\S]*\*\//, '')` 内联五次；抽出函数后"捕获的 selector 里有注释"这个理由消失 |
| `scripts/continuity-dir.mjs` | `servesBundle`（84） | 改名 `atLeastFloorIgnoringPrerelease`，让"忽略预发布标签"进名字 |
| `scripts/isolate-dsh-home.setup.ts` | （17） | 抽 `export function isolateDshHome(): string` 并调用，让"强制 DSH_HOME"是可见动作而不是裸副作用 |
| `scripts/session-trace.ts` | `derived: {} as DerivedFields`（355） | 抽 `hydrateDerived(rows)`，让占位谎话消失 |
| `scripts/session-trace.ts` | `ListRow.archived`（273） | 该字段意思是"会话日志缺失"；改名 `logMissing` |
| `scripts/session-trace.ts` | `@ts-expect-error`（28） | 掩盖了真实的 `any` 洞；加 `harness-dir.d.mts` 或 `@type` JSDoc，然后删 suppression |
| `scripts/check-public-baseline.mjs` | `localSurfaces[].pattern`（64） | 抽 `baselineStatement(text)` 解析器（带测试），替代注释承认"可接受成本"的锚定正则 |
| `scripts/team-ui.ui-preview.ts` | request/context append（97） | 抽 `recordPriceableRoute(agent)`，让 fixture 接缝成为具名 API |

---

## C. 改类型或接口形状

收益大，但改动公开类型或跨模块契约，需要设计。

### C1. `packages/agent-team/src/types/requests-results.ts`（6 条，全部是公开 API）

| 符号 | 问题 | 要求的形状 |
| --- | --- | --- |
| `AgentTeamStaleRevision.tokenUnrecognized`（576） | 三态 boolean（`true` / 缺省）表示"未识别"与"不可知" | `readonly staleTokenKind: 'unrecognized' \| 'race' \| 'unknown'` |
| `AgentTeamActiveTaskThread.status`（992） | 只可能是两个值之一，但类型是全集 | 在 entities.ts 抽 `AgentTeamLiveTaskStatus = Extract<AgentTeamTask['status'], 'in_progress' \| 'in_review'>` |
| `AgentTeamInboxItem.unreadCount` / `.directCount`（786-788） | 「最近活跃」切片被迫塞零进共享行 | 拆出 `AgentTeamRecentInboxItem`（不含计数的基行），让不变式由类型表达 |
| `AgentTeamHumanProfileResult.updateAvailable`（370） | `false` 混表"无更新"与"尚未检查" | 删字段，让 `latestVersion` 成为唯一可选来源（缺省 = 未知） |
| `AgentTeamAddMemberResult.workspaceIds`（179） | 创建时永远恰好一个元素 | 改成 `readonly workspaceId: WorkspaceId` |
| `AgentTeamInboxItem.claimOwners` / `AgentTeamViewItem.claimOwners`（812、969） | 与定义规则的那个函数名字不一致 | 改名 `liveClaimOwners` |

### C2. `packages/agent-team/src/` 其余（7 条）

| 文件 | 符号 | 要求的形状 |
| --- | --- | --- |
| `context-judge.ts` | `TeamContextJudgeStatus`（81） | 同一形状两个权威；让 `AgentTeamContextJudgeResult` 继承它（或删掉它） |
| `context-continuity-host.ts` | `TEAM_JUDGE_TIMEOUT_DEFAULT_MS`（177） | 从挂载的 judge 自己的 `timeoutMs` + 现有 1s 余量推导，而不是硬编码覆盖引擎默认值 |
| `human-profile.ts` | `planLegacyAdoption`（146） | doc 承认参数类型是为了绕开 `exactOptionalPropertyTypes`；改成 Host getter 的真实返回类型 |
| `spec.ts` | `memberCapabilitiesSchema.tools.allow`（65） | 见下方"C3 关于 `tools.allow`" |
| `types/entities.ts` | `AgentTeamMemberCapabilities.tools`（87） | 同上 |
| `member-runtime.ts` | `memberRestrictions`（113） | ~~把预留的 restriction 接缝变成真 API~~ **已核查为误读，剔除**：`memberRestrictions` 是活跃的内部 disposer 注册表（`applyMemberToolPolicy` 写入、swap 回滚路径读取），并非预留接口 |
| `types/entities.ts` | `AgentTeamMemberCapabilities.tools` 的 `allow` | 若保留，doc 应说明它就是 activation 时执行的 allow-list（`member-runtime.ts:156` 确实在执行），而不是"预留" |

### C3. 关于 `tools.allow` 的单独说明

这是本次审查里唯一一处**判断为"注释说法不成立但代码保留"**的地方，需要单独决策。

**事实**：
- `capabilities.tools.allow` 是活代码：有 zod schema、有 `applyMemberToolPolicy` 消费、有 Remote 写路径、有 `member-tool-policy.spec.ts` 覆盖。
- 原注释声称"未来 Runtime Revision manifests 依赖这个 seam"。查证：Runtime Revision 只存在于**已归档且明确标注暂缓**的设计里（`.scratch/archive/2026-09/member-runtime-architecture/`），代码里没有任何对应实体。
- 因此该说法无法证实，本次已从代码注释与 4 处维护文档中移除，只保留"当前无 UI 写入路径"这个可验证的事实。

**待决策**：`tools.allow` 目前**只有 Remote 写入路径，没有 UI**。两个选择：
1. **保留**：它是给脚本化/API 调用方的合法能力，doc 已改为陈述当前事实。
2. **删除**：如果没有真实消费方，删掉字段、schema、执行路径和测试。这符合仓库"不留投机性预留"的约定。

倾向选择 1（Remote 写入路径本身就是消费方），但这是产品决策，需要 Human 确认。

### C4. `packages/client-agent-team/tests/harness.tsx`（2 条）

| 符号 | 要求的形状 |
| --- | --- |
| `changes` double（481） | 暴露可 await 的 stream-open 信号，让 spec 不再用一次丢弃式 publish 预热探针 |
| `threadHistoryFailure`（408） | 用 `failNextThreadHistory(message)` 替代粘性标志，假的 doc 随名字一起消失 |

### C5. 未解析条目（19 条，需先定位）

原报告未给出可核对行号。多数指向 `TeamChannelPage.tsx`、`TeamComposer.tsx`、`TeamMessage.tsx`、`member-lifecycle.spec.ts`：

| 符号 | 要求的形状 |
| --- | --- |
| `persistenceRaceError`（~45） | 改名 `win32StagingDirectoryEnoent` |
| `rmFault`（~54） | 改名 `rmFailingPathFragment`；把哨兵类型化，让"空 = 放行"可见 |
| `ScriptedAdapter.failWith`（~104） | 改名 `throwOnEveryModelCall`，类型改成 `Error \| undefined` |
| `waitFor` 的 `timeoutMs = 60_000`（~2599）+ `vi.setConfig` 预算（~11） | 抽一个 `TEST_TIMEOUT_MS` 常量给两处读 |
| `staysPending`（5143、5204） | 抽一个共享 helper，替代两份拷贝 |
| `TestablePresets.failingMount` / `orphaned`（188-189） | 改名 `mountFailure` / `agentsWithoutComposition` |
| `acceptedClaimRefs`（318-323、328、375） | 把 accept 判别式做成类型，让"空但存在 ≠ legacy"由结构表达 |
| `validateLedgerAtMount()`（1741-1810） | 返回 `{ adopted: boolean; replayed: number }`，让一次性采纳成为可断言状态 |
| commit-path invariant latch（1725-1727、1828） | 暴露 `invariantStatus()` / `lastDivergence()`（与 A11 同一处） |
| `contextJudgeForClient` gate 默认值（3074-3079） | 把不对称（两个默认来自引擎、`judgeTimeoutMs` 是 Team 的）编码成具名 defaults 对象 |
| `legacyJoinLedger` / `legacyRemovalLedger`（88、99） | 改名 `preDerivationJoinFixture` / `preDerivationRemovalFixture` |
| `stableMentionNames` / `mentionNamesCache` | 抽具名 `MentionNameCache`，让身份契约是类型 |
| `mutating`（~181） | 改名 `pendingMutationLabel`：`'promote' \| 'accept'` 没说清"只影响按钮文案" |
| `timelineOnScroll`（~194） | 让 `useTimelineScroll` 返回身份稳定的 memo 对象，删别名 |
| `refreshSupplemental`（270-278） | `await Promise.resolve()` 合并不可见；抽 `coalesceScopeNotifications()` |
| `firstUnreadMention`（107-125） | 改名表达规则（如 `firstUnreadMessageNaming`） |
| `pendingJump` + `useLayoutEffect`（175、567-576） | 抽 `useOpeningJump`，让"待脉冲释放"进名字 |
| 重复的 `activeClaims`（920、942） | 一个 `useMemo` 派生值，被 header 和 accept 对话框共用 |
| `waitActivated` 测试（member-lifecycle.spec.ts:2652、2704、2758） | 抽 `waitForActiveGeneration(memberId)` |

---

## 建议的起手顺序

如果想分批做，按"风险最低、收益最直接"排序：

1. **A2 + A3**（删死代码/死参数）——纯删除，无设计。
2. **A7**（跨包常量去重）——纯搬移，但能防止真实漂移。
3. **A1**（合并三个 `bounded*`）——一个文件，界只有一处。
4. **B1 的改名类**（`pair`/`mirror`、`tokenNeverReached`）——局部改名。
5. **C1**（公开类型的收窄）——影响 API，但每条都很小。
6. **A5**（归档规则抽谓词）——读路径，需要先确认语义唯一。

---

## 核查（2026-10-15 19:04）

**方法**：5 个只读核查 agent 分档验证 + 主线逐条复核全部 A 档事实断言与 C3 决策依据。核对基线：master `1db10e49`（删除已合入）。

**总结论**：清单可信度高。A 档 12/12 成立，可直接实施；B 档抽查全成立；C 档剔除 1 条误读后其余成立；C5 全部 19 条已定位。可按上方起手顺序推进。

**实施后勘误（2026-10-16）**：本节自身有 3 处说法在实施中被推翻，已在上文对应条目标注——A4 的"类注释已删"（实际仍在）、A8 的"只有 2 个 kind"（实际 5 个）、A12 的"try/catch 吞掉 emit"（不存在该 catch）。另有 B2 的 `applyCapabilityEdit` 守卫"不可达"一说亦为误判（实测可达，等待期间句柄可被换掉）。结论：**核查节的事实断言仍需在实施时逐条复验**。

| 档 | 核实结果 |
| --- | --- |
| A（12 条） | **12/12 成立**。A6 证实 jev 侧 `@contexera/dsh-jev` `DEFAULT_RETRY_DELAY_MS = 500` 与本地常量同值；A7 四对常量字面量逐一比对一致（头像上限 10MiB、namespace `'wowyuarm-agent-team-host'`、截断标记、Recovery 摘要均双份）；A8 保留注释声称 "All four release kinds"，**该节的"实际只有 2 个 kind"计数有误（实为 5 个）**，"注释与代码不符"这条结论本身成立 |
| B（~95 符号） | 抽查约 15 条全部成立；行号漂移基本在 ±10 内，按符号定位即可 |
| C1（6 条） | 6/6 成立。`workspaceIds` "创建时恰好一个"经 `addMember` 生产端证实（创建只 seed 一个 Workspace 参与度） |
| C2（7 条） | 6/7 成立；`memberRestrictions` 一条误读，已在表中标注剔除。`TEAM_JUDGE_TIMEOUT_DEFAULT_MS = 10_000` 的描述自己承认"not the engine's own"——硬编码覆盖属实 |
| C3 | 四项事实断言全部证实：zod schema 存在、`applyMemberToolPolicy` 消费（member-runtime.ts:150-171）、`@Remote('addMember')` 写路径、`member-tool-policy.spec.ts` 约 30 处 allow 相关覆盖、client 无 UI 写路径、src 无 Runtime Revision 实体。**可交 Human 决策** |
| C4（2 条） | `threadHistoryFailure` 成立：粘性标志 + 假 doc（"one-shot … cleared by the next successful read" 实际只有手动 `failThreadHistory()` 复位）；`changes` double 的"丢弃式 publish 预热"一条未完全核实，实施时再确认 |
| C5（19 条） | **19/19 已定位**（见下表）。原报告的文件猜测偏差大：最大簇在 `TeamThreadPage.tsx`（7 条），不在猜测名单里 |

### C5 定位结果（替代原"(未解析)"状态）

| 位置 | 条目 |
| --- | --- |
| `TeamThreadPage.tsx` | `stableMentionNames`/`mentionNamesCache`（86-92）、`firstUnreadMention`（116-125）、`pendingJump`（175 + 568-577）、`mutating`（181）、`timelineOnScroll`（194）、`refreshSupplemental`（270-278）、重复 `activeClaims`（920、942） |
| `member-lifecycle.spec.ts` | `persistenceRaceError`/`rmFault`（45-67）、`ScriptedAdapter.failWith`（74-100）、`vi.setConfig`（11）+ `waitFor` 默认 60_000（2519）、`TestablePresets`（166-175）、两份 `staysPending`（5043-5104）、`waitActivated`（2652/2704/2758） |
| `agent-team.spec.ts` | `legacyJoinLedger`/`legacyRemovalLedger`（93/106）、`acceptedClaimRefs`（328-375）、`validateLedgerAtMount` 断言（1795-1810）、`contextJudgeForClient` 默认值断言（3085-3095） |
| `src/index.ts` | `contextJudgeForClient` gate 默认值（1936-1940）、`validateLedgerAtMount`（2344-2348） |
| `invariant.ts` | latch（45-85）与 `validateLedgerAtMount` 调用点（54） |

### 勘误

- 行号基于 worktree `701a4d33` 写成；master `1db10e49` 之后个别条目漂移最多约 60 行（如 `boundedNotificationBody` 3864→3804）。**实施时一律按符号名定位**。
- 分档计数与实际条目数不符：A 标 11 实为 12；B4 标 18 条实为 30 行；B5 标 13 条实为 24 行。总数 ~140 不受影响。
- 附带发现：`packages/*/lib/` 构建产物（未入库）仍含旧 "Runtime Revision — do not remove" 注释，下次构建自然消失，无需处理。
