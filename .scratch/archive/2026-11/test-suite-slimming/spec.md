# 测试套件精简与加速规格说明 (spec)

- **基线提交：** `617d8847`
- **背景与量化依据：** [materials/01-baseline-diagnosis.md](materials/01-baseline-diagnosis.md)

## 一、 核心设计原则

1. **第一性原理分工（让每一层只测只有这一层能证明的东西）**：
   - `unit` / `integration`：证明 Host 状态机、账本不变量、权限与工具策略、技能路由与持久化故障恢复。
   - `client.spec.tsx`（`SlotTestRuntime` + jsdom）：证明 React 状态机、乐观锁/重放/`requestId` 幂等恢复（含网络延迟、断连、切 tab 卸载重挂）、UI 文案与 DOM 交互。
   - `scripts/e2e/*.e2e.ts`（真实 Harness Web + Chromium）：只保留需要真实组装产物才能证明的东西 —— 外部 bundle 安装与卸载（ordinary DSH 恢复）、Cordis/Slot 实际接管顺序、真实 CSS 布局与几何溢出（`1440px` 桌面 + `390×844` 窄屏、对比度、focus ring、scroll anchor）以及端到端跨进程链路（Worker 子进程 / Webhook HTTP）。
2. **Agent 优先的自验证体验**：Agent 改动某一块 UI 或 Surface 时，必须能在 **~10s 内** 通过 `npm run test:browser -- <lane>` 单跑对应浏览器 Surface Lane 并拿到有效的 PNG 截图校验；全量执行则保持合并提速并坚守完整的双宽度截图门禁。
3. **绝对边界**：不修改 `../deepseek-harness`、不削弱产品代码中的安全守卫或校验不变量、`npm test` 连续并发运行 0 Flake、`assertScreenshotEvidence` 在全量运行时继续校验 `[1440, 390]` 与所有非空目录。

---

## 二、 已确认的技术决策（`D1`–`D6`）

### `D1` — 修复 Skill 文件监听与缓存失效并发 Flake
- **影响文件**：`packages/agent-team/tests/manager-skills.spec.ts`、`packages/agent-team/tests/member-skills.spec.ts`（视需要微调 `packages/agent-team/src/member-skills.ts` 测试配置透传能力，不改 Harness 仓库）。
- **措施**：
  - 排查 `manager-skills.spec.ts:94-102` 与 `member-skills.spec.ts:100-112` 在 `writeFile` 前先调用 `catalogNames()` 导致 `SkillRegistry.collectCache` 缓存命中、继而受限于 `FileSystemSkillProvider` 默认 `awaitWriteFinish`（`200ms + 100ms`）+ macOS FSEvents 并发抖动超过 `vi.waitFor` 默认 `1000ms` 超时的问题。
  - 若测试仅需验证后续监听刷新，显式给文件系统事件监听用例提供确定性收敛（避免在写入前无意义预热缓存或合理放宽异步等待/使用可注入的测试级 watcher 参数并保持默认生产行为不变），确保全量高并发 `vitest run` 连续多轮 0 失败。

### `D2` — 消除 Webhook 5s 轮询空等与 Subscription 启动等待
- **影响文件**：`packages/agent-team/src/index.ts`、`packages/agent-team/tests/subscription-runs.spec.ts`、`packages/agent-team/tests/subscription-host.spec.ts`。
- **措施**：
  - 在 `packages/agent-team/src/index.ts` 的 `intakeWebhookDelivery()`（约 `5435-5437` 行写入 `table.put(...)` 返回 `{ kind: 'queued', admissionRef }` 后）立即调度 `void this.pumpWebhookAdmissions()`，不再干等 `WEBHOOK_PUMP_INTERVAL_MS`（`5_000ms`）；保留原有 `admissionPumpTimer` 仅作为失败重试兜底。
  - 审计 `subscription-runs.spec.ts`（7,763ms）与 `subscription-host.spec.ts`（6,809ms）中因等待 `TICK_MS = 1_000`（`subscription-runtime.ts:117`）周期触发的用例，利用现有 `scheduler.runTick()`（`subscription-runtime.ts:179`：“exposed so tests and a manual nudge share the production path”）或无空等驱动方式消除人工 1s 睡眠。

### `D3` — 收敛高频 Spec 重复冷启动与冗余 Host 开销
- **影响文件**：
  - Host integration：`packages/agent-team/tests/manager-member-adjust.spec.ts`（18 tests / 19 `realHarness()` boots / 3,914ms）、`manager-session.spec.ts`（20 tests / 23 `realHarness()` boots / 1,440ms）、`manager-project-adjust.spec.ts`（1,140ms）、`manager-writes.spec.ts`（854ms）、`manager-reads.spec.ts`（752ms）、`worker-steer.spec.ts`（48 tests / 6,915ms）。
  - Client integration：`packages/client-agent-team/tests/team-inbox.client.spec.tsx`（25 tests / 25 boots / 6,052ms）、`team-mode-conversation.client.spec.tsx`（37 tests / 37 boots / 3,429ms）、`team-human-attention.client.spec.tsx`（27 tests / 28 boots / 2,458ms）。
