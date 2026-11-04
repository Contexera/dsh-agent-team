# Review 02 — project-event-notifications 修复复审

**Conclusion:** Changes needed
**Work item:** `.scratch/archive/2026-11/project-event-notifications/`
**Ticket:** Whole work item，重点复核 Review 01 的问题及后续修复
**Compared:** `07f92170c5e86eb496b8947311537579a88899ae...d64114716b9e1eddca0152a289b0299103459aad`
**Commits:** `0da6a50`、`4822848`、`ac72f8d`、`13f6b71`、`d641147`；范围内另有 `d2f11c6`，仅移动 avatar 归档，排除。
**Reviewed:** 2026-11-04

用户确认本轮复审上述五笔修复，未提交的界面改动不计入结论。以下位置均对应固定终点 `d641147`，不能用正在变化的工作树行号直接替代。

验证使用从 `git archive d641147` 建立的独立副本 `/home/yu/projects/dsh-agent-team-review-3x_9ndpw`，依赖复用本机安装，Harness 为 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。实现、工单状态和工作项 README 均未修改。

## Findings

以下七项均为已确认问题。F1、F2、F5、F7 是相关修复仍未覆盖的情况；F3、F4 是新实现的剩余边界；F6 是本轮新增的参数碰撞回归。严重性均为中：需要修改，但不按常规输入必然发生的数据损坏或安全事故定级。

### F1 — 中：非法 UTF-8 输出被接受，不同原始事件 ID 会合并

**Location:** `packages/agent-team/src/subscription-runner.ts:264,277-280`；`packages/agent-team/src/subscriptions.ts:168`。
**Evidence:** 用真实 `SandboxBashExecutor` 分别执行 `printf '{"id":"a\377","title":"A"}\n'` 和 `printf '{"id":"a\376","title":"A"}\n'`。原始 stdout 分别包含 `0xFF` 和 `0xFE`，直接调用 `parseSubscriptionOutput(raw)` 都拒绝；生产 runner 却都返回成功，事件 ID 都是 `a�`。执行器先解码为字符串，runner 再编码，原始字节已无法恢复。
**Impact:** 原本应整次拒绝的运行被接受；两个不同的非法 ID 被改成同一个 ID，后续按订阅去重时会丢弃其中一个。合法 U+FFFD 的误拒已经修复，但严格编码校验仍缺失。
**Basis:** ticket 02 第 5 项、spec §4.4 要求按原始字节校验 UTF-8；`docs/architecture/host-authority.md:221` 仍声明字节级校验。
**Suggested fix:** 在 Team 自有执行封装中取得 stdout 原始字节并交给 fatal decoder，同时保留合法 U+FFFD 的接受行为。若当前 Harness 公共接口无法提供，明确记录接口限制并确认契约调整；不要重新引入“出现 U+FFFD 就拒绝”的判断。

### F2 — 中：旧版本事件成功接受会清除新版本的连续失败

**Location:** `packages/agent-team/src/index.ts:3745-3747,3334-3337,3366`；`clearSubscriptionFailuresLocked` 位于 `index.ts:3044`。
**Evidence:** Host 探针创建 r1 后更新为 r2，将当前 checkpoint 设为连续失败 2 次，再通过生产 `acceptFreshEvents` 接受一批 r1 结果。事件正确记录为 r1，但当前失败数从 2 变成 0。暂存 webhook 的新路径也把 received source 传入这个函数，随后无条件清零同一份 checkpoint。
**Impact:** r2 脚本已经连续失败两次时，r1 暂存批次的迟到成功会清除失败记录；r2 下一次再失败也不会达到三次自动暂停条件。
**Basis:** ticket 02 第 6 项、spec §4.8：迟到结果不得污染新版本统计。
**Suggested fix:** 接受成功后的统计更新携带来源 revision，仅在来源与当前 revision 一致时清除当前失败数；明确 last-success 使用同一版本边界。事件本身继续按接收版本接受和发布。

