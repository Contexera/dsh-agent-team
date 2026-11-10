# 票 01 施工前思考（等原生 CLI 期间）

日期：2026-11-08。只读源码核对，未改代码、未启动进程。基线：Team `57340d4`（本地 master，origin/master 为 `b455aa8`），Harness `66491b05e3`（0.2.2-rc.1）。

## 1. 回传通道：01 用 parent，02 才用 caller

`SubagentActivationSpec.delivery`（Harness `packages/subagent/subagent/src/types.ts:38-43`）：`parent` 通知模型，`caller` 只返回结果、不发父级通知。

- 票 01 只有「仅指定 Project」一条路，结果回发起 Session = **parent delivery**，Team 不写任何 Project 内容。
- 票 02 绑定 Thread／Task 时才需要 caller delivery：Team 先落 Thread 事实，再由 Inbox 唤醒发起者，且不重复发父级通知（research 第五轮已这样定）。

此前 Task 描述里把 01 写成 caller delivery，是错的，按本节修正。

## 2. 组合位置：一个 host 级 subagent 服务 + 显式 parent，不按成员挂 provider

- `startActivation` 的请求里 `parent: Agent` 是**显式参数**（`types.ts:153`、`203-204`），不是从 context 猜的。所以服务挂一次，成员 Session 的 Team 工具把该成员的 live Agent 作为 parent 传进来即可。
- `@deepseek-ai/dsh-subagent` 的 `static inject` 是 `['workingDirectory', 'sessionProjections']`（`subagent/src/index.ts:199`），并往 `sessionProjections` 注册三个 projection（`index.ts:233-236`）。Team Host 本来就 inject `sessionProjections`（`packages/agent-team/src/index.ts:441`）并在其上注册 context projection（`index.ts:965`），说明这些服务在 Host 面可见。
- 因此**不要**把 `dsh-subagent` 塞进 `team-member` preset 的 per-member 组：那会让每个成员的激活各注册一次同名 projection，且每个成员各有一棵独立激活树。放在 host 面一次、provider 两行（codex／claude）、容量沿用 `maxActiveSubagents` 默认 8。
- 仍待实测：成员 Session 的 context 能否解析到 host 面的 `subagents` 服务（`contexera-agent-team-scope` 只 isolate 了 `agentPresets`，理论上可以，但要有 probe 证据）。

## 3. spec 有一处自相矛盾，需要在 02 之前定：执行记录到底存哪

spec §3 两句话冲突：

- 「仅 Project：……保留供发起者和 Human 按编号查看的最小私有诊断记录」——暗示不落公共内容；
- 「Host 重启后无法确认的执行标为『结果未确认』，不重新接管或补跑」——**进程内 Map 无法在重启后说出「未确认」**，必须有跨进程的持久记录。

Team 里唯一持久权威是 ledger。可选形状：

| 方案 | 代价 |
| --- | --- |
| A. 不加持久化，重启后该执行彻底消失 | 直接违反 spec 的重启语义；票 04 的 `inspect` 也没有可查对象 |
| B. 新增 `worker` 类 ledger 操作，audience 限定发起者（+Human），不进 Project 时间线 | 要动 ledger schema、codec、change-scopes 与 replay 校验；但 `team/dm-sent`（`ledger.ts:3074-3103`，audit-only、收发双方寻址）已证明「私有但持久」的账本事实是现有模式，不是新发明 |
| C. Team 自建第二份持久存储 | 违反仓库护栏「ledger 是 Team 事实的唯一权威」 |

倾向 B：`worker started` / `worker settled` 两个操作 + 品牌化 `worker:` 引用，票 03 的停止、票 04 的 inspect 都读它；票 02 的 Thread 结果仍是普通 Thread 事实，与之用引用相连，避免两份真值。

## 4. 现在就能做的验证：OAR 自带 scripted runtime

`@botiverse/oar@0.95.1` 的 `./testing` 导出提供 `ScriptedRuntime`（`dist/testing/scripted-runtime.d.ts`）：脚本化输出文本、推理、工具调用、后台任务，并把一切写进记录流，和真实 runtime 走同一条路径。

意味着票 01 的承重件（服务注册、成员 identity → Project owner 校验、parent delivery、容量、dispose 清理、重送幂等）**今天就能用脚本 runtime 端到端验证**，不必等 CLI。真实 CLI 只替换 runtime，验收范围收窄为「原生可用性 + 权限模式 + 历史落盘位置」。

## 5. 装好 CLI 之后必须先核的几件事

1. **Host 进程的 PATH／HOME 与我的 shell 不同**：本机 `node` 在 `/opt/memoh/toolkit/bin`，Team Host 由 `dsh web` 启动，未必继承同一 PATH。要在成员 Session 内（同一 Host 进程）跑 `codex --version`／`claude --version`，而不是在我自己的 shell 里确认。
2. **凭证落在哪个 HOME**：Codex 用 `~/.codex`、Claude 用 `~/.claude`，取决于 Host 进程的 HOME 与 `DSH_HOME`（仓库里有 `dshHomePath`）。登录态必须在 Host 看得见的那份里。
3. **OAR 的 Codex 默认沙箱是 `danger-full-access`**（`dist/runtimes/codex/session.js`：`process.env.OAR_CODEX_SANDBOX ?? "danger-full-access"`）。这台云主机此前没有可用沙箱执行器，`workspace-write` 可能直接失败。首版默认值要在 settings 里明确，不能靠 OAR 的默认。
4. **node 版本**：OAR 0.95.1 要求 `node >= 24`。要确认 Host 进程实际使用的 node，不是 shell 里的。
5. **原生历史位置**：跑一次最小 turn，确认 Codex 的 thread 文件与 Claude 的 session 文件落在哪，票 04 才能按目录只读查询。

## 6. 新的依赖面

新增 `@deepseek-ai/dsh-subagent` peer 与 `@botiverse/oar` 直接依赖，要过仓库的 `check:versions`／facades／`installed-manifest` 门禁，并确认发布包的 peer 解析不会被 `>=0.2.2-rc.1 <0.2.3` 的范围夹住。这一步放在 01 的第一次提交里做，不单独开票。
