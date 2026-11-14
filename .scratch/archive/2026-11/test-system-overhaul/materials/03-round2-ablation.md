# 第二轮测试消融与故障注入实验记录 (`03-round2-ablation.md`)

- **性质：** 实施记录与故障注入对照证据（Ticket `05`）
- **基线：** `e1bf7c4c7270a0e384c98bbe53391815af27bf76`（2026-11-02 上一轮消融终点） → `57f762f9`（本票交付前的工作树）。交付范围是 `57f762f9` 之后的全部工作树改动（含 Tickets `01`–`06`），即本记录所在的提交。
- **环境说明（实验时）：** 实验执行时相邻 `../deepseek-harness` 处于 `dsh-v0.2.2-rc.1`，`packages/*/lib/` 未构建（`generate:typert` / `build` 在该版本上无法通过）。因此，需要 `packages/*/lib/` 的 `realHarness` / `mountTeamMemberHost` 用例与导入 `@contexera/dsh-agent-team/remote` 的 Client 集成用例在当时环境中无法执行。依据 `spec.md §5` 证据口径，**本轮未对任何不可运行域执行无实证删减**，所有消融与故障注入均在可运行域内完成并取得实测对照证据；交付复验（§5）在 rc.2 上运行完整套件。

---

## 1. 基线差异盘点（`e1bf7c4c` → `HEAD`）

使用 `git diff --name-status -M e1bf7c4c..HEAD -- 'packages/agent-team/tests/*.spec.ts' 'packages/tool-agent-team/tests/*.spec.ts' 'packages/client-agent-team/tests/*.spec.*'` 核对：

| 维度 | 数量 | 说明 |
| --- | ---: | --- |
| `e1bf7c4c` spec 文件总数 | 141 | 2026-11-02 基线 |
| `HEAD` (`57f762f9`) spec 文件总数 | 208 | 净增 +67 |
| 新增 (`A`) | 67 | `agent-team` 47、`client-agent-team` 14、`tool-agent-team` 6 |
| 删除 (`D`) / 重命名 (`R`) | 0 / 0 | 无删除或重命名 |
| 已有文件修改 (`M`) | 96 | 其中部分包含新领域用例（见下表） |
| 当前工作区新增（Ticket `01`/`02`） | +1 | `packages/agent-team/tests/harness-lifecycle.spec.ts`（当前工作区共 209 个 spec） |

### 1.1 新增（`A`）67 个 Spec 清单（按域与可运行性分类）

1. **`packages/tool-agent-team/tests/`（6 个，5 个可运行 / 1 个受阻）：**
   - 可运行：`main-stream-view.spec.ts`、`reading-capacity.spec.ts`、`team-reminder-actions.spec.ts`、`team-subscription-actions.spec.ts`、`team-worker-actions.spec.ts`
   - 受阻（`realHarness` / `lib/`）：`team-view-directory.spec.ts`
2. **`packages/client-agent-team/tests/`（14 个，10 个可运行 / 4 个受阻）：**
   - 可运行：`team-extra-tool-grants.client.spec.tsx`、`team-member-avatar.client.spec.tsx`、`team-member-reminders.client.spec.tsx`、`team-member-workers.client.spec.tsx`、`team-owner-seat.client.spec.tsx`、`team-shortcuts.spec.ts`、`team-subscriptions.client.spec.tsx`、`team-worker-settings.client.spec.tsx`、`thread-actions.client.spec.tsx`、`timeline-scroll.client.spec.tsx`
   - 受阻（`@contexera/dsh-agent-team/remote` / `lib/`）：`team-edit-refresh-recovery.client.spec.tsx`、`team-send-retry.client.spec.tsx`、`team-worker-panel.client.spec.tsx`、`team-worker-thread.client.spec.tsx`
