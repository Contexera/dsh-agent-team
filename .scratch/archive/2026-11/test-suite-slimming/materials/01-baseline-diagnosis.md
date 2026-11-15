# 01 — `617d8847` 基线实测数据与根因诊断

- **采样基准：** `dsh-agent-team` commit `617d8847`（Mac 本地工作区，相邻 `deepseek-harness` 正常预编译）
- **采集日期：** 2026-11-15
- **原始证据产出：** Vitest JSON 全量报告（220 文件 / 2,841 测试）与 Browser E2E JSON 全量报告（28 文件 / 31 测试 / 206 PNG 截图）

---

## 一、 Vitest 五层执行基线

### 1.1 按 Project 汇总

| Project | 文件数 | 测试数 | 文件累计耗时 (ms) | 墙钟说明 |
| --- | ---: | ---: | ---: | --- |
| `unit` | 116 | 1,809 | 13,017 | 平均 112ms/文件 |
| `integration` | 101 | 980 | 102,803 | 占累计总耗时 **86.25%** |
| `shared-host` | 1 | 41 | 2,627 | `member-tool-policy.spec.ts` |
| `worker-long` | 1 | 10 | 745 | `worker-inspect.spec.ts` |
| `benchmark` | 1 | 1 | 0 | `storage-bench.spec.ts`（默认 env 跳过） |
| **合计** | **220** | **2,841** | **119,192** | **全量墙钟：25,444ms (25.44s)** |

### 1.2 Top 20 最慢 Vitest 文件（按单文件 `endTime - startTime` 降序）

| # | 文件 | 耗时 (ms) | 测试数 | 主要瓶颈观察 |
| ---: | --- | ---: | ---: | --- |
| 1 | `packages/agent-team/tests/subscription-runs.spec.ts` | 7,763 | 45 | 多处触发真实 Host 订阅队列与 `TICK_MS = 1_000` / `WEBHOOK_PUMP_INTERVAL_MS = 5_000` 等待 |
| 2 | `packages/agent-team/tests/worker-steer.spec.ts` | 6,915 | 48 | 48 个场景高频冷启动 `realHarness()` 与多轮异步状态轮询 |
| 3 | `packages/agent-team/tests/subscription-host.spec.ts` | 6,809 | 53 | 53 个用例高频启动 Host + 定时周期等待 |
| 4 | `packages/client-agent-team/tests/team-inbox.client.spec.tsx` | 6,052 | 25 | 25 个用例各自独立调用 `mountTeamApp` / 完整 Client Bench |
| 5 | `packages/agent-team/tests/member-lifecycle-core.spec.ts` | 5,517 | 46 | 46 个用例高频创建真实 Host/Member 状态机并等待空闲 |
| 6 | `packages/agent-team/tests/manager-member-adjust.spec.ts` | 3,914 | 18 | 18 个用例执行 **19 次** `realHarness()` 启动（平均每条 217ms） |
| 7 | `packages/client-agent-team/tests/team-mode-conversation.client.spec.tsx` | 3,429 | 37 | 37 个用例全部独立组装重型 `SlotTestRuntime` |
| 8 | `packages/agent-team/tests/performance-scenarios.spec.ts` | 3,298 | 3 | 大规模场景回归 |
| 9 | `packages/agent-team/tests/member-tool-policy.spec.ts` | 2,627 | 41 | 共享 Host 工具策略矩阵（`shared-host` project） |
| 10 | `packages/client-agent-team/tests/team-human-attention.client.spec.tsx` | 2,458 | 27 | 28 次重型 Client Bench 挂载 |
| 11 | `packages/agent-team/tests/main-read-context.spec.ts` | 2,154 | 13 | 完整 Member Turn 上下文组装 |
| 12 | `packages/agent-team/tests/check-package-boundaries.spec.ts` | 2,055 | 10 | 全仓库包边界静态解析与断言 |
| 13 | `packages/client-agent-team/tests/team-main-stream.client.spec.tsx` | 1,613 | 14 | 14 次 Client Bench 挂载 |
| 14 | `packages/client-agent-team/tests/team-mode-agents.client.spec.tsx` | 1,595 | 23 | 23 次 Client Bench 挂载 |
| 15 | `packages/agent-team/tests/notification-context.spec.ts` | 1,594 | 9 | 通知上下文真实 Host Turn |
| 16 | `packages/client-agent-team/tests/team-presence-scope.client.spec.tsx` | 1,549 | 2 | Presence 作用域隔离 |
| 17 | `packages/agent-team/tests/member-wake-safety.spec.ts` | 1,506 | 4 | 唤醒异常恢复安全边界 |
| 18 | `packages/agent-team/tests/thread-read-context.spec.ts` | 1,457 | 7 | Thread 读上下文组装 |
| 19 | `packages/agent-team/tests/manager-session.spec.ts` | 1,440 | 20 | **23 次** `realHarness()` 启动 |
| 20 | `packages/client-agent-team/tests/team-send-retry.client.spec.tsx` | 1,425 | 9 | 发送失败重试恢复 |

