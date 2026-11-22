# 架构

[English](README.md) | 中文

本索引用于查找各项架构边界的维护文档。了解整体结构时先读包职责，再按本次改动涉及的边界继续阅读。

当前行为以源码和测试为准。术语见 [领域模型](../domain-model.zh.md)，Harness 契约见 [Harness 导航](../harness-navigation.zh.md)。[工作历史](../../.scratch/README.md) 不是实现依据。

每条边界只有一份维护文档：

| 文档 | 职责 |
| --- | --- |
| [包职责](package-ownership.zh.md) | 三个源码目录、唯一的发布包及单向依赖。 |
| [Host 权威](host-authority.zh.md) | ledger、生命周期、投影、通知、上下文、私有记忆、能力配置、订阅、Worker、附件与 Human 设置。 |
| [工具与 preset](tools-and-preset.zh.md) | 模型可见工具的定义，以及隔离的 `team-member` 和 `team-manager` preset。 |
| [Client 与 Remote](client-and-remote.zh.md) | typed Remote、Client 插件、slot 组合及数据与展示的边界。 |
| [Workspace、Session 与存储](workspace-session-storage.zh.md) | 复用 Harness 状态、Session 读取失败策略，以及 manager Session 的持久指针。 |