### F3 — 中：时钟回拨且窗口尚有余额时，发布额度仍会重复发放

**Location:** `packages/agent-team/src/subscription-runtime.ts:456-473`，尤其第 473 行。
**Evidence:** 调度器探针将持久窗口设为 M、已发布 10 条，当前时钟设为 M−1。第一轮正确只发布剩余 10 条，但计数保存时把窗口写回 M−1。时钟回到 M 后又重置额度，再发布 20 条。探针观察到新增发布 30 条，连同原来已发布的 10 条，同一 M 窗口共获 40 条额度。现有回归测试只覆盖未来窗口已经用满的情况。
**Impact:** 本轮增加的“窗口只向前推进”保护在部分使用的窗口上失效，仍可能突破每订阅每分钟 20 条的限制。
**Basis:** ticket 02 第 7 项；本轮 `4822848` 的时钟回拨修复目标。
**Suggested fix:** 发布计数保存时保持现有窗口，不能用较早的当前分钟覆盖它；仅在明确开启新窗口时更新窗口编号。补充窗口还有余额时回拨、再追回原分钟的测试。

### F4 — 中：脚本完成后仍占用运行位等待全部事件发布

**Location:** `packages/agent-team/src/subscription-runtime.ts:359-370`。
**Evidence:** 调度器探针让五个订阅到期，前四个脚本完成且已保存下一次到期时间，再让发布调用等待。此时四个运行位仍全部占用，第五个订阅一直排队；解除发布等待后，第五个才开始执行。原因是 `running.delete()` 被放到 `await publishPass()` 之后。
**Impact:** 发布缓慢或阻塞会阻止其他脚本及人工试运行开始，即使实际上已经没有脚本在执行。一次运行还会等待全部订阅的 publication pass，影响超出该订阅自身。
**Basis:** ticket 02 第 4、9 项；spec §4.3 的四个脚本执行位，以及运行与后续发布分离的约定。
**Suggested fix:** 到期状态持久化后释放脚本运行位，发布独立继续；用单独的到期消费标记保护尚未完成的状态保存，避免重新引入同一到期点重复执行。

### F5 — 中：已提交请求的重试仍依赖当前凭据和脚本文件

**Location:** `packages/agent-team/src/index.ts:4279-4293,4321-4337`。
**Evidence:** Host 探针成功创建一个引用 `GH_TOKEN` 的订阅，随后移除该凭据，再原样重试同一 requestId。调用报“no configured credential”，没有返回已提交对象。代码还在查询已提交请求之前重新读取 `scriptPath`；文件被删除会读取失败，内容改变会造成请求碰撞。后两个文件场景为代码检查，未运行 Agent 文件探针。
**Impact:** 创建或更新已经提交、但响应丢失时，调用方可能仍无法获知成功结果。新代码避免了通常情况下的第二次试运行，但尚未完整恢复已提交请求。
**Basis:** spec §4.5 的丢响应后返回已提交对象；Review 01 的 requestId 重试问题。
**Suggested fix:** 当前身份校验保留；已提交请求先按持久化的原始请求意图识别和校验，再返回原结果。凭据可用性、脚本文件读取和执行预检只用于尚未提交的新操作。

### F6 — 中：更改创建基线选项仍被当作同一请求成功重试

**Location:** `packages/agent-team/src/ledger.ts:1458-1466`；调用处 `packages/agent-team/src/index.ts:4291-4292`。
**Evidence:** Host 探针先用 requestId X、`baseline: 'current-output'` 创建，脚本输出 ID `a`；随后以同一 X 改为 `baseline: 'ignore-history'`。第二次返回原订阅成功，已知 ID 仍为 `['a']`，没有报告参数碰撞。新预检忽略了原始 baseline 选项，并直接把比较用的 baselineIds 替换成旧值。
**Impact:** 同一 requestId 携带不同语义的创建请求被静默接受。调用方无法分辨新的基线选择没有执行；绕过了账本原有对不同 baselineIds 的碰撞检查。
**Basis:** 仓库 requestId 契约要求相同 ID、不同写入参数拒绝；`subscription-ledger.spec.ts` 有基线参数碰撞测试，但只覆盖账本直调。
**Suggested fix:** 持久化并比较创建时的基线策略或原始请求指纹；试运行派生的 ID 列表可以复用已提交值，但不能据此忽略调用方显式选项。

