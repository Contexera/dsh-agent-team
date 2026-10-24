# 06 — MUST KILL 重构建议清单（只报告，不实施）

**Status:** complete

## 说明

这些条目的共同形状：注释在解释**我们自己代码里的意外行为**。按 no-comments 的判据，正确的修法是改代码让行为本身可见（改名、抽函数、加类型、把散文规则变成类型或断言），而不是把注释改写得更短。

**本次未实施任何一条。** 每条给出：符号、位置、要求的形状、以及它替换掉的是哪条注释。

按位置分组；`(未解析)` 表示报告没给出可核对的行号，需要人工定位。

---

## 生产代码


### packages/agent-team/src（Host 生产代码）

**`packages/agent-team/src/attachments.ts`**

- `sanitizeFileName` (attachments.ts:61) — extract `reserveSidecarName(cleaned)` (or a `SIDECAR_NAME` constant) so `_meta.json` → `_meta.json` reads.
- `validatePathAttachment` (attachments.ts:94) — extract `refuseAttachmentPath(raw, fault)` so fault-then-route order is structural.

**`packages/agent-team/src/context-continuity-host.ts`**

- `TEAM_JUDGE_TIMEOUT_DEFAULT_MS` (context-continuity-host.ts:177) — derive the gate deadline from the mounted judge's own `timeoutMs` + the existing 1 s margin instead of hardcoding an override of the engine default.

**`packages/agent-team/src/context-judge.ts`**

- `JUDGE_RETRY_DELAY_MS` (context-judge.ts:43) — delete the constant and inherit jev's `DEFAULT_RETRY_DELAY_MS` (the value is already 500), or derive the backoff from `deadlineMs`; "pinned rather than inherited" is untrue.
- `judgeMountConfig` (context-judge.ts:58) — extract `judgeCallBudget(deadlineMs): { timeoutMs, attempts, retryDelayMs }` so the gate/judge agreement is one typed value, not three literals plus prose.
- `TeamContextJudgeStatus` (context-judge.ts:81) — two authorities for one shape; make `AgentTeamContextJudgeResult` extend this one (or delete this one), per AGENTS.md "one authoritative form per domain concept".

**`packages/agent-team/src/context-projection.ts`**

- `isTeamNotice` (context-projection.ts:169) — rename to state the exclusion (`isRedeliverableTeamNotice`).
- `TEAM_ATTENTION_TOOL_NAME` + `LEGACY_TEAM_THREAD_TOOL_NAME` + `isAttentionToolName` (context-projection.ts:62, 72, 178) — collapse into one `ATTENTION_TOOL_NAMES: readonly string[]`, the shape `TEAM_ROLLOVER_TOOL_NAMES` already uses.
- `REMINDER_NOTICE_SUMMARIES` (context-projection.ts:114) — its second literal is duplicated as `RECOVERY_NOTICE_SUMMARY` at agent-team/src/index.ts:175; export one notice-summary registry.

**`packages/agent-team/src/environment-check.ts`**

- `evaluateEnvironment` (environment-check.ts:92) — name the precedence `verdictFor({ satisfied, range, running })` instead of ordering it with prose.

**`packages/agent-team/src/human-profile.ts`**

- `planLegacyAdoption` (packages/agent-team/src/human-profile.ts:146) — doc admits the parameter type is shaped to dodge `exactOptionalPropertyTypes`. Type it as the Host getter's real return so the dodge disappears.

**`packages/agent-team/src/index.ts`**

- `MemberRuntime` construction / `liveMemberContext` closure (packages/agent-team/src/index.ts:500-508) — extract a declared accessor (`liveContextFor(memberId): Context`) so call-time dereference is the function's contract, not a comment about field ordering.
- `applyCapabilityEdit` + `deferred:generation-changed` (packages/agent-team/src/index.ts:1788) — delete the unreachable guard; if the outcome must stay (it is exported in `AgentTeamMemberEffect`), assert the queue invariant at the enqueue seam instead of carrying a dead branch.
- `memberStatus` (packages/agent-team/src/index.ts:3398) — replace the "five states" prose with a real `NO_LIVE_SURFACE_STATES` table/derivation consumed by the three returns.
- `notificationAttempts` / `NotificationCause` split (packages/agent-team/src/index.ts:554-557, 3705-3708) — make the delivery attempt part of the wake record so "attempt ≠ request" is structural, then delete the explanatory text.
- `replayCarriedInput` (packages/agent-team/src/index.ts:2620) — encode the three skip classes as a typed classification (corrupt / refused / started-generation) returned by the reader, replacing the prose list at 2599-2618.

**`packages/agent-team/src/installed-manifest.ts`**

- `readInstalledManifest` (packages/agent-team/src/installed-manifest.ts:18) — extract `installedPackageRoot()` so the `'../../../package.json'` hop is named code, not prose (7-16).

**`packages/agent-team/src/invariant.ts`**

- `apply` (packages/agent-team/src/invariant.ts:45) — extract `createCommitInvariantCheck(ctx)`; the latch + `setImmediate` coalescing becomes a named unit instead of comments 48-64 and 82-83.