### 1.3 `617d8847` 新增 Manager Spec 启动密度

`50e57df5..617d8847` 新增 9 个 `manager-*` 服务端测试 + 1 个 Client 测试，共新增 `5,352` 行测试与代码：
- `manager-member-adjust.spec.ts`（3,914ms / 18 tests / 19 `realHarness()`）
- `manager-session.spec.ts`（1,440ms / 20 tests / 23 `realHarness()`）
- `manager-skills.spec.ts`（1,409ms / 5 tests / 6 `realHarness()`，全量并发时报错）
- `manager-project-adjust.spec.ts`（1,140ms / 12 tests / 13 `harness()`）
- `manager-writes.spec.ts`（854ms / 13 tests / 12 `harness()`）
- `manager-reads.spec.ts`（752ms / 9 tests / 10 `harness()`）
- `manager-context-integration.spec.ts`（519ms / 5 tests / 7 `realHarness()`）
- `team-manager.client.spec.tsx`（790ms / 13 tests）

---

## 二、 `manager-skills.spec.ts:101` 并发 Flake 根因

在全量并发运行 `npx vitest run` 时，该文件第 101 行失败（单跑通过）：

```text
AssertionError: expected [ 'shared-name' ] to deeply equal [ 'shared-name', 'weekly-review' ]
    at packages/agent-team/tests/manager-skills.spec.ts:101:62
```

**机制排查结果：**
1. `packages/agent-team/src/member-skills.ts:153-157` 创建 `FileSystemSkillProvider` 时未覆盖监听参数，沿用 `../deepseek-harness/packages/skill/skill-filesystem/src/index.ts:40-41, 506-511` 的默认配置：`watchStabilityThresholdMs = 200ms`、`watchPollIntervalMs = 100ms`。
2. `packages/agent-team/tests/manager-skills.spec.ts:94` 在写入新文件前先调用了一次 `catalogNames()`，使 `SkillRegistry.collectCache`（`../deepseek-harness/packages/skill/skill/src/index.ts:366`）写入了 `['shared-name']` 的完成态缓存。
3. 第 98–102 行随即 `writeFile(..., 'weekly-review.md')` 并立即进入 `vi.waitFor(..., 1000ms default timeout)`。只有当 Chokidar 完成 macOS FSEvents 投递 + `awaitWriteFinish` 200ms 稳定窗口 + 100ms 轮询并回调 `control.invalidate()` 递增 `revision` 后，`catalogNames()` 才会重新扫描目录。全量并发时 CPU/FS 调度抖动使失效链路超过 1,000ms（实测在 ~1,038ms 处超限），`member-skills.spec.ts:109-112` 存在完全相同的时序依赖。

---

## 三、 Browser E2E 全量 28 文件基线

### 3.1 总体结构

