# Harness 现有 webhook 能力与本仓库接入点

调查日期：2026-11-02。Harness 检出版本 `687f282e`（2026-10-17）。

## 结论

Harness 已提供两个实验性包，版本 `0.2.1-rc.2`，与本仓库 `dsh` 依赖范围 `>=0.2.1-rc.2 <0.2.2` 一致：

| 包 | 作用 |
| --- | --- |
| `@deepseek-ai/dsh-webhook` | 与提供方无关的 webhook 运行时 `ctx.webhookRuntime`。规则通过 `register({ id, kind, run })` 注册；`dispatch()` 异步调用所有匹配 `kind` 的规则。 |
| `@deepseek-ai/dsh-webhook-github` | GitHub HTTP 适配器。在注入的 `webServer` 上注册一个精确路径，校验 `X-Hub-Signature-256` 后再解析 JSON，返回 `202`，不等待规则执行。 |

来源：`packages/experimental/webhook/src/types.ts`、`packages/experimental/webhook-github/src/handler.ts`、`docs/subsystems/webhook.md`。

## 关键行为

- 规则 `run(delivery, signal)` 返回 Session 请求或 `null`。返回 Session 请求时，运行时会新建一个根 Session；返回 `null` 时不做任何事。规则内可以运行任意受信代码。
- 运行时不保存投递状态：没有队列、重试、去重、重放。同一投递重复到达会重复调用规则。
- delivery 字段：`kind`（如 `github`）、`source`（适配器实例名）、`deliveryId`（GitHub `X-GitHub-Delivery`）、`event`（GitHub 为 `{ name, payload }`）、`receivedAt`。
- 适配器配置：`source`、`path`、`secretEnv`（凭据引用）、`maxBodyBytes`。TLS 由反向代理或隧道提供。文档建议用独立的第二个 WebServer 承载入口，避免把浏览器 API 暴露到公网。
- 装配示例：`apps/cli/tests/fixtures/github-webhook/cordis.yml` 与 `github-webhook-rule.mjs`。规则插件 `inject = ['webhookRuntime']`，在 `ctx.effect` 中注册。

## 对本仓库的含义

- 规则返回 `null`，在 `run` 内调用 Team Host 写入账本，即可把外部事件变成 Project 通知，不需要新建 Session，也不需要修改 Harness。
- 签名校验、HTTP 路由、请求体限制已由 Harness 负责；Team 侧需要自己做去重（按 `deliveryId`）和过滤。

## 本地接收的网络前提

GitHub 推送需要公网可达的 HTTPS 地址。本机运行时需要反向代理或隧道。

`gh webhook forward` 只适合测试："Webhook forwarding is only designed for use during testing and development. It is not supported for use in production environments for handling live webhooks." 且同一仓库同一时间只能一人转发。来源：https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing

## Team 现有可复用结构

- Project owner：Human 隐式拥有全部 Project；Agent owner 由 `team/project-owner-added` 授予，授予时获得 Main stream Attention。
- Main stream 已有 Activity（`owner-added` / `owner-removed`）和 Activity marker，可投递给特定 Member；Agent 通过 Inbox 通知被唤醒。
- Actor 有 `human`、`member`、`host` 三类；外部事件不属于任何 Member。

## 其他可用于唤醒 Agent 的 Harness 能力

调查日期：2026-11-02。来源：Harness `packages/schedule`、`packages/jobs`、`packages/goal` 的 README，以及本仓库 `cordis.patch.yml`。

| 能力 | 行为 | 与 Team 的关系 |
| --- | --- | --- |
| `dsh-schedule` + `dsh-tool-schedule` | 持久化提醒，支持单次、固定间隔、每日、每周、cron；Host 重启后保留；到期时以 follow-up 消息送达**原 Session**，必要时恢复冷 Session。 | `team-member` preset 未挂载。提醒绑定 Session，而 Team 会续接/回收 Member 的 Session，绑定关系可能失效（未验证）。 |
| `dsh-jobs` + `dsh-tool-jobs` | 后台任务，完成时向所属 Session 发通知；Session 释放后未送达的通知丢失。 | 已挂载在 `team-member` preset。只覆盖 Agent 自己启动的本地进程。 |
| `dsh-goal` 系列 | 单 Session 的持续目标与自动续跑轮次。 | 面向单个 Session，不涉及外部事件。 |

Team 自身已有 Host 发起的私有提醒（`team/reminder-raised`，类型 `review-backlog` / `stalled`），先例是：由 Host 按账本状态产生提醒，记入账本，送达指定 Member。

## 核实：`dsh-schedule` 不适合做 Member 提醒

- `dsh-schedule` 的提醒归属于 Session：创建、列出、修改、删除都要校验 Session 归属；Session 停止时，它的提醒也会停止。来源：Harness `packages/schedule/schedule/src` 的 runtime 和 domain 模块。
- Team 会把 Member 迁到新的 Session 上，对应账本操作 `team/member-session-renewed`、`team/member-session-rolled-over`、`team/member-session-recycled`。来源：本仓库 `packages/agent-team/src/types/operations.ts`。
- 结论：Member 的提醒需要按 memberId 绑定，由 Team 自己实现，不能直接用 `dsh-schedule`。

## 核实：Host 能否在沙箱里执行命令

- Harness 通过 `ctx.shell` 提供命令执行，可以选择不受限的本地执行器，也可以选择沙箱执行器。沙箱执行器在沙箱不可用时直接报错（fail closed），不会退回到不受限执行。
- 沙箱只限制文件访问，进程仍与 Host 共用同一个内核和文件系统。需要完整隔离时，应使用容器、microVM 或远程执行器。
- 来源：Harness `packages/shell`、`packages/sandbox` 的 README。
- Project 实体带有 `workspaceId`，脚本的工作目录可以取这个 Workspace。

## 修订记录（2026-11-03 复核，supersedes 上文对应说法）

复核基线：Harness `b830ec950`（0.2.1-rc.5），与本文件调查基线 `687f282e`（rc.2）在本文引用的包上源码零差异（仅 package.json 版本号不同）。以下三条上文说法经复核不成立，以本节为准：

1. **“签名校验、HTTP 路由、请求体限制已由 Harness 负责”只对 GitHub adapter 成立。** 验签与 body 上限属于 `@deepseek-ai/dsh-webhook-github`（`handler.ts` 验签、`body.ts` 有界 UTF-8 读取）。通用 `WebRoute` 只提供裸 `req/res`，handler 自负响应生命周期；路由注册（exact/prefix、未匹配 404）是 webserver 的通用能力，不属于 adapter。Team 自建 token 入口必须自己实现 body 限制、状态码、存储失败与路由生命周期。
2. **“dsh-jobs 只覆盖 Agent 自己启动的本地进程”不成立。** `JobSpec` 是通用任务规格（`jobs/src/types.ts`：owner 可选，run 是 producer callback），实际 kind 包括 bash、workflow、pty-send。不选 jobs 作为订阅 authority 的理由应是生命周期与持久化不匹配（完成通知归属 Session，释放后丢失），不是“只能跑本地进程”。
3. **gh 凭据可用性不能假定。** `GH_TOKEN`/`GITHUB_TOKEN` 优先于已存凭据；默认存于系统 credential store，明文文件是 fallback。`gh auth login --help` 与 `gh help environment`（2026-11-03 只读执行）确认。
