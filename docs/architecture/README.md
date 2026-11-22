# Architecture

English | [中文](README.zh.md)

This index routes architecture questions to the document that owns the boundary. Start with package ownership for the overall shape, then follow the boundary you are changing.

Source and tests define current behavior. Use [`domain-model.md`](../domain-model.md) for vocabulary and [`harness-navigation.md`](../harness-navigation.md) for Harness contracts. [`.scratch/README.md`](../../.scratch/README.md) indexes design history, not implementation authority.

Each boundary is maintained in its own file:

| Page | Owns |
| --- | --- |
| [package-ownership.md](package-ownership.md) | the three package directories, the single published manifest, and the one-way dependency direction between seams. |
| [host-authority.md](host-authority.md) | ledger authority, lifecycle, projections, notifications, context, private memory, capabilities, subscriptions, Workers, attachments, and Human settings. |
| [tools-and-preset.md](tools-and-preset.md) | the model-facing tools, where each is defined, and the isolated `team-member` and `team-manager` presets. |
| [client-and-remote.md](client-and-remote.md) | the typed Remote declaration, Client plugin and slot composition, and the Client data and presentation boundary. |
| [workspace-session-storage.md](workspace-session-storage.md) | how Team reuses Harness Workspace, Session, and storage instead of keeping parallel state. |
