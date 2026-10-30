# 当前工作树对 Team 性能研究的影响

**检查日期：** 2026-10-28\
**检查范围：** `c3a9704`、当前仓库状态、启动、七个 Team tool call、成员协作通知、Client load\
**证据类型：** Git 树差异、当前源码、现有构建产物和静态引用链；本轮未运行耗时或浏览器基准

## 结论

任务下达时记录的起点已发生变化。当前实际 `HEAD` 是 `bf777c3`，`c3a9704` 不再是 `HEAD`，也不是当前主线祖先；旧时点描述中的未提交代码已由 rebase 后的提交吸收，并可从 `stash@{...}` 的树 `d0f8db0` 还原。`d0f8db0` 与 `bf777c3` 的产品代码一致，唯一差异是 `package.json` 中 `Agent teams` 与 `Agent Teams` 的大小写。

当前跟踪工作树相对 `bf777c3` 只有 `scripts/team-ui.ui-preview.ts` 的 10 行修改。该文件只构造 UI 预览数据，不属于 Host、Client bundle 或 Team tool 的运行路径。`lib/` 是忽略的构建产物，且早于最终 rebase 时间，不能单独作为当前源码的最终体积证据。

这组变更会改变的潜在性能点是：

- 旧账本启动时为缺失的 Attention `source` 做内存补齐；每次冷启动和全账本校验都会执行。
- 新操作多保存一个小的 `source` 字段，生成的 Remote schema 也随之增大。
- 部分 Team tool 的结构化结果和可见文本增加 Attention 来源，不增加工具数量，也不增加额外 Host RPC。
- Project 与全局 Task Board 共用新的卡片组件；全局 Board 会把执行者文本改成头像组件并增加 DOM。
- 从 Main stream 创建 Task 后会切换 Board、刷新并逐帧查找新卡片以放置焦点。

成员通知的接收者、未读判定、fan-out、wake 和 read/reply 流程没有因这些改动改变。它们共享的账本重放、写队列和提交后全账本校验会承受新字段与该补齐逻辑的额外工作量。

## Git 边界

| 状态 | 代码内容 | 用途 |
| --- | --- | --- |
| `c3a9704` | 任务开始时的基线 | 作为改动前的性能基线 |
| `d0f8db0` | 任务描述中的代码与 UI 改动，含旧未提交状态 | 还原历史现场；与当前产品代码等价 |
| `bf777c3` | 当前 `HEAD`，已吸收上述改动 | 作为当前候选版本 |
| 当前工作树 | `bf777c3` 加 `scripts/team-ui.ui-preview.ts` | 只用于最终预览冒烟；不作为独立性能版本 |

`c3a9704..bf777c3` 是有效的树差异，但不能把它理解为一条连续祖先链。rebase 日志显示当前主线在 2026-10-28 17:05 吸收并重写了相关提交。

当前跟踪工作树差异：

```text
 M scripts/team-ui.ui-preview.ts
```

上述脚本在预览初始化时把全部 Agent 加为 Project owner，因此会改变预览数据量和 Attention 行数。使用它产生的 profile 不能进入性能基准样本。

## 路径影响

| 范围 | 变化 | 性能影响 | 判断 |
| --- | --- | --- | --- |
| Host 插件装配与 Member 激活 | `packages/agent-team/src/index.ts`、preset、member runtime 均未变 | 无结构性变化 | 除外：等待 ledger 构造的历史部分 |
| Ledger 冷启动 | `sortedRecords()` 每条记录增加 `repairLegacyAttentionSource()` | 每个带 inbox 的 operation 执行两次小数组过滤；发现缺失来源时再复制行和 operation | 可能增加冷启动与全量校验成本，幅度未测 |
| 旧账本升级 | 旧行没有 `source`，新公开类型要求 `source` | 行只在内存补齐，不重写 SQLite；旧记录每次重放都重复补齐 | 应作为独立升级场景测量 |
| 新账本稳态 | 新 Attention 行保存 `source` | SQLite、JSON、schema parse 和 projection 行略大 | 应作为新格式场景单独测量 |
| 七个 Team tools | 工具数和输入参数未变；`team_attention`、`team_message`、`team_task` 增加输出字段或来源说明 | 工具定义和结果略大；没有额外 RPC 或模型轮次 | 低风险但应记录 token 和响应体积 |
| Thread/Main 通知 | `affectedMembersOf()`、recipient、marker、unread、wake 逻辑未变 | fan-out 人数与唤醒顺序不变 | 不应把通知尾延迟差异直接归因于本改动 |
| Client 入口 | `client/index.ts`、slot 注册和 Remote 方法数未变 | 仍只有普通 Web boot 的单一 Team Client entry；仍为 40 个 Remote 方法 | 生成 schema 变大，启动解析成本需实测 |
| Project/Board UI | 新增共享卡片组件；Board 执行者由文字改为头像栈；新增焦点轮询 | 不增加数据请求；大 Board 增加每卡渲染工作，创建 Task 后增加至多 12 帧的焦点等待 | 需要大任务板和慢查询场景 |
| 纯类型或测试 | `entities.ts`、`slots.ts`、`thread-actions.ts` 中的部分类型、`inbox-delivery.ts` 的 optional 标注及测试 | 不直接产生运行时操作 | 只保留生成 Remote 的间接影响 |

