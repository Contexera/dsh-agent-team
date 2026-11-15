# 04 delivery record — 2026-11-14 Reeve

实现落在 `feat/team-manager-session`（worktree `/data/repos/dsh-agent-team-mgmt02`），三个本地提交：

| commit | 内容 |
| --- | --- |
| `08bfd2a` | Host 写路径、账本 `authorize` 钩子、`activateMember` 重读守卫、三个 manager 方法、工具 schema/渲染/注册、`cordis.patch.yml` 的 manager `only` 扩到五个工具 |
| `ca2cae5` | `manager-writes.spec.ts`（10 条）、`optional-slot-matrix` 三行、`scripts/e2e/team-manager-writes.e2e.ts`、受影响的既有断言 |
| `84044c4` | `docs/architecture/tools-and-preset.md(.zh)`、两份 tool README、`dsh-release-compatibility.md(.zh)`、CHANGELOG |

## 票面逐条怎么落的

1. **一条完整责任路径。** `team-manager-writes.e2e.ts` 在真实 Web 组成里经 live executor 依次调用 `member_create` → `project_create` → `project_owner add`，断言成员 `availability: active`、Project 纳入该成员、owner 责任原文，并用 `view()` 投影与侧栏/Project 对话框核对同一条记录；截图 `artifacts/browser/team-manager-writes/`。自然语言判断与 dev profile 验收属 Human 步骤，见下。
2. **输入与资格门槛。** `manager-writes.spec.ts` 覆盖空白 description / 空白共同目标 / 空白责任（都不写入）、模型路线四种失败（未知 provider、未知 model、无效 effort、目录不可读，各自原因不同）、suspended 成员不能在建时纳入但可被授予 owner、archived 成员两处都被拒、重复授予被拒、责任超 2,000 被拒。
3. **幂等、模型目录与审计。** 同一 requestId + 同参数重放答回原 `operationId` 且成员数不变；同 id 改参数得到 collision 且不写第二条。模型校验位于 `!ledger.hasCommitted(requestId)` 之后，所以目录随后变化时重放仍拿原回执。账本 actor 仍是 Human。
4. **撤权与激活并发。** 隔离账本用例直接测 `authorize` 缝：排队后撤权 → 不写入；已接收的重放 → 不收尾重查。被替换的 manager 世代调用三个工具都被拒。激活途中归档的用例断言没有活句柄留下（`ctx.agents.get(sessionId) === undefined`）。
5. **部分成功与未知结果。** 结果契约定为 `outcome: 'committed'` 一种：拒绝在 append 前抛出且什么都不写；append 之后失败（激活/通知/投影）由 `commitManagerWrite` 用同一 requestId 重放成原回执，所以「已提交但运行失败」与「结果未知」都答已提交 + 回执，附激活诊断；续做只做剩余步骤。
6. **persona 与人工验收。** persona 文本在 02 已含确认原则与数据红线，本次未改；Host 不把 `ask_user_question` 回执当写凭证（manager 工具自身每次执行重新授权）。dev profile 人工验收未做，需 Human。
7. **文档。** 工具契约、Host 权限边界、幂等与部分成功语义写入 `docs/architecture/tools-and-preset.md(.zh)` 与两份 tool README；`dsh-release-compatibility` 的工具计数改为十五个。

## 产品意图裁定（实现时定下，票面未写）

- `requestId` 是工具的可选显式参数：省略时 Host 按 `agent.id + callId` 派生（无法按 id 重试，只能读回）。
- `outcome` 只有 `'committed'`；拒绝是带原因的抛出。
- owner 资格沿用账本规则（enabled/suspended + 参与目标 Workspace），不另收窄到 runtime active。
- `member_create.description` 与 `project_create.description` 在 manager 层非空；`project_owner.responsibility` 非空（≤2,000 由账本把着）。
- `project_owner` 只暴露 `action: 'add'`。
- `member_create` 不带初始 Project 参数（流程是先建成员再建 Project）。
- `updateMember` 的幂等顺序修正不在 04 范围，留给 05。

## 门禁证据

- `npm test`（含 generate:typert / check:facades / check:docs / check:core-skills / check:boundaries / check:versions / check:comments / vitest）：213 文件通过、2772 测试通过、1 跳过，exit 0。提交后在同一棵树重跑一次，数字一致。
- `npm run typecheck`：exit 0。
- `npm run test:browser`：28 文件 / 31 测试通过，205 张截图，exit 0。
- 修过两处自己造成的红：`optional-slot-matrix` 对 object 型槽位的中性值从 `''` 改成 `{}`（schema 拒绝字符串），`team-manager.e2e.ts` 的工具集断言原先按 `team_` 前缀过滤，会把三个不带该前缀的写工具漏掉。

