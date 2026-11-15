# 04 — 退出后只读诊断的接口核对

> 文中链接的探针脚本位于 Git 忽略的 `artifacts/` 目录，未随仓库分发；这里保留路径作为来源记录。

**核对时间：** 2026-11-09。**范围：** Codex CLI 0.167.0、OAR 0.95.1、Harness 0.2.2-rc.1。本文记录实施中的实证与约束，不代表 04 已验收；当前事实仍以源码、测试和 Task #140 为准。

## 已核实的原生关联

Reeve 在独立临时目录、清空凭证的进程环境和本机 HTTP 假端点中构造失败执行，随后关闭写进程，再启动新的 app-server 读取同一记录：

- OAR `session.id` 与 CLI `thread.id` 相同；OAR 根执行记录的 `spanId` 与 CLI 回读的原生 turn ID 相同。这是同一次执行逐值比对，不是根据“一次只有一个 span”推断。
- `thread/start` 返回的记录路径与退出后 `thread/read` 返回的路径相同；`thread/turns/list` 仍返回 `failed` 及其错误。
- 该版 JSONL 首行 `session_meta.payload` 同时有 `id` 与 `session_id`，均等于原生 thread ID。
- 测试记录的构造阶段会请求本机假端点；退出后的查询没有新增模型端点请求。不能把“没有凭证，预计返回 401”当成不调用真实服务的防护。
- 结论只覆盖上述 Codex/OAR 组合，不外推到 Claude 或任意 runtime。OAR 的 Codex 投影直接以原生 `turnId`／`turn.id` 构造 `spanId`，但仍需把锚点绑定到本次输入，不能遇到多个候选时猜最后一条。

可复跑的原生对照探针（`artifacts/review-worker-native-read.mjs`）位于忽略区；从仓库根运行，并保留可执行文件搜索路径：

```sh
NODE="$(command -v node)"
env -i PATH="${PATH:?}" HOME=/tmp "${NODE:?}" --import tsx artifacts/review-worker-native-read.mjs
```

## 草稿中的三个确定反例

读取边界探针（`artifacts/review-worker-inspection-boundaries.mjs`）对同一读取入口有一个正对照和三个反例，核对时为 1 绿／3 红：

1. 文件属于正确 Session，但目标 turn 不存在，仍返回无说明的 `read`；只有 Session 元数据不能代表查到了该次执行。
2. `password=`、`x-api-key:` 后的测试值进入返回片段。OAR 的 `REDACTION_RULES` 只覆盖若干 Grok／CodeBuddy 帧，不是 Codex 文本清洗器；窄 token 外形匹配也不覆盖带敏感键名的自定义值。
3. 8 MiB 限制在 `readline` 产出整行后才检查；超长单行用例实际读取 8,454,504 字节，超过 8,388,608 字节上限。

```sh
node --import tsx artifacts/review-worker-inspection-boundaries.mjs
```

## `4fd5456` 的独立复核（2026-11-09 23:20）

Reeve 已读完该提交全部 33 个文件的差量；它尚未通过核验。发布版 CLI 的退出后正对照再次通过：同一原生 ID／路径、失败状态与失败片段一致，查询前后本机假端点请求数均为 6。未运行共同基线的完整门禁，也未重启 Host。

- 原来三项读取反例已转绿。读取器改用 `FileHandle.read` 后，字节探针也改为观测这个入口，并要求实际观测字节大于零；只保留旧 `createReadStream` 钩子会得到无意义的零字节通过。
- 扩充后的读取探针为 4 绿／3 红：带引号的敏感 JSON 键漏过 withholding；open 取得另一个真实 inode 而路径前后仍指回原文件时被接受；128 KiB 非法路径被完整回显到拒绝原因。完整报告的界限还须涵盖 native 字段与说明，不能只约束片段。
- 新增锚点生命周期探针（`artifacts/review-worker-anchor-lifetime.mjs`），直接运行 Team provider、只模拟 OAR、不启动进程或模型，连续两次为 1 绿／3 红。正常失败可携带私有锚点；取消与清理失败的调用顺序却是 `abort → dispose → records`，模拟器关闭 dispose 后的记录流时锚点丢失。这个结果证明捕获顺序不符合清理前捕获的要求，不代表已经实测发布版 OAR 在 dispose 后必然清空记录。
- 同一探针再加入另一个根 turn，当前收集循环直接选择最后一个，不能保证属于该次输入。无法唯一关联时应明确缺失，而不是猜测。
- Client 首轮只有列表行的入口，没有 Human 按编号读取窗口外记录的入口；该能力是已定交付条件，不能用删改窗口文案替代。Tars 继续收口实现，Iris 复核 Client 并在控件定稿后补组件说明。

```sh
node --experimental-test-module-mocks --import tsx artifacts/review-worker-anchor-lifetime.mjs
```

## 最终验收（2026-11-10，`032e10f`）

04 已接受，Task #140：task:d6312f96-9391-407a-8c3b-1e5059185e7c。上面的反例是修复过程，不再代表当前缺陷。Reeve 已全文核对实现与各次收口差量，独立读取探针 7/7、生命周期探针（含新增的 await 抛错路径）5/5 通过；取消前与所有结算路径均会尝试捕获，由本次执行携带快照。

另加真实 Team provider 对照探针（`artifacts/review-worker-provider-native.mjs`）：不手工组装锚点，而是调用生产 `startWorkerRun`，取其结果上的私有锚点，再关闭进程并由新的 CLI 回读。发布版 Codex 0.167.0 的 session／turn／路径逐值一致，失败片段可读；构造失败走本机假端点，查询前后端点请求数均为 6。

Vera 的独立整版门禁、新浏览器回归提交 `d46644f` 及最终 `032e10f` 上的窄跑已交付；Reeve 查看了桌面、动作组与 390×844 的三张新截图。完整命令与结果在 Task 的交付记录中。当前认证 GUI 未重启／更新，本验收不把临时测试 profile 冒充运行中的 Host。

## 已确定的实施约束

- 继续复用 `team_worker` 的 `inspect` 模式。Human 入口列活跃／未确认执行与最近 20 条已结束执行；先按 Workspace＋Member 过滤，再按结束时间取最近记录，并保留按编号查询更早记录的入口。活跃执行不读未结算的原生历史。
- 读取器在分行、JSON 解析前限制实际读取字节；核规范化路径、符号链接与打开后的文件身份。缺锚点、未命中 turn、权限／I/O 失败和截断都说明真实原因；旧字段缺失不能被解释成“从未打开原生会话”。
- 不重复读取 `last_agent_message` 作为诊断；已有部分输出仍走正常回传。原生错误文本使用保守的敏感键值清洗或整段 withholding，而不是把自由文本称作结构上安全。所有返回值连同摘要、锚点和说明一并受界限约束。
- 不使用模块级 `anchorsBySession` 交接元数据：sealed 分支会跳过取走操作，晚到结果还可能遗留条目。优先由每次执行的结果携带 Team 私有只读数据，或使用由已有执行所有者持有的显式回调；不改 Harness，不新增无所有者的注册表。
- 已核到当前 Harness 在外部执行清理后原样交回捕获的结果对象。若利用它传 Team 私有结果数据，仍须补真实 Harness 组合测试固定 parent／caller delivery、启动取消、清理失败和卸载行为；元数据捕获失败不能改变执行结局。
- 新字段可以保持可选、不升规则版本；严格 schema、字段约束、回放校验和旧 ledger 用例仍须更新。核心反例转绿后再展开工具、Remote、Client 与文档，最终仍需完整交付和独立验收。
