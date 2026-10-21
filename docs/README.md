# dsh-agent-team Documentation

English | [中文](README.zh.md)

This directory contains the maintained engineering documentation for this repository. The root `AGENTS.md` keeps only rules that every task must know; [`AGENTS.md`](AGENTS.md) here routes doc edits and maintenance — read it before changing anything under `docs/`. Use this index for detailed workflows, architecture, domain language, and cross-repository navigation.

## Documentation entry points

| Document | Purpose | Read it when |
| --- | --- | --- |
| [`development/README.md`](development/README.md) | Setup, commands, generated artifacts, live/UI preview, browser replay, and release checks | Starting development, running verification, changing a package, or changing release layout |
| [`development/start-and-checks.md`](development/start-and-checks.md) | Setup and the verification gradient | Starting work, or deciding which check a change needs |
| [`development/generated-and-seams.md`](development/generated-and-seams.md) | Browser evidence, generated files, package seams, and adding a Host operation | Touching generated files, package seams, or a Host operation |
| [`development/environments-and-install.md`](development/environments-and-install.md) | Sandbox/CI environments and external installation verification | Running in CI, or verifying an installed bundle |
| [`development/storage-and-delivery.md`](development/storage-and-delivery.md) | Ledger storage routing, notification regression, and the delivery checklist | Changing storage routing, notifications, or preparing a delivery |
| [`dsh-release-compatibility.md`](dsh-release-compatibility.md) | Evaluating new DSH versions, isolated certification, installation checks, and release gates | DSH releases, updating `peerDependencies`, or investigating cross-version installation failures |
| [`release-runbook.md`](release-runbook.md) | The end-to-end procedure for publishing a bundle version: pre-flight, check ladder, release material, tag and publish, post-publish verification | Publishing a version, or reviewing what a release must prove before it ships |
| [`architecture/README.md`](architecture/README.md) | Host, tools, command, typed Remote, Client plugin, and authority boundaries | Changing runtime, RPC, preset, Client, or persistence |
| [`architecture/package-ownership.md`](architecture/package-ownership.md) | The three package directories, the published manifest, and the one-way dependency direction | Changing package seams, manifests, or import direction |
| [`architecture/host-authority.md`](architecture/host-authority.md) | What the Host owns: ledger, lifecycle, projections, Session persistence, Attention, context pressure, private memory, and member capabilities | Changing Host runtime, persistence, replay, Attention, or memory behavior |
| [`architecture/tools-and-preset.md`](architecture/tools-and-preset.md) | The eleven model-facing tools, their defining modules, and the isolated `team-member` preset | Changing a model-facing tool or what the preset mounts |
| [`architecture/client-and-remote.md`](architecture/client-and-remote.md) | The typed Remote declaration, Client plugin and slot composition, and the Client data/presentation boundary | Changing RPC, Client plugin loading, slots, or projection |
| [`architecture/workspace-session-storage.md`](architecture/workspace-session-storage.md) | Reuse of Harness Workspace, Session, and storage instead of parallel Team state | Changing Workspace selection, Session storage, or ledger routing |
| [`domain-model.md`](domain-model.md) | Stable Agent Team vocabulary | Changing domain semantics, type names, or the collaboration contract |
| [`team-collaboration/README.md`](team-collaboration/README.md) | The implemented seven-tool, Thread Attention, Inbox, reading, mention, and mutation-fence contract | Changing collaboration semantics, model-facing tools, or Agent notifications |
| [`team-collaboration/model-and-time.md`](team-collaboration/model-and-time.md) | The collaboration model and Member time awareness | Changing what a Thread, Task, Claim, or a time notice means |
| [`team-collaboration/tools.md`](team-collaboration/tools.md) | The eleven model-facing tools and the rules shared by all of them | Changing a tool contract, its refs, or the mutation fence around it |
| [`team-collaboration/attention-and-messaging.md`](team-collaboration/attention-and-messaging.md) | Attention, Inbox, mentions, human-readable messages, and ref citation | Changing notifications, mention delivery, or how a Message is rendered |
| [`team-collaboration/boundaries.md`](team-collaboration/boundaries.md) | Mutation fences, the Human Remote boundary, and the Team Member context boundary | Changing who may mutate what, or what a Member may see of another Session |
| [`team-collaboration/memory-and-context.md`](team-collaboration/memory-and-context.md) | Member memory, context pressure ownership, Agent notifications, and assembled acceptance | Changing memory upkeep, context pressure handling, or what acceptance must prove |
| [`frontend-design/README.md`](frontend-design/README.md) | Long-lived Team Client UI system: principles, layout, typography, components, accessibility, and verification | Changing visible UI or interaction under `packages/client-agent-team/src/client/` |
| [`frontend-design/principles-and-language.md`](frontend-design/principles-and-language.md) | Design principles and DSH design-language alignment | Deciding which primitives to reuse, or aligning with the DSH language |
| [`frontend-design/layout-and-typography.md`](frontend-design/layout-and-typography.md) | Layout skeleton, typography, colour, and identity | Changing layout, type scale, or colour |
| [`frontend-design/components.md`](frontend-design/components.md) | The per-component contracts | Changing a Team component or its states |
| [`frontend-design/thread-and-composer.md`](frontend-design/thread-and-composer.md) | Timeline scrolling, composer and mentions, entry rows, status pills | Changing scrolling, the composer, entry rows, or status pills |
| [`frontend-design/sidebar-browser.md`](frontend-design/sidebar-browser.md) | The sidebar browser and the Inbox surface | Changing the sidebar browser or the Inbox surface |
| [`frontend-design/refresh-copy-accessibility.md`](frontend-design/refresh-copy-accessibility.md) | Refresh semantics, copy, accessibility, and evolution | Changing refresh behavior, copy, or accessibility |
| [`harness-navigation.md`](harness-navigation.md) | Routes through this repository and `../deepseek-harness`, including source entry points and integration traps | Unsure which Harness document, package, source, or test to inspect |

## Documentation rules

Editing or adding a document under `docs/`? Routing branches and the maintenance discipline live in [`AGENTS.md`](AGENTS.md) — read it first.

## Where to start

- **Host or domain changes:** [`architecture/README.md`](architecture/README.md) for boundaries, [`domain-model.md`](domain-model.md) for vocabulary; `packages/agent-team/src/` and its tests are the authority. Use `.scratch/README.md` to locate historical decisions when needed.
- **Tools or preset changes:** the relevant sections of [`architecture/README.md`](architecture/README.md), then the Harness cookbook and subsystem docs.
- **Client or UI changes:** [`frontend-design/README.md`](frontend-design/README.md) for the UI system, [`harness-navigation.md`](harness-navigation.md) for the cross-repository route.
- **Installation, build, tests, or Remote generation:** [`development/README.md`](development/README.md), then the actual `package.json` or script implementation.
- **Publishing a release:** [`release-runbook.md`](release-runbook.md) for the procedure and its gates, then [`dsh-release-compatibility.md`](dsh-release-compatibility.md) for the certification that must precede any peer-range change.
