# 06 — Claude 原生接口预检

**核对时间：** 2026-11-10。**范围：** Claude Code 2.1.319、OAR 0.95.1（npm）、本机 HTTP 假 Messages 端点；不接触真实账号或用户历史。本文记录预检实证与实现约束，不代表 06 已验收；当前事实以源码、测试和 Task 为准。

## 结论

- **Claude 的 steer 按能力阻塞记。** CLI 原生有同轮机制，但 OAR 0.95.1 的公开接口既不暴露条件接收、也不暴露撤回；晚到消息必然另开一轮。05 的 Codex-only gate 保持，06 不开放 Claude steer。
- 其余三条（只启用 Claude 时的发起与默认选择、原生只读读取与回传、组合与浏览器验收）不受影响，待 05 合回后实施。
- 全权限零配置已实证：`launchArgs` 保持为空，不传 `--permission-mode`；实测文件写入成功、无权限拒绝。

## 同轮与收尾竞争的证据

- 判据：消息带 `uuid` 时 CLI 发 `command_lifecycle` 帧（`queued` → `started` → `completed`；取消是终态 `cancelled`）。`started` 落在同一 turn 的 `result` 之前 = 同轮；之后 = 新一轮。
- 工具执行中写入：`queued → started → completed → result#1`，只有 1 个 `result`，指令进入第二次模型请求。
- 工具结果之后写入（约 20ms）：`queued → result#1 → started → result#2 → completed`，2 个 `result`，指令没有进入第二次模型请求。
- OAR 的 `accepted` 只按 `nativeBusy()` 放行；`nativeBusy()` 从 prompt 一直真到 turn 的 `result`，覆盖「工具结果已产生、轮未结束」和「最终文本流式中」两个窗口，所以 `accepted` 不等于同轮送达。
- 原生丢弃机制存在：`cancel_async_message`（按 uuid 撤回排队中的 async user message）；`interrupt` 带 `cancel_queued:true` 取消排队中的 uuid 消息并在响应 `cancelled` 里列出；`send_now` 可把等待中的消息立刻送进当前轮。

## OAR 0.95.1 的公开接口缺口

- OAR 消费 `command_lifecycle` 并转成 `input_queued` / `turn_active(inputId)` / `input_dropped`，但 `streamJsonInputLifecycle` 第一句就要求 `state.promptInputs.has(inputId)`，而 `promptInputs` 只在 `prompt` 和 `queue` 里由 `streamJsonPrompted` 填入。`steer` 只写帧、不登记（`shared/stream-json/session.js:225-241` 对比 `:206-224`），所以 steer 的 inputId 拿不到任何生命周期事件。
- `withdraw(inputId)` 只撤 OAR 自己 heldQueue 里的输入，写出去之后一律 `not_queued`。
- `cancel_queued` 只在 `abort` 里用（`canCancelQueued`），而 abort 会结束当前 turn，不是「撤一条消息」。
- `cancel_async_message` / `send_now` / `still_queued` 在 OAR 全仓无实现（grep 无命中）。
- 自己发 `cancel_async_message` 要绕开 OAR 直接写 stdin，等于自建控制层，属于未经验证的协议技巧，不采用。

## 解除条件（三选一）

1. OAR 的 `withdraw` 能撤已写出的输入（底层就是 `cancel_async_message`）；
2. OAR 把 steer 的 inputId 登记进 `promptInputs` 并暴露 `input_queued` / `turn_active(inputId)`，至少能判「被排到下一轮」并撤回；
3. 06 对 Claude 不提供 steer，只保留派发／停止／只读诊断，Codex 独占 steer，票里写明。

当前按第 3 条记。

## 已实证、实现必须保留的限制

- 原生会话：原 session ID、记录位置为 `<config>/projects/<cwd slug>/<sessionId>.jsonl`；进程退出后只读读取可用，SIGKILL 中途停止后记录文件仍在且可读。不恢复会话、不扫描最新文件、不读真实用户历史。
- 全权限：`launchArgs` 为空时 OAR 自动 `--dangerously-skip-permissions`；实测写文件成功、无 denials。Team 侧不得加 `--permission-mode`，验收会钉住。
- 缺失 CLI 与未登录：OAR 的 `claudeInstallation` 探测与 CLI 实际退出状态要分开读。未登录时 CLI 退出码 1、`result.is_error=true`、`assistant.error=authentication_failed`，`result.subtype` 不能作为成功判据（实测未登录时仍报 success）。不可用时不自动切换引擎。

## 2026-11-10 独立原生验收补充

- `2b22c59` 与验收修复 `aeb04d5` 之上，`node --import tsx artifacts/probe-06-claude-native.mjs` 正常退出（0）。使用发布版 Claude Code 2.1.319／OAR 0.95.1 和隔离 HOME、配置目录、工作目录及本地假 Messages 端点。
- 正常、API 400、工具执行中停止、执行超时、两条并行及无凭据的明确 API 401 均通过。401 报告 `authentication_failed`，记录仍可读取；401 是认证拒绝，不是死端口的连接重试。
- `launchArgs` 为空，原生会话实际为 `bypassPermissions`，工具写入真实临时文件成功；成功、失败和并行执行都显式 dispose 后才读取，探针和 CLI 子进程均退出。
- 原生读取使用本次 CLI 自报的 cwd、session ID 与有效配置目录，没有发模型请求；两条并行执行没有串结果、turn 或记录。
- Claude steer 仍不开放：0.95.1 的 `steer` 只按 `nativeBusy()` 接收，无法保证晚到输入不另开一轮。此能力阻塞不因上述通过而解除。

## 复跑

```sh
node .scratch/archive/2026-11/domain-owners-and-workers/materials/probes/claude-precheck.mjs [--out <dir>] [case ...]
```

九个 case：`steer-tool` / `steer-late` / `steer-stream` / `lifecycle` / `record` / `stop-record` / `permissions` / `missing-cli` / `not-logged-in`。默认全部；`lifecycle` 可单独复跑。所有 case 使用隔离的 HOME/config 和临时工作目录，不读真实用户历史，不使用真实账号；日志落在 `--out`（默认临时目录），不写仓库。