3. **`packages/agent-team/tests/`（47 个，33 个 `PURE/HOST` 可运行 / 14 个 `REAL` 受阻）：**
   - **提醒与日程（4 可运行 / 1 受阻）：** `member-reminder-delivery.spec.ts`、`member-reminder-ledger.spec.ts`、`member-reminder-timer.spec.ts`、`member-reminders.spec.ts`；受阻：`member-reminder-host.spec.ts`
   - **订阅与 Webhook（12 可运行 / 2 受阻）：** `subscription-admissions.spec.ts`、`subscription-host.spec.ts`、`subscription-ledger.spec.ts`、`subscription-runner.spec.ts`、`subscription-runs.spec.ts`、`subscription-runtime.spec.ts`、`subscription-storage-upgrade.spec.ts`、`subscription-webhook.spec.ts`、`subscriptions.spec.ts`、`webhook-entry.spec.ts`、`webhook-ingress.spec.ts`、`webhook-settings.spec.ts`；受阻：`subscription-directory.spec.ts`、`subscription-retry.spec.ts`
   - **Worker 委派/沙箱/停止/诊断（8 可运行 / 6 受阻）：** `worker-delegation.spec.ts`、`worker-host-thread.spec.ts`、`worker-inspection.spec.ts`、`worker-provider.spec.ts`、`worker-sandbox.spec.ts`、`worker-steer-runtime.spec.ts`、`worker-stop.spec.ts`、`worker-thread.spec.ts`；受阻：`worker-anchors.spec.ts`、`worker-catalog-continuation.spec.ts`、`worker-composition.spec.ts`、`worker-inspect.spec.ts`、`worker-steer.spec.ts`、`worker-stop-notice.spec.ts`
   - **其他领域（9 可运行 / 5 受阻）：** `closed-thread-follow.spec.ts`、`cold-inbox.spec.ts`、`human-avatar-host.spec.ts`、`member-compaction-budget.spec.ts`、`member-tool-grants.spec.ts`、`rules-v2-replay.spec.ts`、`session-trace.spec.ts`、`sidebar-order-settings.spec.ts`、`text.spec.ts`；受阻：`dm-delivery-lane.spec.ts`、`member-model-adoption.spec.ts`、`member-model-legacy.spec.ts`、`project-owner-guidance.spec.ts`、`task-transfer-v3.spec.ts`

### 1.2 已有文件中新增大量领域用例的典型 Spec（`M`，按 `git diff --numstat` 新增行数排序）

- `packages/agent-team/tests/member-tool-policy.spec.ts`（+1040 / -34）
- `packages/agent-team/tests/operation-protocol.spec.ts`（+515 / -4）
- `packages/agent-team/tests/member-compaction-flow.spec.ts`（+358 / -17，新增 summary target 与 bounded fallback 状态机）
- `packages/agent-team/tests/attachments.spec.ts`（+200 / -32）
- `packages/client-agent-team/tests/team-project-panel-switch.client.spec.tsx`（+195 / -62）
- `packages/client-agent-team/tests/team-human-attention.client.spec.tsx`（+186 / -93）
- `packages/agent-team/tests/notification-context.spec.ts`（+176 / -9）
- `packages/client-agent-team/tests/sidebar-order.spec.ts`（+175 / -2）
- `packages/tool-agent-team/tests/team-tools-render.spec.ts`（+167 / -54）
- `packages/client-agent-team/tests/team-main-stream.client.spec.tsx`（+161 / -17）

---

## 2. 消融与断言补强明细

本轮共修改 **6 个测试文件**（未删减/重命名任何文件，无需改动 `vitest.config.ts`），删除 **8 项** 重复/常量字面量用例（含 1 个循环内重复分支），并强化 **1 项** 弱断言：

