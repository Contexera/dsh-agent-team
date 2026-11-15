# 05 delivery record — 2026-11-14 Tars

实现落在 `feat/team-manager-session`（worktree `/data/repos/dsh-agent-team-mgmt02`），基于 `9b43187`，三个本地提交（未推送、未合 master）：

| commit | 内容 |
| --- | --- |
| `1b17324` | 账本局部合并与 `authorize` 选项、Host 三条 manager 入口与六个 internal 路径、`updateMember` 幂等顺序修正、`adoptMemberRouteFromRequest` 入队重读、三个工具、preset `only` 扩到八个、harness fixture、AGENTS.md |
| `64d7730` | `manager-member-adjust.spec.ts`（13 条）、`member-model-adoption.spec.ts` 的 adoption/改名竞态、`optional-slot-matrix` 七行、`manager-session`/`shipping` 工具集断言、`team-manager-writes.e2e.ts` 新工具段 |
| `1297621` | `tools-and-preset.md(.zh)`、`host-authority.md(.zh)`、`dsh-release-compatibility.md(.zh)`、两份 tool README、CHANGELOG |

## 票面逐条怎么落的

1. **局部合并。** 合并点在账本自己的串行段落里（`Ledger.updateMember` 的 `enqueue` 内读 `prior` 再只覆盖请求写明的字段），所以任何写入方——manager 工具、Human Remote、adoption 回写——都在同一条队列上收敛；`assertSameMemberUpdate` 只比较请求声明的字段，因此「同一 id + 同一 patch 在后续编辑之后重放」仍答原回执，而「同 id 改 patch」是冲突。Member 会话自身的 `request/header` 模型回写也改走 `enqueueLifecycle` 且只写 route，不再带 handle/description 快照。更换模型沿用 04 的目录校验，位置在 `!ledger.hasCommitted(requestId)` 之后；只改其他字段不碰已配置模型。清除能力覆盖（`clearCapabilities` → `capabilities: null`）与省略 `capabilities` 是两条不同的请求，同时给出会被工具拒绝。
2. **recover 闭环。** `member_state recover` 复用 `recoverMember`，不写账本、要求 `workspaceId`，结果 `outcome: 'runtime-only'` 且无 receipt。闭环用例：`member_create` 激活失败（`ctx.agents.create` 一次性抛错）→ 成员 `unavailable` + `activation` 诊断 → `member_update` 换模型成功 → `member_state recover` 后 `active` / `available`，且账本里模型是修复后的路线。非 enabled 成员的拒绝原样返回（archived 成员 recover 被账本状态拒绝）。
3. **Workspace 与归档。** `member_workspace join` 后 `workspaceIds` 增加、`sessionId` 不变；`leave` 收回参与且 Session 仍不动；退出创建 Workspace 由账本拒绝（`cannot leave its default Workspace`）。归档后 `availability: 'archived'`，`releasedClaims`/`removedAttention` 如实回报，私有记忆与 Session 日志保留（render 明说「nothing was deleted」）。
4. **拒绝与永久移除。** 已归档/不满足条件的拒绝都带原因且不写账本；`member_state` 的 description 明说本版没有永久移除工具、归档是它提供的终态，不指向任何 Web 操作。
5. **文档与人工验收。** 工具契约、局部合并与重放语义、recover 的运行时性质、apply 失败在 manager 面的 `failed:capability-apply` 写进 `docs/architecture/tools-and-preset.md(.zh)` 与 `host-authority.md(.zh)`；工具计数与清单写进两份 tool README、`dsh-release-compatibility.md(.zh)`、CHANGELOG。dev profile 人工验收未做，见「未验证」。

## Reeve 的裁定怎么落的（22:50）

- **「按账本串行队列合并局部字段，继续做。」** 合并点就在账本队列内（见上第 1 条），Host 的生命周期队列只负责串行运行时效果与 adoption。为此新增票面没点名的重放场景：同一 id + 同一 patch 在**后续改名/改描述之后**重放 → 原回执，且后续编辑不被写回；同 id 改 patch → 冲突且不写第二条。
- **「`recover` 没有账本段，仍要在它实际执行的生命周期临界区重检 manager 身份／归档状态。」** `recoverMemberInternal` 在 `requireAccepting()` 之后、读取任何成员状态之前调用 `authorize`（唯一一次调用点，manager 入口不再重复调用），它跑在 `enqueueLifecycle` 的临界区内。用例：suspend 占住成员生命周期段落 → recover 排队 → 替换 manager → 放行后 recover 以 manager 拒绝，且 suspend 本身照常完成。
- **根 AGENTS.md 的 manager 工具描述同步为八个**（`team_overview`、`team_models`、`member_create`、`project_create`、`project_owner`、`member_update`、`member_state`、`member_workspace`），不另扩范围。

## 产品意图裁定（实现时定下，票面未写）

- `member_update` 不编辑 handle 与 preset；显式空白 description 在 manager 层拒绝（Human Remote 仍允许空描述，保持既有行为）。
- `capabilities: null` 与省略区分；`clearCapabilities` 与 `capabilities` 同时给出直接拒绝，而不是静默取其一。
- manager 面的 effect 在共享枚举上多一个 `failed:capability-apply`：写已提交、调用者是模型，答成未提交的拒绝会诱发重复重试；Human Remote 仍保持「失败即拒绝」。
- `recover` 的 `requestId` 被忽略（不写账本），结果里也没有 receipt；`member_state` 的 `workspaceId` 只在 recover 上接受，其余动作给了就拒绝而不是丢弃。
- `member_workspace` 的 join/leave 都是账本写，走同一套 requestId 重放规则；join 不创建、不复制、不移动 Session。
- **04 遗留修正**：`updateMember` 的 `assertModelRoute` 移到 `!ledger.hasCommitted(requestId)` 之后，与 04 给三个写工具定下的契约一致。

