# OAR 版本口径核对（票 01 前置）

核对时间：2026-11-08。核对对象是 npm 上的包和 Harness 仓库源码，未运行任何引擎。

## 结论

Team 自有 provider 直接依赖 npm `@botiverse/oar`，**精确 pin 0.95.1**，不带补丁、不 import Harness 私有 provider。Harness 内嵌 0.67.0 的两处实质补丁在 0.95.1 已上游，所以 `feasibility.md` 里「直接用 OAR 拿不到这些修补」的前提不再成立；那份材料里 0.67.0 的接口行号（`contracts/session.ts#L199-L208` 等）需按 0.95.1 重核。

## 证据

| 事项 | 0.67.0（Harness 内嵌） | 0.95.1（npm latest） |
| --- | --- | --- |
| Claude 权限模式 | OAR 强制 `--dangerously-skip-permissions`，`--permission-mode` 被当作 managed 参数拒绝；Harness 用 `patches/@botiverse__oar@0.67.0.patch` 改 `dist/runtimes/claude/launch-args.js`、`launch.js` 才让出权限模式 | 原生支持：`dist/runtimes/claude/launch-args.js:40-57` 接受并校验 `--permission-mode`（`default`／`dontAsk`／`acceptEdits`／`plan`），带 mode 时不再追加 `--dangerously-skip-permissions`，并拒绝两者同时给出 |
| Codex 启动失败清理 | 同补丁给 `dist/runtimes/codex/session.js` 加 `client.kill()` + `await client.exited` | 原生支持：`dist/runtimes/codex/session.js:281-293` 在同一路径 kill 并等待 `exited` |
| 同轮追加指令 | `Session` 上 `steer` 可选，能力缺失时无效 | `Session.prompt / steer / queue / withdraw / abort` 是显式 API，返回带 `kind` 与拒绝码的 `ControlOutcome`（`dist/contracts/control.d.ts`） |
| 投递语义 | 无单独投递层 | `dist/contracts/deliver.d.ts` 的 `DeliverWhen` 含 `now`／`after_turn`／`when_idle`／`interrupt`；`queued` 与「新开一轮」路径**禁止使用**，委派只走 `Session.steer` |
| 运行时要求 | 未核 | `engines.node >= 24`（本机 24.14 满足） |

Harness 侧基线：`packages/experimental/subagent-oar/package.json:54` pin `@botiverse/oar: 0.67.0`；补丁 `patches/@botiverse__oar@0.67.0.patch`（163 行，内容只有上述两类修复）。

## 尚未核对（各票自己的责任）

- 票 04：进程退出后按原生 id／目录／存储位置只读读取历史，在 0.95.1 的 `records`／`observe` 接口上是否还成立。0.95.1 的契约分层（kernel／deliver／control）与 0.67.0 不同，不能沿用旧结论。
- 票 01：`@deepseek-ai/dsh-subagent` 的 external provider 注册与 `delivery: 'caller'` 在 0.2.2-rc.1 的实际装载行为，以及新 peer 依赖对既有版本范围的影响。
- 票 06：0.95.1 的 Claude 历史读取接口（原生 session id、原目录）与 `getSessionMessages` 的关系。
