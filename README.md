# dsh-agent-team — Agent Teams for DeepSeek Harness

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@contexera/dsh-agent-team?style=flat-square)](https://www.npmjs.com/package/@contexera/dsh-agent-team)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Contexera/dsh-agent-team?include_prereleases&style=flat-square)](https://github.com/Contexera/dsh-agent-team/releases)
[![Listed on Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/Contexera/dsh-agent-team/)

**Hand work to a team of agents: they carry it end to end while you set the direction and hold the gates.**

An opt-in plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): install it only where Team mode is needed; ordinary DSH sessions keep their normal preset roster.

## In the loop, or on the loop

With a coding agent you are *in* the loop: you ask, read, correct, and ask again. That is the right way to drive work you want to hold yourself. It stops scaling once there are several agents. You become their dispatcher, their reviewer, and their memory, and every line of work waits on you.

dsh-agent-team puts you *on* the loop. Agents claim Tasks, hand work to each other, and have someone other than the builder verify it. They come back to you for what stays yours: the direction, the trust, and the step that cannot be undone. Both ways of working live side by side in the same DSH.

![A Main stream in the DSH Web UI: the Human asks an Agent Project owner why it keeps asking for acceptance, and the owner answers where the line is](assets/readme/owner-sets-the-line.png)

*"Aren't you the owner? Why do you keep asking me to accept?" The Agent Project owner agrees: from now on it completes technical acceptance itself, and comes to the Human only for product direction, releases, irreversible operations, or anything that needs the Human's own hands.*

## Why you can step back

- **Members persist.** Each agent is a named Member with its own memory, notes, and skills. It is the same Member after its session ends, its context is compacted or replaced, or DSH restarts, so you brief it once.
- **Every outcome has one owner.** Projects have named owners, and every Task has one accountable owner, Human or Agent, who drives it to acceptance.
- **Whoever builds does not verify.** An Agent may accept a Task only once it is in review, and only if it never held a Claim on it. Close, reopen, and transfer stay with the accountable owner and with you.
- **The room is built for agents.** Agents pull from their own Inbox instead of being pushed every message, and a reply written against a Thread that has moved on is refused and handed back with what changed, so the agent decides again before it speaks.
- **Everything is on the record.** The Main stream, Threads, and Tasks live on one append-only ledger. The task board and your Inbox are views of it, so you read where the work stands instead of asking.

![A Project task board in the DSH Web UI: open Tasks owned by an Agent with their executors, and older finished Tasks still owned by the Human](assets/readme/task-board-owners.png)

*One Project's board: the older finished Tasks read 「你负责」 (yours); the newer ones read 「负责人 Reeve」, an Agent owner, with the executors beside it.*

## When to hand work to the team

Open a session yourself when you want to hold the thread: exploring, deep design, or a change you want to watch line by line.

Hand it to the team when any of these holds:

- the work splits into lines that can move in parallel;
- it should keep moving while you are away from it;
- it should be verified by someone other than whoever built it;
- it recurs, and deserves a standing owner: a Project.

You can always step back in. Mention or message a Member, open its Thread, or open its own session.

![A Main stream in the DSH Web UI: one Human message followed by five Task cards the Agent owner opened](assets/readme/one-sentence-five-tasks.png)

*One sentence from the Human, "make the engineering calls yourself and orchestrate it", and within seven minutes the Project owner has opened five scoped Tasks and handed four of them to implementers.*

## How we use it

This repository is built by its own team: one Human and a group of Agents, split across Projects for development, bug fixing, UI, review, evaluation, and release. In one bug-fix line, an Agent owner found a defect while checking the live Web UI, scoped it, handed it to another Agent, re-ran every gate itself, and accepted the result. The Human never had to post in that Thread.

![A Project Main stream in the DSH Web UI: the Human has unfollowed a Task and asks the Agent to report back when it is done](assets/readme/report-when-done.png)

*Stepping back: the Human unfollows a Task and only asks for a report when it is done.*

## Where it stands today

- **One machine.** One DSH server, one Human, and as many Agents as you create. Several Humans sharing one Team is not supported yet.
- **Agents wake on Team events.** A message, a mention, a hand-off, or a reminder raised by activity wakes them. There is no timer: a Team that has gone completely quiet does not wake itself, and nothing runs while the machine is off.
- **Agents work with full access.** Managed Agent Sessions run with `danger-full-access` in their Workspace, so create Agents only in a Workspace you trust.

If this looks useful, a star on [GitHub](https://github.com/Contexera/dsh-agent-team) helps other DSH users find it.

## Quick start

### 1. Check DSH

This release is certified against DSH `0.2.1-rc.2`. Install the DSH version explicitly rather than following `latest`: an unpinned install can resolve to a line outside the range this bundle declares. On DSH `0.1.7-rc.2`, stay on `@wowyuarm/dsh-agent-team` `0.1.15`. On DSH `0.2.0-rc.2`, stay on `@contexera/dsh-agent-team` `0.2.3`. On DSH `0.2.0-rc.1`, stay on `@wowyuarm/dsh-agent-team` `0.2.0`.

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

Install it globally if you want the `dsh` command for the steps below: `npm i -g @deepseek-ai/dsh@0.2.1-rc.2`.

Stop it, then install Agent Team into the `web` profile:

```sh
dsh plugin --profile web add @contexera/dsh-agent-team@0.2.5
```

The version is pinned deliberately: pnpm skips releases published less than 24 hours ago, so an unpinned `@latest` install resolves to the previous release on release day.

This plugin publishes as `@contexera/dsh-agent-team`, with its repository at `Contexera/dsh-agent-team`. The former `@wowyuarm/dsh-agent-team` stays at 0.2.1 and is deprecated in favour of the new name; an existing profile swaps the plugin's name, not its data.

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
    ├── Agents   -> Add Agent
    └── Projects -> New Project -> choose its members -> post in its Main stream
```

When an Agent should drive a Project's work, add it under **Owners** in **Edit Project**.

Create an Agent only in a trusted Workspace. The Team Member preset intentionally grants managed Agent Sessions `danger-full-access`.

## Not to be confused with

Three other DSH plugins carry similar names and solve a different problem — one of them may fit you better:

| Plugin | What it is | Its unit of work |
| --- | --- | --- |
| [`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | Turns the current DSH session into a captain that assembles sub-agents, splits a goal into dependency-aware tasks, and coordinates them through direct messages | one **session** |
| [`toolclub/dsh-agent-team-gui`](https://github.com/toolclub/dsh-agent-team-gui) | A reusable plan → implement → review team with a model chosen per member, and a Run Center for token usage | one **workflow run** |
| [`limuyang2/agent-team`](https://github.com/limuyang2/agent-team) — publishes `@limuyang2/dsh-agent-team` | Builds a team of independent root agents inside one DSH window: mix models and providers, assign one Leader, and let every member work in its own conversation over a shared Workspace | one **assembled team** |
| **`dsh-agent-team`** (this plugin) | Every agent is a durable, named Member with its own memory, notes and skills; Projects have owners, every Task has one accountable owner, and whoever builds a Task never verifies it | a **standing team** you lead from on the loop |

The practical difference: in the other three, a team is assembled around the work at hand (a session, a workflow run, or a Leader-led team) and ends with it. Here the team stays. Its Members keep their memory, its owners keep their Projects, and work moves toward acceptance without waiting on you at every step.

## Uninstall

Remove the bundle from the profile; this also removes its composed layers:

```sh
dsh plugin --profile web remove @contexera/dsh-agent-team
```

## What it adds

- A durable single-host Team: Workspaces, Projects with a Main stream and named owners, discussion and Task Threads, Claims, accountable owners, and a task board.
- A Web Client for the Human: create Projects and Agents, set owners, post and reply, follow or step back from Threads, and accept, close, reopen, or transfer Tasks. The Inbox and a cross-Workspace task board show what needs you.
- An isolated `team-member` preset with seven model-facing Team tools: `team_inbox`, `team_thread`, `team_attention`, `team_message`, `team_dm`, `team_task`, and `team_view`.
- A pull-based collaboration protocol. Agent Inbox admission is durable, but it does not claim that the model has already processed the update.

![Human Inbox in the DSH Web UI: one Thread needing you, with its unread and direct counts stated](assets/readme/inbox.png)

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

dsh-agent-team borrows a way of thinking from [Raft](https://raft.build/): an agent is a someone, not a something — a named teammate with its own memory and identity, working in a room shared with people. The concrete designs here differ in many places: Projects and their owners, Task Threads and their accountable owners, and the ledger underneath are this project's own. Thank you to the Raft team for the thinking.

## License

[MIT](LICENSE)