## 判别性证据（变异后还原，逐条只红目标用例）

| 变异 | 结果 |
| --- | --- |
| `updateMemberInternal` 的路线校验去掉 `!hasCommitted` 前置 | `answers an update replay after the provider registry moved` 红，其余 12 条绿 |
| 账本合并把未声明的 description 写成 `''` | `patches one field at a time…` 红，其余 12 条绿 |
| `recoverMemberInternal` 的 `authorize` 置空 | `re-checks the manager inside the lifecycle section…` 红，其余 12 条绿 |
| 账本 `updateMember` 的 `authorize` 置空 | `refuses every new call site… queued in the ledger` 红，其余 12 条绿 |
| manager apply 失败一律重抛（不报 `failed:capability-apply`） | `answers a committed write whose live capability apply failed…` 红，其余 12 条绿 |
| 重放比较改为对照「当前存储值」而非「本次声明」 | `replays the same patch to its original receipt…` 红 |
| 去掉 description 的比较分支 | 同上一条红 |
| adoption 回写带 handle/description 快照 | `keeps a rename that landed while the adoption was queued` 红，其余 adoption 用例绿 |

## 门禁证据

- `npx vitest run --no-file-parallelism`：217 文件通过、2813 测试通过、1 跳过，exit 0。
- `npm test`（generate:typert / check:facades / check:docs / check:core-skills / check:boundaries / check:versions / check:comments / vitest）：同上数字，exit 0；`facades match the generated output (581 Harness mappings)`、`Documentation check OK: 29 maintained documents…`、`Comment check OK`。
- `npm run typecheck`：exit 0。
- `npm run lint`：0 error / 110 warning（与改动前同一组既有项；本次唯一新增的一条 `AgentTeamManagerMemberStateAction` 未使用导入已删掉，回到 110）。
- `npm run test:browser`（`PATH=/opt/memoh/toolkit/node-glibc/bin:$PATH CHROME_PATH=/usr/bin/chromium`）：28 文件 / 31 用例通过、205 张截图，exit 0，501.51s。
- 自造红两处：浏览器车道首次跑 `member_update` 只改 description 却断言 `effect: 'applied'`（实际 `already-applied`，语义正确，改的是断言）；`member_state` recover 的 render 标题从「requested」改成「Member recovery」。

## 未验证

- **dev profile 人工验收**（真实模型 + Human 账号）：票面要求跨 Workspace 调整与故障成员恢复闭环各一次。按 Human 22:38 的决定，人工使用统一移到全项完成、合本地 master 之后，05 不等待该结论。
- **recover 的真实故障端到端**：浏览器车道覆盖了 `member_update`、`member_state` 的 suspend/resume/archive、`member_workspace` 的退出创建 Workspace 拒绝；recover 需要真实激活失败或孤儿组合，只在单测里用 seam 制造。
- 双平台 CI 未跑（本地提交，未推送）。

## 复核修正（2026-11-15，`b29737c`）

[05 review](05-review.md) 的两处行为阻断在当前树修正，作为单独一笔提交（`fix: finish a replayed lifecycle write against the current member`），不追加到已复核的三个 SHA 上：

1. **生命周期重放不再驱动历史快照。** `suspendMemberInternal`／`resumeMemberInternal`／`archiveMemberInternal` 写后重读 `ledger.getMember(...)`，converge 与 status 都用当前行；resume 重放时若当前已不是 `enabled`，只收敛、不激活。新增三条回归：suspend→resume→旧 suspend、resume→suspend→旧 resume、归档后旧 suspend，同时核账本、回执与当前运行态。
2. **模型应用失败单独命名并真正重试。** 新增 `MemberModelApplyError`／`MemberCapabilityApplyError` 与 `model-apply` 诊断类别，manager 面 effect 分报 `failed:model-apply`／`failed:capability-apply`；应用判定改为「已存路由 vs 活代 `agent.model.current()`」，同 id／同 patch 重放补做仍欠的模型效果，后来被换掉的路由不被旧 patch 写回。客户端 formatter 与中英文案同步。

同一树还修了 06 复核的两处探针（显式空责任、Project patch 重放答当前行），细节、变异表与统一门禁数字见 [06 delivery](06-delivery.md)。

## 独立复验（2026-11-15 01:48 Reeve）

Reeve 在独立 worktree 固定 `c48a721` 复跑：原生命周期重放与模型失败续做场景均恢复正确，后续状态不被旧请求倒退，模型／能力失败分别诊断。独立证据：build 成功；05/06 聚焦套件加他的 2 条探针合计 5 文件／108 用例通过；完整 `typecheck`／`npm test`／`lint` exit 0（219 文件通过、1 跳过，2837 用例通过、1 跳过，lint 0 error／110 既有 warning）。结论「05 可以接受」，真实浏览器最终车道与人工实际使用仍留到全项收尾统一处理。验收动作由他执行——我执行了本票，不参与验收。
