# 包职责

[English](package-ownership.md) | 中文

本文说明发布包的边界和依赖方向。运行时权威见 [Host 权威](host-authority.zh.md)，工具名单见 [工具与 preset](tools-and-preset.zh.md)。

## 一个发布包，三个源码边界

根目录的 `package.json` 只发布一个包：`@contexera/dsh-agent-team`。以下三个目录都没有独立的 manifest；它们划分构建与导出边界，不单独发布。

| 目录 | 职责 | 入口 |
| --- | --- | --- |
| `packages/agent-team` | Host service、operation ledger、投影、Agent 生命周期、manager 运行时与 Remote 声明 | `src/index.ts` |
| `packages/tool-agent-team` | 模型可见工具的声明与处理逻辑 | `src/index.ts`、`src/subscription.ts` |
| `packages/client-agent-team` | Client 加载与浏览器展示 | Node：`src/index.ts`；浏览器：`src/client/` |

下图的箭头表示「使用」，不表示导入对方的内部实现：

```text
tool-agent-team   → live Host service
client-agent-team → typed Remote + public Team types
agent-team       → neither tool nor Client implementation
```

工具在执行时取得当前 Host service，既不另建 service，也不直接写入投影。浏览器通过 typed Remote 读取 Host 投影，并使用 Harness 的公开 slot 渲染。各边界之间不得用相对路径访问对方生成的 `lib/`。

构建机制与新增 operation 的清单统一维护在 [生成文件与模块边界](../development/generated-and-seams.zh.md)。

## Host 模块分工

`packages/agent-team/src/` 中的主要职责如下：

| 模块 | 职责 |
| --- | --- |
| `index.ts` | Host 组合、生命周期编排与 typed Remote 适配。 |
| `member-runtime.ts` | Member 的 Turn 等待、skill 挂载与私有记忆目录准备。 |
| `member-tool-policy.ts` | Member 的工具限制、Turn 授权与能力警告。 |
| `ledger.ts` | 持久提交、授权、重放校验与投影。 |
| `spec.ts` | 已存 operation 的 schema 与 Team 存储 domain 定义。 |
| `types.ts` | 公开类型入口，重新导出 `types/entities.ts`（id 与实体）、`types/operations.ts`（ledger 记录）和 `types/requests-results.ts`（按表面分文件的 Remote 请求、结果、回执与视图）。 |
| `invariant.ts` | companion 插件，在挂载时校验 ledger，并在提交后复查。 |

`MemberRuntimeDeps` 将运行时边界限定为三项依赖：Host `ctx`、`liveMemberContext` 解析函数，以及共享的只读 `runningAgents` 集合。ledger、Agent handle、通知与恢复编排仍由 Host 持有。

## 何时引入新边界

第二个调用方、第二种 adapter，或需要独立管理的状态，才足以支持拆分；行数本身不是理由。`index.ts` 承载组合，`ledger.ts` 承载权威。不要只为缩短文件而拆分，也不要在出现第二份真实实现前建立 `services/`、`utils/` 或 `adapters/`。

如果新模块只转发 props、改名调用或重新导出，既不持有状态也不维护约束，就应保留内联调用。失效的转发契约应删除，而不是留下空层。

多个模块共用的规则只能有一份实现。例如，`packages/agent-team/src/text.ts` 统一按 code point 计数和截断；按 code point 判断上限、却按 UTF-16 单元切片，会破坏这一规则。
