# 合成场景与上下文量测

当前行为以 packages 源码与测试为准；本目录为工作项的验收工具，不读取个人 Session，也不调用真实模型。

## 当前组合场景

从仓库根运行：

```bash
npx vitest run --config .scratch/archive/2026-11/agent-tools-context-rendering/harness/vitest.config.ts --project context-scenarios
```

使用既有 realHarness、ScriptedAdapter 和真实 Agent loop，在同一 Session 中依次验证 F3（direct→post→read）、F5（压缩→无未读背景恢复→不重复）与 F6（长通知→message续读→显式确认），同时检查 Host 未读状态。F1、F2、F4 与更多边界复用 packages 下现有集成测试，定位见 `../materials/2026-10-30-acceptance-plan.md`。

输出 `.scratch/local/agent-context-implementation/context-snapshots.json`。它是合成场景快照，不是 Session 存储文件格式；不要传入个人日志。

## 当前量测

```bash
node --import tsx .scratch/archive/2026-11/agent-tools-context-rendering/harness/context-volume.mts .scratch/local/agent-context-implementation/context-snapshots.json
```

必须显式指定输入，不会默认扫描本机目录。可以传多个合成快照文件，分别列出文件数量、Session 数量及每个阶段。

- `cumulativeLog`：截至该检查点的全部已记录文本，按工具动作与 Member 背景类别分别计数。包括已经离开当前上下文的内容。
- `currentSurface`：通过 Harness 的 Session 投影得到的当前模型上下文文本。
- `requests`：真实 Agent loop 交给 ScriptedAdapter 的每次 GenerateOptions；文本、消息 JSON 和工具 schema JSON 分开计数。realHarness 的测试preset不包含完整发布persona，所以不是生产请求总长度或provider网络请求字节数。
- `partBindings` / `wholeMessageBindings`：输出中记录的分段／全文绑定次数，不代表唯一内容量或当前仍可见的内容量。

所有长度都是 UTF-16 代码单元，不是 token、费用或模型理解质量。每个检查点在自身 Session 内累计，不可把连续检查点相加。该工具通过实际 Session 的恢复验证事件和 surface，不从 metadata 单独推断可见事实。

## Member 分类更新对比

```bash
node --import tsx .scratch/archive/2026-11/agent-tools-context-rendering/harness/member-context-scenario.mts
```

固定合成 memory 与责任变化，对比基线 `deaa671` 和当前实现。每个版本独立 Session，分别输出单步注入、完整索引副本和当前 surface 字符数。

## 历史工具

`member-context-resend.mjs` 与 `member-context-triggers.mjs` 是旧个人日志研究入口，不属于当前验收命令，不应默认重跑。原 `context-volume.mjs` 的自动扫描实现已由上述显式合成输入工具替代；历史材料中的数字和命令保留原记录，不更新成新结果。

## 真实模型

ScriptedAdapter 固定行为，只证明组合和状态规则，不证明模型会正确理解。旧 `team-tools-model-eval` runner 自行拼 messages、直接 execute/render，适合历史参数形状评测，但不能验证本工作项的 Session 上下文恢复。真实模型验收应继续复用真实 Agent loop；运行前确认本轮模型配置和费用授权，不复制归档配置或凭据。

## 生产日志核对（免费的一半）

「模型看到的输出形状对不对」不需要付费调用：真实会话日志里有结果原文，对照 [spec](../spec.md) 承诺机械核查即可。脚本随本工作项归档在 [`production-result-quality-scan.mjs`](production-result-quality-scan.mjs)，只读离线，从仓库根运行 `node .scratch/archive/2026-11/agent-tools-context-rendering/harness/production-result-quality-scan.mjs` 即可复跑。**JSON 输出默认写到仓库外**（`$HOME/.dsh/result-quality-<ts>.json`，可用 `RESULT_QUALITY_OUT` 改）：它含拒绝样本与结果正文片段即真实内部讨论，而本仓库公开。方法与五轴结论见 [../materials/2026-11-05-production-result-quality.md](../materials/2026-11-05-production-result-quality.md)。

它读的是本机全部成员会话，与本目录的合成场景是两条独立证据：合成场景证明状态与接口规则，生产日志证明真实使用中的输出形状；两者都不证明模型理解。