### F7 — 中：update 首次启用 webhook 后重试，仍不说明地址已无法取回

**Location:** `packages/agent-team/src/index.ts:4337`；公开结果说明在 `types/requests-results.ts:1394`、`packages/tool-agent-team/README.md:15`。
**Evidence:** Host 探针先创建 timer-only 订阅，再用 requestId X 更新为 `webhook: true`。首次响应带完整地址；原样重试 X 时，既没有 `webhookAddress`，也没有 `webhookAddressGone`。update 的新重放路径固定传 `addressArmed=false`。
**Impact:** 若首次响应丢失，页面和 Agent 都不会收到新加的“地址无法取回，请重置”说明；这一修复只覆盖了 create/reset，未覆盖同样会生成地址的 update。
**Basis:** 新公开结果契约及 tool README 明确包含 update；Review 01 的地址重试说明问题。
**Suggested fix:** 从持久化的 update 操作判断本次是否首次启用了地址，重试时据此返回 `webhookAddressGone: true`。保留旧地址的普通 update 不应返回该标志。

## Acceptance criteria

编号对应每张工单中 checkbox 的原始顺序。Met 表示代码核对及本次现有测试支持该项；不表示另做过跨平台或真实模型人工验收。

| Criterion | Result | Evidence |
| --- | --- | --- |
| 01-1 提醒 create/list/cancel 与账本重放 | Met | member-reminder-ledger、工具 action 测试通过 |
| 01-2 Inbox 唤醒及运行中的 steer | Met | member-reminder-host、delivery 测试通过 |
| 01-3 occurrence 消费、重投与替换 | Met | member-reminder-delivery、ledger 测试通过 |
| 01-4 UTC+8 cron 与恢复补发一次 | Met | member-reminders 测试通过；新增 2096→2104 用例 |
| 01-5 50 个提醒与 10 分钟下限 | Met | member-reminders、ledger 测试通过 |
| 01-6 Member 暂停、归档、移除、Session 变化 | Met | member-reminder-ledger、host 测试通过 |
| 01-7 Human 查看和取消 | Met | team-member-reminders client 测试通过 |
| 01-8 工具注册与双语文档 | Met | 工具及文档检查通过 |
| 02-1 无 Session 沙箱根目录 | Met | runner 检查通过；本次编码探针实际使用 Linux SandboxBashExecutor；其他平台按票内约定另验 |
| 02-2 生命周期、接受和发布入账及 owner 权限 | Met | subscription-ledger、host 测试通过 |
| 02-3 快照、试运行、凭据及独立基线初始化 | Partial | 常规路径通过；F5、F6 的重试边界未满足 |
| 02-4 超时、输出上限、四个运行位及排队 | Partial | 现有 runner/runtime 测试通过；F4 的发布等待占用执行位 |
| 02-5 原始 UTF-8、逐行校验及跨订阅去重 | Partial | BOM、JSON 等测试通过；真实执行器探针确认 F1 |
| 02-6 固定运行版本且不污染新版本统计 | Partial | held 事件版本归属已修复；F2 的统计清零仍错误 |
| 02-7 接受、20/min、500 上限及恢复发布 | Partial | 常规队列与恢复测试通过；F3 的时钟回拨边界仍超额 |
| 02-8 环境清除及凭据显式注入 | Met | subscription-runner、subscriptions 测试通过 |
| 02-9 执行位满时等待和合并到期 | Partial | 常规排队通过；F4 会把发布等待算作执行占用 |
| 02-10 外部事件记录与 owner 通知 | Met | ledger、host、Main stream 测试通过 |
| 02-11 启动随机延迟、补跑及数量频率限制 | Met | subscriptions、runtime、host 测试通过 |
| 02-12 Project 归档停止运行 | Met | 终态及 Host 测试通过 |
| 02-13 生命周期 Main stream 记录和操作者 | Met | ledger/client 测试通过；reset 文案已修复 |
| 02-14 九工具及双语维护文档 | Met | 工具注册、core-skills、docs 检查通过 |
| 03-1 50 条持久化运行记录及字段 | Met | subscription-runs 测试通过 |
| 03-2 owner 输出、其他成员摘要 | Met | subscription-runs 的读取裁剪测试通过 |
| 03-3 接受为成功时点及持久失败数 | Partial | 常规原子更新测试通过；跨版本统计边界见 F2 |
| 03-4 三次失败自动暂停和 resume 规则 | Partial | 常规失败与恢复通过；F2 会清除新版本失败数 |
| 03-5 update 试运行、保留基线、revision 冲突 | Met | subscription-host/runs/ledger 测试通过 |
| 03-6 独立失败投递及版本重放 | Met | runs/host/client 测试通过；页面现在传 received/current |
| 03-7 test 不发布、不改基线、保留记录 | Met | subscription-runs 测试通过 |
| 03-8 删除订阅清理运行记录 | Met | subscription-runs、host 终态测试通过 |
| 04-1 数量、触发、创建者、时间与暂停原因 | Met | client 测试通过，桌面/390×844 列表截图已查看 |
| 04-2 展开 stdout/stderr | Met | client 测试及 browser 运行记录流程通过 |
| 04-3 试运行后保存、非乐观写入、失败保留输入 | Partial | 常规表单流程通过；丢响应后的恢复仍受 F5、F7 影响 |
| 04-4 三态、键盘、弹窗及两档截图 | Met | client 测试与 browser 12/12；查看两档列表、表单、地址弹窗和运行记录截图 |
| 04-5 Main stream 事件卡片 | Met | team-main-stream client/browser 通过 |
| 04-6 双语前端文档 | Met | 两版 interval-only 旧说明已修改，docs 检查通过 |
| 05-1 公网配置与缺失拒绝 | Met | webhook-settings/host 测试通过 |
| 05-2 durable 202、恢复与终态屏障 | Met | host、webhook-entry、runs 的故障恢复测试通过 |
| 05-3 独立入口、token 哈希及一次性地址 | Met | webhook/host/ingress 测试与 browser 通过；update 重试说明另见 F7 |
| 05-4 状态码及持久队列 10 条上限 | Met | 入口/host 测试通过；维护文档已补 431/415/400 |
| 05-5 stdin、header 白名单及长度拒绝 | Met | subscription-webhook/entry 测试通过 |
| 05-6 双触发、积压批次保存及只重试接受 | Met | host 的 held→update→accept 用例通过，事件标注 r1 |
| 05-7 稳定 admission ID | Met | host/runs 重试及重放测试通过 |
| 05-8 独立失败集合及页面版本重放 | Met | host/runs/client 测试通过 |
| 05-9 退避、失败次数、暂停和恢复 | Met | host/runs 测试通过；受控 jitter 的额外设计要求仍见限制 |
| 05-10 重置旧地址与保留已接受投递 | Met | host 及 webhook browser 流程通过 |
| 05-11 触发方式及一次性地址弹窗 | Met | webhook browser 通过，两档地址截图已查看 |
| 06-1 核心技能内容和示例 | Met | 技能及引用文件静态核对，core-skills 检查通过 |
| 06-2 persona 主动建立提醒和订阅 | Met | patch 与 shipping 测试通过 |
| 06-3 core-skills 检查 | Met | 本次 npm test 实际执行并通过 |
| 06-4 真实 GitHub CI 订阅唤醒与 Session 证据 | Not verified | README 有事件及 Session 日志说明；本次未取 profile 日志、未重新访问 GitHub |

