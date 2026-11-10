# 01 — 从成员 Session 派出 Codex Worker

**What to build:** Human 可以在 Team 设置开启实验性 Worker；目标 Project 的 Agent owner 可以不建 Thread，指定 Project 后在成员 Session 委派一次本机 Codex。启动先返回执行编号，后台结束后只通知发起 Session。
**Blocked by:** None — can start immediately
**Status:** complete — 2026-11-09 已验收，Task #136 task:b3067e15-cce8-497e-88a5-cbd34763165c；基线 `eef5af2`。

- [x] 设置默认关闭，打开后明确展示本机 CLI 会按配置的原生权限执行；可启用 Codex 并用它作默认。普通 DSH Session 的工具和加载行为不变。
- [x] 工具对 Team 成员统一可见；未启用、未指定有效 Project、非目标 Project owner、请求未启用的引擎均在启动原生进程前拒绝。未安装和打开失败有可理解的错误。
- [x] 同一次发起请求重送不会多开进程；Host 在启动前记录可追踪的执行编号。接纳后发起者能继续对话；完成或失败只向原 Session 报告一次，不建 Task、不发 Main，离线不补投。
- [x] Team 自有 OAR provider 通过 Harness 管理执行。使用明确的原生权限和清理规则，遵守现有环境清理约定；实际发布组合验证成功和打开失败后没有残留进程。不改 Harness 仓库或普通 DSH 配置。
- [x] 发起者可指定已准备的工作目录；实验配置允许真实文件修改，不加 checkout 锁，不自动创建 worktree。用隔离目录验证一个小改动。
- [x] 常驻引导和工具说明让 owner 能写自包含任务，并说明启动后可以继续、无需轮询。完成可重复的受控验证和已安装 Codex 的原生验收。

**验收记录：** accepted 2026-11-09（Human accept，票 01 关闭）— `master` 本地 `eef5af2`，未 push

- 提交：`94ec3de`（Worker 运行时、`team_worker` 工具、设置行）、`9f2b94d`（文档）、`a0f99ab`（设置页 UI）、`01d3a36`（原生链路修复：沙箱策略、原生 session id、每次打开读设置行）、`8eeeebb`（`team_worker` 进 Member 工具契约）、`6a3bb1a`（沙箱策略接线钉住、手写行默认策略）、`eef5af2`（设置页抛光：可访问名、显式空串策略、截图起点）。
- [x] 设置默认关闭；组开关打开前引擎与字段禁用；页面在开关之前写明 CLI 按自己的原生权限执行。普通 DSH Session 不受影响（composition/委派 spec）。
- [x] 工具对 Team 成员统一可见；关闭、非 owner、未知 Project、引擎未启用、空任务、相对目录均在启动原生进程前拒绝（11 条委派 spec）。
- [x] 重送同一 requestId 返回原执行、不双开；完成后只向发起 Session 通知一次（composition probe + 原生验收）；离线不补投、不建 Thread/Task/Main。
- [x] Team 自有 OAR provider 走 Harness subagent 管理；成功与打开失败都没有残留进程（原生验收后 `ps` 无 app-server；卸载等待清理）。
- [x] 隔离目录完成一次真实改动：Codex 在 `/tmp/team-worker-native-*` 写出 `worker-proof.txt` = `WORKER-PROOF-OK`；未加 checkout 锁、未建 worktree。
- [x] 工具说明写明"启动后可以继续、无需轮询"；门禁：`npm test` 组成清单全绿，`vitest` **2122 passed / 0 failed / 1 skipped**，`npm run test:browser` 14/14、167 张截图。

**01 落地时发现的机制事实（02–06 直接用）**

- 环境：本仓 `node_modules` 是对邻接 Harness checkout 的软链农场；Harness 新增包后要重跑 `node scripts/link-harness-packages.mjs`（这次补了 30 个链接，`@deepseek-ai/dsh-tool-testkit` 缺链接曾让 `member-tool-policy.spec.ts` 整文件 `unavailable`，把 3 条真实的工具面断言失败一起吞掉）。

- OAR 0.95.1 的 Codex 权限模式只读 Host 进程自己的 `OAR_CODEX_SANDBOX`；会话 `env` 只到子进程，库没有逐会话选项。`withCodexSandbox` 在打开调用期间设置、随后恢复；`worker-provider.spec.ts` 钉住"每次打开读当前设置行"。
- 外部子执行的 `childId` 就是引擎原生 session id（Codex thread id）。执行记录的 `nativeSessionId` 取自 `activation.childId`，逐次 `onNativeFacts` 回调已删除；04 可直接用它 reopen 原生历史。
- `worker.timeoutMs` 仍是行字段（单次 turn 时限），设置页未渲染；`defaultEngine` 指向未启用引擎时页面有提示，委派会被拒。
- `6a3bb1a`：`worker-provider.spec.ts` 在 mock `session` 里断言 Host 的 `OAR_CODEX_SANDBOX` 期间等于行里的策略（摘掉 `withCodexSandbox` 会红）；`worker.engines.codex.sandbox` 字段默认改为 `DEFAULT_WORKER_SANDBOX`，缺该键的手写行不再回落到 OAR 的 `danger-full-access`。共用 checkout 里并发 `npm run build` 会 `clean:build-outputs`，把正在跑的 vitest 扫成整文件红——假红，复跑即绿。
- 最终树 `eef5af2`（干净）：`npm test` 组成清单全绿，`vitest` **2125 passed / 0 failed / 1 skipped**（178 文件）；`npm run test:browser` 14/14、167 截图、exit 0；Worker 两张截图 `7d7ebd60…`／`f05ccd7f…` 与 Iris 自跑逐字节相同（我独立复跑），1440×960 与 390×844 都确认组标题在画面内、值可读。
- 原生验收证据：`worker:9aedda2c…` → codex → `01a1bcb9-3b6b-7c22-b20a-a41f02ccd703`，app-server 命令行含 `-c sandbox_mode="workspace-write"`，结果按 parent delivery 回成员 Session，结束后无残留进程。

**Amendment（2026-11-09，Human 决定）：默认权限改为全权限**

Human 在票 02 的 Thread 里定：两个 CLI 都应该按全权限跑（Codex `danger-full-access`），不需要操作者配置。落地：
- `DEFAULT_WORKER_SANDBOX` 从 `workspace-write` 改为 `danger-full-access`；设置行 schema 默认随之；OAR 本身不设 `OAR_CODEX_SANDBOX` 时就是 `danger-full-access`，我们只是不再往上加闸。
- Claude 无需权限字段：OAR 在没有 `--permission-mode` 时自动 `--dangerously-skip-permissions`，Team 的 `launchArgs` 保持空。这条作为票 06 的验收要求。
- 设置页不再渲染沙箱选择器（全权限默认，收紧只能手写行）；`docs/frontend-design/components.md`、`tools.md`、`host-authority` 口径同步。
- 原「原生验收」证据（`workspace-write` 那次）仍证明机制；默认值变更由 `worker-sandbox.spec` 与 Codex env 映射断言覆盖。
