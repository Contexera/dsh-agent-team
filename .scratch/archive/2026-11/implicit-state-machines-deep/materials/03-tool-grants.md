# Extra tool grants：状态、权威与开放问题

`extraToolGrants` 是 Team Host row 上的 profile 级工具名许可，第一轮审计基线之后新增（`8825b238`）。它改变了每个 Member 的工具面，但第一轮的 M1 只覆盖 `member.capabilities`（成员自己的 allow-list），没有覆盖这份 profile 级许可。

本材料只做地图和开放问题。这里有一条**已静态确认的文档/代码范围不一致**，但还没有在真实入口复现用户故障。

## 范围

| 文件 | 职责 |
| --- | --- |
| `packages/agent-team/src/member-tool-grants.ts` | 许可的校验/复制；`undefined` 表示不可读，不是空列表 |
| `packages/agent-team/src/tool-availability-guidance.ts` | 对可见但未许可的自有 scope 工具生成 prompt 段 |
| `packages/agent-team/src/member-runtime.ts` | turn 冻结、baseline + grants 合并、失败收紧、执行 guard |
| `packages/agent-team/src/index.ts` | Host row 读取、`turn/start` 同步读取、Worker 开关同步、roster 的 `capabilityState` |
| `packages/client-agent-team/src/client/extra-tool-grants.ts` | 草稿、目录、冲突、保存的局部协调器 |
| `packages/client-agent-team/src/client/TeamSettingsSection.tsx` | 设置页的许可编辑器 |

测试锚点：`member-tool-policy.spec.ts` 的 grant 收紧/基线失败/目录候选用例；Client 的 extra-tool-grants 相关用例；e2e 的 Team 设置旅程。

## 权威分层

| 层 | 保存什么 | 不是什么 |
| --- | --- | --- |
| Host row 的 `extraToolGrants` | profile 级的精确工具名列表；唯一的 durable 许可 | 不是 ledger 事实，不是 Member capability |
| `turnToolGrants`（进程内） | 当前 turn 冻结的许可集合 | 不是持久状态；下一轮重新读取 |
| `enforcedToolAllow`（进程内） | 当前 restriction 实际允许的名字 | 不是持久状态；释放时删除 |
| `appliedCapabilities`（进程内） | 已应用的能力意图证据 | **不包含 grants** |
| `turnToolPolicyFailures`（进程内） | 本轮同步安装/刷新失败 | 不是持久状态；下一步拒绝 |

关键区别：**设置已保存 ≠ 许可已生效**；**许可已生效 ≠ 模型 schema 只显示许可的工具**（自有 scope 的外来注册仍可能可见，由 prompt 段和执行 guard 兜底）。

## 状态与事件

### Host 读取与冻结

1. `extraToolGrants()` 每次从 Host row 读取并 `sanitizeExtraToolGrants`；不可读的值不会变成空列表（`extraToolGrantsFrom` 返回 `undefined`）。
2. `turn/start` 时 `observeMemberToolPolicyTurns` 同步读取当前 Member、Worker 开关和 grants，冻结到 `turnToolGrants`。
3. `agent/pre-step` 再刷新一次；同步读取或 `restrict` 失败时 `turnToolPolicyFailures` 记录原因，`agent/pre-step` 在模型请求前拒绝该步。
4. 失败收紧：grant-bearing 安装失败时，先移除旧的 restriction，再安装 no-grant baseline；baseline 也失败则抛 `AggregateError`，该步不发起模型请求（`member-runtime.ts:306-345`）。
5. 执行 guard：grant 名要求该步的 `toolSet.view(scope)` 包含它；baseline 名要求定义身份未被替换。两者都不放行 Team tools、`working_directory` 或 Worker 开关。

### Client 编辑器

`ExtraToolGrantsController` 的状态：

```text
listStatus: loading | ready | error
catalogStatus: loading | ready | error
committed / draft / missing
writable, revision, dirty, canSave, canDiscard
saving, awaitingReview
notice: saved | rejected | failed | conflict
```