| 文件 | 处理类型 | 变更内容 | 保留覆盖映射 |
| --- | --- | --- | --- |
| [team-reminder-actions.spec.ts](../../../../packages/tool-agent-team/tests/team-reminder-actions.spec.ts) | 裁剪重复子集 | 删除 `cancels when the model also sends the schedule kind default`、`lists when the model also sends the schedule kind default`、`treats a blank note as absent on cancel and list`；并从 `still refuses a schedule value...` 中移除重复的 `{ minutes: 30 }` | 前三项由同文件 `cancels the retry shape a live session kept sending`（同时以 `{ minutes: 0, scheduleKind: 'once', note: '' }` 测 `cancel` 与 `list`）严格覆盖；`{ minutes: 30 }` 由同文件 `rejects the schedule fields on list and cancel` 覆盖 |
| [team-worker-actions.spec.ts](../../../../packages/tool-agent-team/tests/team-worker-actions.spec.ts) | 裁剪重复用例 | 删除 `still refuses a real second ref and a real start field`（内含 `stop`+`inspect`、`stop`+`task`、`steer`+`inspect` 三条断言） | 分别由同文件 `refuses a call that names both a stop and an inspect`、`refuses a call that mixes a ref with any start parameter`、`refuses a call that names a steer beside a stop or an inspect` 覆盖 |
| [member-reminders.spec.ts](../../../../packages/agent-team/tests/member-reminders.spec.ts) | 删除常量字面量测试 | 删除 `describe('the per-Member active-reminder ceiling')`（仅断言 `MAX_ACTIVE_REMINDERS_PER_MEMBER === 50` 与 `Number.isInteger`）及未用导入 | 由 [member-reminder-ledger.spec.ts](../../../../packages/agent-team/tests/member-reminder-ledger.spec.ts) `limits hold > refuses a fifty-first active reminder` 在真实账本写入路径上验证 |
| [webhook-settings.spec.ts](../../../../packages/agent-team/tests/webhook-settings.spec.ts) | 删除重复用例 | 删除 `builds the address a provider must post to, on exactly the configured origin` 及未用导入 `webhookAddress` | 由 [subscription-webhook.spec.ts](../../../../packages/agent-team/tests/subscription-webhook.spec.ts) `accepts an absolute http or https origin, with or without a trailing slash`（覆盖带斜杠与不带斜杠两种 origin）覆盖 |
| [subscription-webhook.spec.ts](../../../../packages/agent-team/tests/subscription-webhook.spec.ts) | 删除常量字面量测试 | 删除 `keeps the limits the contract states`（仅断言 `WEBHOOK_BODY_MAX_BYTES`、`WEBHOOK_QUEUE_LIMIT`、`WEBHOOK_STATUS` 常量值）及未用导入 | 由 [webhook-entry.spec.ts](../../../../packages/agent-team/tests/webhook-entry.spec.ts) 在真实 HTTP 入口处理器上验证 `202/404/405/409/413/415/400/429` 状态码与字节/队列上限 |
| [team-member-reminders.client.spec.tsx](../../../../packages/client-agent-team/tests/team-member-reminders.client.spec.tsx) | **补强弱断言** | `turns a refused read into a retryable error instead of endless loading` 原仅断言 `expect(await screen.findByRole('alert')).toBeTruthy()`；改为断言 `alert.textContent` 包含 `'Member does not participate'` | 消除只检查 alert 存在性而漏检错误文本被吞掉/替换的盲区（见下表 `F06`） |

---

## 3. 故障注入对照实验（16 项有效故障）

实验在独立临时 worktree `/Users/yu/projects/.tmp-ablation-wt` 中进行（生产代码仅在临时 worktree 中临时修改并逐项 `git checkout -- packages/*/src` 还原，实验结束后已彻底移除临时 worktree）。所有 16 项均为可执行的真实断言检出实验。

