# Review 01 — domain-owners-and-workers

**结论：** Changes needed（需要修改）  
**工作项：** `.scratch/archive/2026-11/domain-owners-and-workers`  
**票据：** 全工作项，01–06；Claude steer 按明确关闭的能力限制审查，另按用户追加要求调查替代方案  
**比较范围：** `76a28534855d44dca1027ca38c8299dbfbf43d6f...4af67bb2294e1655ebd2d968f5c89e5630e587e0`，由用户确认  
**审查日期：** 2026-11-10

## 发现

### P1 — 并发打开 Codex 会话会把临时权限留在 Host 进程中

**位置：** `packages/agent-team/src/worker-runtime.ts:509–519`（`withCodexSandbox`）。

**证据：** 每次打开都保存当时的 `process.env.OAR_CODEX_SANDBOX`，但直到异步握手结束才恢复。A 设置临时值后 B 进入，B 保存的是 A 的临时值；A 先完成、B 后完成时，B 最后把 A 的值写回，而非 Host 原值。主审门闩探针将原值设为 `read-only`，A 使用 `workspace-write`、B 使用 `danger-full-access`，最终观测值为 `workspace-write`。两次都使用相同的默认权限也有同样的恢复顺序问题。

OAR 0.95.1 的 `dist/runtimes/codex/session.js:32` 在首个 `await` 之前同步读取该变量。独立审查进一步用伪 executable 核对了实际启动参数。因此这里不是两条 Team Worker 必然拿错各自权限，而是打开结束后污染全 Host 的默认环境。

**影响：** 两次并发委派即可让 Host 原本收紧的 Codex 配置被 Team 的临时配置替代。之后不另设此变量的 Codex provider 会话可能继承更宽的权限；Team 插件的影响没有随着本次打开结束而消失。实际是否影响另一 provider，取决于 Host 是否同时使用它。

**依据：** 票 01 要求遵守环境清理约定、普通 DSH 不变；设计 §2 要求执行权限由操作者配置。当前实现承诺打开后恢复环境，但并发时没有做到。

**建议修改：** 利用已锁定 OAR 版本的同步读取行为，在同步调用 `runtime.session(...)` 得到 Promise 后立即恢复环境，再等待 Promise；不要把临时进程变量保持到握手结束。增加并发完成顺序与真实启动参数回归。仅给 Team 的打开加互斥仍留下其他 provider 读取临时值的窗口。

### P2 — 超时后清理失败，Thread 和私有通知都没有说明进程可能仍活着

**位置：** `packages/agent-team/src/worker-runtime.ts:381–394,468–477`；`packages/agent-team/src/worker-service.ts:690–700`。

**证据：** 超时以 `stopReason: 'error'` 结束；只有 `aborted` 分支等待 disposal 并把清理失败并入结果。主审使用挂起的 turn、10ms 超时和拒绝的 `session.dispose()`，结果只有 `The Worker exceeded its execution timeout.`，随后 `run.dispose()` 明确拒绝。独立审查通过真实 Harness subagent + Team Host 分别重现绑定与非绑定路径：持久记录是 `stage: 'turn'`，Thread/Inbox 或父 Session 通知也只有超时原因。

**影响：** owner/Human 得知执行超时，却不知道进程退出未确认，可能继续在同一目录派活，而旧进程仍可能执行或写文件。正常停止分支已有的安全说明在超时分支丢失。

**依据：** 设计 §3–5 要求超时/停止回传状态、已有输出及安全诊断，清理失败必须明确说明；票 03 不允许把清理未确认当作完成清理。

**建议修改：** 将超时中断纳入与主动取消相同的清理确认步骤。在同一份结果中保留超时原因、部分输出和清理未确认说明，不另发第二份通知；覆盖两种回传路径。

### P2 — 明确未送达的 steer 被永久去重，换 requestId 也不能重试原文

**位置：** `packages/agent-team/src/worker-service.ts:519–542,557–578`。

**证据：** `entry.steers` 在异步结果出来前保存 Promise，按相同 instruction 去重时连已拒绝的 Promise 也复用。主审先让原生控制明确返回 `no_active_turn`，再切为可接收；以新 requestId 重试同一句指令，仍返回旧的 `worker_steer_refused`，原生控制调用数保持 1。

