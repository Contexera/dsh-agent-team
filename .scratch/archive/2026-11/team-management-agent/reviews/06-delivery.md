# 06 delivery record — 2026-11-15 Tars

实现落在 `feat/team-manager-session`（worktree `/data/repos/dsh-agent-team-mgmt02`），接在 05 的 `1297621` 之后，六个本地提交（未推送、未合 master）：

| commit | 内容 |
| --- | --- |
| `706156d` | `project_update`（`update`／`archive`）与 `project_owner` 的 `update`／`remove`；账本串行段内局部合并、`archiveProject`／`updateProjectOwner` 增加 `authorize`、`forgetProjectSubscriptions`、三条 manager 入口、preset `only` 扩到九个、harness fixture、根 AGENTS.md |
| `67be0be` | `manager-project-adjust.spec.ts`（12 条）、`manager-session`／`manager-writes`／`shipping` 工具集断言、`optional-slot-matrix` 新行、`team-manager-writes.e2e.ts` 的改名／归档／owner 责任段、`team-manager.e2e.ts` 九工具 |
| `346c767` | `tools-and-preset.md(.zh)`、`host-authority.md(.zh)`、`dsh-release-compatibility.md(.zh)`、`docs/team-collaboration/tools.md(.zh)`、两份 tool README、CHANGELOG |
| `b29737c` | 05 复核两处阻断（生命周期重放驱动历史快照、模型应用失败误分类且不重试）与 06 复核两处探针（显式空责任被归一、旧 Project patch 重放答历史快照）的修正；见下「复核修正」 |
| `08d9dbe` | 复核指出的两处文档措辞：归档后清理失败那句改成「同 id 重放会再跑清理」，非空 owner 责任收窄到 `add` |
| `c48a721` | 浏览器车道自造红：撤回 owner 后「移除负责人」行的断言改成 `expect.poll(...count()).toBe(0)`（该文件用的是 vitest 的 `expect`，没有 Playwright 的 `toHaveCount`） |

## 票面逐条怎么落的

1. **局部合并。** `project_update` 的 `name`／`description` 都可选，合并点在账本自己的串行段落里（`Ledger.updateProject` 的 `enqueue` 内读 `prior` 再只覆盖写明的字段），所以排队期间 Human 改过的字段不会被写回旧值；显式空白共同目标照 Web 编辑器清空，空名字拒绝。改名／改描述后共同目标与 owner 责任在 `team_view`／`team_overview` 里仍一致可见（用例断言同一份投影）。
2. **archive。** 走既有 `archiveProjectInternal`：保留事实与整段历史、释放活跃 Claim、清空相关 Attention、停掉并清空该 Project 的订阅私有状态（`forgetProjectSubscriptions`，提交后失败作为回执旁的 warning 而不是拒绝）；归档后 Project 从 Team 各界面隐藏，开放 Task 按 v3+ 的参与规则交回 Human。用例覆盖重复归档（同 id 重放答原回执且 `state: 'archived'`）、已归档 ref 的新编辑拒绝、旧 rename patch 在归档后重放答当前行（`state: 'archived'` + 后来改的共同目标）。
3. **owner 责任更新。** `project_owner update` 只改该 Project 关系里的 `responsibility`，走 01 的只追加操作 `team/project-owner-responsibility-updated`，不是 remove+add：Member 保住授予、Main stream Attention 与历史，Member 全局 description 不动；`view().owners`、ownership context 与 `team_overview` 一致替换。
4. **owner 撤回。** `remove` 只结束关系：仍以别的方式参与该 Project 的 Member 保留它负责的 Task，参与关系因此结束的才交回 Human；并发撤权在账本队列内串行，过期 ref 与已归档 Project 都带原因拒绝且不写账本。
5. **文档与人工验收。** 工具契约、局部合并与重放语义、归档清理、owner 责任写进 `tools-and-preset.md(.zh)`、`host-authority.md(.zh)`、`docs/team-collaboration/tools.md(.zh)` 与两份 tool README；工具计数与兼容性写进 `dsh-release-compatibility.md(.zh)` 与 CHANGELOG。dev profile 人工验收未做，见「未验证」。

## 复核修正（`b29737c`）

05 复核（[05-review.md](05-review.md)）两处阻断：

- **生命周期重放不再驱动历史快照。** `suspendMemberInternal`／`resumeMemberInternal`／`archiveMemberInternal` 在写之后重读 `ledger.getMember(...)`，converge 与 status 都用当前行；resume 重放时若当前已不是 `enabled`，只收敛、不激活。回归三条：suspend→resume→旧 suspend、resume→suspend→旧 resume、归档后旧 suspend，同时核账本、回执与当前运行态。
- **模型应用失败单独命名并真正重试。** 新增 `MemberModelApplyError`／`MemberCapabilityApplyError` 与 `model-apply` 诊断类别，manager 面 effect 从 `failed:model-apply`／`failed:capability-apply` 分报；应用判定改为「已存路由 vs 活代 `agent.model.current()`」，所以同 id／同 patch 重放会补做仍欠的模型效果，而后来被别的编辑换掉的路由不会被旧 patch 写回。客户端 formatter 与中英文案同步（`模型切换未生效`／`Model switch not applied`）。

