# 当前 E2E、测试选择和 Agent 反馈审计

**性质：** 当前实现与历史证据的只读整理

**工作项：** [README.md](../README.md)

## 1. 当前规模与耗时

来源：`.scratch/archive/2026-11/test-suite-slimming/README.md`、当前 `scripts/e2e/` 和近期复跑记录。

| 指标 | 当前证据 |
| --- | --- |
| E2E lane 文件 | 9 |
| E2E 测试数 | 24 |
| 截图数 | 约 204 PNG |
| 全量 E2E 历史记录 | 197.55s |
| 单 lane 历史记录 | 12.42s（`team-inbox-and-recovery`） |
| 全量 Vitest | 23.20–23.85s，219 files passed / 1 skipped |
| 浏览器复跑限制 | 默认路径 `/usr/bin/google-chrome` 在本机（macOS）不存在，但存在 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，可通过 `CHROME_PATH` 传入 `run-browser-test.mjs` |

全量 E2E 相比 217.2s 基线只下降约 9%，单 lane 相比被迫全量运行约快 94%。因此主要提效方向是让 Agent 选择正确的 targeted lane，而不是让每次改动都等待全量 E2E。

## 2. 当前 E2E 的真实启动成本

`run-browser-test.mjs` 会一次 staging bundle template，然后把场景写入相邻 Harness；`support.ts` 的 `openTeamPage()` 仍会为每个场景创建隔离 HOME、启动 Web Scaffold、创建 BrowserContext、打开页面并连接 Workspace。

共享 Chromium 只复用浏览器进程；它没有复用场景的 Web Scaffold、Workspace、SQLite 或登录/页面启动过程。继续保持 per-scenario 隔离，不能把未经测量的共享可变状态当作提速手段。

## 3. 当前文档问题

### 3.1 根入口没有测试选择路由

根 `AGENTS.md` 有检查命令和 browser 触发规则，但没有按 Host、Client、assembled Web 和跨表面风险给 Agent 一个短的选择树。

### 3.2 `scripts/README.md` 已过时

它仍描述旧的 10 个 `.e2e.ts` 文件，包括已经合并或删除的 lane。当前真实文件数是 9。

### 3.3 维护指南只有示例

`docs/development/start-and-checks.zh.md` 只示范 `team-manager` 和 `team-inbox-and-recovery`，没有完整的功能到 lane 映射。

### 3.4 Runner 反馈粒度不足

Runner 当前主要在最后报告 browser evidence 的截图数。它没有统一报告当前 lane 的契约、哪个测试失败、失败发生在启动/行为/投影/证据的哪个阶段、使用了哪些截图。

## 4. 当前 lane 的重叠和下沉候选

| 位置 | 观察 | 处理方向 |
| --- | --- | --- |
| `team-journey.e2e.ts` | 一个测试约 2750 行、101 次截图，覆盖大量局部表面和完整恢复流程 | 保留短核心冒烟，把局部 UI 行为交给表面 lane 或 Client spec |
| `team-timeline-and-shell.e2e.ts` bundle toggle | 用 `launchWebScaffold`、`ctx.pluginManager.setBundleEnabled` 和 `ctx.clientModules.graph()`，未启动 Chromium | 移到 Harness-backed integration 测试（如 `packages/agent-team/tests/harness-lifecycle.spec.ts` 或同级 integration spec） |
| `team-settings-and-tools.e2e.ts` Settings nav icon | 断言具体 SVG path、circle 和尺寸；Client 侧已有 `team-settings.client.spec.tsx`（`draws the bundle mark at the shell-supplied size`） | 核对现有 Client spec 覆盖后下沉/收口；`configures the Team page identity from Settings in real Web` 已验证真实 Web Settings 入口与 `团队` 按钮 |
| `team-settings-and-tools.e2e.ts` environment check | 主要验证运行版本文案和窄屏容器；Client 侧已有 `environment-check.client.spec.tsx`、`environment-check.spec.ts` 和 `team-settings.client.spec.tsx` | 核对现有 Client spec 覆盖后下沉，必要时把窄屏 `maxHorizontalScroll` 断言并入保留的 Settings E2E |
| `team-main-stream-and-board.e2e.ts` | 与 `team-journey` 共享项目、Task、Main/Board 的部分流程 | 保留 Main/Board 独有焦点和跳转，删除重复准备步骤 |
| `team-subscriptions.e2e.ts` | Host 语义已有大量 integration coverage，E2E 主要证明事件的真实投影和布局 | 保留事件投影、Inbox 和运行记录的代表性路径 |

## 5. Agent 闭环缺口

当前 Agent 可以：

- 找到 `npm run test:browser`；
- 传入 lane 过滤词；
- 看到 Vitest 或截图门禁失败。

当前 Agent 仍需要自己推断：

- 哪个 lane 对应当前改动；
- 哪些低层测试已经覆盖同一状态机；
- 某个 E2E 失败属于真实产品问题、环境问题还是证据门禁；
- targeted lane 通过后是否仍需完整 acceptance；
- 应查看哪一批截图。

工作项的文档和 Runner 改动应直接消除这些推断。

## 6. 不采用的替代方案

- **所有改动都跑全量 E2E：** 反馈成本接近 3 分钟，Agent 会倾向于跳过；不能解决 lane 选择和失败定位问题。
- **删除大部分 E2E 以达到 75–90 秒：** 会把真实 assembled Web 风险变成文档承诺，不能证明覆盖等价。
- **让所有场景共享 Scaffold/Workspace：** 会破坏测试隔离，产生顺序依赖和跨场景状态污染。
- **只更新 `AGENTS.md`：** 根入口会变成长表，lane 变化时仍会过时；完整契约应放在维护文档，并用机械检查防漂移。