**影响：** 启动就绪窗口中的一次拒绝会让这句要求在整次 Worker 执行中永久不可发送。调用方按拒绝说明稍后重试也没有效果，只能改写文字绕过缓存。

**依据：** 票 05 要求重复请求不重复送入，同时对尚未就绪和已结束等状态准确拒绝。明确拒绝、从未送入的指令，不应被当成已经提交的指令。

**建议修改：** 保留相同 requestId 的既有回执；对新的 requestId，不将明确未送达的失败纳入按文本去重。区分“明确拒绝”与“传输结果不明”，不能一律删除所有失败缓存，否则可能重复发送实际已接收的指令。

### P2 — Claude 多步执行的重复模型片段占满配额，真正的失败原因被丢弃

**位置：** `packages/agent-team/src/worker-inspection.ts:229–238,340–348,379–382`。

**证据：** 每条 Claude assistant 记录都添加一个 `turn` 片段；读取最多返回 4 个片段。主审构造同一 session、同一 prompt 的原生 JSONL：2 条 assistant 后的 `api_error` 正常返回；增至 3 条 assistant 后，结果变成 `session + turn + turn + turn`，失败片段消失，仍报告 `kind: 'read', truncated: false`。

**影响：** 多次工具调用后才出错的常见执行，只能看到重复的模型/effort 信息，看不到原生错误原因，也不知道诊断被省略。Team 的通用失败摘要无法替代该次原生错误。

**依据：** 票 04、06 要求按执行编号查看可用失败诊断；设计 §5 要求明确缺失或读取限制，不拼造完整性。

**建议修改：** 去重重复的 turn 元数据并为最终失败保留位置；若仍省略有用片段，应明确标记。加入同轮三条以上 assistant 后出现 `api_error`/合成失败 assistant 的回归。

### P2 — 同时提供互相矛盾的 Project 与 Thread/Task，会静默使用后者并启动

**位置：** `packages/agent-team/src/ledger.ts:1234–1250`；`packages/agent-team/src/index.ts:3755–3788`。

**证据：** `delegationTarget` 在解析 Thread 或 Task 的分支不检查显式 `projectRef`；Host 只向 Registry 转交解析后的 Project，原始矛盾也不参与请求去重。主审通过公开 `workerStartForAgent` 传入 Project B 与属于 A 的 Thread，观察到执行被接纳、绑定 A，并调用了一次引擎启动。

**影响：** 调用者明确给出两个冲突目标时没有得到纠正，而是执行了 Host 单方面选定的目标。当前代码仍核对 A 的 owner，因此这不是绕过 ownership；问题是错误目标请求被执行，以及重送时显式 Project 的改写被忽略。

**依据：** 设计 §3 的“目标不一致，拒绝启动”，票 02 的“拒绝相互矛盾的目标”。工具参数说明建议省略冗余 Project，但不能替代冲突校验。

**建议修改：** 从 Thread/Task 得出 Project 后，若调用方也提供了 `projectRef`，要求两者一致；否则在写 started 和启动进程之前返回 `worker_target_conflict`。覆盖 Thread 和 Task 两条分支。

### P2 — 窄屏诊断正文被长路径撑宽，右侧内容被弹窗裁掉

**位置：** `packages/client-agent-team/src/client/create.module.css:269–276,296–307`；漏检位置为 `scripts/e2e/team-worker-inspect.e2e.ts:278`。

**证据：** 主审查看本次 390×844 截图发现诊断正文被裁切；独立 Chromium 测量进一步确认：可用列宽 294px，而 `[data-worker-report]` 宽 364.69px，右缘 412.69px；弹窗内容右缘只有 366px。报告中的路径/编号没有断行规则，grid 子项按不可断文本的最小宽度扩张，连摘要和失败文本所在轨道也一起撑宽。`probe/clip-narrow.json` 和截图均已核对。

**影响：** Human 按编号查询失败执行时，默认视图看不到完整的摘要、记录位置和原生错误。全量浏览器虽然通过，也没有证明这些诊断在窄屏完整可读。

