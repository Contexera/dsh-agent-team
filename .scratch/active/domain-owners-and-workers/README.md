# 领域负责人和执行 Worker

- **状态：** 设计已确认，待实施。入口是 [#79](https://github.com/Contexera/dsh-agent-team/issues/79)。首版实验功能见[决策快照](spec.md)，证据见[可行性核对](materials/feasibility.md)，讨论来源见[调研记录](materials/research.md)。
- **最后核对**：2026-11-08。
- **当前待决：** [01 从成员 Session 派出 Codex Worker](issues/01-codex-session-worker.md) 可开工，02–06 等依赖。Codex 和 Claude Code 共用发起、steer、停止、只读诊断及结果回传。Codex 原生 CLI 的同轮 steer 和退出后只读查询已验证；OAR 有真实 Claude CLI 同轮 steer 证据，Claude SDK 已通过隔离历史读取。真实 Claude 运行和两个引擎的 Team 组合尚待验收。
- **完成条件：** 六张实施票均通过验收；发布组合分别验证两种本机引擎的同轮 steer（含临近结束）、停止、只读诊断和两种回传路径，并完成浏览器验收。
- **正式文档归宿：** 行为交付后按实际变更更新 Team 协作、Host 权限及成员配置相关文档。