- **Runner 总墙钟耗时**：`217.22s`（`217,220ms`，含 `stageBundleTemplate` 与 Vitest 启动）
- **E2E 文件跨度 (`min startTime -> max endTime`)**：`216.33s`（单进程文件串行）
- **测试净耗时合计**：`208,790ms`（28 文件、31 测试）
- **截图证据总计**：**206 个 `.png` 文件**（通过 `assertScreenshotEvidence(artifacts, [1440, 390])`）
- **每场景固定冷启动估算**：单个 `openTeamPage()` 包含 `installLocalBundle()`（symlink `BUNDLE_TEMPLATE` + 预建 16 个目录）+ `launchWebScaffold()`（Host & HTTP 启动 + 新建 temp HOME 与 sqlite 存储）+ `chromium.launch({ headless: true })` + 登录进入 Workspace 与点击“团队”按钮，单次约 **2.3s ~ 2.7s**；31 个测试累计固定冷启动 overhead 约 **70s ~ 82s**（占总 E2E 耗时 ~36%）。

### 3.2 28 个 `.e2e.ts` 逐文件实测清单

| # | E2E 文件 (`scripts/e2e/`) | 耗时 (ms) | 测试数 | `screenshot()` 数 | 当前处置归属 |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | `team-journey.e2e.ts` | 47,843 | 1 | 115 | **保留主干 + 拆分尾部** (`D6` Lane 1 & 2) |
| 2 | `team-manager.e2e.ts` | 24,998 | 2 | 7 | **合并写入投影检查** (`D6` Lane 9) |
| 3 | `team-subscription-event.e2e.ts` | 17,480 | 1 | 4 | **合并 + Webhook 即时泵送降耗** (`D6` Lane 8) |
| 4 | `team-worker-inspect.e2e.ts` | 10,156 | 1 | 3 | **合并 Worker 生命周期 Lane** (`D6` Lane 7) |
| 5 | `team-timeline-anchor.e2e.ts` | 7,965 | 1 | 2 | **合并 Shell/Timeline Lane** (`D6` Lane 4) |
| 6 | `team-main-stream.e2e.ts` | 7,586 | 1 | 10 | **合并 Main Stream & Board Lane** (`D6` Lane 3) |
| 7 | `team-extra-tools.e2e.ts` | 7,408 | 1 | 5 | **合并 Settings & Tools Lane** (`D6` Lane 5) |
| 8 | `team-worker-stop.e2e.ts` | 6,417 | 1 | 3 | **合并 Worker 生命周期 Lane** (`D6` Lane 7) |
| 9 | `team-page-identity.e2e.ts` | 6,393 | 1 | 10 | **合并 Settings & Tools Lane** (`D6` Lane 5) |
| 10 | `team-worker-settings.e2e.ts` | 6,090 | 1 | 4 | **合并 Worker 设置与 Thread Lane** (`D6` Lane 6) |
| 11 | `team-reply-reopen.e2e.ts` | 5,077 | 2 | 0 | **下沉迁移至 `team-send-retry.client.spec.tsx` 后删除** (`D5`) |
| 12 | `team-main-reopen.e2e.ts` | 5,006 | 2 | 0 | **下沉迁移至 `team-send-retry.client.spec.tsx` 后删除** (`D5`) |
| 13 | `team-subscriptions.e2e.ts` | 4,915 | 1 | 10 | **合并 Subscriptions Lane** (`D6` Lane 8) |
| 14 | `team-worker-thread.e2e.ts` | 4,900 | 1 | 3 | **合并 Worker 设置与 Thread Lane** (`D6` Lane 6) |
| 15 | `team-multi-page.e2e.ts` | 4,833 | 1 | 2 | **合并 Shell/Timeline Lane** (`D6` Lane 4) |
| 16 | `team-worker-subscription.e2e.ts` | 4,374 | 1 | 0 | **下沉迁移至 Host integration 后删除** (`D5`) |
| 17 | `team-project-owners.e2e.ts` | 4,090 | 1 | 3 | **合并 Main Stream & Board Lane** (`D6` Lane 3) |
| 18 | `team-manager-writes.e2e.ts` | 4,029 | 1 | 2 | **Step 7 并入 `team-manager.e2e.ts`，其余下沉删除** (`D5`) |
| 19 | `team-shortcuts.e2e.ts` | 3,529 | 1 | 5 | **合并 Shell/Timeline Lane** (`D6` Lane 4) |
| 20 | `team-environment-check.e2e.ts` | 3,309 | 1 | 2 | **合并 Settings & Tools Lane** (`D6` Lane 5) |
| 21 | `team-board-task-focus.e2e.ts` | 3,287 | 1 | 2 | **合并 Main Stream & Board Lane** (`D6` Lane 3) |
| 22 | `team-avatar-initial.e2e.ts` | 3,129 | 1 | 2 | **已被 `team-member-avatar.client.spec.tsx` 覆盖，删除** (`D5`) |
| 23 | `team-thread-ref-chip.e2e.ts` | 3,123 | 1 | 3 | **合并 Main Stream & Board Lane** (`D6` Lane 3) |
| 24 | `team-attachment-recovery.e2e.ts` | 2,972 | 1 | 2 | **合并 Inbox & Recovery Lane** (`D6` Lane 2) |
| 25 | `team-settings-nav-icon.e2e.ts` | 2,937 | 1 | 2 | **合并 Settings & Tools Lane** (`D6` Lane 5) |
| 26 | `team-attachment-send-retry.e2e.ts` | 2,649 | 1 | 0 | **已被 `team-send-retry.client.spec.tsx` 覆盖，删除** (`D5`) |
| 27 | `team-edit-refresh-recovery.e2e.ts` | 2,621 | 1 | 0 | **已被 `team-edit-refresh-recovery.client.spec.tsx` 覆盖，删除** (`D5`) |
| 28 | `team-bundle-toggle.e2e.ts` | 1,674 | 1 | 0 | **合并 Shell/Timeline Lane** (`D6` Lane 4) |

