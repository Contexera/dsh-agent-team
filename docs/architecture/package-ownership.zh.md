# Package ownership

[English](package-ownership.md) | 中文

```text
packages/agent-team
  Host service + operation ledger + projections + Agent lifecycle + Remote declarations
        │
        ├── packages/tool-agent-team
        │     model-facing team_inbox / team_thread / team_message / team_claim / team_view
        │
        └── packages/client-agent-team
              typed Remote client + Team mode + browser presentation
```

这三个目录是同一发布包 `@contexera/dsh-agent-team` 的构建与导出接缝，由根 `package.json` 声明；它们都没有自己的 manifest。依赖方向是单向的：Host 从不导入 Client 或 tools 的实现内部，tools 在执行时解析 live Host service，Client 只消费 typed Remote、公开类型与 Harness slots——绝不通过相对路径进入另一个接缝的生成 `lib/`。[`generated-and-seams.zh.md`](../development/generated-and-seams.zh.md) 负责接缝的具体机制、Host 模块布局与新增 operation 的清单。

- `packages/agent-team` 拥有 Team capability。service 自身保留 ledger、handles、notifications 与 recovery orchestration，模块划分如下：
  - `src/index.ts` 组装 service 并声明 Remote methods；
  - `member-runtime.ts` 在只依赖三个依赖项（`ctx`、live member context、共享 running-agents set）的接缝之后持有 per-Member runtime state（tool-policy restriction、capability warning、私有 skill 挂载与选择、私有 memory 供给）；
  - `ledger.ts` 提交 operations；
  - `spec.ts` 定义 operation records；
  - `types.ts` 把领域拆分（`types/entities.ts`、`types/operations.ts`、`types/requests-results.ts`）re-export 成唯一公开导入路径；
  - `invariant.ts` 校验运行时关系。
- `packages/tool-agent-team` 在 tools 执行时解析 live Team service。它不创建第二个 service，也不直接写入 projections。
- `packages/client-agent-team` 分为 Node 部分（`src/index.ts`）和 browser 部分（`src/client/`）。browser 部分通过 typed Remote 读取 Host projections，并通过 public Client slots 渲染。

接缝由第二个调用方、第二个 adapter 或独立持有的状态换来，绝不由行数换来。`index.ts` 与 `ledger.ts` 大，是因为它们承载 composition 与 authority，不是因为缺了一层；不要为了让单个文件变小而拆它们，也不要在真的出现第二份实现之前引入 `services/`、`utils/`、`adapters/` 目录。只做 re-export、只转发 props、只改名的模块不持有状态也不持有不变式：把调用内联，或删掉契约已经死掉的那一侧。
