# Manager bundled skills

Read-only skills shipped with the bundle for the Team manager Session only. The
manager's skill provider scans this directory first and its writable
`$DSH_HOME/agent-team/manager/skills/` second, so a same-name private skill never
shadows a bundled one; no Member and no ordinary Session sees this root.

The six guide skills cover the manager's resident method and its on-demand
knowledge:

- `team-management-guide` — how a Team works, how to diagnose one from evidence,
  the least structure that carries a result, and continuing responsibility.
- `team-operations` — the order of work, the nine manager tools, recovery,
  archival, event-loop routing, and private-asset discipline.
- `team-event-loops` — subscriptions, reminders and messages as the loops that
  keep a Team moving, and how to design one that escalates.
- `manager-domain-model` — the Member-facing roles, delivery rules and Task
  lifecycle, explained to a manager that holds none of those tools.
- `manager-memory` — the manager's own bounded index, notes, review points and
  what must never be saved.
- `manager-session-evidence` — locating a Member's current Session, reading its
  stored log through the shipped read-only reader, and separating fact from
  inference when the question is what a Member actually did.

`npm run check:core-skills` checks all six under the same front-matter, budget,
and link gate as the Member core skills. The budget counts the Markdown a model
reads; `manager-session-evidence/scripts/session-evidence.mjs` ships beside its
`SKILL.md` and is reported by the gate rather than budgeted as prompt text. `packages/agent-team/tests/manager-skills.spec.ts`
proves the manager's provider discovers them from this root, that the first
model request carries the catalog, and that a `skill` call from the model puts a
body into the next request.

This file is not a skill: the check reads skill *directories* here, so a
directory without a `SKILL.md` is what fails, and a root-level file is ignored.