## 未验证

- dev profile 人工验收（真实模型 + Human 账号）：步骤见 07 线程里同批整理的做法，04 的版本是「用自然语言要求建一个长期角色 → 确认它先读现状 → 确认 Project/owner/责任出现在界面」。
- 双平台 CI 未跑（本地提交，未推）。

## Vera 独立验收后的两项修正（2026-11-14 晚）

Vera 判定**不通过**：门禁全绿、五项自造探针全过、实现本身没找到行为缺陷，但票面有两处没兑现，且四条承重行为在交付测试里没有回归钉。

1. **票面第 6 行的数据红线没落**（persona 只有通用的「Protect data」「untrusted input」）。已在 `cordis.patch.yml` 的 `team-manager` persona 里补一段：`$DSH_HOME` 下只读写自身 `agent-team/manager/` 与经 `team_overview` 查实的成员私有资产、禁碰 Host 的 sqlite 与会话日志、memory/notes/工具结果不当作 Human 授权。persona 2374/4000 字符预算。同改写进 `docs/architecture/tools-and-preset.md(.zh)`（`danger-full-access` 工具面的红线由 persona 写成规则）。提交 `1111b84`。
2. **票面第 5 行的「已提交但激活失败」没有测试**。补三条（提交 `c846661`）：激活失败答 committed + 诊断、render 打印「Committed, but the Member is not live」、修复后同 requestId 重放拿原回执且只一条成员；目录事后不可读时重放仍拿原回执；三个写调用点各自「排队后撤权」被拒且不写账本。

**这三条的判别性我都当场变异验过**（改一处→跑→还原→确认字节回到交付态）：

| 变异 | 结果 |
| --- | --- |
| `activateMember` 失败后重抛 | 激活失败续做那条红，其余 12 条绿 |
| 把 `assertManagerModelRoute` 提到 `hasCommitted` 判断之前 | 目录变化重放那条红，其余 12 条绿 |
| 三个写调用点的 `authorize` 显式传 `undefined` | 排队撤权那条红，其余 12 条绿 |

**变异归属更正：** 删除整个 options 实参造成 `options.authorize` TypeError 的是 Reeve 的早期尝试，不是 Vera。Vera 在 `9b43187` 上独立省略三个调用点的 `authorize` 属性、保留 options 对象，得到干净的 1 failed / 12 passed；她同时指出显式 `undefined` 在 `exactOptionalPropertyTypes` 下未必通过类型检查。应以该无连带 TypeError 的形状作为独立证据，不把结构损坏导致的红当成授权检查的判别性。

顺带清了两条不阻塞项：`manager-writes.spec.ts` 未使用的 `AgentTeamRequestId` 导入（04 新引入的唯一一条 lint warning，lint 回到 110 既有项、0 error）；`project_owner` 的英文 description 把占位符写成「`未说明` / `Unspecified`」（提交 `9b43187`）。

修正后门禁：`npm test` 216 文件 / 2790 测试通过、1 跳过，exit 0（check:docs / core-skills / boundaries / versions / comments / facades 全 OK）；`npm run typecheck` exit 0；`npm run lint` 0 error / 110 warning（与改动前同一组既有项）；浏览器车道见下。

## 最终状态与证据口径（2026-11-14 22:44）

Vera 在 `9b43187` 独立复验通过（见 thread:b3dbc9ae-2cbd-4b0f-9100-51c4afc4e1ae 的 22:18 原文）：三项变异与五项探针均重跑，门禁同上；浏览器车道 28 文件 / 31 用例 / 205 截图，exit 0，505.4s。Reeve 自验的同一车道为 499.97s，二者不要混称独立验证。Human 于 22:44 accept Task #154。

旧的 `dsh web --profile web-dev` 操作步骤不成立：当时该 profile 链接到创建 checkout 的 `master`（`1c57e5a`），不是交付分支。新建 profile 也不必然隔离数据，同一 `DSH_HOME` 默认共用 storage。隔离浏览器车道证明真实 Host、工具执行和 Client 组装，不证明真实模型的自然语言判断，更不等于 Human 实际验收。

Human 22:38 的新决定（message:2e3dfb58-ce7c-4851-acc9-880d9151701d）将人工使用统一移到完成全项、合本地 `master` 之后；05/06 不再等待人工产品结论。上文人工场景按此时点保留，尚未运行。续做验证仍需覆盖故意激活／授予失败后只做剩余步骤；重复一句自然语言不是 requestId 幂等测试，后者要求相同 requestId **和参数**。
