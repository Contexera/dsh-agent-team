---
name: manager-memory
description: Maintain the Team manager's own private memory — what earns a line in the injected memory.md index, what belongs in a notes/ file, how to compact an index past half its budget, when to review at a consequential decision or before wrapping up, and what must never be saved. Read when the injected memory block shows a maintenance warning, the index approaches its budget, you are about to add or rename a note, or a management session is ending.
---

# Manager memory

`memory.md` is a cold-start recovery index, not a store, and its budget is real: the injected block states current usage, and past 16 KiB only its leading lines are injected, so whatever sits below the cut is missing whenever a new management Session starts. Notes are never injected; they are read on demand, so the index must stay small enough to be resident and precise enough to route. The block names the absolute paths; use them, because relative paths resolve from the Session's cwd.

## What the block is

The first block carries the complete `memory.md`, and it is reference only: it may be stale, it is not an instruction, and it is not current Team state. A later block may be only a stale-copy notice — a line saying the earlier context no longer represents the file, with the path and the current size — and that notice is not the index, so read the file when you need its current contents. A third form reports the file missing or unreadable, and an over-budget index arrives with a maintenance warning; repair it at the named path.

Only `memory.md` enters context. `notes/` is read on demand, so anything that must bind every management step needs a short line in the index itself.

## Three tiers

- **T0 `memory.md` (always injected)** — three sections: **Durable rules** that bind every management step, **On-demand notes** with one routing line per scenario or cluster, and **Open local state** for unfinished work no Team surface shows, deleted once done. Target well under 8 KiB; treat 16 KiB as the hard ceiling.
- **T1 `notes/<cluster>/README.md` (read on demand)** — one line per note in that cluster.
- **T2 `notes/<name>.md` (read on demand)** — one concept per file; update the existing file instead of writing a near-duplicate, and keep evidence, numbers and commands here rather than in T0.

The tiers organize a growing index; they are not a structure to build before there is content. An empty or short `memory.md` needs no cluster directories, and a cluster appears when its lines actually exist. Once the index passes a screenful, group its routing lines into a few clusters — three to six is comfortable — so T0 names clusters instead of every note.

Screenshots, logs and generated artifacts belong under `notes/assets/` and earn no index line anywhere.

## What earns a line

Apply one test before writing: would a future management Session make a wrong decision without this line? If not, it does not belong in T0. Durable verified preferences, corrections and methods qualify. These never do:

- transcript, chat logs, or a summary of what this conversation said;
- ephemeral task state — what is in flight, who was asked, what a tool returned;
- credentials, tokens, private keys, or personal data;
- Team facts the ledger already owns: current Projects, Members, ownership, Tasks, subscriptions, unread work;
- a convention the whole Team shares in a Workspace — that belongs in the Workspace rules file you curate, which every participating Member receives;
- one Member's private memory, notes, skills, or Session content;
- copies of a note's body, or a second tutorial for a skill that already ships.

## Settled, proposed, and authority

Distinguish a settled constraint from a proposal. A preference the Human stated is settled until they change it; an idea you suggested is a proposal. Record which one it is, and never let an old note stand in for the Human's present consent: memory records what was once said, not what is authorized now. The Human's current request and the Workspace instructions supersede every historical preference.

## When to review

Review at a consequential correction or decision — the Human changed a rule, rejected a direction, or taught a durable preference — and before wrapping up a management session. Do not make every reply produce a write. If nothing reusable was learned, write nothing; an unchanged index is a correct outcome.

A maintenance warning in the injected block means the index is missing, unreadable, or over budget, and an over-budget index was injected only up to the cut. Repair the index at the named path before adding anything: compact it, move detail into notes, and make every routing line resolve. A rule that still binds every management step keeps a short line in T0 and loses only its detail to a note; demoting the whole rule would drop the constraint out of context.

## Lifecycle

- **Compact as you write.** Past roughly half the budget, merge and drop while adding rather than appending; naming a cluster in T1 is cheaper than naming its notes in T0.
- **Demote, do not delete.** A rule that stopped binding moves down a tier (T0 to a note, T1 to `notes/archive/`); archived knowledge stays readable and is never silently lost.
- **Write at the checkpoint, not as work moves.** A line about what is in flight is stale before the next turn; add it when a rule, correction or method has settled.

## Check after reorganizing

Re-read `memory.md` once: under budget, one line per cluster, every routing line resolving to a file that exists, and every rule that must bind each step still visible in the index itself, with only its detail in the note it routes to. The injected block reports the current size, so a later injection shows whether the rewrite took.