| 编号 | 领域 | 注入故障（临时 `src/` 改动） | 测试范围 | 消融前失败数 | 消融后失败数 | 消融后检出用例与关键断言 |
| --- | --- | --- | --- | ---: | ---: | --- |
| `F01` | Tool (`team_reminder`) | 移除 `scheduleKind === 'once'` 容忍分支 | `team-reminder-actions.spec.ts` | 3 | 1 | `cancels the retry shape a live session kept sending` (`cancel does not accept scheduleKind`) |
| `F02` | Tool (`team_worker`) | 移除 `stop`+`inspect` 互斥抛出 | `team-worker-actions.spec.ts` | 2 | 1 | `refuses a call that names both a stop and an inspect` (`promise resolved instead of rejecting`) |
| `F03` | Tool (`team_subscription`) | 将 `notify: []` 当作未指定而省略 | `team-subscription-actions.spec.ts` | 2 | 2 | `preserves explicit clearing...` & `keeps "not named" apart from "nobody"` (`expected ... to match object { notify: [] }`) |
| `F04` | Tool (`main-stream`) | `mainEntryView` 在 `subscription-event` 丢弃 `projectRef` | `main-stream-view.spec.ts` | 2 | 2 | `carries the Project into the view` (`expected undefined to be 'project:...'`) |
| `F05` | Tool (`reading-budget`) | `resolveModelInfo` 返回后漏掉 `signal.throwIfAborted()` | `reading-capacity.spec.ts` | 1 | 1 | `does not fall back when cancellation arrives with model metadata` (`resolved "83616" instead of rejecting`) |
| `F06` | Client (`MemberRemindersSection`) | 读取被拒时固定 `setError('read failed')` 吞掉 `result.error.message` | `team-member-reminders.client.spec.tsx` | **0（漏检）** | **1（检出）** | `turns a refused read into a retryable error...` (`expected '提醒读取失败：read failed重试' to contain 'Member does not participate'`) |
| `F07` | Client (`TeamMemberAvatar`) | `identityInitial` 改用 `.charAt(0)` 切半代理对 | `team-member-avatar.client.spec.tsx` | 1 | 1 | `renders a whole astral character when the handle starts with one` (`expected '\ud83c' to be '🎈'`) |
| `F08` | Client (`TeamOwnerSeat`) | `accountableLabel` 直接拼接 `@${owner.name}` 不去重 `@` | `team-owner-seat.client.spec.tsx` | 1 | 1 | `writes one @ however the name arrived...` (`expected '负责人 @builder' to be '负责人 @@builder'`) |
| `F09` | Client (`WorkerConfigController`) | `executable` 解析跳过 `.trim()` | `team-worker-settings.client.spec.tsx` | 1 | 1 | `stages an engine and its path as two leaves, trimming what a path cannot carry` |
| `F10` | Client (`TeamSubscriptionsTab`) | `eventCount === 0` 时仍渲染 `共 0 条事件` | `team-subscriptions.client.spec.tsx` | 1 | 1 | `keeps the fact line free of a zero count it would otherwise state twice` (`expected <span></span> to be null`) |
| `F11` | Ledger (`member-reminders`) | 将上限判断 `>= MAX_ACTIVE_REMINDERS_PER_MEMBER` 改为 `>` | `member-reminders.spec.ts` + `member-reminder-ledger.spec.ts` | 1 | 1 | `limits hold > refuses a fifty-first active reminder` (`promise resolved instead of rejecting`) |
| `F12` | Ledger (`closed-thread-follow`) | 无论 `rulesVersion` 一律拒绝已关闭 Thread 的 `follow`（注：初次尝试改为 `<= 4` 因当前 `AGENT_TEAM_RULES_VERSION > 4` 为无效故障 `0/0`，已修正为有效故障重跑） | `closed-thread-follow.spec.ts` | 2 | 2 | `returns the Human to the follower set...` (`Task ... is closed; reopen it before following`) |
| `F13` | Webhook (`subscription-webhook`) | `webhookAddress` 停止去除 origin 末尾 `/` | `webhook-settings.spec.ts` + `subscription-webhook.spec.ts` | 2 | 1 | `accepts an absolute http or https origin, with or without a trailing slash` (`https://team.example.com//team/hooks/...`) |
| `F14` | Webhook (`webhook-entry`) | `WEBHOOK_STATUS.notPost` 由 `405` 改为 `400` | `subscription-webhook.spec.ts` + `webhook-entry.spec.ts` | 2 | 1 | `refuses a method that is not POST...` (`expected 400 to be 405`) |
| `F15` | Worker (`worker-sandbox`) | `withCodexSandbox` 在原本无 `OAR_CODEX_SANDBOX` 时跳过 `delete` | `worker-sandbox.spec.ts` | 1 | 1 | `leaves no key behind when the host had none, even if the open fails` (`expected 'workspace-write' to be undefined`) |
| `F16` | Text (`truncateToCharacters`) | 改用 UTF-16 `value.slice(0, limit)` 截断 | `text.spec.ts` | 2 | 2 | `cuts on a code-point boundary...` (`expected '🎈🎈\ud83d' to be '🎈🎈🎈🎈🎈'`) |

