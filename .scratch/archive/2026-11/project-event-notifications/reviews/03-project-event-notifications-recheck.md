# Review 03 — project-event-notifications 七项修复复审

**Conclusion:** Pass
**Work item:** `.scratch/archive/2026-11/project-event-notifications/`
**Ticket:** Whole work item，本轮仅复核 Review 02 的 F1–F7
**Compared:** `c6ae99af8c22af1bc094a7693ebbff4f6cfc06d6` → 当前未提交修复
**Commits:** None
**Reviewed:** 2026-11-04

用户要求由子代理修复，再由主代理复审。三名子代理分别负责原始输出、调度器、Host 与账本；主代理检查代码、退回问题、集成改动并执行最终验证。本轮包含 22 个实现、测试和维护文档文件，未提交。

基线已包含此前另行完成的订阅只读界面调整。本次没有 Client 源码变更；Review 02 原先比较的五笔提交仍以该报告为准。本报告不重新认定整个归档工作项的验收状态。

22 个文件按相对路径排序，以 `路径 + NUL + 文件内容 + NUL` 计算的 SHA-256：`0545387f95d96a10236e8e985e5c63124e3e89efffd1a98a8435aed7147aa920`。两个 review 文件不计入此摘要。

## Findings

No confirmed findings.

F1–F7 的新实现和回归测试通过复核。旧账本请求信息缺失和跨平台实测范围见下文限制。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| F1：按原始字节验证 UTF-8，保留合法 U+FFFD | Met | `subscription-runner.ts` 从公开 `stdout.spillPath` 有界读取原始字节，交给 fatal decoder。通过固定 ASCII 前缀和一字节 collector 阈值保证空输出也生成 spill；Team 的脚本输出上限仍为 65,536 字节。覆盖非法 FF/FE、合法替换字符、跨 chunk 的多字节字符、65,536/65,537 字节、超时及文件清理。真实 Linux 沙箱探针确认非法输入拒绝、合法替换字符接受、工作区内写入成功、工作区外写入失败，五次运行的 spill 均删除。 |
| F2：迟到的旧版本结果不修改当前版本的失败统计 | Met | `index.ts:3046` 的统计清理接收来源 revision；timer 的完成结果及耗尽重试的 webhook 失败也核对当前 revision。旧版本成功不清除新版本失败数、不移动其成功时间；旧版本失败不增加新版本失败数。事件和运行记录继续保留来源版本。 |
| F3：时钟回拨时，部分使用的发布窗口不会重复获得额度 | Met | `subscription-runtime.ts` 逐条保存仅增加 `publishedInWindow`，不把持久窗口写回当前时钟。新增未来窗口已用 10 条、回拨后使用余下 10 条、时钟追平后仍不得额外发布的回归。 |
| F4：脚本结束后释放执行位，退出仍等待发布完成 | Met | `subscription-runtime.ts:370` 在释放执行位及接纳排队任务后等待发布；完整 Promise 仍由退出流程跟踪。测试覆盖发布被阻塞时第五个脚本启动，以及发布拒绝时正常退出。 |
| F5：新提交的创建和更新可在文件或凭据撤回后原样重试 | Met | Host 在文件读取和凭据预检前查找已提交操作；仍先检查当前调用方权限。账本保存最小请求意图，脚本内容复用原快照。测试覆盖创建和更新的路径文件删除、凭据撤回、改变来源拒绝，以及 Owner 被撤回后重试拒绝。历史缺失信息的情况见下文。 |
| F6：同一 requestId 改变创建基线策略必须拒绝 | Met | create 的持久请求意图记录并比较 `baseline`，省略值规范为 `current-output`；不再用旧 baselineIds 代替请求选项。Host 和账本回归均覆盖碰撞。 |
| F7：首次启用 webhook 的更新重试说明地址已无法取回 | Met | `ledger.ts:1581` 根据操作前一 revision 的订阅状态判断是否生成地址；首次启用的更新重试返回 `webhookAddressGone: true`。普通更新保留地址时不返回该标志，同一毫秒的创建和更新也有回归。 |

