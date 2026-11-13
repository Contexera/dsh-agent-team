# 覆盖差集：第一轮基线到当前 HEAD

第一轮审计基线 `7076dbd`（2026-11-09）与当前 HEAD `796024fc`（2026-11-11）之间，应用新增了 13 个源文件，并在若干既有文件里增加了新的状态面。第一轮的 129 文件覆盖表仍然准确，但它描述的是 `7076dbd`，不是当前应用。

## 文件计数

| 范围 | `7076dbd` | 当前 HEAD | 差 |
| --- | ---: | ---: | ---: |
| `packages/agent-team/src`（含 types、vendor） | 56 | 64 | +8 |
| `packages/tool-agent-team/src` | 6 | 7 | +1 |
| `packages/client-agent-team/src`（含 client、index、声明） | 67 | 71 | +4 |
| 合计 | 129 | 142 | +13 |

计数口径与第一轮 `COVERAGE.md` 一致：只算 `src` 下的 TS/TSX，不算生成 `lib`、依赖源码、CSS 和测试。

## 新增文件

| 文件 | 引入提交 | 它拥有什么 | 是否状态面 |
| --- | --- | --- | --- |
| `agent-team/src/worker-service.ts` | Worker 委派 | 运行注册表、start/stop/steer/continue、dispose、五条列表窗口 | **是**，本轮最大 |
| `agent-team/src/worker-runtime.ts` | Worker 委派 | OAR provider、原生会话、steer 投递、失败分类 | **是** |
| `agent-team/src/worker-inspection.ts` | Worker 委派 | 原生记录的有界只读、锚点校验、凭据隐藏 | 读取协议，不是生命周期 |
| `agent-team/src/worker-settings.ts` | Worker 委派 | 引擎枚举、sandbox 模式、文本上限 | 常量/类型，不是状态机 |
| `agent-team/src/member-tool-grants.ts` | `8825b238` | profile 级精确工具名许可的校验/复制 | 纯转换 |
| `agent-team/src/tool-availability-guidance.ts` | `8825b238` | 对可见但未许可的自有 scope 工具生成 prompt 段 | 纯派生 |
| `agent-team/src/project-owner-guidance.ts` | `f9134d6d` | owner 常驻 prompt 段，按当前 ledger 事实每次组装重算 | 纯派生 |
| `agent-team/src/sidebar-order.ts` | `9dada275` | Host row 的版本化侧栏顺序、键/ref 校验 | 存储契约，不是运行时机器 |
| `tool-agent-team/src/member-target.ts` | `806a7e9f` | 订阅事件收件人的成员寻址 | 纯解析 |
| `client-agent-team/src/client/extra-tool-grants.ts` | `8825b238` | 许可编辑器的草稿、目录、冲突与保存 | **是**，局部协调器 |
| `client-agent-team/src/client/worker-copy.ts` | Worker 委派 | 引擎显示名与 CLI 名 | 常量/纯函数 |
| `client-agent-team/src/client/team-shortcuts.ts` | `77e9cec7` | Team 快捷键注册、平台默认、重绑定 | 声明式，不是状态机 |
| `client-agent-team/src/client/clipboard.ts` | `653a44e5` | 复制失败后的 legacy 回退 | 单次资源尝试，不是状态机 |

## 既有文件里的新增面

13 个新文件只是下限。以下既有文件也增加了第一轮没有覆盖的职责：

| 文件 | 新增职责 | 第一轮对应 |
| --- | --- | --- |
| `agent-team/src/index.ts` | Worker Remote、运行列表、停止、诊断、Thread 上的 Worker 状态投影；extra tool grants 的 turn 读取与冻结 | T1 只覆盖工具寻址；C18/C20 未含 Worker |
| `agent-team/src/member-runtime.ts` | `extraToolGrants` 的 turn 冻结、失败收紧到 no-grant 基线、执行 guard 的 grant 分支 | M1 只覆盖 capabilities 意图/证据 |
| `agent-team/src/types/operations.ts` | `team/worker-started`、`team/worker-settled`、steer admission/outcome 记录 | D01 的 ledger 协议新增事件 |
| `agent-team/src/types/entities.ts` | Worker 执行/结算/steer 的领域类型 | D01–D19 未含 |
| `client-agent-team/src/client/TeamMemberEditor.tsx` | 五行 Worker 运行窗口、停止、诊断入口 | C18/C20 只覆盖编辑与提醒 |
| `client-agent-team/src/client/TeamSettingsSection.tsx` | extra tool grants 编辑器、Worker 设置组 | C22 只覆盖名称/头像/配置暂存 |
| `client-agent-team/src/client/sidebar-order.ts` | 从 Host row 补水、localStorage 上迁、未确认写入重试 | C16 仍写“localStorage 偏好，不修改 Team ledger”，已过时 |
| `tool-agent-team/src/index.ts` | `team_worker` 的 start/steer/stop/inspect 动作、拒绝渲染 | T1 的九工具清单已变为十工具 |

## 第一轮仍然有效的结论

- 唯一权威仍是 ledger；新面没有另造 Team 事实仓。
- 稳定 branded ref、requestId 与 payload 绑定、revision/unread fence 继续有效。
- 非乐观 durable mutation、真实失败原因、输入/草稿保留、可执行恢复提示继续有效。
- “不引入全仓 FSM、统一 async 层、新状态仓、外部副作用 exactly-once”继续有效。

## 已经过时的描述

| 第一轮位置 | 过时点 | 当前事实 |
| --- | --- | --- |
| `materials/client.md` C16 | 侧栏排序是“localStorage 偏好，不修改 Team ledger” | 排序现在写 Host row 的 `sidebarOrder`，localStorage 是缓存和离线回退；首次读取会把旧本地顺序上迁。 |
| `COVERAGE.md` 的 129 文件表 | 只覆盖 `7076dbd` | 当前 142 文件；Worker、grants、owner guidance、sidebar order、shortcuts、clipboard 未列入。 |
| `REPORT.md` 的“129 个 TS/TSX 源文件” | 作为“当前应用已全部盘点”的证据 | 只对 `7076dbd` 成立；归档 README 已注明这一点，但标题容易被误读。 |

## 结论

第一轮作为 `7076dbd` 的快照是完整的；作为“当前应用的全部隐式状态机”已经不完整。但这份差集只是深入轮的一个输入，不是范围本身：Worker 和 extra tool grants 是最明显的新面，第一轮的 68 组仍要按[全域深入切片](07-deep-slices.md)的六条线重新追问。

差集的作用是防止把“第一轮没列过”误当成“不存在”，不是把这一轮缩成“只补新文件”。