**依据：** 票 04 的可用诊断入口、票 06 的浏览器验收，以及仓库 390×844 的可读性要求。

**建议修改：** 让报告 grid/子项能收缩，为路径、编号和片段添加明确断行规则。浏览器检查须覆盖实际滚动/裁切的弹窗内容祖先，而非只查 Worker 子树：当前 `maxHorizontalScroll` 跳过 `overflow: visible` 的节点，也查不到子树外的弹窗内容，因此断言为 0 仍可能裁切。

## Claude steer 替代方式调查

### 结论

**不能把当前限制概括为“Claude 不能 steer”。** 当前 OAR 0.95.1 的 `session.steer()` 路径确实没有满足“只追加当前轮、不意外开下一轮”的保证；但 Claude Code **2.1.319（与票据同版）** 的同步 `PostToolUse` / `PostToolUseFailure` hook，已经实测能把文本放进工具返回后的下一次模型请求。这是一条可实施验证的替代路径，不需要修改 Harness loop。

**推荐：** 后续优先设计 Team 自有的、按 Worker 执行隔离的 hook 投递通道。它不是现有 `steer()` 的简单开关，也还不是可直接上线的完整实现。生产 Codex-only gate 本次保持不变。

### 原生实证

从 npm 下载固定 `@anthropic-ai/claude-code-darwin-arm64@2.1.319` 到忽略区，二进制自报 `2.1.319 (Claude Code)`。每次启动使用隔离 HOME、配置目录和工作目录、本机假 Messages API、测试用假 key、空 MCP 配置；没有真实账号或真实模型请求。真实 CLI 执行 Bash，并把后续 provider 请求发送到本地记录端点。

| 场景 | provider 请求 | 原生 result | 观察 |
| --- | --- | --- | --- |
| Bash 执行中投递 | 2 | 1 | 标记进入第 2 个请求，位于 tool_result 后的 hook system reminder |
| 最终文本流式期间晚投递 | 2 | 1 | 标记没有进入任何请求，没有额外轮次；待投递文本留给执行结束时清理 |
| Bash 失败 `exit 7` | 2 | 1 | `PostToolUseFailure` 把标记送入第 2 个请求 |
| 两个并行 Bash | 2 | 1 | 两次 hook 只有一次取走文本，第 2 个请求出现一次标记 |

主审不只采信代理摘要：已读探针、hook 和结果 JSON，并独立重跑前两项。第二次主审探针让 Bash 写入“已开始”文件、等待 3 秒后写“已结束”文件；仅在确认开始文件存在且结束文件不存在时投递，排除了“其实在工具开始前就写入”的证据缺口。断言检查了请求数、result 数及 marker 所在请求，全部符合上表。

OAR 0.95.1 的另一个实测确认 `launchArgs: ['--settings', ...]` 能注入同一 hook，运行完成且下一步请求包含 marker。该 OAR 假端点实验有 stream→非流式重试，共 4 次请求，原因未查明；它只证明配置透传和 hook 投递，不用于声称 OAR 全组合只有一个 result。

### 候选方案比较

| 方式 | 判断 |
| --- | --- |
| 当前 OAR `session.steer()` | 旧限制仍成立：只检查 `nativeBusy()` 后写 user 消息，没有原子的目标 turn 条件接收；本次核对了安装源码 |
| 同步工具 hook + `additionalContext` | 已有同版 CLI 的正例、晚到反例及失败/并行例；推荐继续验证和设计 |
| 原生 `priority: 'now'` | 官方 SDK changelog 明确支持加入当前轮，但还会把 shell/agent/MCP 工具移到后台；尚未证明收尾不会另开轮，本次未原生验证 |
| 撤回消息 / interrupt / send-now 控制 | 2.1.319 自报相关 interrupt capability，但能力名不证明时序保证；异步撤回不能单凭回执排除已开下一轮，本次不推荐直接依赖 |
| Stop hook、abort 后重新 prompt | 可能增加继续执行或新轮次，不是原定的当前轮追加语义，不作为等价替代 |

### 实施前仍需解决

