# Agent Team：定位、责任与协作原则

本文记录 2026-11-12 对齐的产品认识，供团队管理会话设计及未来项目定位文档复用。当前行为仍以源码和维护文档为准；这里新增的责任说明与交接设计见 `../spec.md`。

## 1. Team 的核心是持续负责

Agent Team 不是为一次任务临时召集的执行者集合，而是围绕 Human 的长期目标，让稳定成员持续负责结果、积累判断并主动推进。

单次任务表现不能检验 Team 的长期价值。真正的价值来自这条循环：

> Human 给出目标 → owner 判断该做什么 → 提醒和 Project 订阅发现变化 → owner 自己执行或委派 Worker → 核对交付并推动验收 → 结果进入成员记忆和公共记录 → 影响下一次判断。

因此：

- 写代码、测试、文档是完成责任所需的能力，不是默认的成员类别。
- Task 是某次具体承诺，不是创建一个长期 Member 的理由。
- Worker 提供按需执行和并发，不持有 Project 责任、长期身份或验收权。
- owner 不只是任务 router。它决定是否值得做、如何做、是否需要 Human 或其他 owner、结果是否达到目标，以及下次应怎样调整。

## 2. 四种角色与普通参与

| 角色 | 持续责任 | 明确不做 |
| --- | --- | --- |
| Human | 目标、优先级、信任授权、必要的最终验收 | 逐项替团队协调执行 |
| Team owner | 首版在对话中引导、设计并直接搭建和调整团队；后续增加无需 Human 发起的自主发现与持续复查 | 不做全团队任务总路由，不介入每个 Project 的日常推进 |
| Project / domain owner | 对一块持续结果作判断、主动推进、直接对接 Human、组织执行并积累经验 | 把 coding、测试、文档分别固定交给其他长期 Agent |
| Worker | 完成一次边界明确的执行并交回证据 | 持有 Member 身份、Project 责任、私有 Team 记忆或自我验收 |

普通 Agent Member 仍可以不是某个特定 Project 的 owner：它可以参与讨论、承担 Claim、协助处理依赖或为其他 owner 提供独立验收。**非 owner 参与是合法关系，但不应成为一个长期 Member 存在的唯一理由。** 如果它长期只提供执行人手，应优先使用 Worker；如果需要它积累独立判断，应授予明确责任。

## 3. 每个长期 Agent 都应有明确责任

产品原则是：**每个 enabled 的长期 Agent Member，通常至少是一个 active Project 的 Agent owner。** 它可以同时负责多个 Project，也可以和其他 owner 共同负责一个 Project，不要求独占。

这不是 Host 必须强制维持的不变量：

- 创建成员和授予 owner 是不同操作，中间可能失败；
- 撤权、Project 归档和跨 Workspace 调整会自然产生暂时没有 owner 关系的成员；
- 普通参与、Claim 和独立验收仍是非 owner 关系，不能从领域模型删除。

Host 允许这些状态存在；`team_overview` 必须把「没有 active owner 责任的 enabled Member」明确显示出来。团队管理会话应建议补充责任、复用到合适 Project、暂停或归档，而不是把这种成员当成健康的常驻团队结构。

## 4. Project 不一定等于 Domain

- **Project** 是一个持续目标及其公共协作记录。
- **Domain** 是一块需要持续判断的责任。
- **Member** 是全局稳定身份，可以跨 Workspace 和 Project 积累同一领域的判断。
- **Project owner** 是 Member 与 Project 之间的责任关系，不是另一种 Member 类型。

允许以下情况：

1. 一个 Project 只有一块持续责任，只设一个 owner。
2. 一个 Project 有多块相对独立、都需要长期推进的责任，设多个领域 owner。
3. 同一领域出现在多个 Project 中，复用同一个 Member，而不是为每个 Project 复制成员。
4. 一次性优化或修复不新建常驻 owner，由现有 owner 决定自己做或派 Worker。

Member 的全局 `description` 说明它是什么身份；Project 的 `description` 说明共同目标；owner 关系的 `responsibility` 说明它在这个 Project 中具体对什么结果负责。三者不能互相替代。

## 5. Owner 的工作方式