**`packages/agent-team/src/ledger.ts`**

- `boundedInboxPreview` / `boundedReplyExcerpt` / `boundedThreadTitle` (ledger.ts:448, 458, 468) — collapse to one `boundedOpeningLine(body, max)`; move the shared bound next to the Client's `RECENT_ROWS_LIMIT`.
- archival rule (ledger.ts:1535, 3765, 4015) — extract one `visibleChannel(channelRef)` predicate (or `ARCHIVED` guard type) used by feed, ref resolution and inbox; delete all seven copies.
- `recordClaim` (ledger.ts:3121) — extract `upsertKeepingPosition(bucket, claim, key)` so "first write wins position" is the name.
- `recordAttentionObservations` (ledger.ts:3138) — split into `recordUnfollowObservations` / `recordFollowObservations`.
- `occurredAtForFactFrom` (ledger.ts:3408) — carry an `occurredAtBySequence` map on `Projection` instead of `ordered[sequence - 1]`.
- `directMarkersForFrom` (ledger.ts:3568) — rename to `frozenMarkerSnapshot` (or return a readonly type), deleting the "frozen copy" note.
- `pair` / `mirror` (ledger.ts:1467) — rename `sentByOther` / `sentByReader`.
- `apply` (ledger.ts:2872) — rename `applyAndBumpProjectionVersion`, or move the bump into `changeScopesOf`'s caller.
- audit-only kinds (ledger.ts:3301, 3309) — replace four per-kind comments with one `AUDIT_ONLY_KINDS` set checked once.
- `applyReleaseSnapshot` (ledger.ts:3050) — make the required order a sequence of typed steps (`applyClaims` → `applyActivities` → `applyInbox`) instead of a prose ordering rule.
- `prepareReadReceiptFrom` (ledger.ts:3247) / `prepareReadFrom` (ledger.ts:3280) / `readPicture` (ledger.ts:4672) — split receipt-shaped from picture-shaped reads into two named types, removing the "frozen legacy shape" caveats.
- `tokenNeverReached` (ledger.ts:3660) — rename `revisionNeverExisted` and return a `'before-first-fact' | 'known-absent' | 'raced'` enum instead of `false`-as-unknown.

**`packages/agent-team/src/member-runtime.ts`**

- `MemberRuntime.memberRestrictions` (member-runtime.ts:113) — make the reserved restriction seam a real API (a `MemberToolPolicy` value with its own consumer) or delete it; do not reserve an interface inside a comment.
- `MemberRuntime.appliedCapabilities` (member-runtime.ts:126) — replace the `… | null` sentinel with a tagged type that distinguishes "never applied" from "applied with no capabilities".
- `MemberRuntime.awaitTurnBoundary` (member-runtime.ts:257) — return `'waited' | 'idle'`, not a bare boolean explained only by a doc block.
- `MemberRuntime.reapplyMemberToolPolicy` (member-runtime.ts:196) — extract the rollback (`restoreEnforcedToolAllow`) so the restored state (allow-list vs warnings) is a value, not a paragraph.

**`packages/agent-team/src/member-skills.ts`**

- `MemberSkillSelectionRef.swap` (packages/agent-team/src/member-skills.ts:23, assigned :54 and :62) — make the mount return `{ swap, dispose }`; the no-op placeholder at :54 exists only because a caller-owned config field is reassigned.

**`packages/agent-team/src/member-time-context.ts`**

- `renderClockSnapshot` (member-time-context.ts:125) — clamp via a named `nonNegativeDuration(elapsedMs)`; never comment a rollback.

**`packages/agent-team/src/recovery.ts`**

- `RecoveryCoordinator.dispose` (recovery.ts:238) — snapshot `[...this.episodes.keys()]` before clearing, or extract `clearAll(reason)`; never rely on mutation-while-iterating.
- `classifyRecoverableError` (recovery.ts:60) — extract `kindFromProvenance(code, status)` so "structured outranks wording" is structural.

**`packages/agent-team/src/request-scoped-id.ts`**

- `requestScopedUuid` (packages/agent-team/src/request-scoped-id.ts:16) — rename so retry-stability is in the name (e.g. `stableRequestUuid`); delete the doc block 3-15.

**`packages/agent-team/src/session-event-cursor.ts`**

- `advanceSessionEventCursor` (session-event-cursor.ts:95) — name the append-only precondition in the signature: rename to `advanceAppendOnlySessionEventCursor` and type `logFrom`/`logEnd` as a branded `SessionLogOffset` instead of bare `number`, so the log-identity requirement is checked by the compiler rather than by a prose residual.

**`packages/agent-team/src/spec.ts`**

- `memberCapabilitiesSchema.tools.allow` (spec.ts:65) — no consumer of `tools.allow` exists in any src; either delete the field or ship the consumer. A comment cannot reserve an interface.
- `releaseSnapshotFields` (spec.ts:282) — promote to a named exported schema/type so the shared shape is type-enforced; the comment is already stale.

**`packages/agent-team/src/surface-visibility.ts`**

