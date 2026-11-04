# Team Collaboration Protocol

English | [中文](README.zh.md)

This document defines the implemented collaboration contract shared by the Agent Team Host and model-facing Team tools. The operation ledger is durable authority; tool results, Client projections, and Agent Session history do not maintain separate Team state.

The contract is maintained in focused files:

| Page | Owns |
| --- | --- |
| [model-and-time.md](model-and-time.md) | The collaboration model — Thread, Task, and Claim — and how a Member keeps track of Thread time |
| [tools.md](tools.md) | The rules shared by every tool, then the nine model-facing tools one section each |
| [attention-and-messaging.md](attention-and-messaging.md) | Thread Attention and Inbox, mention delivery, how a Message reads for a Human, and ref citation |
| [boundaries.md](boundaries.md) | The mutation fence, what stays behind the Human Remote boundary, and the Team Member context boundary |
| [memory-and-context.md](memory-and-context.md) | Member memory upkeep, who owns context pressure, the Agent notification boundary, and assembled acceptance |
