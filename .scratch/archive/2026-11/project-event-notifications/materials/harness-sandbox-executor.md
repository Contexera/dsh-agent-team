# 真实 Harness 执行器实测（ticket 02 §4.3）

本文件记录 ticket 02 用**真实执行器**验证的无人值守执行事实，作为 spec §4.3「权限 / 可写根目录 / 环境变量 / 限制」的实现依据。探针脚本与本文件同目录：`sandbox-executor-probe.mts`（可重跑，不提交）。

- 环境：Linux（内核 Landlock 可用），Node v24.15.0，Harness `687f282e86`（0.2.1-rc.2 发布合并）。
- 组合：`LocalSubprocessRuntime` + `LocalSandboxProvider`（Landlock）+ `SessionProjectionRegistry` + `SandboxPolicyService` + `SandboxBashExecutor`，即 Web 组合里 `ctx.shell` 的真实实现。
- 关键做法：部署策略故意设为 `read-only` 且可写根指向**另一个**目录，每次调用再传 per-call `sandboxPolicy`，以此证明是调用方传入的策略在起作用，而不是部署默认值。

## 结果

| 验证点 | 调用 | 结果 |
| --- | --- | --- |
| per-call 策略进入 spec | `resolve({ command, workdir, sandboxPolicy })` | `spec.sandboxPolicy = { mode: 'workspace-write', workspaceRoot }`，覆盖部署的 `read-only` 与另一个根 |
| 可写根内写入 | `printf ok > $WS/inside.txt` | 退出码 0，`result.sandbox = { mode: 'workspace-write', denied: false, enforcement: 'full' }`，文件存在 |
| 可写根之外写入 | `printf nope > $OUTSIDE/outside.txt` | 退出码 1，文件不存在，stderr `No such file or directory`；`result.sandbox.denied` 仍为 **false** |
| `read-only` 下在工作区内写入 | `printf hi > $WS/ro.txt` | 退出码 1，`denied: true`，`Read-only file system`，文件不存在 |
| `danger-full-access` | 同上但写到根外 | 退出码 0，成功；`result.sandbox` 无 `enforcement` 字段（不设限） |
| 工作目录 | `pwd -P` | 等于请求的 `workdir`（不继承进程 cwd） |
| 显式 env | `env`，请求带 `env: { DSH_TEAM_SUBSCRIPTION_REF, DEMO_API_KEY }` | 两者都到达子进程；进程环境里的 `DSH_AMBIENT_PROBE`、`PROBE_API_TOKEN` 都没有隐式继承 |
| bash 家族探测 | `printf %s "${BASH_VERSION:-}"` | `5.2.21(1)-release` |
| pwsh 家族探测 | `if ($null -ne $PSVersionTable) { ... }` | 退出码 2、stdout 空（本机无 pwsh） |
| stdout 上限与截断 | 3000 字节输出 + `stdoutMaxBytes: 100` | `truncated: true`，`text` 保留**尾部**（`HEAD` 丢失、`TAIL` 保留），长度正好 100；spill 文件保留全量 |

## 结论（已落实到实现）

1. **per-call `sandboxPolicy` 是有效契约**：Harness 0.2.1-rc.2 的 `ShellExecRequest.sandboxPolicy` 同时覆盖 mode 与 `workspaceRoot`，无 Session 调用不需要也不要提权。Host 因此每次运行显式传 `{ mode: 'workspace-write', workspaceRoot: <Project Workspace 根> }`，实测 enforcement 为 `full`。
2. **越界写入不能靠 `result.sandbox.denied` 判定**：根外目标的写入是普通 bash 失败（`No such file or directory`），`denied` 为 false；只有被 runner 分类的拒绝（如 `read-only` 下的写）才置 `denied: true`。实现的失败判定只用退出码、超时、truncated 与输出校验，不把 `denied` 当唯一信号。
3. **env 必须显式传**：进程环境的 `DSH_*` 与凭据形状（`*TOKEN`/`*KEY`/`*SECRET`/`*PASSWORD`）被 Harness 子进程层清除，而 `ShellExecRequest.env` 在清除**之后**合并，所以 `DSH_TEAM_*` 与解析出的 credential 值一律放进 `env`；这也意味着不能用「继承进程环境」实现凭据注入。
4. **家族探测只看 stdout**：pwsh 探测在没有 pwsh 的机器上以非零码退出且无输出，bash 探测输出真实版本号。判定逻辑必须是「stdout 是否等于预期标记」，退出码不作为依据。
5. **截断是尾部截断**：`stdout.text` 在 `truncated` 时只保留尾部，因此输出解析必须在 `truncated` 时判本次运行失败，不能拿「恰好合法的尾部」当完整输出（实现已如此）。

## 未覆盖 / 留给发布前

- 只验证了 Linux + Landlock + bash。macOS（seatbelt）、Windows（ACL 沙箱）与 Windows pwsh 家族的真实运行未在本机验证；enforcement 事实以运行机器为准，Host 不假设 `full`。
- 网络、进程可见性不在沙箱语义内（Harness 沙箱只约束文件写入），与 spec §4.3「信任边界」一致。