- `isDirectMentionNotice` / `isDmRelay` (packages/agent-team/src/surface-visibility.ts:117,122) — dead exports: no call site, test, or diagnostic anywhere in the repo (grep). Delete both; the "for tests and diagnostics" doc is false.
- `TRUNCATION_MARKER` (packages/agent-team/src/surface-visibility.ts:38) — the literal duplicates `boundedNotificationBody` (index.ts:3864). Export one marker from the renderer and import it here, so the coupling is a type/import, not a comment.

**`packages/agent-team/src/types/entities.ts`**

- `AgentTeamMemberCapabilities.tools` (entities.ts:87) — drop the "reservation" framing: either document it as the enforced activation allow-list it actually is (`member-runtime.ts:156` enforces it) or delete the field.

**`packages/agent-team/src/types/requests-results.ts`**

- `AgentTeamActiveTaskThread.status` (requests-results.ts:992) — extract `AgentTeamLiveTaskStatus = Extract<AgentTeamTask['status'], 'in_progress' | 'in_review'>` in entities.ts and use it; `ledger.ts:3734-3736` already filters to exactly those two.
- `AgentTeamStaleRevision.tokenUnrecognized` (requests-results.ts:576) — tri-state boolean (true | absent) meaning unrecognized | unknowable; replace with `readonly staleTokenKind: 'unrecognized' | 'race' | 'unknown'` so absence stops meaning "the ledger cannot tell" (`ledger.ts:3642` only ever sets `true`).
- `AgentTeamInboxItem.unreadCount` / `.directCount` (requests-results.ts:786-788) — zeros forced into a shared row for the 「最近活跃」 slice (`ledger.ts:1651`); split `AgentTeamRecentInboxItem` (base row without counts) so the invariant is the type.
- `AgentTeamHumanProfileResult.updateAvailable` (requests-results.ts:370) — `false` conflates "no update" with "not yet checked"; drop the field and make `latestVersion` the single optional source (absent = unknown), or `updateAvailable?: boolean`.
- `AgentTeamAddMemberResult.workspaceIds` (requests-results.ts:179) — always exactly one element at creation (`index.ts:1251`); make it `readonly workspaceId: WorkspaceId`.
- `AgentTeamInboxItem.claimOwners` / `AgentTeamViewItem.claimOwners` (requests-results.ts:812, 969) — rename to `liveClaimOwners`, matching the one function that defines the rule (`ledger.ts:1599`), deleting the cross-reference prose.

**`packages/client-agent-team/src/client/TeamAgentsPanel.tsx`**

- `followRollover` (TeamAgentsPanel.tsx:86) + `observedSessionIds`/`pendingFollows`/`seatSessionIdRef` — extract `useMemberSessionFollow(seatSessionId, openMemberSession)` with typed states (`idle | pending | followed`); the commit-window rule must be a state transition, not a comment.
- empty-roster condition (TeamAgentsPanel.tsx:270) — extract `const showEmptyRoster = !loading && error === undefined && members.length === 0`.

**`packages/client-agent-team/src/client/TeamChannelPage.tsx`**

- `mergeChannelView` (TeamChannelPage.tsx:56) — extract `hasOlderBeyondFreshWindow(current, fresh)` so `current.cursor < fresh.cursor` reads as the retention rule.
- `printedActivityAt` (TeamChannelPage.tsx:88) — rename to `unresolvedFollowUpAt` (or gate `done/closed` at the call site), so a resolved Task suppressing the instant is visible.
- `followUpAt` (TeamChannelPage.tsx:74) — rename to `newerActivityAt`; "strictly newer than the entry's own Message" must be in the name.
- unread update in `refresh` (TeamChannelPage.tsx:221) — extract `applyInboxRead(previous, result)`; "a failed read keeps the last counts" must be code, not a comment.

**`packages/client-agent-team/src/client/TeamComposer.tsx`**

- `MentionTier` (TeamComposer.tsx:26) — replace `0 | 1 | 2` with a named union (`'thread-follower' | 'channel-peer' | 'workspace'`) so ranking, styling, and `mentionTierIsParticipant` read a word; then the doc is dead.
- `replyTo` prop type (TeamComposer.tsx:117) — extract a named `ReplyTarget` type; the Human-exclusion is currently invisible in the anonymous inline shape.
- `notifiedIds` (TeamComposer.tsx:233) — extract `deliverableRecipients(recipients, draft, members, replyTo)`; the rule must be a function name, not a 13-line comment.
- `draftPreviewUrls` (TeamComposer.tsx:71) — extract `revokeDraftPreviewUrl(file)` and call it at :422; the WeakMap lifecycle becomes a call, not a comment.

**`packages/client-agent-team/src/client/TeamInboxPage.tsx`**

- `compareInboxRows` (TeamInboxPage.tsx:50) — rename to `compareByHostInboxOrder` so "mirrors the Host's order and truncation policy" is in the name.

**`packages/client-agent-team/src/client/TeamMessage.tsx`**

