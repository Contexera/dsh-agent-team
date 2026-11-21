# E2E 浏览器 Lane 目录

[English](e2e-lanes.md) | 中文

## 用途

本目录说明组装后的 Web 场景能验证什么、可以先跑哪些底层测试，以及去哪里查看浏览器证据。完整的检查路径见[检查梯度](start-and-checks.zh.md#检查梯度)。

## 按风险选择测试

改动 slot、preset、布局或跨页行为时，先选对应的 lane。改动共用场景配置或 runner 时，直接跑全量。全量默认用简短的 `team-journey` 冒烟场景；要验收完整 Team 流程或准备发布，就加 `--deep`。

```sh
node scripts/run-browser-test.mjs --list
npm run test:browser -- team-timeline-and-shell -t "four same-origin"
npm run test:browser -- --deep
```

只想列出 lane 时，直接运行 Node 脚本，不必先构建。lane 参数匹配文件名，`-t` 再按测试名称过滤。定向执行仍会构建并检查已有截图，但不要求全套满足 `1440` 和 `390` 两个宽度。所跑的 lane、耗时和失败阶段见 `artifacts/browser/summary.json`。

## 全量运行调度

无过滤 Runner 会先串行运行 `team-journey` 与 `team-manager`。这两条 lane 启动的完整 Harness 成本最高，与其他场景同时运行时曾出现 hook 超时。深度模式会用 `team-journey-deep` 替换 `team-journey`。

其余 lane 随后运行，默认最多使用两个测试进程。定向运行或传入自定义 Vitest 参数时保留调用方参数，不会自动改成分组调度。

资源受限时可设置 `DSH_E2E_SCHEDULING=serial` 强制全量串行；设置 `DSH_E2E_MAX_WORKERS` 可调整轻量批次的测试进程数。

## Lane 目录

### `team-journey`

- **文件与命令：** `scripts/e2e/team-journey.e2e.ts` — `npm run test:browser -- team-journey`
- **真实 Web/Harness 契约：** Opt-in bundle 激活、进入一个 Team Project、一次 Main/Task 变更、reload 持久化及普通 DSH 恢复。
- **低层测试：** `packages/agent-team/tests/` Host/integration spec 与 `packages/client-agent-team/tests/` Client spec。
- **触发条件：** 跨表面 Team 进出、Workspace 连接、侧栏/顶栏/弹窗集成或普通 DSH 恢复改动。
- **必需证据：** `artifacts/browser/team-journey-smoke/`（`1440` 与 `390` 视口）、零 console 警告/页面错误、普通 DSH 恢复干净。
- **不负责证明：** 深度视觉矩阵、Inbox 离线恢复、Worker 诊断或 Settings 冲突的穷举边界。
- **规模与成本：** 1 个短测试，包含在默认全量运行中。

### `team-journey-deep`

- **文件与命令：** `scripts/e2e/team-journey-deep.e2e.ts` — `npm run test:browser -- team-journey-deep` 或 `npm run test:browser -- --deep`
- **真实 Web/Harness 契约：** 完整跨表面 Team 旅程：Shell 几何、Member/Project/Thread/Task/Claim/DM/Board 变更、附件与响应式 UI 断言、reload 持久化、归档、插件退出及普通 DSH 恢复。
- **低层测试：** 与 `team-journey` 相同的 Host/integration 与 Client spec，以及各表面 lane 负责的详细行为。
- **触发条件：** Team Shell 大范围重设计、跨表面导航改动、深度视觉回归审查或发布验收。
- **必需证据：** `artifacts/browser/ui-01/` 至 `ui-06/`（`1440` 与 `390` 视口）、零 console 警告/页面错误、普通 DSH 恢复干净。
- **不负责证明：** 替代 Inbox、Manager、Worker、Settings、Subscription 或 Main/Board lane 的专门契约。
- **规模与成本：** 1 个深度测试。

### `team-inbox-and-recovery`

- **文件与命令：** `scripts/e2e/team-inbox-and-recovery.e2e.ts` — `npm run test:browser -- team-inbox-and-recovery`
- **真实 Web/Harness 契约：** Human Inbox 投递、离线重试/恢复、连续消息、过期附件与损坏图片区分及键盘导航。
- **低层测试：** `packages/agent-team/tests/dm-delivery-lane.spec.ts`、`attachments.spec.ts` 及 Client Inbox spec。
- **触发条件：** Inbox UI、附件渲染/降级、离线重试或 Inbox 键盘导航改动。
- **必需证据：** `artifacts/browser/ui-07/` 和 `ui-08/` 下的离线状态；键盘焦点与导航校验。
- **不负责证明：** Host ledger 重放不变量或非 Inbox 表面。
- **规模与成本：** 2 个测试。

### `team-main-stream-and-board`

- **文件与命令：** `scripts/e2e/team-main-stream-and-board.e2e.ts` — `npm run test:browser -- team-main-stream-and-board`
- **真实 Web/Harness 契约：** Main stream 发消息、创建讨论和 Task、Project owner 弹窗、Task 看板卡片焦点（键盘/鼠标）及无 Task thread 的 ref-chip 跳转。
- **低层测试：** `packages/agent-team/tests/main-read-context.spec.ts`、`body-authored-mentions.spec.ts` 及 Client Main/Board spec。
- **触发条件：** Main stream、Task board、ref-chip 跳转或 Project owner 弹窗 UI 改动。
- **必需证据：** `artifacts/browser/main-stream/`、`ui-04/`、`ui-02/`（`1440` 与 `390` 视口）、焦点断言。
- **不负责证明：** 完整 Team 进出恢复或 Worker 生命周期。
- **规模与成本：** 4 个测试。

### `team-manager`

- **文件与命令：** `scripts/e2e/team-manager.e2e.ts` — `npm run test:browser -- team-manager`
- **真实 Web/Harness 契约：** `team-manager` preset 接入 shipped Conversation、Manager Session 替换、reload 恢复、stale-read 守卫、侧栏/Project owner 投影及普通 Session 恢复。
- **低层测试：** `packages/agent-team/tests/manager-session.spec.ts`、`manager-writes.spec.ts`、`manager-reads.spec.ts`、`manager-skills.spec.ts`。
- **触发条件：** `team-manager` preset、Manager Session 路由、`cordis.patch.yml` manager 行或 shipped Conversation 槽位改动。
- **必需证据：** `artifacts/browser/team-manager/`（`1440` 与 `390` 视口）、普通 Session 恢复。
- **不负责证明：** `team-member` 工具执行或真实模型质量。
- **规模与成本：** 3 个测试。

### `team-settings-and-tools`

- **文件与命令：** `scripts/e2e/team-settings-and-tools.e2e.ts` — `npm run test:browser -- team-settings-and-tools`（alias：`team-settings-nav-icon`）
- **真实 Web/Harness 契约：** Settings 弹窗 Team 页身份/头像冲突处理、窄屏 `[data-environment]` 容器防溢出，以及 assembled Web 中 profile `extraToolGrants` 授权/撤销/对账。
- **低层测试：** `packages/client-agent-team/tests/team-settings.client.spec.tsx`（含 `TeamSettingsNavIcon` 图标）、`environment-check.client.spec.tsx`、`team-extra-tool-grants.client.spec.tsx`。
- **触发条件：** Settings 槽位、Human profile 表单、`extraToolGrants` 或 `EnvironmentCheck` UI 改动。
- **必需证据：** `artifacts/browser/ui-09/`、`extra-tools/`（`1440` 与 `390` 视口）。
- **不负责证明：** `team-member` preset 内部的后端工具门禁执行，或已由 Client spec 覆盖的 SVG 路径与文案矩阵。
- **规模与成本：** 2 个测试。

### `team-subscriptions`

- **文件与命令：** `scripts/e2e/team-subscriptions.e2e.ts` — `npm run test:browser -- team-subscriptions`
- **真实 Web/Harness 契约：** 只读 Project 订阅展示（无 Human 写控件），以及已发布订阅事件在窄屏/桌面端作为脚本数据的单列投影。
- **低层测试：** `packages/agent-team/tests/` 订阅/webhook Host spec 与 `packages/client-agent-team/tests/` 订阅 spec。
- **触发条件：** Project 订阅投影、事件格式化或订阅 UI 布局改动。
- **必需证据：** `artifacts/browser/subscriptions/`（`1440` 与 `390` 视口）。
- **不负责证明：** Webhook HTTP 入口、重试调度或 cron 触发时机。
- **规模与成本：** 2 个测试。

### `team-timeline-and-shell`

- **文件与命令：** `scripts/e2e/team-timeline-and-shell.e2e.ts` — `npm run test:browser -- team-timeline-and-shell`
- **真实 Web/Harness 契约：** Thread/Main 在加载历史与新消息到达时的滚动锚定、4 个同源 Team 页面并发订阅，以及全局快捷键（`Meta+Alt+T` 与三界面切换）。
- **低层测试：** `packages/client-agent-team/tests/` 时间线滚动与快捷键 spec，以及 `packages/agent-team/tests/harness-lifecycle.spec.ts`（Host 卸载/重装持久化）。
- **触发条件：** 时间线滚动锚定、多页面 Remote 同步或全局 shell 快捷键改动。
- **必需证据：** `artifacts/browser/timeline-anchor/`、`ui-09/` 和 `multi-web-{desktop,mobile}.png`；检查滚动偏移是否稳定。
- **不负责证明：** 单页面 Inbox 或 Manager 流程，或 Host 插件卸载/重装持久化。
- **规模与成本：** 3 个测试。

### `team-worker-lifecycle`

- **文件与命令：** `scripts/e2e/team-worker-lifecycle.e2e.ts` — `npm run test:browser -- team-worker-lifecycle`
- **真实 Web/Harness 契约：** 在 edit-Agent 弹窗读取 Worker 诊断（5 行上限），以及停止两个活跃 Worker 运行中的一个并保持另一个继续运行。
- **低层测试：** `packages/agent-team/tests/` Worker 生命周期 spec（`worker-long` project）与 Client Worker UI spec。
- **触发条件：** Worker 诊断 UI、停止 Worker 操作或 Worker 状态投影改动。
- **必需证据：** `artifacts/browser/worker-inspect/`、`worker-stop/`（`1440` 与 `390` 视口）。
- **不负责证明：** 真实 Codex/Claude CLI 协议行为。
- **规模与成本：** 2 个测试。

### `team-worker-settings-and-thread`

- **文件与命令：** `scripts/e2e/team-worker-settings-and-thread.e2e.ts` — `npm run test:browser -- team-worker-settings-and-thread`
- **真实 Web/Harness 契约：** 在 Team settings 配置 Worker 委派组，并在独立 Thread 中观察委派的 Worker 运行。
- **低层测试：** `packages/client-agent-team/tests/team-worker-settings.client.spec.tsx` 与 Host Worker 委派 spec。
- **触发条件：** Worker 委派设置 UI、`team_worker` thread 投影或 Worker 失败终态渲染改动。
- **必需证据：** `artifacts/browser/worker-thread/`，以及 `ui-09/` 中的 Worker 设置截图。
- **不负责证明：** Worker 诊断行上限或单停隔离（由 `team-worker-lifecycle` 覆盖）。
- **规模与成本：** 2 个测试。

## 别名（Aliases）

| 选择词 | 目标 lane | 原因 |
| --- | --- | --- |
| `team-settings-nav-icon` | `team-settings-and-tools` | lane 合并后保留原选择词兼容性（`scripts/browser-runner.mjs`） |