**结论：** 在上述 16 项代表性故障中，消融前检出 **15/16**（`F06` 漏检），消融与弱断言补强后检出 **16/16**。

---

## 4. 消融实验后的定向验证（实验环境）

1. **临时 worktree 清理：** `git worktree remove --force /Users/yu/projects/.tmp-ablation-wt` 成功；`git worktree list` 仅保留主工作区 `/Users/yu/projects/dsh-agent-team 57f762f9 [master]`。
2. **定向 Vitest 验证（修改文件 + 映射保留文件）：**
   - `npx vitest run packages/tool-agent-team/tests/team-reminder-actions.spec.ts packages/tool-agent-team/tests/team-worker-actions.spec.ts packages/agent-team/tests/member-reminders.spec.ts packages/agent-team/tests/webhook-settings.spec.ts packages/agent-team/tests/subscription-webhook.spec.ts packages/client-agent-team/tests/team-member-reminders.client.spec.tsx packages/agent-team/tests/member-reminder-ledger.spec.ts packages/agent-team/tests/webhook-entry.spec.ts packages/agent-team/tests/closed-thread-follow.spec.ts packages/agent-team/tests/worker-sandbox.spec.ts packages/agent-team/tests/text.spec.ts` → **11 passed (142 tests)**。
   - `npx vitest run --project unit packages/tool-agent-team/tests` → **12 passed (250 tests)**。
   - `npx vitest run`（10 个可运行的新增 Client spec）→ **10 passed (99 tests)**。
3. **静态检查：**
   - `./node_modules/.bin/tsc -p packages/tool-agent-team/tsconfig.json --noEmit` → **0 errors**。
   - `packages/agent-team/tsconfig.json` 与 `packages/client-agent-team/tsconfig.json`（经项目引用）仅存在 8 条与 `dsh-v0.2.2-rc.1` 相关的既有 `packages/agent-team/src/` 类型错误（`zod@4.6.6` vs `4.4.3` 及 `SubagentActivationSpec` `parent` 字段），**测试文件 0 新增错误**。
   - `pnpm dlx oxlint@1.76.0 --disable-typescript-plugin` 检查 6 个修改后的测试文件 → **0 errors, 0 warnings**。

## 5. 交付复验（2026-11-14，Harness `dsh-v0.2.2-rc.2`）

交付范围是 `57f762f9` 之后的全部工作树改动（150 个路径，含 Tickets `01`–`06`、测试底座、Vitest 配置、E2E 脚本、CI 与维护文档）。消融实验之后只修改了 harness 生命周期、integration 清单、附件重启用例和未使用导入，没有触及 §2 的 6 个消融文件与 §3 的故障注入对象。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 208 passed / 1 skipped（209 files），2683 passed / 1 skipped（benchmark 需 `DSH_BENCH_STORAGE=1`） |
| `npx vitest run --project unit` | 114 files / 1758 tests passed |
| `npx vitest run --project integration` | 92 files / 874 tests passed |
| `npx vitest run --project integration packages/agent-team/tests/harness-lifecycle.spec.ts` | 7 tests passed |
| `npm run typecheck` | Passed |
| `npm run check:docs` | Passed |
| `npm run check:artifact` | Passed（458 files，133 relative imports） |
| `node scripts/audit-ui-parity.mjs` | Passed（0 errors，2 existing warnings） |
| `npm run lint` | Exit 0；0 errors，83 warnings（基线 95） |
| `npm run test:browser`（`CHROME_PATH` 指向本机 Chrome） | 26 files / 28 tests passed，195 张截图证据通过 |
| `rg "vi\\.setConfig" packages` | 0 |
| 完整套件后 `/tmp` 下 `dsh-agent-team-*` / `dsh-team-*` 目录 | 0 |
| `../deepseek-harness` 工作区 | 无新增改动 |
| `git diff --check` | Passed |

首次把附件 spec 移入 integration 时，完整套件暴露了一个真实竞态：Host 重启的启动 GC 会异步清理共享缓存里的过期条目，而用例断言整个缓存前后相等。修复后该文件单独连续运行 3 次、完整套件连续运行 2 次均通过；细节见 [review 02](../reviews/02-followup.md)。
