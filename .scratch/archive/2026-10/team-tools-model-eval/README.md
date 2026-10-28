# Team 工具 × 新模型（gpt-6.1-sol）系统评测

> 本工作项把「每次被咬到再修」的循环换成系统化评测：用真实模型驱动真实 Host 上的七个 Team 工具，量化每个工具的传参习惯、拒绝率与恢复成本，并沉淀可复跑的评测 harness。
> 它不定义当前产品行为——行为以 `packages/` 源码、测试与 `docs/` 双语对为准。

**状态**：**已归档（2026-10-28，Human 要求「暂时归档」）。** Task #4 于 10-28 11:15 被 Human accept，我的 Claim 随之完成。交付物：两层评测 harness + 语料 + 修复 `a03c0a0`（归档时**未推送**，在本地 master 等发布窗口）。归档**不删任何东西**：harness、语料结论、修复记录与 Human 的回归清单全部随本目录进入 `.scratch/archive/2026-10/`；真实环境试出新结论时再 revival 或新开工作项。

**最后核对日期**：2026-10-28（归档）

## 入口

- 讨论 Thread：`thread:12f0fa72`（Evaluation Project）。Human 10-28 拍板：用本机 `codex-proxy`（`127.0.0.1:3425`，Bearer `magpie`，模型 `auto/gpt-6.1-sol`）做测试环境，并指定本 scratch 记录探索、测试与后续讨论的解决方案。
- [`harness/`](harness/)：可复跑脚本（语料抽取 + 活模型评测）。**归档时已按新深度重写过相对导入**（archive 比 active 深一级），并用无模型冒烟从归档位置实跑验证过：
  `node --import tsx .scratch/archive/2026-10/team-tools-model-eval/harness/smoke.mts`
- [`materials/`](materials/)：已验证的探索结论。
- 输出物（日志、语料 JSON）在 `.scratch/local/team-tools-model-eval/`（gitignored，会丢，脚本可重建）。

## Human 回来后的回归验证清单

修复 `a03c0a0` 在真实环境生效的**前提**：dev profile 的成员进程吃 `packages/*/lib/` 构建产物 ⇒ 先 `build`（会独占共享树，树空了再做）再重启成员会话。之后值得盯的：

1. **直接验**：让成员读回一条消息时故意传序号当 ref（或等它自然踩到），看报错是否带指路（「copy a messageRef rendered by team_thread read, team_view, or an inbox notice」）且它下一轮改对——这条在 harness 里只验到「报错已指路」，没现场抓到「模型照指引恢复」。
2. **顺带核**：10-27 三修（空参归一化 / 读忽略页大小 / 发言忽略 start-only 参数）在真实会话零复发。
3. **可选扩**（Human 尚未挑）：场景集加「稳定诱发序号当 ref」的任务；十个场景再多跑几轮压稳 4/144 的发生率。

## 当前前沿（归档时定格）

- **第一层（离线回放语料）已建**：`harness/team-tools-shape-corpus.mjs` 全量扫 824 份 session log，产出 7,239 次 team 调用、159 种参数形状、按模型的拒绝/抛错分布（`materials/2026-10-28-corpus-findings.md`）。
- **第二层（活模型评测）已出数并落了第一处修复**：runner 用真实 persona 前缀 + 七个工具真实 schema 驱动 `auto/gpt-6.1-sol`（proxy 3425），累计 144 次调用：0 业务拒绝、0 空串填充、0 杂参，4 例抛错全是同一族（序号当 ref）。**坐实并修掉**：`team_thread message` 读回消息的 ref 报错没有指路（同族两处都有），模型被拒后绕路、任务没达成——`a03c0a0` 给 readMessage 家族四个抛点补了恢复指引，变异验证 + 失败点探针 + 全门禁过（`materials/2026-10-28-live-eval-findings.md`）。
- **未做的三项**（归档时仍开放，见 materials 末尾与上面回归清单第 3 条）：稳定诱发 message-read 形状的场景、`replyToMessageRef` 产品观察、build+重启生效提醒。

## 完成条件

- [x] runner 可一条命令复跑：boot 隔离 Host → 播种项目/成员/Thread → 模型经 proxy 驱动七个工具 → 落指标
- [x] 每个工具至少一个场景，产出：调用数、拒绝率、恢复轮数、空参/多参习惯
- [x] 活模型随机性处理：重复跑、报分布不报单点
- [x] 结论进 Thread（`thread:12f0fa72`）与 Human 讨论；涉及行为改动的落正式票据（`a03c0a0` + CHANGELOG）
- [x] Human accept（10-28 11:15）后按要求归档

## 正式文档出口

行为改动的出口已交付：`a03c0a0`（`packages/agent-team` 的 `ledger.ts` readMessage 家族四个抛点补恢复指引，`recovery-hints.ts` 增三个 registry kind）+ 对应测试 + `CHANGELOG.md` 一条 Changed。`docs/team-collaboration/tools.*` 与 `attention-and-messaging.*` 只陈述「未知或跨 Thread 的 ref 被拒绝」这一行为、不锁措辞，改动后仍准确（归档前 grep 核过），无需同步。评测方法与证据的出口即本目录（harness + materials），随归档进 Git。

## 与其它工作项的关系

承接 Evaluation Project 10-27 的工具修复线（`411b1c6` 空参归一化、`73b9693` 读操作忽略页大小、`b02102f` 契约测试同步、`5ad2362` 发言忽略 start-only 参数——10-28 核过，**四笔均已在 origin/master**）。那些修复的验证对象是「日志里已撞红的形状」；本工作项补上「模型还不知道的形状」这一层。
