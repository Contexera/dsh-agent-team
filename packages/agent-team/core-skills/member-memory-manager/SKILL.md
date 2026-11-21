---
name: member-memory-manager
description: Maintain this Member's private memory — where a new piece of knowledge belongs before it is written, what earns a line in the memory.md index, what belongs in a notes/ file instead, how to compact an index past half its budget, and when to demote knowledge that no longer earns a line. Read this skill when the injected memory block shows a maintenance warning, when the index approaches its budget, before adding or renaming a note, or when a Task you worked on was accepted.
---

# Member Memory Manager

`memory.md` is a cold-start recovery index, not a store. Its test: if every earlier conversation were gone and you saw only this index and the injected context, could you tell within one screen which rules bind every step, which note to open for a given job, and what local state is still unfinished? Its budget is real: the injected block states current usage, and past 16 KiB only its leading lines are injected, so whatever sits below the cut is missing whenever you start over. Notes are never injected; they are read on demand.

## Where it belongs

Before writing anything, ask in order and stop at the first yes:

1. **Can it be read live?** Who owns or is doing what, Task state, Thread history, current code — the ledger, `team_view`, and the source answer it. Write nothing.
2. **Does the whole Team in this Workspace need it?** A shared convention or a local environment fact belongs in the Workspace rules file, which reaches every Member each step; edit it only as its injected block allows. A public engineering rule belongs in the repository's `AGENTS.md`.
3. **Does it change what you answer for?** Your Project responsibility is injected every turn; never copy it into memory. If it is wrong or out of date, take that to the Human.
4. **Is it your own craft or your own unfinished local state?** Then it is yours: `memory.md` or a note.

## Three tiers

- **T0 `memory.md` (always injected)** — three sections, nothing else:
  - **Durable rules** — your own craft that binds every step, each one or two lines.
  - **On-demand notes** — one line per scenario naming the note or cluster `README.md` to open; a routing line never carries the body.
  - **Open local state** — what the ledger and git cannot show: an unmerged worktree, a pending verification, the next step across a compaction, each with its Task, Thread, or path handle. Delete an entry the moment it is done; an empty section is normal.

  Target well under 8 KiB; treat 16 KiB as the hard ceiling.
- **T1 `notes/<cluster>/README.md` (read on demand)** — one line per note in that cluster. What T0 routes to is the cluster count (3–6), not the note count.
- **T2 `notes/<name>.md` (read on demand)** — one concept per file; update the existing file instead of writing a near-duplicate, and keep evidence, numbers, and commands here rather than in T0.

Screenshots, logs, and generated artifacts belong under `notes/assets/` and earn no index line anywhere. A procedure you repeat and keep getting wrong belongs in a private skill instead.

## What earns a line

Apply one test before writing: would my future self make a wrong decision without this line? If not, it does not belong in T0. Team facts the ledger already owns, your injected identity or responsibility, event logs, one-off task detail, credentials, and copies of a note's body never qualify.

## Memory is a clue, not evidence

A method or lesson evolves in place and needs no date. A snapshot of the environment or of other people's arrangements goes stale: date it and mark it to be checked before use. Never let a remembered fact stop you from acting — "paused", "not installed here", "someone else owns that" — without checking the live source first; choosing not to act needs the same evidence as acting.

## Lifecycle

- **Compact as you write.** Past roughly half the budget, merge and drop while adding rather than appending; naming a cluster in T1 is cheaper than naming its notes in T0.
- **Demote, do not delete.** A rule that stopped binding moves down a tier (T0 to a note, T1 to `notes/archive/`); archived knowledge stays readable and is never silently lost.
- **Clear open state at the boundary.** When a Task you worked on is accepted, remove its Open local state entries and keep only the lesson that will matter again.

## Check after reorganizing

Re-read `memory.md` once: under budget, the three sections only, every routing line resolving to a file that exists, nothing that must bind every step living only in a note, and Open local state holding only work still unfinished. The injected block reports the current size, so a later injection shows whether the rewrite took.
