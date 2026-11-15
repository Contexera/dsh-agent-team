# 04 fresh-context rehearsal 记录（2026-11-14）

- **执行**：team_worker（codex，worker:2ac8cf2a-86de-47d0-980e-f218f45b1f5a），cwd `/data/repos/dsh-agent-team-mgmt02`，只读，未改任何文件。
- **结论**：按当时阅读集**不能无误开工**——点名符号都在，但写工具的 requestId/结果契约、部分产品语义和资料时效性未闭环。以下逐条记录 Reeve 的核验与裁定。原票面契约未改写；本文件是 04 的 readiness addendum，票面 `Status: ready` 指向这里。

## 1. 阅读集缺口（已核验）

| # | 发现 | 核验结果 | 处理 |
|---|---|---|---|
| 1 | `.scratch` 相对路径在 mgmt02 worktree 不存在 | 属实：`.scratch/` 只在创建 workspace `/data/repos/dsh-agent-team` | 票面 Required context 改为绝对路径 |
| 2 | `facts.md:8` 说 `addMember` 不校验 preset | **已过期**：`index.ts:1630` 已在模型校验和账本写入前拒绝非 `team-member`（02 交付） | facts.md 该行标注 superseded |
| 3 | `facts.md:11` 说 owner 关系无 responsibility、无 update | **已过期**：01 已交付 `updateProjectOwner`、责任字段、rules v8 | facts.md 该行标注 superseded |
| 4 | `facts.md:15` `activateMember` 写回前不重读账本 | **仍属实**（`index.ts:3458` `handles.set` 前无重读） | 列入 04 必修项 |
| 5 | owner「状态允许」未在阅读集定义 | 属实：规则在未点名的 `projectOwnerChangeProblem`（`ledger.ts:2977`）：enabled 或 suspended，必须参与目标 Workspace | 票面点名该符号 |
| 6 | 模型校验要求强于现有 `assertModelRoute` | 属实：`index.ts:1634` 仍在幂等判断前调用，且只用 `llm` 服务、吞普通 lookup 失败 | 04 按 spec 用 `sessionController.modelCatalog()` 重做，区分未知路线/无效 effort/目录失败 |
| 7 | 03 只读面随写工具落地而失效的文案未列 | 属实：`cordis.patch.yml:343` manager `only` 仅两工具；`index.ts:1696` 描述与 `:1730` 页脚都写着本 Session 不持有写工具 | 列入 04 同步项 |

## 2. 产品意图裁定（Reeve，2026-11-14）

1. **requestId 由模型可显式传入（可选参数）**。省略时 Host 按现有 `requestId(agentId, callId)` 派生；同一意图+参数的重试沿用原 id（账本返回原回执），同 id 改参数由账本 collision 拒绝并提示换新 id（`ledger.ts:2579` 语义已验证）。工具描述写明该规则。
2. **结果契约**：三个写工具统一返回 `{ requestId, outcome: 'committed' \| 'unknown', receipt, <对象 ref>, runtime?: { availability, diagnostic? } }`。`runtime` 仅出现在「账本已提交但运行态效果未生效/失败」时；`outcome: 'unknown'` 表示 Host 无法确认，模型用原 requestId 重试或读回。拒绝（未写任何东西）是带明确原因的错误。render 把三种情形分开呈现。
3. **owner 资格沿用账本规则**：enabled 或 suspended 均可被授予，必须已参与目标 Workspace；`project_create` 纳入成员仍只用 Host 的 `availability === 'active'` 门槛。管理层不加严。
4. **`project_create` 的 description 在管理工具层必填非空**（共同目标是 Project 的成立理由；Host 请求本身不变，其他路径仍允许空）。
5. **`project_owner add` 的 responsibility 在管理工具层必填非空、trim、≤2,000 字符**；Web 授权入口仍允许留空显示「未说明」。
6. **`project_owner` 本票只暴露 `action: 'add'`**；update/remove 随 06 扩展同一工具，不改名。
7. **`member_create` 本票不暴露初始 Project 参数**（按流程 B：先建成员，再建 Project）。
8. **一次性 vs 持续目标是 persona 判断**，不设可实现阈值；教学由 08 的 guide skill 承担，不作 04 的实现门禁。

## 3. 范围裁定

- `spec.md:57` 提到顺带修正 `updateMember` 的幂等前校验顺序：**04 只修 `addMember` 路径**（抽出共享的「幂等判断后模型校验」helper 并用于 addMember）；`updateMember` 的切换留到 05（`member_update` 落地时），在此记录以免 05 漏掉。

## 4. 04 实现须一并完成的同步项

- `cordis.patch.yml` manager 行 `only` 扩为五个工具；member 行不动（仍十个）。
- `team_overview` 描述与页脚、「本 Session 不持有写工具」措辞改为实际形状；两份 README 与 `docs/dsh-release-compatibility.md` 同步工具数。
- shipping spec 的两个钉（member 行 == `AGENT_TEAM_TOOL_NAMES`；member ∪ manager == 插件默认集）随插件默认集变 15 继续成立，测试同步。
- 工具与 Host 权限文档目标定为 `docs/team-collaboration/tools.md` 与 `docs/architecture/tools-and-preset.md`。

## 5. 验收要点（从 rehearsal 的 A 节吸收，与原票面勾选合并执行）

- 同名 handle 两个 Workspace：后续写入只命中工具返回的 branded `memberRef`。
- handle 冲突仍按同 Workspace 规则裁决；receipt actor 为 Human；Host 日志可关联管理 Session id、requestId、operationId。
- 撤权时序：写调用排队后、进入写入临界区前撤权 → 不写账本；账本 append 后撤权 → 已完成写入可收尾。
- `activateMember` 写回 `handles` 前重读成员账本状态（并发归档不留活句柄）——用判别性测试钉住。