## 上一轮问题复核

| 问题 | 结果 |
| --- | --- |
| 超过 24.8 天的提醒定时器溢出 | 已修复；delay 有上限，新增远期定时器测试通过 |
| 2 月 29 日可能超过五年搜索范围 | 已修复；九年范围与 2096→2104 测试通过 |
| reset 在 Main stream 被显示为删除 | 行为已修复；client/browser 通过 |
| held 批次被标注成当前版本 | 事件归属已修复；统计清零另见 F2 |
| 普通顺序 requestId 重试重新试运行 | 已避免普通已提交重试执行脚本；剩余边界见 F5–F7 |
| 暂停/满积压每秒保存 dueAt | 已修复为到期后推进；现有测试通过；publication 窗口仍有自身正常写入 |
| settle 等待期间重复执行到期点 | 正常保存路径已修复；执行位释放边界见 F4 |
| 合法 U+FFFD 被拒绝 | 已修复；原始非法字节问题见 F1 |
| interval 因余量不足的 deferred 计失败 | 保持原实现；ticket 02 第 7 项及 spec §8 明确“会超过 500 时整批拒绝并计失败”，不再把它单独判为产品语义缺口 |
| 归档 Project 订阅列表读取报错 | 已修复；读允许、写拒绝测试通过。运行记录仍按既有归档清理规则删除，不声称保留历史输出 |
| 表单旧文档、私有表数、package README | 相关条目已修复；docs 检查通过 |
| 页面 replay 无版本选择 | 已修复；received/current 客户端用例通过 |
| comment budget 零余量 | 已修复；实测 4187/4315 |
| 死导出、重复重试常量、源码 spec.md 引用 | 已删除或改为维护文档引用 |
| 431/415/400 未进入维护契约 | 已补两版维护文档；归档 spec 保持原状 |
| 并发 publication 重复花额度 | 按订阅串行已修复；时钟回拨部分使用窗口见 F3 |
| 单 Host、跨订阅总预算、retry jitter | 单 Host 已写入维护文档；运行时检查/告警、跨订阅预算及 jitter 未实现，继续作为已知未闭合设计项 |
| 纯简化建议 | 本轮未要求全部实施，也不把未采纳建议自动列为缺陷 |