- `TeamMessage` (TeamMessage.tsx:101) — extract the ref/mention resolution into `useResolvedBodyRefs` (or pass identity-stable callbacks via context) so callers stop hand-memoizing; the memo JSDoc and the `onReply` rationale then die.
- `renderResolvedMarkdownText` / `renderResolvedMarkdownCodeRef` (TeamMessage.tsx:437, 459) — render chips as React nodes (a MarkdownText node renderer) instead of rewriting the DOM after render; that removes the "wrapper must stay mounted" and re-entrancy constraints.
- `rowActions?: boolean` (TeamMessage.tsx:70) — absence silently inherits `onReply`; make it required or `'inherit' | 'always' | 'never'`.
- `fallbackNames` filter (TeamMessage.tsx:126) — extract a named helper in team-formatters.ts (`mentionFallbackNames({ …, readerName, quoteAuthor })`).

**`packages/client-agent-team/src/client/TeamSettingsSection.tsx`**

- `AVATAR_MAX_BYTES` (TeamSettingsSection.tsx:31) — export one shared constant from a subpath both packages may import, so it cannot drift from host `ATTACHMENT_MAX_BYTES`.
- `draft` (TeamSettingsSection.tsx:88) — make it a discriminated union (`{ kind: 'follow' } | { kind: 'editing'; text: string }`) instead of `string | undefined` whose `undefined` carries meaning.
- `judgeForm` (TeamSettingsSection.tsx:84) — extract a `useObservedJudgeForm(source)` hook; the subscription reason belongs in one place, not in a comment.

**`packages/client-agent-team/src/client/TeamWorkspaceBrowser.tsx`**

- inbox total merge (TeamWorkspaceBrowser.tsx:76-81) — extract `mergeInboxTotals(results, previous)` as a named pure function over a discriminated per-workspace result, so "a failed refresh keeps the last good total" is a signature, not a comment.

**`packages/client-agent-team/src/client/avatar-image.ts`**

- useAvatarImage / AvatarImage.src (avatar-image.ts:24) — `src: undefined` collapses "no URL" and "bytes did not decode"; return a discriminated result (`{kind:'image';src} | {kind:'initial'}`) so the fallback reason is in the type.

**`packages/client-agent-team/src/client/drafts.ts`**

- `TeamDraftStore.write` (drafts.ts:127) — extract the entry-equality test to `sameDraftEntry(previous, next): boolean` so the no-bump rule needs no comment.

**`packages/client-agent-team/src/client/human-identity.ts`**

- `TeamHumanIdentity.read` (human-identity.ts:118) — lift the two catch sites into one `recordReadFailure(error)`; the avatar-reuse branch becomes `avatarUrlFor(ref)` carrying the immutability assumption as a type/named function, not a comment.

**`packages/client-agent-team/src/client/index.ts`**

- `TEAM_SETTINGS_NS` (client/index.ts:69) — the same literal is duplicated at packages/agent-team/src/human-profile.ts:35 (`HUMAN_PROFILE_SETTINGS_NAMESPACE`); extract one shared constant both packages import.
- `leaveTeamFromUi` (client/index.ts:111) — make panel-clear + mode-exit one atomic navigation operation, not an order-dependent pair the comment has to defend.
- `membersQuery` (client/index.ts:190) — express the covered scopes as data, not a predicate defended by "issue 03 criterion 4" (that issue lives in `.scratch/`, which `docs/AGENTS.md` says is not an authority).

**`packages/client-agent-team/src/client/mention-presentation.ts`**

- mentionSurfaceOf (mention-presentation.ts:16) — make `TeamDraftKey` a discriminated union and switch on its discriminant (or mint the surface where the key is minted) so the surface mapping is total and visible, not a `startsWith` prefix test.

**`packages/client-agent-team/src/client/navigation.ts`**

- `setMemberSession` guard (navigation.ts:134) — extract `isReselectingActiveMember(snapshot, sessionId)`.

**`packages/client-agent-team/src/client/refs.ts`**

- `hostRefLookup` walk (refs.ts:176) — extract `rememberAliasedResolutions(entries, refs)` so the Host input-order dependency is named, not narrated.

**`packages/client-agent-team/src/client/team-dialog-save.ts`**

- useEditDialogSave (team-dialog-save.ts:12) — drop the returned `pendingRequest: MutableRefObject`; own the invalidation (return `invalidate()`, or take the edit fields and decide reuse internally) so no caller can forget to clear a committed request.

**`packages/client-agent-team/src/client/team-queries.ts`**

- `answeredFailure` (team-queries.ts:62) — move the payload-failure rule into the `failed` counter's contract (a named outcome check on `Outcome`) so the counter's shape carries it.
- `settle` (team-queries.ts:230) — extract `dropStale` / `deliverSuperseded` so each branch's rule is its name, not a paragraph.

**`packages/client-agent-team/src/client/team-separators.ts`**

- `timelineDayKey` (packages/client-agent-team/src/client/team-separators.ts:24) — pass-through alias to `localDateKey`; delete the wrapper, export `localDateKey` and use it.

**`packages/tool-agent-team/src/host-access.ts`**

- `MIN_WORKSPACE_PREFIX` (packages/tool-agent-team/src/host-access.ts:40) — abbreviation tolerance duplicated with branded refs. Extract a shared `refTail()` + tolerance constant instead of the 4-line rationale.