维护文档已同步：Host authority 中英文、Team tools 中英文、tool 包 README 中英文。操作 schema 的新增请求意图为可选字段，旧记录读取和投影测试通过。

## Checks run

检查环境：本机 Linux/WSL；相邻 Harness 为 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。

| Command or check | Result |
| --- | --- |
| `npm run build` | 通过；主工作区完整构建 |
| `npm run typecheck` | 通过；最后一次仅改 webhook 测试执行器后，另跑 `tsc -p packages/agent-team/tsconfig.json` 也通过 |
| `npm test` | 最终 160 文件通过、1 跳过；1976 tests 通过、1 跳过。包含 facades、docs、core-skills、boundaries、versions、comments 检查 |
| `npm run lint` | 最终退出码 0；保留已有 warnings |
| `node scripts/audit-ui-parity.mjs` | 通过；0 errors、0 warnings |
| `npm run check:artifact` | 通过；97 个运行时相对导入全部可解析 |
| `npm run test:browser` | 11/11 通过，147 张截图 |
| `view_image` 检查截图 | 已查看桌面和 390×844 订阅列表、手机运行记录、桌面提醒、手机空提醒及退出 Team 后的普通 DSH 页；未发现新增布局阻断 |
| `node --import tsx artifacts/review/verify-runner.mts`，隔离工作区 | 真实 LocalSandboxProvider、SandboxBashExecutor，确认完整沙箱生效；非法 FF/FE、合法 U+FFFD、工作区写入边界和五份 spill 清理均符合预期 |
| `git diff --check` | 通过 |
| Harness 工作区最终核对 | 与开始时一致，只保留原有未跟踪的 `packages/external-agent-team-RZayq3/`；临时浏览器文件已清理 |

合流检查发现旧测试执行器没有提供原始 spill，以及测试仍用旧命令查找运行记录。这些测试已适配公开执行结果及实际包装命令，原来的行为断言保留。webhook 测试临时目录在服务退出完成后清理。最终全量运行通过。

## Unverified scope and residual risk

- **旧请求的信息限制：** 旧操作没有保存原始脚本路径时，无法证明某个路径重试与原请求相同。此类重试明确报错并给出已提交订阅引用，调用方应读取该引用确认结果；不会猜测路径或重新试运行。旧记录仍能正常加载。新写入的 create/update 已保存必要意图，覆盖文件删除和凭据撤回的重试。
- **平台范围：** 本轮真实执行验证覆盖 Linux/WSL。Windows/pwsh 和 macOS 的真实沙箱执行未验证；PowerShell 包装仅作静态代码核对，不能据此认定该执行路径通过。
- **执行器条件：** 依赖当前公开 collector 的完整原始 spill。缺失或不可读取时拒绝运行结果；当前 Harness collector 在超过 spill 上限时撤销文件路径，已核对对应实现。其他自定义 Shell 实现需要满足相同条件。
- 本轮没有重新执行真实模型人工验收、性能矩阵或长期运行测试；不扩大 Review 02 已声明的验收范围。
- 常规截图和检查日志留在忽略的 `artifacts/browser/`、`artifacts/review/`，未加入归档截图集。清理这些目录不会改变上述已记录结果。

## Review record

- Spec sources：Review 02 F1–F7；归档 `spec.md` §4.4、§4.8 和 ticket 02 的相关约束，均与当前源码、测试及维护文档核对。
- Standards sources：根 `AGENTS.md`、`.scratch/AGENTS.md`、`docs/AGENTS.md`、`docs/README.md`、`docs/development/start-and-checks.md`，以及相邻 Harness 的公开 Shell 类型、collector 和沙箱实现。
- Uncommitted and untracked changes included：21 个已跟踪文件的未提交修改，加新回归文件 `packages/agent-team/tests/subscription-retry.spec.ts`。保留 Review 02，新增本报告；未改工作项 README、原工单或历史报告。