## Checks run

所有项目检查在固定副本执行。临时探针仅加在副本中，正式全量通过的那次运行不包含这些探针文件。

| Command or check | Result |
| --- | --- |
| `npm run build` | 通过 |
| `npm test` | 最终运行 159 文件通过、1 跳过；1964 tests 通过、1 跳过；包括 facades/docs/core-skills/boundaries/versions/comments |
| `npm run typecheck` | 固定终点失败：新增 `team-main-stream.client.spec.tsx:49` 两条 TS2322，`reset.kind` 被推断为 string。此问题已在范围外 `1b316d1` 修复，不列为待办 |
| `node /tmp/scratch-review-3x_9ndpw/typecheck-baseline.mjs` | Compiler API 保持其余终点代码，只把该测试换为 07f9217 版本，Client 诊断从 2 条归零，确认归因 |
| `node /tmp/scratch-review-3x_9ndpw/typecheck-postfix.mjs` | 同一方式替换为 1b316d1 测试，Client 诊断归零，验证范围外修正 |
| `npm run lint` | 通过，退出码 0；存在既有 warnings |
| `node scripts/audit-ui-parity.mjs` | 失败：subscriptions.module.css 使用未定义的字体变量。07f9217 已有相同行，修复范围无此 CSS diff，属于已有问题 |
| `npm run check:artifact` | 通过；400 项，97 个运行时相对导入全部可解析 |
| `git diff 07f9217...d641147 --check` | 通过 |
| `npm run test:browser` | 12/12 通过，153 张截图 |
| `view_image` 检查 browser 截图 | 已查看 desktop/390×844 订阅列表、手机表单、两档 webhook 地址、手机运行记录及普通 DSH 恢复页；未发现新增布局阻断 |
| `./node_modules/.bin/vitest run packages/agent-team/tests/review-retry.probe.spec.ts` | 4 项观察探针通过：凭据撤回后已提交重试报错；改变 baseline 静默成功；启用 webhook 的 update 重试无 gone 标志；r1 接受清除 r2 失败数 |
| `./node_modules/.bin/vitest run packages/agent-team/tests/review-runtime.probe.spec.ts` | 2 项观察探针通过：部分窗口回拨后再获额度；发布等待占满四个执行位 |
| `./node_modules/.bin/vitest run packages/agent-team/tests/review-utf8.probe.spec.ts` | 真实 Linux sandbox bash 探针通过，确认两种非法原始 ID 都被接受为 a� |