**`packages/tool-agent-team/src/index.ts`**

- `rejectionLines`' `noun` parameter (index.ts:221) — dead: `noun` appears only in the signature and comment; callers pass `'message'`/`'Claim mutation'`. Drop the parameter and both call-site arguments.
- `RejectedFact` and the `fact as FactView` cast (index.ts:191, 273) — delete the hand-widened duplicate and the cast; make `factLine` accept the structural input (or declare `kind` as an enum in the output schema) so one type serves both surfaces.
- `MessageFactView.replyTo` / `replyToMessageRef` (index.ts:54, 62) — rename so ref-vs-resolved-quote is self-evident (`replyToMessageRef` / `replyToQuote`), removing any need for the justification.
- `tokenUnrecognized` branch (index.ts:246) — make the token-unrecognized case its own outcome `kind` (the recovery registry already has a distinct id), so withholding the fact list is self-describing.

### packages/tool-agent-team/src（工具）

**`packages/tool-agent-team/src/host-access.ts`**

- `MIN_WORKSPACE_PREFIX` (packages/tool-agent-team/src/host-access.ts:40) — abbreviation tolerance duplicated with branded refs. Extract a shared `refTail()` + tolerance constant instead of the 4-line rationale.

**`packages/tool-agent-team/src/index.ts`**

- `rejectionLines`' `noun` parameter (index.ts:221) — dead: `noun` appears only in the signature and comment; callers pass `'message'`/`'Claim mutation'`. Drop the parameter and both call-site arguments.
- `RejectedFact` and the `fact as FactView` cast (index.ts:191, 273) — delete the hand-widened duplicate and the cast; make `factLine` accept the structural input (or declare `kind` as an enum in the output schema) so one type serves both surfaces.
- `MessageFactView.replyTo` / `replyToMessageRef` (index.ts:54, 62) — rename so ref-vs-resolved-quote is self-evident (`replyToMessageRef` / `replyToQuote`), removing any need for the justification.
- `tokenUnrecognized` branch (index.ts:246) — make the token-unrecognized case its own outcome `kind` (the recovery registry already has a distinct id), so withholding the fact list is self-describing.

### packages/client-agent-team/src（Client）

**`packages/client-agent-team/src/client/TeamAgentsPanel.tsx`**

- `followRollover` (TeamAgentsPanel.tsx:86) + `observedSessionIds`/`pendingFollows`/`seatSessionIdRef` — extract `useMemberSessionFollow(seatSessionId, openMemberSession)` with typed states (`idle | pending | followed`); the commit-window rule must be a state transition, not a comment.
- empty-roster condition (TeamAgentsPanel.tsx:270) — extract `const showEmptyRoster = !loading && error === undefined && members.length === 0`.

**`packages/client-agent-team/src/client/TeamChannelPage.tsx`**

- `mergeChannelView` (TeamChannelPage.tsx:56) — extract `hasOlderBeyondFreshWindow(current, fresh)` so `current.cursor < fresh.cursor` reads as the retention rule.
- `printedActivityAt` (TeamChannelPage.tsx:88) — rename to `unresolvedFollowUpAt` (or gate `done/closed` at the call site), so a resolved Task suppressing the instant is visible.
- `followUpAt` (TeamChannelPage.tsx:74) — rename to `newerActivityAt`; "strictly newer than the entry's own Message" must be in the name.
- unread update in `refresh` (TeamChannelPage.tsx:221) — extract `applyInboxRead(previous, result)`; "a failed read keeps the last counts" must be code, not a comment.

**`packages/client-agent-team/src/client/TeamComposer.tsx`**

- `MentionTier` (TeamComposer.tsx:26) — replace `0 | 1 | 2` with a named union (`'thread-follower' | 'channel-peer' | 'workspace'`) so ranking, styling, and `mentionTierIsParticipant` read a word; then the doc is dead.
- `replyTo` prop type (TeamComposer.tsx:117) — extract a named `ReplyTarget` type; the Human-exclusion is currently invisible in the anonymous inline shape.
- `notifiedIds` (TeamComposer.tsx:233) — extract `deliverableRecipients(recipients, draft, members, replyTo)`; the rule must be a function name, not a 13-line comment.
- `draftPreviewUrls` (TeamComposer.tsx:71) — extract `revokeDraftPreviewUrl(file)` and call it at :422; the WeakMap lifecycle becomes a call, not a comment.

**`packages/client-agent-team/src/client/TeamInboxPage.tsx`**

- `compareInboxRows` (TeamInboxPage.tsx:50) — rename to `compareByHostInboxOrder` so "mirrors the Host's order and truncation policy" is in the name.

**`packages/client-agent-team/src/client/TeamMessage.tsx`**