- **措施**：在保持绝对测试隔离（禁止跨破坏性用例泄露可变状态）的前提下，对共享只读前置夹具（例如不改写模型目录/只创建独立 Workspace 或 Project 验证参数校验、幂等重放与只读查询的测试用例组）在同一 `describe` 块内共享 `beforeAll` / 轻量化复位，显著削减 `realHarness()` 与 `SlotTestRuntime` 重复挂载总次数；保持单文件归属与超时预算（禁止新增 `vi.setConfig`）。

### `D4` — 升级 E2E Runner 单 Lane 过滤校验、共享 Chromium 与按需目录创建
- **影响文件**：`scripts/e2e/support.ts`、`scripts/run-browser-test.mjs`、`scripts/browser-evidence.mjs`。
- **措施**：
  1. **共享 Worker 内 Browser 实例 + 隔离 Context**：在 `scripts/e2e/support.ts` 中，将 `chromium.launch` 提升为单 Worker 进程内懒初始化复用，每次 `openTeamPage()` 通过 `sharedBrowser.newContext({ viewport, locale, deviceScaleFactor })` 创建相互完全隔离（Cookie / `localStorage` / Storage State 隔离）的上下文；`closeScenario()` 关闭 `page`/`context` 与 `WebScaffold` 及临时目录，而在进程/文件退出时统一关闭共享 `Browser`。保留直接操作原生 `chromium` 的逃生能力，确保异常重启可恢复。
  2. **按需创建截图目录**：移除 `installLocalBundle()`（`scripts/e2e/support.ts:621-624`）中每次预创建全部 16 个 `*_SHOTS` 目录的逻辑，改为在截图前按需 `mkdir(dirname(path), { recursive: true })`（可在 `support.ts` 提供统一 `captureScreenshot` / 确保目录存在，避免空目录假失败）。
  3. **真正的单 Lane 过滤与证据门禁**：修改 `scripts/run-browser-test.mjs`：
     - 解析 CLI 传入的文件名/子串过滤参数（如 `npm run test:browser -- team-manager` 或 `worker`），当存在文件过滤条件时，**只 staging 并只向 `vitest run` 传入匹配到的 `.e2e.ts` 路径**（透传 `-t` 等 Vitest flag）；
     - 缩窄运行结束时不再直接绕过 `assertScreenshotEvidence`，而是对其本次实际产出的截图执行 PNG 完整性与非空校验（允许单 lane 仅含自身声明宽度，不强求全套 16 个目录都存在）；当无过滤条件（全量验收运行）时，继续严格执行全部表面截图与 `[1440, 390]` 双宽度门禁；
     - 命令执行时若环境中 `corepack` 不可用，自动回退直接调用 `pnpm`。

### `D5` — 下沉并删除 7 个冗余 / 错配的 E2E 文件
执行“**先在下层补齐断言并跑绿 → 再删除 E2E**”流程，涉及以下 7 个文件：

| # | 待删除 E2E 文件 | 现存或目标下层归宿 | 补强要求 |
| --- | --- | --- | --- |
| 1 | `team-edit-refresh-recovery.e2e.ts` | `packages/client-agent-team/tests/team-edit-refresh-recovery.client.spec.tsx` | 核对 9 条用例已完整覆盖编辑提交成功关闭 + 列表刷新失败重试且不重写 |
| 2 | `team-attachment-send-retry.e2e.ts` | `packages/client-agent-team/tests/team-send-retry.client.spec.tsx` | 核对附件幂等上传与丢回执重发已完全覆盖 |
| 3 | `team-main-reopen.e2e.ts` | `packages/client-agent-team/tests/team-send-retry.client.spec.tsx` | 补入 Main 发送在途时切换/卸载 Tab 再重挂后，延迟或丢失回执仍保持单条消息不重复的状态机用例 |
| 4 | `team-reply-reopen.e2e.ts` | `packages/client-agent-team/tests/team-send-retry.client.spec.tsx` | 补入讨论侧面板在发送中关闭再重新打开时，延迟与丢失回执（`delayed` / `lost`）恢复用例 |
| 5 | `team-avatar-initial.e2e.ts` | `packages/client-agent-team/tests/team-member-avatar.client.spec.tsx` | 核对/补充 `𐐨builder`（Deseret 辅助平面字符）全字形首字母且无 `LONE_SURROGATE` 截断断言（`UI02` 与其他截图仍覆盖真实头像渲染） |
| 6 | `team-worker-subscription.e2e.ts` | `packages/agent-team/tests/subscription-runs.spec.ts` 或 `worker-composition.spec.ts` | 本文件含 **0 张截图**，仅测 `intakeWebhookDelivery -> 唤醒 owner -> team_worker` 后端链路；迁入 Host 集成测试（如新建独立集成 spec 需同步更新 `vitest.config.ts`） |
| 7 | `team-manager-writes.e2e.ts` | `packages/agent-team/tests/manager-*.spec.ts` + `scripts/e2e/team-manager.e2e.ts` | Step 1–6、8 已在 Host `manager-*` spec 完全覆盖；仅将 Step 7 的 29 行 UI 投影核对（Sidebar 显示 Iris、项目编辑弹窗显示负责人的描述、桌面与 `390×844` 截图写入 `MANAGER_SHOTS`）并入 `team-manager.e2e.ts`，同步从 `support.ts` 移除不再使用的 `MANAGER_WRITES_SHOTS` |