探针的“通过”表示断言观察到了上文缺陷，不代表产品行为正确。关键输入、状态变化和输出已经写入各 finding，临时文件不是唯一证据。

## Unverified scope and residual risk

- 本次固定终点之后，`1b316d1` 除保存 Review 01 外还给 `reset` 增加了 `MainStreamSeedEntry` 类型标注。提交标题不能证明它只有文档变化；本报告单独检查了该源码差异。当前未提交 UI 改动及后续提交整体均未审查。
- 最早一次临时副本构建因 Harness 的 symlink/真实路径不一致失败，副本移到 Harness 的真实相邻目录后构建通过；最早一次 npm test 缺少被 gitignore 的 `.generated-harness`，补齐本机同名 marker 后继续。均为验证副本准备问题。
- 第一次全量测试曾与 browser 的清理构建重叠，出现构建文件暂时不存在等 14 个失败；构建完成后在同一固定源码上重新运行，1964 项全部通过。该失败未归因为产品缺陷。
- macOS、Windows、pwsh 的真实沙箱 enforcement 仍按 ticket 02 约定留待发布前验证。本次真实执行器探针仅支持 Linux/bash 结论。
- ticket 06 的真实 GitHub CI 唤醒没有在本次重演；本地 README 的验收说明不替代 Session 日志原文。
- spec §4.4 的跨订阅条目/字节总预算、§4.5 的受控 retry jitter 仍没有实现；§7 的单 Host 部署约束已有维护文档，但未找到启动前检测或运行时告警。它们是 Review 01 已指出的剩余设计项，本轮没有证据证明获得了取消要求的批准。
- 现有字体变量问题仍使 UI parity gate 失败；不应因为它早于本轮就把该检查记为通过。
- 子审查还提出 checkpoint 保存故障、在途并发重试、发布后计数保存故障等候选；本次未对它们完成独立时序/故障归因，不作为已确认新发现。也未把无影响的注释、透传及重命名建议列入必改项。
- 临时检查日志和截图保存在上述独立副本及 `/tmp/scratch-review-3x_9ndpw/`；未复制进归档，也未提交。后续清理临时目录不改变本文记录的输入、结果及复现步骤。

## Review record

- Spec sources: 本工作项 README、`spec.md`、issues 01–06（状态均 complete）；没有 DESIGN.md，设计意图来自 spec.md；上一轮记录为 `reviews/01-project-event-notifications.md`。
- Standards sources: 根 `AGENTS.md`、`.scratch/AGENTS.md`、`docs/AGENTS.md`、`docs/development/start-and-checks.md`、`docs/architecture/{host-authority,package-ownership}.md`、`docs/frontend-design/components.md`，以及对应源代码和测试。
- 方法：Spec / Correctness / Standards and simplicity 三条只读子审查并行；主审复核候选、运行现有检查及七项边界观察探针。子审查意见经核实和取舍后汇总，未直接照搬。
- Uncommitted and untracked changes included: 不包含。启动及结束时分别检查 git status；并行变动涉及订阅页、Member 界面、文档和 browser 脚本，均排除。主工作区只新增本报告，没有修改此前报告、实现、工单状态或 continuation README。
