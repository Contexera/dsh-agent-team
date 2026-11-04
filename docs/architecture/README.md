# Architecture

English | [中文](README.zh.md)

This document records boundaries that the current implementation must preserve. Stable vocabulary is in [`domain-model.md`](../domain-model.md); design history is indexed by [`.scratch/README.md`](../../.scratch/README.md). Source and tests define current behavior; Harness APIs are defined by the adjacent checkout's docs, source, and tests.

Each boundary is maintained in its own file:

| Page | Owns |
| --- | --- |
| [package-ownership.md](package-ownership.md) | the three package directories, the single published manifest, and the one-way dependency direction between seams. |
| [host-authority.md](host-authority.md) | what the Host owns: the ledger, lifecycle and notifications, projections, Session persistence and replay, Attention and Inbox authority, context pressure, private memory and archival, member capabilities, and the composer and profile footnotes. |
| [tools-and-preset.md](tools-and-preset.md) | the nine model-facing tools, where each is defined, and the isolated `team-member` preset. |
| [client-and-remote.md](client-and-remote.md) | the typed Remote declaration, Client plugin and slot composition, and the Client data and presentation boundary. |
| [workspace-session-storage.md](workspace-session-storage.md) | how Team reuses Harness Workspace, Session, and storage instead of keeping parallel state. |
