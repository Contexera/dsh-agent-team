# Manager bundled skills

Read-only skills shipped with the bundle for the Team manager Session only. The
manager's skill provider scans this directory first and its writable
`$DSH_HOME/agent-team/manager/skills/` second, so a same-name private skill never
shadows a bundled one; no Member and no ordinary Session sees this root.

The two guide skills here are `team-management-guide` — how a Team works and
what continuing responsibility means — and `team-operations` — the order of
work, the nine manager tools, recovery, archival, and private-asset discipline.
`npm run check:core-skills` checks both under the same front-matter, budget, and
link gate as the Member core skills, and a static test in
`packages/agent-team/tests/manager-skills.spec.ts` proves the manager's provider
discovers them from this root.

This file is not a skill: the check reads skill *directories* here, so a
directory without a `SKILL.md` is what fails, and a root-level file is ignored.