- `TeamMessage` (TeamMessage.tsx:101) — extract the ref/mention resolution into `useResolvedBodyRefs` (or pass identity-stable callbacks via context) so callers stop hand-memoizing; the memo JSDoc and the `onReply` rationale then die.
- `renderResolvedMarkdownText` / `renderResolvedMarkdownCodeRef` (TeamMessage.tsx:437, 459) — render chips as React nodes (a MarkdownText node renderer) instead of rewriting the DOM after render; that removes the "wrapper must stay mounted" and re-entrancy constraints.
- `rowActions?: boolean` (TeamMessage.tsx:70) — absence silently inherits `onReply`; make it required or `'inherit' | 'always' | 'never'`.
- `fallbackNames` filter (TeamMessage.tsx:126) — extract a named helper in team-formatters.ts (`mentionFallbackNames({ …, readerName, quoteAuthor })`).

**`packages/client-agent-team/src/client/TeamSettingsSection.tsx`**

- `AVATAR_MAX_BYTES` (TeamSettingsSection.tsx:31) — export one shared constant from a subpath both packages may import, so it cannot drift from host `ATTACHMENT_MAX_BYTES`.
- `draft` (TeamSettingsSection.tsx:88) — make it a discriminated union (`{ kind: 'follow' } | { kind: 'editing'; text: string }`) instead of `string | undefined` whose `undefined` carries meaning.
- `judgeForm` (TeamSettingsSection.tsx:84) — extract a `useObservedJudgeForm(source)` hook; the subscription reason belongs in one place, not in a comment.

**`packages/client-agent-team/src/client/TeamWorkspaceBrowser.tsx`**

- inbox total merge (TeamWorkspaceBrowser.tsx:76-81) — extract `mergeInboxTotals(results, previous)` as a named pure function over a discriminated per-workspace result, so "a failed refresh keeps the last good total" is a signature, not a comment.

**`packages/client-agent-team/src/client/avatar-image.ts`**

- useAvatarImage / AvatarImage.src (avatar-image.ts:24) — `src: undefined` collapses "no URL" and "bytes did not decode"; return a discriminated result (`{kind:'image';src} | {kind:'initial'}`) so the fallback reason is in the type.

**`packages/client-agent-team/src/client/drafts.ts`**

- `TeamDraftStore.write` (drafts.ts:127) — extract the entry-equality test to `sameDraftEntry(previous, next): boolean` so the no-bump rule needs no comment.

**`packages/client-agent-team/src/client/human-identity.ts`**

- `TeamHumanIdentity.read` (human-identity.ts:118) — lift the two catch sites into one `recordReadFailure(error)`; the avatar-reuse branch becomes `avatarUrlFor(ref)` carrying the immutability assumption as a type/named function, not a comment.

**`packages/client-agent-team/src/client/index.ts`**

- `TEAM_SETTINGS_NS` (client/index.ts:69) — the same literal is duplicated at packages/agent-team/src/human-profile.ts:35 (`HUMAN_PROFILE_SETTINGS_NAMESPACE`); extract one shared constant both packages import.
- `leaveTeamFromUi` (client/index.ts:111) — make panel-clear + mode-exit one atomic navigation operation, not an order-dependent pair the comment has to defend.
- `membersQuery` (client/index.ts:190) — express the covered scopes as data, not a predicate defended by "issue 03 criterion 4" (that issue lives in `.scratch/`, which `docs/AGENTS.md` says is not an authority).

**`packages/client-agent-team/src/client/mention-presentation.ts`**

- mentionSurfaceOf (mention-presentation.ts:16) — make `TeamDraftKey` a discriminated union and switch on its discriminant (or mint the surface where the key is minted) so the surface mapping is total and visible, not a `startsWith` prefix test.

**`packages/client-agent-team/src/client/navigation.ts`**

- `setMemberSession` guard (navigation.ts:134) — extract `isReselectingActiveMember(snapshot, sessionId)`.

**`packages/client-agent-team/src/client/refs.ts`**

- `hostRefLookup` walk (refs.ts:176) — extract `rememberAliasedResolutions(entries, refs)` so the Host input-order dependency is named, not narrated.

**`packages/client-agent-team/src/client/team-dialog-save.ts`**

- useEditDialogSave (team-dialog-save.ts:12) — drop the returned `pendingRequest: MutableRefObject`; own the invalidation (return `invalidate()`, or take the edit fields and decide reuse internally) so no caller can forget to clear a committed request.

**`packages/client-agent-team/src/client/team-queries.ts`**

- `answeredFailure` (team-queries.ts:62) — move the payload-failure rule into the `failed` counter's contract (a named outcome check on `Outcome`) so the counter's shape carries it.
- `settle` (team-queries.ts:230) — extract `dropStale` / `deliverSuperseded` so each branch's rule is its name, not a paragraph.

**`packages/client-agent-team/src/client/team-separators.ts`**

- `timelineDayKey` (packages/client-agent-team/src/client/team-separators.ts:24) — pass-through alias to `localDateKey`; delete the wrapper, export `localDateKey` and use it.

### scripts/

**`scripts/audit-ui-parity.mjs`**

- extract `bareSelector(rule)` (scripts/audit-ui-parity.mjs:401, 429, 510, 546, 594) — the same `rule.selector.replace(/^[\s\S]*\*\//, '')` inline lives five times, which is the only reason the "comment inside the captured selector" prose exists; one named helper makes it self-evident and deletes the comment.

**`scripts/check-core-skills.mjs`**

