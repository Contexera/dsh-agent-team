# 生产源码覆盖索引

检查日期：2026-11-10；基线 `7076dbd`。本表的“覆盖”表示源码/符号及责任归属扫描；高风险协议结合关键分支与现有测试细读，不表示每行、每个交错或每个状态组合均已执行证明。各域材料记录证据深度与未验证项。

范围为三个 package 的 `src` 下 TS/TSX（含声明），不含生成 `lib`、依赖源码、历史 `.scratch` 或 CSS；样式和纯渲染已在 Client 材料分类，不把它们算成机器。工具/Host 为同一补充材料；各域交叉引用不增加独立权威。

## agent-team（56 文件）

| 相对 src 的文件 | 审计材料 |
| --- | --- |
| `acceptance-context.ts` | [domain](materials/domain.md) |
| `activity-facts.ts` | [domain](materials/domain.md) |
| `attachments.ts` | [subscriptions](materials/subscriptions.md) |
| `cold-inbox.ts` | [domain](materials/domain.md) |
| `context-codec.ts` | [member-runtime](materials/member-runtime.md) |
| `context-projection.ts` | [domain](materials/domain.md) |
| `context-source.ts` | [member-runtime](materials/member-runtime.md) |
| `environment-check.ts` | [subscriptions](materials/subscriptions.md) |
| `host-row-settings.ts` | [subscriptions](materials/subscriptions.md) |
| `human-avatar.ts` | [subscriptions](materials/subscriptions.md) |
| `human-profile.ts` | [subscriptions](materials/subscriptions.md) |
| `human-settings.ts` | [subscriptions](materials/subscriptions.md) |
| `human-update-check.ts` | [subscriptions](materials/subscriptions.md) |
| `inbox-delivery.ts` | [host-and-tools](materials/host-and-tools.md) |
| `inbox-notice.ts` | [host-and-tools](materials/host-and-tools.md) |
| `index.ts` | [host-and-tools](materials/host-and-tools.md) |
| `installed-manifest.ts` | [subscriptions](materials/subscriptions.md) |
| `invariant.ts` | [domain](materials/domain.md) |
| `ledger.ts` | [domain](materials/domain.md) |
| `member-compaction-engine.ts` | [member-runtime](materials/member-runtime.md) |
| `member-compaction.ts` | [member-runtime](materials/member-runtime.md) |
| `member-context.ts` | [member-runtime](materials/member-runtime.md) |
| `member-idle.ts` | [member-runtime](materials/member-runtime.md) |
| `member-reminders.ts` | [member-runtime](materials/member-runtime.md) |
| `member-runtime.ts` | [member-runtime](materials/member-runtime.md) |
| `member-skills.ts` | [member-runtime](materials/member-runtime.md) |
| `member-time-context.ts` | [member-runtime](materials/member-runtime.md) |
| `mentions.ts` | [domain](materials/domain.md) |
| `recovery-hints.ts` | [subscriptions](materials/subscriptions.md) |
| `recovery.ts` | [host-and-tools](materials/host-and-tools.md) |
| `request-scoped-id.ts` | [domain](materials/domain.md) |
| `session-event-cursor.ts` | [domain](materials/domain.md) |
| `spec.ts` | [domain](materials/domain.md) |
| `stored-session-reader.ts` | [member-runtime](materials/member-runtime.md) |
| `subscription-admissions.ts` | [subscriptions](materials/subscriptions.md) |
| `subscription-runner.ts` | [subscriptions](materials/subscriptions.md) |
| `subscription-runs.ts` | [subscriptions](materials/subscriptions.md) |
| `subscription-runtime.ts` | [subscriptions](materials/subscriptions.md) |
| `subscription-store.ts` | [subscriptions](materials/subscriptions.md) |
| `subscription-webhook.ts` | [subscriptions](materials/subscriptions.md) |
| `subscriptions.ts` | [subscriptions](materials/subscriptions.md) |
| `surface-visibility.ts` | [domain](materials/domain.md) |
| `task-reminders.ts` | [domain](materials/domain.md) |
| `team-context-management.ts` | [member-runtime](materials/member-runtime.md) |
| `text.ts` | [host-and-tools](materials/host-and-tools.md) |
| `time-format.ts` | [host-and-tools](materials/host-and-tools.md) |
| `types/entities.ts` | [domain](materials/domain.md) |
| `types/operations.ts` | [domain](materials/domain.md) |
| `types/requests-results.ts` | [domain](materials/domain.md) |
| `types.ts` | [domain](materials/domain.md) |
| `vendor/storage-sqlite/index.ts` | [host-and-tools](materials/host-and-tools.md) |
| `vendor/storage-sqlite/schema.ts` | [host-and-tools](materials/host-and-tools.md) |
| `vendor/storage-sqlite/unit.ts` | [host-and-tools](materials/host-and-tools.md) |
| `wake-recycle.ts` | [member-runtime](materials/member-runtime.md) |
| `webhook-ingress.ts` | [subscriptions](materials/subscriptions.md) |
| `webhook.ts` | [subscriptions](materials/subscriptions.md) |

## tool-agent-team（6 文件）

