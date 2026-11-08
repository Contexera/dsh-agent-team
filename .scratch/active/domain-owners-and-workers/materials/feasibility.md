# #79 设计可行性核对

核对日期：2026-11-08。Team 基线 [b455aa8](https://github.com/Contexera/dsh-agent-team/commit/b455aa81f7469f12a60482cd8271748810b2cc66)，Harness 基线 [fcc0ad4](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)，OAR [0.67.0 / c264f17](https://github.com/botiverse/oar/tree/c264f17040dd9513b43300886a80f3f6eddde7b1)。这是实施前核对，不是 Team 功能验收。[#79](https://github.com/Contexera/dsh-agent-team/issues/79) 仍开放。

## Team 与 Harness 接入

| 要验证的行为 | 证据和结论 |
| --- | --- |
| Team 自有 provider 能进入 Harness 的执行管理 | [注册](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/index.ts#L522-L540)和[启动接口](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/index.ts#L244-L294)接受外部 provider；[外部 run 的 id](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L871-L885)成为 activation 的 childId，可以用来定位 provider 手中的活会话。Harness 另外生成内部 runId；它、Team 执行编号和原生会话 ID 不得互换。npm 已核对 `@deepseek-ai/dsh-subagent@0.2.2-rc.1` 存在。 |
| 停止的确认与执行结果分开 | [公开句柄](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/types.ts#L39-L66)支持启动前取消信号和发布后的 `dispose()`。[Harness 清理路径](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L1081-L1105)可能保留原结果同时报告清理失败。不能用收到“aborted”或任一文本输出证明进程已退出；用停止句柄的清理结果判定。 |
| 回传不用猜父 Session 或冒充成员 | [caller delivery](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L1108-L1128)不会再向父 Session 投递原生完成通知。Task 关闭后[普通 reply 会被拒绝](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L2376-L2388)，因此绑定结果应是 Host 记录的执行事实，保持 Task 原状态。Inbox 指向同一事实。 |
| 诊断能在进程释放后保留 | [OAR 会话接口](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/packages/oar/src/contracts/session.ts#L199-L208)在打开后给出原生 id 和当前进程观察到的事件。Harness 在发布回执后很快就可能清理；[结果在清理之后才交调用者](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L1092-L1105)。适配层应在释放前提取安全摘要，保留到 Host 接收，不能靠终态到来后再读活对象。临时委派可保留最小私有执行记录供 `inspect`，无须向 Project 公开或补投原 Session。 |
| 发布后仍有原生 CLI 可用 | Harness 发布包嵌入已打补丁的 OAR；[补丁](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/patches/%40botiverse__oar%400.67.0.patch)包含 Claude 权限参数处理及 Codex 启动失败清理。Team 自有 provider 直接使用 OAR 时不会自动得到这些修改。按实际装载版本验证权限参数、未安装和打开失败时的清理、环境变量处理以及发布包安装；不要从现成 provider 的测试推断 Team 已通过。 |

本机的两个 checkout 仅用于核对源码，未安装或构建项目。原生 CLI 可行性证据分别记录在下面，Team 组合验收由实施票负责。

## Codex：实际 CLI，使用本地模拟模型响应

子代理运行本机 `codex-cli 0.167.0-alpha.3.2`。用临时 `CODEX_HOME` 和无密钥的本地 Responses fixture；未改用户配置，也未调用真实模型。fixture 第一条响应触发两秒命令，第二条响应完成该轮。

1. 启动 `codex app-server --listen stdio://`；依次发送 `initialize`、`thread/start`、`turn/start`。收到命令开始事件后，向同一 thread 和预期 turn 发 `turn/steer`。
2. CLI 返回同一 turn ID；命令结束后的第二个模型请求包含 steer 的唯一标记，最终只产生一个完成 turn。
3. 关闭并等待第一个进程退出。另起 app-server，使用同一原生存储位置和 thread ID，依次调用 `thread/read`、`thread/turns/list`、`thread/items/list`。读到同一 turn 和 steer 输入，线程状态仍为 `notLoaded`；没有调用 `thread/resume`，也没有新增模型请求。
4. 查询使用原来的原生存储位置；换成空的存储位置时，同一 ID 不能找到记录。Team 应保留该次原生存储的定位信息及 thread／turn 归属，不根据当前默认位置猜测。

复核依据：[Codex steer 第一方测试](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/app-server/tests/suite/v2/turn_steer.rs#L258-L445)、[进程重启后只读查询测试](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/app-server/tests/suite/v2/thread_read.rs#L250-L354)、[OAR 0.67.0 的 Codex steer](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/docs/runtimes/codex.md#L278-L289)。本次证明 CLI 协议和持久历史可行；未运行 Team provider，也未验证真实模型的服从性、失败路径或并行读写。

## Claude Code：实际 SDK，只读隔离记录

从 npm 发布包直接取出 `@anthropic-ai/claude-agent-sdk@0.3.263` 的 `sdk.mjs`，在临时配置目录放入两个不同项目和 UUID 的合成 JSONL。用 `getSessionMessages(id, { dir, limit: 2 })` 反序读取，均返回对应内容；随机缺失 ID 返回空；读取前后的两个文件一致。执行查询时 PATH 不含 CLI，未启动 CLI 或模型。复核依据：[Claude SDK 只读接口](https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages)。

子代理用独立隔离记录复核：正确的 ID 与原目录读到 user 和 assistant 两条；传错误目录返回空，省略目录会扩大搜索范围。因此查询必须带上发起时的目录和原配置位置，不省略目录或换目录搜索。

同时从发布包核对 OAR `0.67.0` 类型声明导出 native id、可选 steer、事件与记录接口。OAR 已用[真实 Claude CLI 和本地模型模拟响应](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/docs/runtimes/steer-delivery.md#L22-L35)观察到：在工具运行期间提交指令，Claude 在同一轮的下一次模型调用收到它。若输入到达时已过当前轮的最后一个模型步骤，Claude 可能把输入用于[下一轮](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/docs/runtimes/claude.md#L265-L278)。这是收尾时序风险，不否定正常同轮行为。

Codex 和 Claude Code 均须交付同轮 steer、停止和回传。对 Team 组合仍需用实际 Claude CLI 重跑正常与临近结束的场景；OAR 的通用投递可以把未能同轮追加的输入排队或转为新一轮，不符合 #79 的同轮约定。