### `D6` — 将剩余 21 个 E2E 文件收拢为 9 条按 UI 表面划分的 Surface Lanes
保持每个文件内聚于单一产品表面、避免单文件膨胀成第二个 3,400 行巨无霸：

| # | 目标 Lane 文件 (`scripts/e2e/`) | 来源文件合并 / 拆分范围 | 核心真浏览器验收职责与截图目录 |
| --- | --- | --- | --- |
| 1 | `team-journey.e2e.ts` | 原 `team-journey.e2e.ts` 第 1–2745 行（切分尾部） | 核心团队旅程 `UI01`–`UI06`（进入/退出模式、侧栏拖拽、Project/Member CRUD、提及、引用、Accept、Transfer、归档、普通模式还原）；裁减中间态冗余 `fullPage: true` 截图，保留关键状态与 `390×844` 双宽度证据 (`ui-01`..`ui-06`) |
| 2 | `team-inbox-and-recovery.e2e.ts` | 从原 `team-journey.e2e.ts` 拆出第 2747–3403 行（`UI07` + `UI08`）+ `team-attachment-recovery.e2e.ts` | Inbox 红点/未读计数/窄屏 drawer/聚焦态 (`ui-07`)、离线报错与重连恢复 (`ui-08`)、过期附件与损坏图片键盘重读区分 (`attachment-recovery`) |
| 3 | `team-main-stream-and-board.e2e.ts` | `team-main-stream.e2e.ts` + `team-project-owners.e2e.ts` + `team-board-task-focus.e2e.ts` + `team-thread-ref-chip.e2e.ts` | Main stream v2 发文开讨论/开任务 (`main-stream`)、Owner 弹窗编辑、看板 Task 卡片创建后键盘/鼠标 focus ring、无任务 Thread Ref Chip 打开 (`ui-04`, `ui-02`) |
| 4 | `team-timeline-and-shell.e2e.ts` | `team-timeline-anchor.e2e.ts` + `team-multi-page.e2e.ts` + `team-bundle-toggle.e2e.ts` + `team-shortcuts.e2e.ts` | 时间线滚动锚定几何 (`timeline-anchor`)、多 Page 状态同步、Bundle 开关、macOS/默认快捷键面与帮助表 (`ui-09`) |
| 5 | `team-settings-and-tools.e2e.ts` | `team-page-identity.e2e.ts` + `team-settings-nav-icon.e2e.ts` + `team-environment-check.e2e.ts` + `team-extra-tools.e2e.ts` | Team 页身份配置、Settings Nav 图标占位、本地环境检测、额外宿主工具授权开关 (`ui-09`, `settings-nav`, `extra-tools`) |
| 6 | `team-worker-settings-and-thread.e2e.ts` | `team-worker-settings.e2e.ts` + `team-worker-thread.e2e.ts` | Settings Worker 开关与引擎路径校验 (`ui-09`)、派发 Worker 在独立 Thread 展示起始与失败终态 (`worker-thread`) |
| 7 | `team-worker-lifecycle.e2e.ts` | `team-worker-inspect.e2e.ts` + `team-worker-stop.e2e.ts` | 运行中/失败 Worker 记录展开 (`worker-inspect`)、停止 Worker 运行实时停稳 (`worker-stop`) |
| 8 | `team-subscriptions.e2e.ts` | `team-subscriptions.e2e.ts` + `team-subscription-event.e2e.ts` | Project 订阅创建/运行记录双流输出/编辑与停用、Webhook 事件排版几何对齐与 Inbox 未读计数 (`subscriptions`) |
| 9 | `team-manager.e2e.ts` | `team-manager.e2e.ts` + `team-manager-writes.e2e.ts` Step 7 | Manager 会话切换、模型引导、Header 动作、Team Write 工具写入后在 Sidebar 与 Project 编辑弹窗的桌面/`390×844` 投影 (`team-manager`) |

---

## 三、 不在范围内的事项

- 不改动 `../deepseek-harness` 任何代码或构建脚本。
- 不将 `npm run test:browser` 引入 GitHub Actions 默认 `checks` job（延续 PR #101 分层边界）。
- 不为凑时长而删除边界检查（`check-package-boundaries.spec.ts`）、规则版本检查（`rules-version.spec.ts`）或双宽度视觉门禁。