| 相对 src 的文件 | 审计材料 |
| --- | --- |
| `activity-view.ts` | [host-and-tools](materials/host-and-tools.md) |
| `host-access.ts` | [host-and-tools](materials/host-and-tools.md) |
| `index.ts` | [host-and-tools](materials/host-and-tools.md) |
| `main-stream.ts` | [host-and-tools](materials/host-and-tools.md) |
| `reading-budget.ts` | [host-and-tools](materials/host-and-tools.md) |
| `subscription.ts` | [host-and-tools](materials/host-and-tools.md) |

## client-agent-team（67 文件）

| 相对 src 的文件 | 审计材料 |
| --- | --- |
| `client/BoardCardFoot.tsx` | [client](materials/client.md) |
| `client/EnvironmentCheck.tsx` | [client](materials/client.md) |
| `client/TeamAgentImport.tsx` | [client](materials/client.md) |
| `client/TeamAgentsPanel.tsx` | [client](materials/client.md) |
| `client/TeamAvatarStack.tsx` | [client](materials/client.md) |
| `client/TeamComposer.tsx` | [client](materials/client.md) |
| `client/TeamConversation.tsx` | [client](materials/client.md) |
| `client/TeamCountBadge.tsx` | [client](materials/client.md) |
| `client/TeamInboxPage.tsx` | [client](materials/client.md) |
| `client/TeamMainStream.tsx` | [client](materials/client.md) |
| `client/TeamMemberAvatar.tsx` | [client](materials/client.md) |
| `client/TeamMemberEditor.tsx` | [client](materials/client.md) |
| `client/TeamMemberRow.tsx` | [client](materials/client.md) |
| `client/TeamMessage.tsx` | [client](materials/client.md) |
| `client/TeamOwnerSeat.tsx` | [client](materials/client.md) |
| `client/TeamPanelHandle.tsx` | [client](materials/client.md) |
| `client/TeamPanelIcon.tsx` | [client](materials/client.md) |
| `client/TeamPresenceDot.tsx` | [client](materials/client.md) |
| `client/TeamProjectOwners.tsx` | [client](materials/client.md) |
| `client/TeamProjectPage.tsx` | [client](materials/client.md) |
| `client/TeamProjectPanel.tsx` | [client](materials/client.md) |
| `client/TeamProjectsPanel.tsx` | [client](materials/client.md) |
| `client/TeamRowMenu.tsx` | [client](materials/client.md) |
| `client/TeamRunDivider.tsx` | [client](materials/client.md) |
| `client/TeamSettingsNavIcon.tsx` | [client](materials/client.md) |
| `client/TeamSettingsSection.tsx` | [client](materials/client.md) |
| `client/TeamSidebarSection.tsx` | [client](materials/client.md) |
| `client/TeamStateDot.tsx` | [client](materials/client.md) |
| `client/TeamSubscriptionsTab.tsx` | [client](materials/client.md) |
| `client/TeamTaskBoardPage.tsx` | [client](materials/client.md) |
| `client/TeamThreadCard.tsx` | [client](materials/client.md) |
| `client/TeamThreadPage.tsx` | [client](materials/client.md) |
| `client/TeamThreadStartControls.tsx` | [client](materials/client.md) |
| `client/TeamWorkspaceBrowser.tsx` | [client](materials/client.md) |
| `client/TeamWorkspaceSelector.tsx` | [client](materials/client.md) |
| `client/attachment-preview.ts` | [client](materials/client.md) |
| `client/avatar-image.ts` | [client](materials/client.md) |
| `client/capacity.ts` | [client](materials/client.md) |
| `client/drafts.ts` | [client](materials/client.md) |
| `client/environment-check.ts` | [client](materials/client.md) |
| `client/human-identity.ts` | [client](materials/client.md) |
| `client/index.ts` | [client](materials/client.md) |
| `client/locales.ts` | [client](materials/client.md) |
| `client/main-stream.ts` | [client](materials/client.md) |
| `client/mention-presentation.ts` | [client](materials/client.md) |
| `client/multi-menu-field.tsx` | [client](materials/client.md) |
| `client/navigation.ts` | [client](materials/client.md) |
| `client/panel-width.ts` | [client](materials/client.md) |
| `client/refs.ts` | [client](materials/client.md) |
| `client/requests.ts` | [client](materials/client.md) |
| `client/sidebar-drag.tsx` | [client](materials/client.md) |
| `client/sidebar-order.ts` | [client](materials/client.md) |
| `client/sidebar-sections.ts` | [client](materials/client.md) |
| `client/slots.ts` | [client](materials/client.md) |
| `client/team-changes.ts` | [client](materials/client.md) |
| `client/team-config.ts` | [client](materials/client.md) |
| `client/team-dialog-save.ts` | [client](materials/client.md) |
| `client/team-formatters.ts` | [client](materials/client.md) |
| `client/team-mark.ts` | [client](materials/client.md) |
| `client/team-queries.ts` | [client](materials/client.md) |
| `client/team-separators.ts` | [client](materials/client.md) |
| `client/thread-actions.ts` | [client](materials/client.md) |
| `client/thread-controller.ts` | [client](materials/client.md) |
| `client/thread-facts.ts` | [client](materials/client.md) |
| `client/timeline-scroll.ts` | [client](materials/client.md) |
| `css-modules.d.ts` | [client](materials/client.md) |
| `index.ts` | [client](materials/client.md) |