## 启动与加载

Host 的插件装配、Session 列表、Workspace 清理和 Member 串行恢复代码没有改。变化位于 `AgentTeamLedger` 构造时的 `replay()`：`sortedRecords()` 现在对每条带 inbox 的 operation 检查 Thread 与 Main Attention 的 `source`。

该检查有两个复杂度层次：

- 新格式记录没有缺失字段时，仍为每个 inbox operation 建立两个临时过滤结果。成本随 operation 数线性增长。
- 旧格式记录存在缺失字段时，还会复制 operation、inbox、attention set 和相关行。成本随旧 attention 行数线性增长。

补齐只在内存发生。旧 SQLite 行不会因为打开一次就获得 `source`，所以后续每次启动和每次 `validate()` 都可能再次补齐。提交后的 invariant 校验会重新遍历整个账本，因此同样可能带上这项开销。

Client 入口没有改成动态 import。新增的 `BoardCardFoot` 被两个已静态加载的页面引用，最终仍在同一个 Team Client bundle 中。Remote 方法数仍为 40，变化是结果 schema 中多次出现六值 `source` 枚举及说明。

现有构建产物的临时体积如下；它们只能用于预判，最终基准必须在两个目标提交上分别 clean build：

| 文件 | 早期基线 clean build | 当前现有产物 | 当前相对变化 | 说明 |
| --- | ---: | ---: | ---: | --- |
| `client.js` raw | 1,088,000 | 1,093,771 | +5,771 | 当前产物时间早于最终 rebase，需重建确认 |
| `client.js` gzip level 1 | 215,856 | 217,931 | +2,075 | Web server 使用的压缩级别 |
| `client.js` Brotli | 105,532 | 106,054 | +522 | 仅作辅助 |
| `typert.remote-client.js` raw | 415,622 | 418,751 | +3,129 | 当前产物已包含新增 schema |
| `typert.remote-client.js` gzip level 1 | 54,628 | 55,482 | +854 | Client 启动需要挂载 |

这些是体积差，不是启动耗时结论。必须另测 script decode/compile/evaluate、`remote.$mount()`、普通会话 boot 和 Team 页面首次可用时间。

## Tool call

七个工具的模型可见数量仍为 `team_inbox`、`team_attention`、`team_thread`、`team_dm`、`team_message`、`team_task`、`team_view`。没有新增工具，也没有修改工具输入参数。

可观察变化：

- `team_attention` 的状态、follow 和 unfollow 结果可携带 `source`；following 状态的可见文本多一句来源说明。
- `team_message` 的 start 结果可携带作者获得的 Attention 来源。
- `team_task` 的 claim 结果可携带调用者获得的 Attention 来源。
- Ledger 的 claim 结果原本已经包含 Attention 行，工具只读取新增字段；没有再次查询 projection。

因此，单次调用没有新增 Host RPC 或持久写。需要注意的是，写调用之后的异步全账本校验会执行新增的来源补齐扫描；这属于提交后背景成本。模型上下文成本则来自工具声明、结构化结果和可见文本的少量增加。

## 协作通知

Thread start/reply、Claim、Task responsibility 和 Project owner 变化现在写入确定性的 `source`，但这字段只用于解释 Attention 的来源，没有进入以下决策：

- 谁收到 mention、reply、activity 或 reminder。
- 谁处于 unread。
- 哪些成员需要 fan-out。
- warm 或 cold Member 如何 wake。
- Thread read 最多返回多少条事实。
- 何时允许下一次写。

所以对于“A 发消息，B 被唤醒，读取并回复”的主链路，算法与调用次数不变。可测差异只有：operation 和 projection 略大、提交后校验多一点扫描、tool result 多一个字段和一句说明。若端到端 p95 出现明显变化，不应直接归因于 fan-out 改写；先查样本数据、Host 调度和模型响应波动。

## Project、Board 与焦点

任务卡改为同一种展示：负责人显示文字，执行者显示最多三个头像和一个 `+N`，解决后的卡不再显示执行者槽。

```text
Task #12  [待验收]
修复成员唤醒后的读取门槛
负责人 Reeve · 执行者 [A][B][+2]                      12:34
```

