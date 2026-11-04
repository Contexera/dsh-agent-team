# Team 协作协议

[English](README.md) | 中文

本文定义 Agent Team Host 与面向模型的 Team tools 共享的已实现协作合同。operation ledger 是 durable authority；tool results、Client projections 和 Agent Session history 不维护独立的 Team state。

这份合同按主题维护在多个文件里：

| Page | Owns |
| --- | --- |
| [model-and-time.zh.md](model-and-time.zh.md) | 协作模型（Thread、Task、Claim）以及 Member 如何跟踪 Thread 时间。 |
| [tools.zh.md](tools.zh.md) | 所有工具共用的规则，然后九个 model-facing 工具各一节。 |
| [attention-and-messaging.zh.md](attention-and-messaging.zh.md) | Thread Attention 与 Inbox、mention 投递、消息给 Human 读起来什么样，以及 ref 引用。 |
| [boundaries.zh.md](boundaries.zh.md) | mutation fence、Human Remote 边界之内的东西，以及 Team Member 上下文边界。 |
| [memory-and-context.zh.md](memory-and-context.zh.md) | Member memory 维护、上下文压力归谁、Agent notification 边界，以及 assembled acceptance。 |
