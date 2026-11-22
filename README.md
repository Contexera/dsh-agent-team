# dsh-agent-team — Agent Teams for DeepSeek Harness

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@contexera/dsh-agent-team?style=flat-square)](https://www.npmjs.com/package/@contexera/dsh-agent-team)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Contexera/dsh-agent-team?include_prereleases&style=flat-square)](https://github.com/Contexera/dsh-agent-team/releases)
[![Listed on Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/Contexera/dsh-agent-team/)

**Give a standing team of Agents the work. You set the direction and keep the decisions that need you.**

Agent Team is an opt-in plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Install it only in profiles where you want Team mode. Ordinary DSH Sessions keep their existing presets.

## In the loop, or on the loop

With a coding agent you are *in* the loop: you ask, read, correct, and ask again. That is the right way to drive work you want to hold yourself. It stops scaling once there are several agents. You become their dispatcher, their reviewer, and their memory, and every line of work waits on you.

dsh-agent-team puts you *on* the loop. Agents claim Tasks, hand work to each other, and have someone other than the builder verify it. They come back to you for what stays yours: the direction, the trust, and the step that cannot be undone. Both ways of working live side by side in the same DSH.

## How we use it

This repository is built by its own team: one Human and a group of Agents, split across Projects for development, bug fixing, UI, review, evaluation, and release. In one bug-fix line, an Agent owner found a defect while checking the live Web UI, scoped it, handed it to another Agent, re-ran every gate itself, and accepted the result. The Human never had to post in that Thread.

![A Main stream in the DSH Web UI: one Human message followed by five Task cards the Agent owner opened](assets/readme/one-sentence-five-tasks.png)

## Why you can step back

- **Members persist.** Each agent is a named Member with its own memory, notes, and skills. It is the same Member after its session ends, its context is compacted or replaced, or DSH restarts, so you brief it once.
- **Every outcome has one owner.** Projects have named owners, and every Task has one accountable owner, Human or Agent, who drives it to acceptance.
- **Agents cannot accept their own work.** An Agent must be a Project owner or the Task's accountable owner to accept it, and can do so only when it is in review and the Agent has never held a Claim on it. The accountable owner and the Human can close, reopen, or transfer the Task.
- **The room is built for agents.** Agents pull from their own Inbox instead of being pushed every message, and a reply written against a Thread that has moved on is refused and handed back with what changed, so the agent decides again before it speaks.
- **Everything is on the record.** The Main stream, Threads, and Tasks live on one append-only ledger. The task board and your Inbox are views of it, so you read where the work stands instead of asking.

![A Project task board in the DSH Web UI: open Tasks owned by an Agent with their executors, and older finished Tasks still owned by the Human](assets/readme/task-board-owners.png)

## When to hand work to the team

Open a session yourself when you want to hold the thread: exploring, deep design, or a change you want to watch line by line.

Hand it to the team when any of these holds:

- the work splits into lines that can move in parallel;
- it should keep moving while you are away from it;
- it should be verified by someone other than whoever built it;
- it recurs, and deserves a standing owner: a Project.

You can always step back in. Mention or message a Member, open its Thread, or open its own session.

![A Project Main stream in the DSH Web UI: the Human has unfollowed a Task and asks the Agent to report back when it is done](assets/readme/report-when-done.png)

![A Main stream in the DSH Web UI: the Human asks an Agent Project owner why it keeps asking for acceptance, and the owner answers where the line is](assets/readme/owner-sets-the-line.png)

## Where it stands today

- **One Host and one Human.** Several Humans sharing one Team is not supported.
- **Agents wake on notifications and schedules.** Messages, mentions, and handoffs can notify a Member. Member reminders and Project subscriptions also run on a schedule. The Team does not wake without an event or an active schedule, and nothing runs while the Host is off.
- **Agents work with full access.** Managed Agent Sessions run with `danger-full-access` in their Workspace, so create Agents only in a Workspace you trust.

If this looks useful, a star on [GitHub](https://github.com/Contexera/dsh-agent-team) helps other DSH users find it.

## Quick start

### 1. Check DSH

This release was first certified against DSH `0.2.2-rc.2`. Pin that version for the quick start instead of relying on the moving `latest` tag. See the [compatibility record](docs/dsh-release-compatibility.md) for other certified versions.

To try the pinned CLI without installing it globally:

```sh
npx @deepseek-ai/dsh@0.2.2-rc.2 web
```

Stop the trial server if you started it. For the steps below, install the pinned CLI globally if you do not already have it: `npm i -g @deepseek-ai/dsh@0.2.2-rc.2`.

If you need to stay on an older DSH version:

| DSH | Agent Team |
| --- | --- |
| `0.2.2-rc.1` | `@contexera/dsh-agent-team@0.2.7` |
| `0.2.1-rc.2` through `0.2.1-rc.5` | `@contexera/dsh-agent-team@0.2.6` |
| `0.2.0-rc.2` | `@contexera/dsh-agent-team@0.2.3` |
| `0.2.0-rc.1` | `@wowyuarm/dsh-agent-team@0.2.0` |
| `0.1.7-rc.2` | `@wowyuarm/dsh-agent-team@0.1.15` |

### 2. Install and start the Web UI

Install the bundle into the `web` profile. Use the exact bundle version shown rather than relying on an unpinned install.

```sh
dsh plugin --profile web add @contexera/dsh-agent-team@0.2.9
dsh web
```

Use the installed `dsh` CLI for the published bundle. Starting it through the Harness source checkout (`pnpm dsh web`) can load a second copy of the scope module and cause `selected preset is not team-enabled`.

The old npm name, `@wowyuarm/dsh-agent-team`, is deprecated. If you installed it in this profile, replace that plugin entry rather than adding both names. The rename does not require migrating Team data.

### 3. Verify and try it

If Team mode does not appear, inspect the composed profile:

```sh
dsh --profile web --dump-config
```

The output should include entries such as `contexera-agent-team-scope` and `contexera-agent-team-client`. In the browser, enter **Team mode** from the DSH navigation:

```text
Team mode
├── Team manager → configure the team in a dedicated DSH conversation
└── select a Workspace
    ├── Agents → Add Agent
    └── Projects → New Project → post in Main stream
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
| **`dsh-agent-team`** (this plugin) | Every agent is a durable, named Member with its own memory, notes and skills; Projects have owners, every Task has one accountable owner, and whoever builds a Task never verifies it | a **standing team** you guide |

The difference is what the plugin organizes around. Here, Members keep their memory and Projects keep their owners across Sessions, so you can return to a standing team rather than set one up for each piece of work.

## Uninstall

Remove the bundle from the profile; this also removes its composed layers:

```sh
dsh plugin --profile web remove @contexera/dsh-agent-team
```

## What it adds

- A durable single-host Team: Workspaces, Projects with a Main stream and named owners, discussion and Task Threads, Claims, accountable owners, and a task board.
- A Web Client for the Human: create Projects and Agents, set owners, post and reply, follow or step back from Threads, and accept, close, reopen, or transfer Tasks. The Inbox and a cross-Workspace task board show what needs you.
- A dedicated Team manager conversation for shaping the Team itself. It is a Host-owned DSH Session, not a Member or ledger entity; it uses the shipped Conversation and composer, keeps private memory, and offers **New conversation** without changing Harness.
- An isolated `team-member` preset with [model-facing Team tools](docs/team-collaboration/tools.md). The optional `team_worker` tool appears only when the Host's Worker switch is on.
- A pull-based collaboration protocol. Agent Inbox admission is durable, but it does not claim that the model has already processed the update.

![Human Inbox in the DSH Web UI: one Thread needing you, with its unread and direct counts stated](assets/readme/inbox.png)

There is one Team per DSH home. See the [architecture guide](docs/architecture/README.md) for how the ledger backs the UI and tools.

## Install from a local checkout

Keep local builds separate from the published `web` profile. See [development profiles](docs/development/environments-and-install.md#profiles-and-release-cadence) for the `web-dev` setup and runtime pairing.

## Development

- [Contributing](CONTRIBUTING.md): how to propose, verify, and submit a change.
- [Development guide](docs/development/README.md): setup, checks, and previews.
- [Documentation index](docs/README.md): architecture, collaboration, and other engineering guides.

## Acknowledgments

dsh-agent-team borrows a way of thinking from [Raft](https://raft.build/): an agent is a someone, not a something — a named teammate with its own memory and identity, working in a room shared with people. The concrete designs here differ in many places: Projects and their owners, Task Threads and their accountable owners, and the ledger underneath are this project's own. Thank you to the Raft team for the thinking.

## License

[MIT](LICENSE)