Project Board 原来已经显示执行者头像，所以主要不是新增负担。全局 Task Board 原来只显示“我负责执行 / 已有执行者 / 未指派”文字，现在每个开放 Task 都构造头像列表和头像 DOM。全局 Board 会汇总所有 Workspace 的开放 Task，因此要按 Task 数、执行者数和 Workspace 数测渲染时间。

从 Main stream 创建 Task 后的交互路径为：

```text
提交成功
  -> 切换到 Board
  -> 刷新 Project 数据
  -> 下一帧查找 data-team-task-ref
  -> 最多重试 12 帧
  -> 聚焦新卡片；找不到时聚焦 Board tab
```

这条路径不阻塞发送结果，但会影响“Board 已出现、焦点仍在哪里”的可观察完成时间。慢查询或刷新失败时应测焦点最终落点；这不能用首屏 UI 测试代替。

## 基准执行边界

必须分别运行基线、候选和升级路径。不能只选当前工作树，也不能只比较两个 `HEAD`。

| 基准 | 代码和数据 | 回答的问题 |
| --- | --- | --- |
| 基线稳态 | 在 `c3a9704` clean checkout 中生成并打开基线格式 corpus | 改动前启动、tool call、通知和 Client 成本 |
| 候选稳态 | 在 `bf777c3` clean checkout 中从空库生成候选格式 corpus | 当前版本自身在 1k/10k/100k operation 下的规模曲线 |
| 升级路径 | 用 `c3a9704` 生成旧 corpus，再由 `bf777c3` 打开 | 缺失 `source` 的内存补齐成本 |
| 混合账本 | 先走升级路径，再由候选写入新 operation，随后重启 | 真实已安装用户从旧版升级后的长期成本 |
| 当前工作树冒烟 | `bf777c3` 加当前预览脚本 | 只确认最终 checkout 可启动、可预览；不报告为独立性能版本 |

基线格式 corpus 可以在两边打开；候选格式 corpus 含 `source`，旧版 strict schema 会拒绝。不得拿候选格式 corpus 在旧版上制造“失败”或“更慢”的结论。要比较新格式稳态，应为两个 commit 分别生成逻辑相同的独立 corpus。

建议样本矩阵：

| 路径 | 规模与变量 | 指标 |
| --- | --- | --- |
| Host 启动 | 1k/10k/100k operation；旧、新、混合格式；1/4/8/16 enabled Member | storage open、parse、ledger replay、validation、首查询、Host ready |
| 单次 Team tool call | 七个工具的 read/status/write/rejection；空数据和深历史 | p50/p95/p99、Host CPU、结果 bytes/token、声明 bytes/token |
| Thread 协作 | A reply 到 B read 再到 B reply；1/2/10/50 followers；warm/cold B | commit ack、notice queued/claimed、read commit、reply commit、turn idle |
| Main/Activity 通知 | 每条 Main post 或 Activity 的 follower 数；全项目未读规模 | fan-out 总时长、wake 队列延迟、event-loop lag |
| Project Board | 10/100/500 个开放 Task；每卡 0/1/4/8 个执行者 | mount/render、交互响应、DOM 节点数 |
| 全局 Task Board | 1/5/20 Workspace 汇总；大量开放 Task | 首屏、滚动/打开卡片、schema 和查询等待 |
| 创建 Task 焦点 | 热查询、慢查询、空结果、错误结果 | 从提交 ack 到卡片出现、卡片聚焦、tab 回退 |
| Client load | cold/warm cache；普通会话；恢复 Team mode；空/大 Team | raw/压缩体积、script compile/eval、Remote mount、根页面 ready、Team usable |

每一组都要固定 Team commit、Harness commit、Node/Chromium 版本、SQLite bytes、operation 数、旧/新 Attention 行数、Member 数、Session 大小、Workspace/Project/Task/follower 数和缓存状态。至少运行 30 次，报告 p50/p95/p99 与峰值 event-loop lag。

## 基准判读规则

- **启动回退候选：** 新格式稳态也变慢，或旧格式升级额外时间超过预设门槛。
- **Tool call 回退候选：** 七工具测试中 Host 处理时间稳定上升；若只有结果 token 增加，应归到模型上下文成本。
- **协作回退候选：** commit ack 或 notice queued 的 p95 随 follower 数上升；需同时报告全账本 invariant 校验造成的 event-loop lag。
- **Client 回退候选：** clean build 后 Team bundle/Remote 体积增长，并且浏览器 trace 中 compile/evaluate、Remote mount 或普通 boot 的首个可用时间同步上升。
- **Board 回退候选：** Task 数或执行者数增加时，全局 Board 的 commit、交互和滚动出现稳定的额外耗时。

当前只能确认结构影响和基准边界；没有任何由这些变更新增的毫秒级结论。