- owner 围绕持续结果主动发现工作，而不是只等 Human 派 Task。
- 提醒提供再次判断的时机，Project 订阅提供外部变化；一次唤醒不等于必须建 Task 或派 Worker。
- owner 可同时负责多个 Task，并按任务独立性委派多个 Worker；委派不转移 accountable 或 Claim 责任。
- owner 直接对接 Human。Team owner 不是日常沟通的必经中转。
- 跨 owner 协作用于共享约定、真实依赖和责任冲突，不用于把常规执行再拆给固定职能 Agent。
- 独立验收不意味着默认创建常驻「测试 Agent」。由未参与实施的合适 owner 或 Human 验收；只有质量保障本身形成持续责任时才设相应 owner。

## 6. Team owner 的现阶段定位与演进

### 首版：对话驱动的 Team owner

引导只是其中一部分。Team owner 已经能够根据 Human 的需要和我们提供的实践，完成从目标讨论到团队落地的完整过程：

- **把目标讨论清楚。** 当 Human 只说「帮我组个团队」时，不直接套模板；围绕持续结果、非目标、现有责任、Human 保留的决策和验收方式追问并挑战方案。能从工具或 repo 查到的自己查，只问会改变责任结构的判断。
- **建立 Human 的直觉。** 在讨论中解释什么时候该用普通 Session、现有 Project、Task、Worker，什么时候才需要新 Project 或新 Member；为什么这样划分 owner，而不是只给最终名单。
- **设计责任结构。** 从持续目标识别最少量的 owner 责任，优先复用成员，说明 Project 共同目标、每位 owner 的 responsibility，以及他们将怎样直接与 Human 协作。
- **直接搭建和调整。** 按既有确认原则直接创建 Member、Project、owner，配置模型和能力，交接责任，处理运行故障；不是只给操作说明，也不是替 Human 被动代点按钮。
- **在请求下检查团队。** Human 问「现在有什么问题」时，首版就能通过 `team_overview` 找出责任空缺、责任未说明、运行故障和配置漂移，并提出或执行调整。

它仍不是全团队任务总路由，不接管 Project owner 的日常分工。首版由 Human 打开会话或提出请求启动工作，不需要 Member Inbox、提醒或 Project 订阅，也不读取成员私有 Session 或 DM。

### 后续：自主发现与持续经营

推后的是**无需 Human 发起**的主动性，而不是对话中的分析、设计和执行能力：

- 像 Project owner 主动发现领域工作一样，Team owner 自己发现持续责任无人承担、owner 过载、责任重叠或 Project 已无持续目标；
- 通过定期或事件驱动的复查，根据公共协作结果提出合并、拆分、复用、暂停或归档建议；
- 主动找 Human 讨论团队结构是否仍服务其目标，而不是等 Human 打开「团队管理」才检查。

## 7. 责任交接与 DM 的边界

标准交接需要三项事实：

1. Project `description` 中有共同目标；
2. owner 关系中有当前 `responsibility`；
3. owner 的下一步上下文能看到 Project 目标、自己的责任和完整 owner 列表。

现有 owner 授予已经写公共 Activity、给新 owner 留 Main 标记并走提交通知。扩展责任字段后，这条链可以完成标准交接；即使成员暂时离线，责任仍在账本中，恢复后的上下文仍会呈现。

因此首版不增加通用双向 DM 工具，也不把所有 owner 拉进一个交接 Thread：

- 多个 owner 分别通过 `project_owner add` 获得各自责任，共用同一份 Project 目标；
- 每个 owner 通过 `team_view` 看到其他 owner 的责任，需要协调时再进入公共协作；
- 如果确有一次性补充说明，可在授予责任时附带，随现有通知送达；通知未送达不改变已提交的责任关系。

通用 DM 是后续的额外沟通能力，不是首版交接的权威或必要条件。若未来允许 Team owner 与成员双向 DM，需要另行设计它的发送者身份、回复路径和离线投递，不能直接把仅限同 Workspace Agent Member 的 `team_dm` 套到全局管理 Session。

## 8. 验收长期价值

不要用「成功创建几个成员」作为主要验收。应至少走通：

> owner 获得明确责任 → 建立提醒或订阅 → 发现值得推进的变化 → 同时委派 Worker 且继续回应 Human → 核对结果并推动独立验收 → 将持久结论写入记忆 → 后续判断利用这次经验。

团队管理会话自己的验收则包括：能区分一次性任务和持续责任、优先复用成员、拒绝按职能机械扩编、指出没有 owner 责任的长期成员，并完成可恢复的责任交接。
