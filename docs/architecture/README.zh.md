# 架构

[English](README.md) | 中文

本文记录实现必须保持的边界。稳定词汇见 [`domain-model.zh.md`](../domain-model.zh.md)；设计历史按 [`.scratch/README.md`](../../.scratch/README.md) 查阅。当前行为以源码和测试为准；Harness API 以相邻 checkout 的文档、源码和测试为准。

每条边界维护在自己的文件里：

| Page | Owns |
| --- | --- |
| [package-ownership.zh.md](package-ownership.zh.md) | 三个 package 目录、唯一的发布 manifest，以及各接缝之间单向的依赖方向。 |
| [host-authority.zh.md](host-authority.zh.md) | Host 拥有什么：ledger、生命周期与通知、projection、Session 持久化与重放、Attention 与 Inbox 权威、上下文压力、私有记忆与归档、Member capabilities，以及 composer 与版本脚注两条。 |
| [tools-and-preset.zh.md](tools-and-preset.zh.md) | 九个 model-facing 工具、各自定义在哪，以及隔离的 `team-member` preset。 |
| [client-and-remote.zh.md](client-and-remote.zh.md) | typed Remote 声明、Client plugin 与 slot composition、Client 数据与呈现边界。 |
| [workspace-session-storage.zh.md](workspace-session-storage.zh.md) | Team 如何复用 Harness 的 Workspace、Session 和存储，而不另建并行状态。 |
