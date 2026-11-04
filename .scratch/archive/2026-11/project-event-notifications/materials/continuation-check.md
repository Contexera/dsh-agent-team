# 继续讨论前的核查

日期：2026-11-03。核查基线：Team `81c27a1`；本机相邻 Harness `687f282e86`（0.2.1-rc.2）。已读取工作区中的未提交设计修订。本文区分源码事实与讨论建议，不替代 `spec.md`，也不表示建议已经获 Human 认可。

## 已核实事实

| 问题 | 结果 | 证据 |
| --- | --- | --- |
| 凭据值从哪里取得 | Harness 已有 `ctx.credentials.resolve(ref)`，按次解析；`describe(ref)` 只返回是否配置等信息。接口参数不含 Team 的 Project 身份，Project 的可用凭据范围需要 Team 自己规定。 | [凭据服务](../../../../../deepseek-harness/packages/credentials/credentials/src/index.ts)，第 174–192 行；[维护文档](../../../../../deepseek-harness/docs/subsystems/credentials.md)。 |
| 凭据如何进入脚本 | `ShellExecRequest.env` 支持显式注入；子进程先清除父进程中的敏感变量，再合并显式值。Team 可复用这两项能力，无需另建密钥存储。 | [shell 请求类型](../../../../../deepseek-harness/packages/shell/shell/src/types.ts)，第 85–103 行；[子进程环境规则](../../../../../deepseek-harness/packages/subprocess/subprocess/src/index.ts)，第 40–71 行；[bash 执行器](../../../../../deepseek-harness/packages/shell/bash-local/src/index.ts)，第 149–175 行。 |
| 是否能从 shell 结果严格校验原始 UTF-8 | `ctx.shell` 的结果与增量读取都返回字符串；本地采集器使用 `Buffer.toString('utf8')`，非法字节会被替换。事后检查 JSON 不能恢复原始字节是否合法。 | [shell 类型](../../../../../deepseek-harness/packages/shell/shell/src/types.ts)；[输出类型](../../../../../deepseek-harness/packages/subprocess/subprocess/src/types.ts)，第 21–29 行；[采集器](../../../../../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts)，第 265–308 行。 |
| 更低层是否提供原始字节 | `ctx.subprocess` 的 pipe 模式提供 `Readable`，但它不负责 shell 选择或沙箱策略。直接改用它会增加 Team 对执行行为的责任，不能视为替换一个读取函数。 | [子进程类型](../../../../../deepseek-harness/packages/subprocess/subprocess/src/types.ts)，`SubprocessOutputMode`、`SubprocessSpawnSpec`、`SubprocessHandle`；[服务定义](../../../../../deepseek-harness/packages/subprocess/subprocess/src/index.ts)。 |
| 当前账本是否提供跨队列事务 | Team 的 durable domain 只声明 `operations` 表；vendored SQLite KV 的写入是单条语句，当前接口不提供队列更新与账本追加之间的联合事务。 | [领域声明](../../../../packages/agent-team/src/spec.ts)，第 767–773 行；[SQLite KV](../../../../packages/agent-team/src/vendor/storage-sqlite/unit.ts)，第 12–17、106–110 行。 |
| 内置沙箱约束什么 | 沙箱词汇表只描述文件写入效果（`read-only` / `workspace-write` / `danger-full-access`），`workspace-write` 的允许清单只有可写根目录；网络与进程可见性不在词汇表内。读取不受限。 | [沙箱类型](../../../../../deepseek-harness/packages/sandbox/sandbox/src/index.ts)，`SandboxMode` 注释；[可写根推导](../../../../../deepseek-harness/packages/sandbox/sandbox/src/roots.ts)。 |
| 凭据值存放在哪 | `credentials-local` 是 `ctx.credentials` 的标准实现，值在 `$DSH_HOME/.credentials.yaml`（普通文件），下层是进程环境与 `.env`。受限脚本以 Host 用户身份运行，可读该文件。 | [本地提供方](../../../../../deepseek-harness/packages/credentials/credentials-local/src/index.ts)，第 2–9 行；[能力缝表](../../../../../deepseek-harness/docs/capability-seams.md)，`ctx.credentials` 行。 |
| 凭据如何注册 | Human 在既有设置界面（或环境变量、`.env`）中录一次值即可，全局生效；settings controller 以 Remote 暴露 describe/set/unset，视图不含值。Team 不需要自建注册机制。 | [凭据控制器](../../../../../deepseek-harness/packages/api/settings-controller/src/credentials.ts)；[维护文档](../../../../../deepseek-harness/docs/subsystems/credentials.md)。 |

## 设计中仍需明确的内容

无。凭据授权范围已定：全局注册 + 订阅引用，不设按 Project 清单（依据见上文事实表）。仅剩“执行器验收”是实施阶段的验证项：严格 UTF-8 与 shell 类型识别需要具体的公开接口方案；真实平台 enforcement 不能标为已经通过。

## 本轮建议，待讨论

- 按既定的账本权威原则，接受后的事件内容进入账本，发布队列可由接受与发布记录重建；运行输出日志保持可淘汰。原始入站请求与未交接的运行进度是必须保留的传输状态，不能称为可任意删除的缓存。**已写入 spec（应用账本唯一事实来源原则，消除 §4.1 与 §4.4 的矛盾）。**
- 凭据：Human 在既有设置界面全局注册（一次录入，Team 不建注册机制）；订阅只保存 ref → env 引用（最多 8 项，env 名避开 `DSH_TEAM_` 前缀），Host 每次运行前解析并注入，订阅不保存值；不设 Team 侧按 Project 的可用凭据清单——注册动作本身就是 Human 的授权面，且沙箱只约束写入，清单挡不住脚本直读凭据存储文件，属安全表演习。校验放在创建/更新/试运行时（`describe` 确认已配置）与运行时（未配置则本次运行明确失败）。**已确认，写入 spec。**
- 显式重新初始化只追加要忽略的 id，保留原有去重记录，已接受的待发布事件继续发布；普通修改订阅不改变去重记录，webhook 测试样本也不计入真实历史。**已确认，写入 spec。**
- 自动重试固定接收时的配置版本；人工重放默认选当前版本，以便修复脚本后处理旧请求，并允许明确选择原版本。重置 webhook 地址保留已经接收的请求，旧地址随后发来的请求被拒绝。**已确认，写入 spec。**

## 验证范围

已执行一个符合输出格式的 Node 样本：在 JSON 的 id 中插入非法字节 `0xff`。严格 UTF-8 解码拒绝它，而 `Buffer.toString('utf8')` 后 `JSON.parse` 仍成功，确认字符串阶段不能完成原始字节校验。未运行真实 Harness 执行器、功能测试或浏览器测试；本轮未修改实现。

Nowledge Mem 的空间列表、健康检查、Working Memory 与定向搜索均返回 HTTP 502；本轮以工作项文档和已检查源码恢复上下文，没有取得记忆检索结果。