- `frontMatter` (scripts/check-core-skills.mjs:74) — either parse folded `key: value` values or throw on a folded description; silently reading the first line is the behavior the comment confesses.

**`scripts/check-public-baseline.mjs`**

- `localSurfaces[].pattern` (scripts/check-public-baseline.mjs:64) — extract a `baselineStatement(text)` parser (with tests) instead of the "accepted cost" anchoring regex.

**`scripts/continuity-dir.mjs`**

- `servesBundle` (scripts/continuity-dir.mjs:84) — rename to `atLeastFloorIgnoringPrerelease` (or return an explicit `'below'|'ok'` comparison) so ignoring the prerelease tag is in the name, not a comment.

**`scripts/isolate-dsh-home.setup.ts`**

- scripts/isolate-dsh-home.setup.ts:17 — extract `export function isolateDshHome(): string` and call it, so forcing DSH_HOME is a visible act, not a bare module side effect.

**`scripts/session-trace.ts`**

- `derived: {} as DerivedFields` in `cmdTimeline` (session-trace.ts:355) — extract `hydrateDerived(rows)` so the placeholder lie disappears.
- `ListRow.archived` (session-trace.ts:273) — the flag means "session log absent"; rename/split into `logMissing` instead of the comment.
- `import { harnessDir } from './harness-dir.mjs'` (session-trace.ts:28) — `@ts-expect-error` masks a real `any` hole; add `scripts/harness-dir.d.mts` (or `@type` JSDoc) and delete the suppression.

**`scripts/team-ui.e2e.ts`**

- `taskEntrySelector` (scripts/team-ui.e2e.ts:95) — parsing the door's accessible name by string prefix is a smell: give the door a stable marker (`data-thread-entry-door`) and select on it.
- `builderAgent.session.append('request/context', …)` (scripts/team-ui.e2e.ts:685-690) — a hand-written Host record inline; wrap as a named scaffold fixture (`seedPersistedRoute`) or fix the harness adapter's route capacity.
- `channelSeat` (scripts/team-ui.e2e.ts:1082) — asserts the seat variable off the Channel root to guard a past declaration site; declare it on the shared conversation root and read it from there.
- `faceGeometry` / `[34, 34, 5]` (scripts/team-ui.e2e.ts:1314, 1329) — frozen face/drop literals; name the constants or read the drop from the live identity rule.
- `readCountCapsule` (scripts/team-ui.e2e.ts:170) — a bespoke box/inset/shape reader standing in for one shared badge rule; encode the rule once and assert the rule.

**`scripts/team-ui.ui-preview.ts`**

- request/context append (scripts/team-ui.ui-preview.ts:97) — extract `recordPriceableRoute(agent)`, making the fixture seam a named API.

### 测试

**`packages/agent-team/tests/agent-team.spec.ts`**

- `replayLedger` (tests/agent-team.spec.ts:131, comment :785-787) — rename to `ledgerAtBoot()` and give `AgentTeamLedger` an explicit `refresh()`/live view, so "a ledger is a frozen construction-time replay" is the API, not a comment.

**`packages/agent-team/tests/change-scopes.spec.ts`**

- `addLedgerMember` (change-scopes.spec.ts:52) — rename to `commitMemberRecordDirectlyOnLedger` so writing a Member record outside the service is visible.
- `staysPending` (change-scopes.spec.ts:94) — rename to `staysPendingAcrossMacrotask`.

**`packages/agent-team/tests/context-projection.spec.ts`**

- `legacyRolloverPair` → `legacyNewContextPair` (packages/agent-team/tests/context-projection.spec.ts:108-113, called at :135, :165-166, :214-215) — the doc comment only exists because the helper hides which name it emits (`NEW_CONTEXT_TOOL_NAME`); put the legacy name in the symbol and split the live pair into a separate helper (`rolloverPair(...CONTEXT_ROLLOVER_TOOL_NAME)`) so the misuse warning is unnecessary.

**`packages/agent-team/tests/helpers/legacy-thread-read.ts`**

- `snapshotReadData` (packages/agent-team/tests/helpers/legacy-thread-read.ts:10) — rename `fabricateLegacyThreadReadSnapshot`; the legacy shape must be a named type.
- `receiptReadData` (packages/agent-team/tests/helpers/legacy-thread-read.ts:32) — rename `counterfactualReceiptReadData`; the name must state it fabricates a pre-receipt record.

**`packages/agent-team/tests/helpers/memory-backend.ts`**

- `failNextWrites` (packages/agent-team/tests/helpers/memory-backend.ts:45) — rename `injectedWriteFailuresRemaining`; the countdown semantics must live in the name.

**`packages/agent-team/tests/member-time.spec.ts`**

- `replayLedger` (packages/agent-team/tests/member-time.spec.ts:85) — rename `replayLedgerAtConstruction` (or take the table and encode construction-time replay in the type) so line 115-117's claim is visible.

**`packages/agent-team/tests/member-tool-policy.spec.ts`**

