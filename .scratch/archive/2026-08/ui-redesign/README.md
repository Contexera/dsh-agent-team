# Agent Team UI Redesign

状态：archived — 2026-08-17 已完成。这里保存 UI native-feel 重做的历史设计、实施拆分和验收上下文，不是当前工作的入口或实现规范。

M2 functional baseline 已完成于 commit `9ae7cc3`；本工作项随后只重做 Client presentation，不改 Host、ledger、Remote、authority 或 persistence。当前 Client 边界和验收规则分别见 [`../../../../docs/architecture/README.md`](../../../../docs/architecture/README.md) 与 [`../../../../docs/development/README.md`](../../../../docs/development/README.md)。

## 历史阅读顺序

1. [`design/team-ui-redesign.md`](design/team-ui-redesign.md)：当时的设计基线。
2. [`spec.md`](spec.md)：范围和非目标快照。
3. [`research/team-ui-visual-audit.md`](research/team-ui-visual-audit.md)：改造动机。
4. [`research/dsh-ui-reuse-inventory.md`](research/dsh-ui-reuse-inventory.md)：当时确认的 public API 边界。
5. [`ticket-plan.md`](ticket-plan.md) 和 [`issues/`](issues/)：已完成的六张实施票。
6. [`../validation/browser/README.md`](../validation/browser/README.md)：人工筛选保留的代表性浏览器证据。

所有 01–06 tickets 已完成。日常 browser 截图不再写入本目录；运行 `npm run test:browser` 后在 Git 忽略的 `artifacts/browser/` 检查本次页面。

## 不要做

- 不要因为 UI 重做修改 Host、ledger、Remote schema、authority 或 persistence。
- 不要 import Harness `./src/*`、`WorkspaceBrowser`、`SidebarRoot`、`InputBar`、`MessageItem` 等 private implementation。
- 不要一次性重写整个 `team.module.css`。
- 不要加入 Agent DM、Thread inbox、search、URL routing、attachments、slash commands、model/provider/preset controls。
- 不要把 functional tests green 当成视觉完成。

## 已知事实

- 可直接复用：`Button`、`Input`、`Modal`、`Menu`、`Tooltip`、`HoverCard`、`Pill`、`StateDot`、`Toast`、`MessageText`、public icons。
- 没有 public multiline composer、Message row 或 Team domain row；这些由 Team 做薄 presenter。
- composer 仍需保留 textarea，但要遵守 DSH focus、density、token、keyboard 语法。
- `StateDot` 没有 neutral/unavailable state；不要伪造其他 StateDot state。
- Workspace 由普通 Session/Workspace UI 创建；Team 只列出并选择已有 Workspace，不拥有 New Workspace 或 directory picker。
- M2 只持久化 `mode + workspaceId`；刷新后 Channel/Thread/tab 回到 transient 初始状态，这是正确行为。

## 开工前门禁

```bash
npm run typecheck
corepack pnpm exec vitest run --reporter=dot
npm run build
npm run test:browser
```

每张票完成后都跑现有 functional gate；最终再跑 `npm pack` 和真实 browser screenshot 对照。开发预览在本仓库执行：

```bash
npm run preview
```

不是在相邻 `deepseek-harness` 根目录执行。