06 复核（[06-review.md](06-review.md)）两处探针：

- **显式空责任。** 工具只在 `action !== 'update'` 时丢弃空白 `responsibility`，`update` 上的空串照原样送到 Host 并记成 `unspecified`；`add` 仍拒绝空责任，`remove` 容忍空白槽位（模型填满可选槽时不误拒），非空责任配 `clearResponsibility` 仍拒绝。
- **Project patch 重放答当前行。** `managerUpdateProjectForAgent` 的 update 分支提交后重读 `getProject(projectRef)` 再作答，重放不再回放历史快照。

## 产品意图裁定（实现时定下，票面未写）

- `project_update` 用 `action: 'update' | 'archive'`；`archive` 拒绝同时给 name／description，`update` 至少要给一个字段——两条都是显式拒绝而不是静默取其一。
- `project_owner update` 接受显式空 `responsibility`（与 `clearResponsibility: true` 等价），`add` 仍要求非空，`remove` 拒绝非空责任但容忍空白槽位。
- 归档提交后的清理失败是「已提交 + warning」，不是拒绝；同一 `requestId` 重放会保留原回执并再跑一次清理，新 `requestId` 不能重做归档。
- manager 面的 `project_update` 答回读当前行，与 05 的 Member 生命周期重放同一口径：重放只补自己欠的效果，不撤销后来的状态。

## 判别性证据（变异后还原，逐条只红目标用例）

| 变异 | 结果 |
| --- | --- |
| `suspendMemberInternal` 用 `result.value.member` 代替当前行 | `replays a suspend without undoing a resume that landed after it`、`replays a suspend after the Member was archived` 红，其余 16 条绿 |
| `resumeMemberInternal` 用 `result.value.member` 代替当前行 | `replays a resume without reviving a suspend that landed after it` 红，其余 17 条绿 |
| manager 面 effect 一律报 `failed:capability-apply` | `answers a committed model edit whose live route apply failed, then retries it on a replay` 红，其余 17 条绿 |
| 工具对 `update` 也把空白 `responsibility` 归一为 absent | `records an unspecified responsibility when the update clears it` 红，其余 11 条绿 |
| `project_update` 答回改用提交时的快照 | `replays the original receipt after a later edit and refuses a changed patch`、`archives a Project: claims release, subscriptions clear, history stays` 红（后者含归档后旧 patch 重放断言），其余 10 条绿 |

工具侧变异（第 4 行）先 `npm run build` 再跑，否则 spec 读的是旧 `lib/`。

## 门禁证据

最终树 `c48a721`（`1297621` 之后六笔本地提交）；除注明外数字都取自该树。

- `npm run build`：exit 0。
- `npx vitest run --no-file-parallelism`：218 文件通过、2835 测试通过、1 跳过，exit 0（369.86s，跑在 `b29737c`；其后两笔只改文档与一个浏览器断言，最终树的 `npm test` 见下）。
- `npm test`（generate:typert / check:facades / check:docs / check:core-skills / check:boundaries / check:versions / check:comments / vitest）：同上数字，exit 0；`facades match the generated output (581 Harness mappings)`、`Documentation check OK: 29 maintained documents…`、`Comment check OK`。
- `npm run typecheck`：exit 0。
- `npm run lint`：0 error / 110 warning（与改动前同一组既有项）。
- `npm run test:browser`（`PATH=/opt/memoh/toolkit/node-glibc/bin:$PATH CHROME_PATH=/usr/bin/chromium`）：28 文件 / 31 用例通过、205 张截图，exit 0（505.06s）。
- 自造红一处：浏览器车道首次跑 06 时 `team-manager-writes.e2e.ts` 用 `toHaveCount` 断言撤回后的负责人行，而该文件用的是 vitest 的 `expect`（`Invalid Chai property: toHaveCount`）；改成 `expect.poll(...count()).toBe(0)` 后同一场景窄跑通过，再跑全量。

## 未验证

- **dev profile 人工验收**（真实模型 + Human 账号）：票面要求一次 Project 改名／归档与一次 owner 责任更新／撤回。按 Human 的决定，人工使用统一移到全项完成、合本地 master 之后，06 不等待该结论。
- **recover 的真实故障端到端**：仍只在单测里用 seam 制造（05 遗留，未变）。
- 双平台 CI 未跑（本地提交，未推送）。

## 验收

Reeve 在最终树 `c48a721` 独立复跑后于 2026-11-15 01:48 接受 06（同批接受 05）：他的两条原始探针均转绿，build 成功，聚焦 5 文件／108 用例通过，完整 `typecheck`／`npm test`／`lint` exit 0（219 文件／2837 用例通过、各 1 跳过）。真实浏览器最终车道与 Human 实际使用按他的口径留到 08 后的统一收尾，未记成已完成。验收动作由他执行——我执行了本票，不参与验收。