- `vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })` (member-tool-policy.spec.ts:13) — move the timeout policy into `vitest.config.ts`; a per-file override plus its story should not exist.
- `buildSharedHarness` (member-tool-policy.spec.ts:151) — extract to `tests/helpers/` as a reusable Harness fixture; the boot contract belongs in the helper's shape, not prose.
- `let shared` + `t1..t7` handles (member-tool-policy.spec.ts:213, 236) — make each test's ids structurally unique (per-test namespace/session-scoped ledger); drop the grep-audited convention.
- `EmptyAdapter.resolveModel` (member-tool-policy.spec.ts:58) — rename the class/const so the large window is intent: `StablePressureAdapter` with `CONTEXT_WINDOW`.
- `ctx.provide('tokenMeter', …)` (member-tool-policy.spec.ts:189) — extract `provideQuietTokenMeter(ctx)`; the reason dies with the comment.

**`packages/agent-team/tests/operation-protocol.spec.ts`**

- `internals` / `LedgerInternals` (operation-protocol.spec.ts:541) — replace the `as unknown as` double cast with a typed test seam for `normalizeOperation` / `repairLegacyChannelCleanup`.
- `ensureFollow` (operation-protocol.spec.ts:1190) — rename so the coverage intent (`followThreadForLegacyRepair`) is in the name.

**`packages/agent-team/tests/shipping.spec.ts`**

- `PERSONA_CHARACTER_BUDGET` (packages/agent-team/tests/shipping.spec.ts:38) — record the persona size as a checked-in baseline artifact so the number carries its own provenance.

**`packages/client-agent-team/tests/harness.tsx`**

- `changes` double (harness.tsx:481) — expose an awaitable stream-open signal so specs stop priming the probe with a throwaway publish.
- `threadHistoryFailure` (harness.tsx:408) — replace the sticky flag with `failNextThreadHistory(message)`; the false doc dies with the name.

**`packages/client-agent-team/tests/team-inbox.client.spec.tsx`**

- double `b.seedInbox(...)` calls (team-inbox.client.spec.tsx:77–78 and throughout) — the harness swallows the first publish; make seeding deterministic so one call suffices.

### 未解析（报告未给出可核对行号，需人工定位）

**`(未解析)`**

- `persistenceRaceError` (45) — rename to `win32StagingDirectoryEnoent`.
- `rmFault` (54) — rename to `rmFailingPathFragment`; type the sentinel so "empty = pass through" is visible, then delete the mock's rationale block.
- `ScriptedAdapter.failWith` (104) — rename `throwOnEveryModelCall`, type `Error | undefined` instead of `unknown`.
- `waitFor`'s `timeoutMs = 60_000` (2599) plus `vi.setConfig` budget (11) — extract one `TEST_TIMEOUT_MS` constant both read.
- `staysPending` (5143, 5204) — extract one shared helper instead of two copies.
- `TestablePresets.failingMount` / `orphaned` (188–189) — rename to `mountFailure` / `agentsWithoutComposition` so the seam reads without the class block comment.
- `acceptedClaimRefs` (:328/:375, comment :318-323) — make the accept discriminator a type (e.g. `accept: { accepted: ClaimRef[]; completed: ClaimRef[] }` written unconditionally for `accept`, versioned), so "empty but present ≠ legacy absent" is not prose.
- `validateLedgerAtMount()` (:1795/:1810, comments :1741-1742, :1771-1772, :1784, :1807-1809) — return what the mount did (`{ adopted: boolean; replayed: number }`) so one-shot adoption is assertable state.
- commit-path invariant latch (:1828 `/* still latched */`, comment :1725-1727) — expose `invariantStatus()` / `lastDivergence()` instead of a swallowed `emit` in try/catch.
- `contextJudgeForClient` gate defaults (comment :3074-3079) — encode the asymmetry (two defaults come from the engine, `judgeTimeoutMs` is Team's) as a named defaults object, not a paragraph.
- `legacyJoinLedger` / `legacyRemovalLedger` (:88/:99) — rename to `preDerivationJoinFixture` / `preDerivationRemovalFixture` and drop the doc blocks.
- `stableMentionNames` / `mentionNamesCache` (T:86-92) — extract a named `MentionNameCache` (or memoized map keyed on facts) whose identity contract is the type, not a paragraph.
- `mutating` (T:181) — rename to a label-source like `pendingMutationLabel`; `'promote' | 'accept'` does not say "button copy only".
- `timelineOnScroll` (T:194) — make `useTimelineScroll` return an identity-stable memoized object; delete the alias.
- `refreshSupplemental` (T:270-278) — the `await Promise.resolve()` coalescing is invisible; extract/rename `coalesceScopeNotifications()`.
- `firstUnreadMention` (T:107-125) — rename to name its rule (`firstUnreadMessageNaming`) and drop the `direct`-vs-body footnote.
- `pendingJump` + its `useLayoutEffect` (T:175, 567-576) — extract `useOpeningJump`, whose name owns "pending until the pulse releases".
- duplicated `activeClaims` (T:920, 942) — one derived `activeClaims` (useMemo) consumed by both the header and the accept dialog.
- `waitActivated` tests (member-lifecycle.spec.ts:2652,:2704,:2758) — extract one `waitForActiveGeneration(memberId)` helper; the ordering comments disappear with it.