1. **执行和当前输入绑定。** mailbox 必须属于该 Worker、该次输入；停止/结束后关闭并清掉未投递内容，晚到 hook 不得消费下一轮或其他执行的内容。代理的 `leak` 探针在下一条 prompt 中没有再次执行工具，所以不能证明“保留 mailbox 也不会泄漏”；本报告不采纳该外推。
2. **回执与并发。** 目前小探针只能观测 hook 取走文本和真实请求；生产需要区分等待、已交接、未交接、结果不明，处理重复 requestId、并发工具、连续多条追加、停止竞态与 hook 超时。不能仅凭写文件就声称已提交给当前轮。
3. **工具覆盖。** 当前原生实验只覆盖 Bash 成功/失败/并行。还要核对其他工具、后台工具、无下一工具边界、自然结束和强制停止；同步 hook 超时会丢弃输出，须准确回报。
4. **配置与权限。** OAR 源码说明重复 `--settings` 是替换，不是合并；注入 hook 时不能覆盖已有设置，也不能为此更改用户的全权限默认或全局 Claude 配置。原票据“launchArgs 为空”的验收须被新的正式设计明确替换，而非偷偷绕开。
5. **文本语义。** `additionalContext` 以 system reminder 上下文进入请求，不是 user 消息，也不保证模型采用。官方建议用事实性上下文，命令式外来系统指令可能触发注入防御。若采用，应明确标记为本次委派者的追加要求并确认该产品语义。

### 来源与复跑