> 注：实际运行结束后 `artifacts/browser/` 下共有 206 张 PNG（`ui-01`: 7、`ui-02`: 7、`ui-03`: 7、`ui-04`: 54、`ui-05`: 35、`ui-06`: 2、`ui-07`: 10、`ui-08`: 3、`ui-09`: 21、`main-stream`: 10、`subscriptions`: 14、`team-manager`: 7、`extra-tools`: 5、`timeline-anchor`: 4、`worker-thread`: 3、`worker-stop`: 3、`worker-inspect`: 3、`browser` 根(`multi-page`): 3、`attachment-recovery`: 2、`avatar-initial`: 2、`settings-nav`: 2、`team-manager-writes`: 2）。

---

## 四、 Agent 自验证与 Runner 层阻塞点

1. **过滤失效 (`scripts/run-browser-test.mjs:103-105`)**：即使命令行传入 `npm run test:browser -- team-manager`，脚本第 104 行依然将全部 28 个渲染后的 `.e2e.ts` 路径作为位置参数传在 `...process.argv.slice(2)` 之前；Vitest 对多个位置文件参数取并集，导致无法只执行单个 `.e2e.ts` 文件。
2. **截图目录预建与单 Lane 门禁 (`scripts/e2e/support.ts:621-624`、`scripts/run-browser-test.mjs:108`)**：`installLocalBundle()` 每次预创建全部 16 个截图目录；当单跑部分用例时，未执行的目录会变成空目录，导致全量 `assertScreenshotEvidence` 直接判定失败；而 `run-browser-test.mjs:108` 的 `if (!narrowed)` 在缩窄运行时直接跳过所有截图校验，无法验证单跑产生出来的 PNG 是否损坏或符合双宽度期望。
3. **Webhook 5 秒轮询空等 (`packages/agent-team/src/index.ts:5399-5438`)**：`intakeWebhookDelivery` 将入队记录写入 `subscriptionAdmissionsTable` 后直接返回，未唤醒 `pumpWebhookAdmissions()`；每次测试依赖 5,000ms 的 `WEBHOOK_PUMP_INTERVAL_MS`（`subscription-webhook.ts:143`）定时器兜底（例如 `team-subscription-event.e2e.ts` 内两次调用，加上 `SubscriptionScheduler` `TICK_MS = 1_000`，单文件耗时 17.48s）。
4. **`corepack` PATH 依赖 (`scripts/run-browser-test.mjs:103`)**：某些本地/Agent 环境只有直接安装的 `pnpm` 而未将 `corepack` 软链入 PATH，直接 `spawn('corepack', ...)` 会报 `ENOENT`。