- 列表读取失败不会物化为空已保存值；`canSave` 要求 `listStatus === 'ready'`、可写、有 revision、不正在保存、不在冲突复核。
- 目录读取独立于设置和 Human 身份；目录失败不阻止撤销已保存的名字。
- 保存只写 `set`，显式 `[]` 是真正撤销；冲突保留草稿和最新已提交列表，直到 Human 明确确认。
- 保存成功用响应里的 namespace view 重新解码，不从请求值推断。

### Prompt 与执行

- `team:tool-availability` 段只列「自有 scope 可见、但执行 guard 仍拒绝」的名字；它说 schema 可见不等于执行许可，并提示许可从下一轮生效。
- 执行 guard 是权威；prompt 段只是让模型不要反复尝试。

## 已静态确认的范围不一致

**`capabilityState` 只比较 `member.capabilities`，不包含 grants。**

- `index.ts:3306`：`appliedCapabilitiesMatch(member.memberId, member.capabilities)`。
- `member-runtime.ts:333`：grant-bearing 安装失败时只写一条 Host warning，然后收紧到 no-grant baseline；`recordAppliedCapabilities` 仍可能被调用（例如 Worker 开关同步路径 `index.ts:950` 之后）。
- `docs/architecture/host-authority.zh.md:134` 说 `capabilityState` 由「运行时实际已应用的效果」派生，回答「存储配置此刻生效没有」。按字面，grant 也是存储配置的一部分。
- `memberStatus` 不读取 `turnToolPolicyFailure`；`agent/pre-step` 只在日志里拒绝该步（`index.ts:3153-3156`），不写 `memberFailures`。

因此存在一个可达组合：Human 在设置页保存了 grant，roster 显示 `capabilityState: applied`、`presence: available`，但该 Member 的下一轮因为 grant 安装/刷新失败被收紧到 no-grant baseline，甚至整步被拒绝；Human 侧只有 Host 日志，没有 roster 诊断。

这是**文档与代码的范围不一致 + 失败可见性缺口**，不是已复现的用户事故。需要决定：

1. 把 grants 纳入 applied proof（`capabilityState` 或一个新的 `grantState`），让 roster 如实显示「许可未生效」；或
2. 收窄文档，明确 `capabilityState` 只回答 Member capabilities，grant 的生效由设置页/日志回答；并给 grant 失败一条 Human 可见的诊断。

两种都比「让 roster 继续显示 applied」更诚实。

## 开放问题

1. **grant 失败是否应该阻断整步？** 当前 grant 安装失败会收紧到 baseline；baseline 刷新失败会拒绝整步。前者是「少给工具」，后者是「不给模型请求」。需要确认这与「失败不静默降级」的产品原则一致，还是应该把 grant 失败降级为 warning + 本轮无 grant。
2. **`turnToolPolicyFailure` 是否应该进入 roster 诊断？** 现在只有日志。若进入，`memberStatus` 需要一个新 slot 或复用 `capabilityApply`，并定义它与 `capabilityState` 的优先级。
3. **目录候选的稳定性。** 目录是「全局 + Agent scope 注册、排除 preset 基线」的发现结果；它不按某个 Member 过滤。需要确认：一个名字在目录里、但在某个 Member 的 scope 不可执行时，设置页是否仍允许保存（当前允许，执行 guard 拒绝）。
4. **撤销的边界。** 显式 `[]` 是真正撤销；一个已保存但不再注册的名字保留为可选可移除项。需要确认「保留未知名字」不会让 Human 误以为它仍生效。
5. **与 Worker 开关的交互。** `team_worker`、`working_directory` 是保留名，grant 不能重开；Worker 开关关闭时 `team_worker` 不声明。需要确认 roster 是否应该显示「Worker 面 pending」，还是这属于另一个字段。

## 建议

先做一次真实入口验证：在设置页保存一个 grant，让 `restrict` 在 grant-bearing 安装时失败，观察 roster、设置页、Host 日志和下一轮工具面。若确认 Human 侧确实看不到失败，再决定是补 applied proof 还是补诊断。不要先改 `capabilityState` 的语义；它是 Client 已经在读的字段，改动要先确认所有消费者。