- 官方 [Hooks：Add context for Claude](https://code.claude.com/docs/en/hooks#add-context-for-claude)：说明插入时点、下一次模型请求可见、工具结果旁的位置。主审已核原文；同页说明 10,000 字符限制与同步 hook 超时丢弃输出。
- 官方 [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/2007ac4092a58963176cb9b1a583a1c2ed4fc455/CHANGELOG.md)：0.3.286 的 priority now 加入当前轮/工具后台化，0.3.287 的后台结果在后续轮到达；主审已核原文。
- 安装源码：`node_modules/@botiverse/oar/dist/shared/stream-json/session.js:206–264`、`dist/runtimes/claude/launch.js:15–36`、`launch-args.js`。版本锁为 0.95.1。
- 原生探针与结构化结果：`artifacts/scratch-review-domain-workers/claude-probe/` 下的 `probe.mjs`、`hook.mjs`、`oar-probe.mjs`、`out-final-2.1.319/results.json`、`out-oar-0.95.1/oar-results.json`。
- 主审加强版：同目录 `lead-probe.mjs` 与 `out-lead-tool-running/results.json`。从该目录运行 `node lead-probe.mjs --out "$PWD/out-new-check" mid late`；必须使用新的输出目录。它运行真实 CLI，但模型服务是本机回放。
- 本次没有测试 Claude 2.1.322，也没有用新版本事实替代 2.1.319 的实证。

## 验收条件核对

这里的“满足”表示本次检查的代码和自动化证据支持该行为，不重新勾选原票据，也不把历史原生验收当成本次重跑。

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| 01：默认关闭、权限告知、启用和设置保存 | 满足 | Host schema；Worker settings 组件测试与浏览器设置场景 |
| 01：普通 Session 不获得 Team 工具；Host 开关控制 Member 工具和引导 | 部分满足 | policy/guidance/composition 测试通过；并发打开的进程环境隔离见 P1 |
| 01：无目标、非 owner、禁用引擎、缺 CLI 在相应边界拒绝 | 满足 | delegation/provider/Host 测试；浏览器缺 CLI 场景 |
| 01：并发重送不重复启动，started 先于进程，调用接纳后后台执行 | 满足 | delegation/Host/operation-protocol 测试；真实工具浏览器回放 |
| 01：Project-only 只回原 Session，不建公共 Thread/Task/Main | 满足 | composition/stop-notice 测试；ledger 分支检查 |
| 01：准备好的 cwd、无 checkout 锁或自动 worktree、环境清理 | 部分满足 | cwd 路由与 provider 测试；环境恢复有 P1 |
| 01：自包含任务引导、继续工作、不轮询 | 满足 | 工具说明和 `projectOwnerGuidance`；组合回放 |
| 01：发布组合真实 CLI 修改文件和无残留 | 本次未完整重跑 | 票据留有历史证据；本次不以 mock 替代此项 |
| 02：Task/讨论 Thread 绑定，冲突目标拒绝，归属固定 | 部分满足 | 反序结算和 Task/Thread 冲突测试通过；Project 冲突见 P2 |
| 02：两条执行回各自 Thread，发起者 Inbox，无第二份父通知 | 满足 | `worker-host-thread`、`worker-thread`、`worker-stop-notice` |
| 02：Task 关闭/验收后仍保留执行事实，不改 Task 状态 | 满足 | Host 测试分别覆盖 close/accept |
| 02：终态/通知去重，重启未确认、不自动重跑 | 满足 | ledger replay、Host restart、stop 测试 |
| 02：输出只当数据，Claim/accountable/验收不由 Worker 改写 | 满足 | ledger 两类操作、工具与 domain skill；公开 Thread 不含原始回答 |
| 02：Task/讨论 Thread、Inbox、失败、窄屏和普通 DSH 恢复 | 满足 | 完整浏览器 Worker Thread/组合场景；已查看新截图 |
| 03：Human/原发起者定向停止，其他成员拒绝，不影响兄弟执行 | 满足 | stop/stop-notice 测试；浏览器只停一条 |
| 03：关闭开关仍可 Human 停止，启动中取消，停止中等待清理 | 满足 | stop 测试和结构化回执；工具面关闭由 Host 拒绝新启动保证 |
| 03：自然完成竞争保持真实终态、重复停止不重复通知 | 满足 | stop/provider/Client 回执测试 |
| 03：清理失败准确报告 | 部分满足 | 主动停止路径通过；超时路径漏报见 P2 |
| 03：已有改动不回滚、不改 Task/Claim、失去句柄不假装可停 | 满足 | stop/Host 测试；无文件回滚入口 |
| 03：正常卸载拒绝新启动、清理自身执行、封住晚到写入 | 满足 | stop 测试与生命周期代码；每条执行的有界等待并非全局单一期限 |
| 04：保留原生 ID/turn/位置，缺锚点如实说明 | 满足 | anchors/provider/inspect 测试 |
| 04：按编号授权，原位置读取，不续跑、不扫最新文件 | 满足 | Host 授权、读取器和 browser inspect 场景 |
| 04/06：诊断弹窗在桌面和 390×844 完整可读 | 部分满足 | 全量场景通过，但截图与追加几何测量确认窄屏裁切，见 P2 |
| 04：并行记录隔离，缺失/不支持保留 Team 摘要，片段有界 | 部分满足 | 现有读取安全测试通过；Claude 失败片段配额问题见 P2 |
| 04：发布版 Codex 退出后原生回读 | 本次未重跑 | 当前本机 Codex 为 0.167.0；历史接口核对作为历史证据，不冒充本次实测 |
| 05：Codex-only 同轮控制、按编号授权、回执仅称已提交 | 满足 | steer 测试；OAR 调用链检查；未以此宣称本次原生 steer 重验 |
| 05：两条执行隔离、重复不多送、就绪后可以正常提交 | 部分满足 | 现有通过；明确拒绝后的同文重试见 P2 |
| 05：停止/结束拒绝，无第二轮、无额外 Worker，重启不重连 | 满足（代码/受控测试范围） | steer 测试、Codex 原生 turn 控制；完整原生比赛窗口本次未重跑 |
| 06：默认/显式 Claude、不可用不切引擎、全权限零配置 | 满足（配置与受控测试范围） | settings/provider/sandbox/组合测试；未向 Claude 传 permission-mode |
| 06：Claude 正常/失败/超时/停止/修改文件/退出后读取 | 部分满足 | 历史原生验收；本次受控测试通过但发现超时诊断与多片段读取缺陷 |
| 06：Claude 同轮追加指令 | 已明确关闭，不计漏实现 | 生产 Codex-only gate 与票据状态一致；替代方式见后续附录 |
| 06：订阅唤醒→真实工具委派→继续回答 Human→定向停止→回原 Thread | 满足（确定性回放范围） | `team-worker-subscription.e2e.ts` 本次通过；不是模型自主判断能力证明 |

## 执行过的检查

日志、临时探针生成器位于忽略目录 `artifacts/scratch-review-domain-workers/`，不作为要提交的文件。

| 命令或检查 | 结果 |
| --- | --- |
| `npm test`（重建之前） | 209 failed / 2191 passed / 1 skipped，另有 1 unhandled error；失败集中在缺 `team_worker`，不是最终结论 |
| `node_modules/.bin/vitest run packages/agent-team/tests/member-tool-policy.spec.ts`（重建之前） | 20 failed / 1 passed，稳定复现 preset 缺工具 |
| `npm run build`，随后 `npm test` | 构建通过；196 文件通过 / 1 跳过，2400 passed / 1 skipped；`npm test` 内含文档、core skills、边界、版本、facades、comments 检查 |
| `npm run typecheck` | 通过，包括 scripts 类型检查 |
| `node scripts/audit-ui-parity.mjs` | 0 errors；2 条现有 `#000` 颜色警告 |
| `npm run lint` | exit 0；有 warning，无 error |
| `npm run check:artifact` | 通过；443 个发布文件、125 个运行时相对 import 均有目标，无多余 TypeScript 源文件 |
| `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser` | Team build 通过；首次 browser 因相邻 Harness 缺 `apps/web/dist/index.html` 未启动 |
| `(cd ../deepseek-harness && corepack pnpm build:web)` | 通过；仅补足忽略的前端构建产物，未修改相邻仓库源码 |
| 同一 `CHROME_PATH` 下 `node scripts/run-browser-test.mjs` | 19/19 通过；181 张截图 |
| `python3 artifacts/scratch-review-domain-workers/make-probes.py` + 临时 sandbox spec + `node_modules/.bin/vitest run packages/agent-team/tests/__scratch-review-*.spec.ts` | 4/4 按预期失败：Project 冲突、steer 拒绝重试、超时清理说明、并发环境恢复；临时测试已删除 |
| `node --import tsx artifacts/scratch-review-domain-workers/inspect-fragments.mts` | 2 条 assistant 有 failure；3 条 assistant 无 failure，仍 `truncated:false` |
| 独立审查的真实 Harness + Team Host 超时/清理失败探针 | 绑定与父 Session 两路均复现漏报；临时测试已删除，主审另有 provider 级复现 |
| 临时复制 inspect 场景加入几何测量，同一 `CHROME_PATH` 下 `node scripts/run-browser-test.mjs -t "reads a Worker diagnostic by number"` | 确认报告宽 364.69px、可用列宽 294px、越过弹窗内容右缘 46.69px；临时场景已删除，原 181 张全量截图已恢复 |
| 隔离 CLI `node probe.mjs --out ... mid late leak fail parallel`（研究代理） | 2.1.319 原生 hook 正例/晚到/失败/并行观察见附录；leak 例不证明下一轮再调用工具时安全 |
| 同目录 `node lead-probe.mjs --out "$PWD/out-lead-tool-running" mid late` + Node assert（主审） | 通过：确认 Bash 正在执行时追加，下一请求包含标记；晚到时没有额外请求/result |
| `node oar-probe.mjs`（研究代理） | OAR 0.95.1 设置透传、hook 投递及 completed 通过；4 请求中的非流式重试原因未查明 |
| `git diff --check 76a28534...4af67bb2` / `git diff --check HEAD` | 通过 |

重建前的失败来自旧 `packages/tool-agent-team/lib/index.js` 不含 `team_worker`。源码没有修改，只重建就使全套恢复通过，因此不把首轮的 209 条失败归因于本次实现。

## 未验证范围与剩余风险

- 本次不发布、不重启用户正在使用的 Host、不更换 profile，不以隔离浏览器通过代表用户当前 GUI 已部署此代码。
- 真实账号、付费模型、所有原生成功/失败/超时/停止/steer 组合没有完整重跑。本次新增的是隔离 Claude hook 探针，不替代生产 Worker 全组合验收。原验收引用的一些忽略区原生探针在当前 checkout 不存在；归档材料只作为历史证据。
- 当前检查在 macOS arm64、Node 22.23.4、OAR 0.95.1、相邻 Harness `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` 上执行；未做 Linux/Windows 全组合，也未做本次发布安装认证。
- 本报告列经过主审复现或交叉核实的发现，不直接采用子代理的严重度。已排除“`worker_stop_unconfirmed` 在 running 下抛出”的候选：running 分支先返回 pending。卸载逐条 5 秒等待是维护文档明确的行为，不擅自增加“整次卸载最多 5 秒”的要求。
- 原 spec 的工具可见性、公开结果范围和权限默认值已有票据补充决定；按最终交付状态核对，不把已关闭的 Claude steer、只向发起者回传答案等已明确取舍记成漏实现。

## 审查记录

- 设计来源：工作项 `README.md`、`spec.md`、全部 6 张票据，以及 `materials/04-inspect-interface-review.md`、`materials/06-claude-precheck.md`、`materials/06-independent-review.md`。
- 规范来源：根 `AGENTS.md`、`.scratch/AGENTS.md`、`docs/README.md`、`docs/development/start-and-checks.md`、Host authority、tools/preset、collaboration tools、frontend accessibility；跨仓库检查遵循相邻 Harness `AGENTS.md`，并核对实际安装的 OAR 源码。
- 分工：三个只读子代理分别检查规格/工具/Client、运行时正确性、诊断边界/标准；另一个研究代理调查 Claude 原生替代方式。主审负责 Host/ledger、完整检查、截图检查、候选复现和单份报告。
- 开始时工作区干净，无未提交或未跟踪实现。审查只新增本报告及忽略区验证材料；没有修改生产代码、原设计、验收勾选或完成状态。
- 已排除范围内夹杂的快捷键、剪贴板、一般 compaction、session trace viewer、通用文档/注释清理等独立功能；共享文件只检查 Worker 相关变化及其必要调用关系。测试执行仍覆盖完整当前树。
- 本报告已提交到对应工作项 PR：重新打开 [Contexera/dsh-agent-team#80](https://github.com/Contexera/dsh-agent-team/pull/80) 后发布评论 [#issuecomment-6764397027](https://github.com/Contexera/dsh-agent-team/pull/80#issuecomment-6764397027)。该 PR 原本只含设计文档，评论已说明审查针对取代它的实现区间。
- 审查期间工作区出现一个与本次无关的未提交修改（`packages/agent-team/tests/subscription-host.spec.ts`，webhook 恢复用例），不是本次审查产生，未触碰也未纳入结论。

### 比较范围内提交

以下完整列出范围，列出不表示把无关功能纳入本工作项审查：

```text
7624055a feat: delegate one Worker from a Member session
2630ac93 feat: report a Worker run in the Thread it was delegated from
5ebaf2ba fix: pull the Host catalog once before refusing a Member Session
ac20d81c docs: require re-deriving an Unreleased bullet from the current code
305a3f0e docs: record the composer drop and the centred activity rows
e1678cf3 docs: extend the docs maintenance duty to a change that adds a fact
9423d081 chore: drop the comment budget and the unused scratch staleness report
df9084de fix: end the grant's Main stream Attention when ownership is withdrawn
5e08d54a feat: stop one delegated Worker run without touching its siblings
653a44e5 fix: report a refused message copy on the card
42ee923c fix: name the Project on a published subscription event
cd06265d test: wait for the Host to confirm a Member before a browser read
e4ab572f fix: steer Team wakes to the next step instead of the next turn
8e87b603 fix: read the Member context budget from the provider count
547cec88 feat: read one Worker run's native diagnostic by its Team number
a79c7211 feat: add one instruction to a running Worker turn
58752166 fix: give the Agent editor's record blocks their own group level
955fdd0c fix: restore the member session trace viewer
f9134d6d feat: read Claude Worker records and gate Worker surface on the Host switch
1acc53dc fix: state reminders as personal in the owner guidance
d16a2bf3 docs: describe Worker exposure and composed acceptance
5ecd0f36 test: verify subscription-driven worker delegation end to end
a36a4526 fix: give the verifier and the accountable the acceptance boundary
36749dfc fix: decide the build scripts the Worker dependency pulls in
303fc403 fix: tolerate neutral slots across team tools
77e9cec7 feat: give Team mode its own keyboard commands
4af67bb2 fix: judge a Worker record location under either path separator
```
