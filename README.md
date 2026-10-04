# dsh-agent-team — Persistent Agent Teams for DeepSeek Harness

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@wowyuarm/dsh-agent-team?style=flat-square)](https://www.npmjs.com/package/@wowyuarm/dsh-agent-team)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/wowyuarm/dsh-agent-team?include_prereleases&style=flat-square)](https://github.com/wowyuarm/dsh-agent-team/releases)
[![Listed on Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/wowyuarm/dsh-agent-team/)

**dsh-agent-team** gives DeepSeek Harness agents that don't reset. Each agent is a durable Member with its own memory, notes, and skills — the Member you set up last week is still the same one this week, after its session ended, its context rolled over, or DSH restarted. You set the direction; Workspaces organize teams per project, Channels route responsibilities, and Task Threads keep one line of progress.

An opt-in plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): install it only where Team mode is needed; ordinary DSH sessions keep their normal preset roster.

## Core ideas

- **Agents are first-class team members, not just sessions.** Each member keeps its own memory, responsibility boundaries, and private space (memory, notes, and skills), while all agents collaborate in one shared project Workspace; multiple Workspaces manage multiple teams.
- **Workspaces organize everything.** Different projects live in different Workspaces, each managing its own Agents and Channels.
- **The Human routes Channels and responsibilities.** You decide who is in which channel and what they own; mentions route work to the right agent.
- **Task Threads carry one line of progress.** Claims set the direction, Threads hold the context, and multiple session agents advance the same line of work without talking past each other — the facts of the work live in one Thread.
- **No context babysitting.** Members manage their own context: roll over to a fresh one and stay on duty (`context_rollover`), return to a past anchor (`context_status` / `context_checkpoint`), or shorten the current one in place (`context_compact`); pending work survives switches and restarts, and memory and notes keep accumulating — a member carries its full memory into every new context.

## Preview

Team mode lives inside the ordinary DSH Web UI: Channels carry the discussion, the Inbox gathers what needs you, and Task Threads keep one line of progress.

![Channel in the DSH Web UI: member roster, @mentions, and Task references in the message flow](assets/readme/channel.png)

The Human Inbox leads with unread Threads that need you, followed by recently active ones:

![Human Inbox in the DSH Web UI: unread Threads that need you on top, recently active Threads below](assets/readme/inbox.png)

### Task Threads

A Task Thread keeps Claims, Agent handoffs, Human acceptance, and follow-up replies in one durable context.

![Task Thread in the DSH Web UI: Claims, Agent handoffs, Human acceptance activity, and the reply composer](assets/readme/task-thread.png)

If this looks useful, a star on [GitHub](https://github.com/wowyuarm/dsh-agent-team) helps other DSH users find it.

## Quick start

### 1. Check DSH

This release is certified against DSH `0.2.0-rc.2`. Install the DSH version explicitly rather than following `latest`: an unpinned install can resolve to a line outside the range this bundle declares. On DSH `0.1.7-rc.2`, stay on `@wowyuarm/dsh-agent-team` `0.1.15`.

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Install it globally if you want the `dsh` command for the steps below: `npm i -g @deepseek-ai/dsh@0.2.0-rc.2`.

Stop it, then install Agent Team into the `web` profile:

```sh
dsh plugin --profile web add @wowyuarm/dsh-agent-team@0.2.0
```

The version is pinned deliberately: pnpm skips releases published less than 24 hours ago, so an unpinned `@latest` install resolves to the previous release on release day.

### 2. Start the Web UI

```sh
dsh web
```

Do not start DSH from its source checkout (`pnpm dsh web`): source mode loads a second copy of the scope module, so every member reports `selected preset is not team-enabled`. Always start the compiled CLI.

Agent Team is opt-in. Installing it adds the bundle to the `web` profile; it does not modify the Harness installation or shipped defaults.

### 3. Verify and try it

Before starting the UI, you can inspect the composed profile:

```sh
dsh --profile web --dump-config
```

The output should include Team rows such as `wowyuarm-agent-team-scope` and `wowyuarm-agent-team-client`. In the browser, enter **Team mode** from the DSH navigation. The first useful path is:

```text
Team mode
└── select a Workspace
    ├── Channels -> New Channel -> send the first message
    └── Agents   -> Add Agent -> choose its initial Channels
```

Create an Agent only in a trusted Workspace. The Team Member preset intentionally grants managed Agent Sessions `danger-full-access`.

## Not to be confused with

Three other DSH plugins carry similar names and solve a different problem — one of them may fit you better:

| Plugin | What it is | Its unit of work |
| --- | --- | --- |
| [`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | Turns the current DSH session into a captain that assembles sub-agents, splits a goal into dependency-aware tasks, and coordinates them through direct messages | one **session** |
| [`toolclub/dsh-agent-team-gui`](https://github.com/toolclub/dsh-agent-team-gui) | A reusable plan → implement → review team with a model chosen per member, and a Run Center for token usage | one **workflow run** |
| [`limuyang2/agent-team`](https://github.com/limuyang2/agent-team) — publishes `@limuyang2/dsh-agent-team` | Builds a team of independent root agents inside one DSH window: mix models and providers, assign one Leader, and let every member work in its own conversation over a shared Workspace | one **assembled team** |
| **`dsh-agent-team`** (this plugin) | Every agent is a durable Member identity with its own private memory, notes and skills; Channels and responsibilities are yours to assign, and a Task Thread is one line of progress | a **standing team** |

The practical difference: a Member you created last week is still the same Member today — same memory, same responsibilities, same private notes — after its session ended, its context rolled over, or DSH restarted. In the other three, a team is assembled around the work at hand — a session, a workflow run, or a Leader-led team.

## Uninstall

Remove the bundle from the profile; this also removes its composed layers:

```sh
dsh plugin --profile web remove @wowyuarm/dsh-agent-team
```

## What it adds

- A durable single-host Team with Channels, Messages, Tasks, Threads, Claims, and Agent membership.
- A Web Client for Human control: create Channels and Agents, manage membership, send Messages, open Threads, and handle Tasks.
- An isolated `team-member` preset with five model-facing tools: `team_inbox`, `team_thread`, `team_message`, `team_claim`, and `team_view`.
- A pull-based collaboration protocol. Agent Inbox admission is durable, but it does not claim that the model has already processed the update.

The Team is one collaboration domain per DSH home. Its append-only operation ledger is the authority; UI, Remote responses, tools, Inbox, and other projections derive from committed operations. Ordinary DSH Sessions keep the profile's normal preset roster and do not receive Team tools or guidance.

## Install from a local checkout

For development, install the local bundle into the same profile:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-agent-team
dsh web
```

Published packages include built artifacts. A local checkout needs the adjacent Harness repository only for development checks, not for end-user installation.

## Development

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to propose a change, what CI runs, and what a pull request should contain.

Read [`docs/README.md`](docs/README.md) for the maintained documentation index. The usual checks are:

```sh
corepack pnpm install
npm run typecheck
npm test
npm run build
npm run lint
npm run test:browser
npm pack --dry-run
```

`npm run test:browser` uses the adjacent `../deepseek-harness` checkout, an isolated temporary profile, and `/usr/bin/google-chrome` (override with `CHROME_PATH`). It does not need provider credentials. For manual checks, `npm run preview:ui` loads Team fixtures without model streaming; `DEEPSEEK_API_KEY=... npm run preview` starts the real provider preview. Both preview commands clean up their temporary state on `Ctrl+C`.

Architecture and the collaboration contract are documented in [`docs/architecture/README.md`](docs/architecture/README.md) and [`docs/team-collaboration/README.md`](docs/team-collaboration/README.md).

## Acknowledgments

The collaboration shape of dsh-agent-team — named agent members, Channels, Task Threads, @mention routing, and per-member memory — originates from and borrows several design ideas from [Raft](https://raft.build/). Thank you for the work.

## License

[MIT](LICENSE)
