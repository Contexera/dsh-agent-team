---
name: ax-review
description: Review a repository's agent experience - mechanical link/reference checks, a simulated cold-start walk, guardrail audit, optional session-log evidence, and optional .scratch/archive audit.
disable-model-invocation: true
---

# ax-review

(ax = agent experience.) Answer one question: **can a fresh agent land in this repository, load the right context, and start working without friction?**

Review whatever documentation layer exists — a bare `README.md`, an `AGENTS.md`, a `docs/` tree, a `.scratch/` work area, or the full pattern ax-init builds — and grade it on the same principles. Judge whether the layer a repo has does its job; never demand a pattern the repo does not use. A library repo with an honest README can pass.

Three sources of findings, in order of how much work they are: the scripts, the walk, and — when a local session log is available — what actually happened. The first is exact, the second is where the judgment lives, and the log is optional and never required; a repo reviewed cold still gets the other two.

## 1. Detect the layer

Inventory what exists and its weight: root `AGENTS.md` / `CLAUDE.md` (line count), `README.md`, `docs/` (is there an index? does it route by task?), `.scratch/` or an equivalent work area. Record what you find — the review report starts from this inventory.

## 2. Mechanical pass

Run from the skill directory, with `<repo>` the repository under review. Script defaults retain the Git-known Markdown scope. For the standard current-work review of a repository with `.scratch/`, explicitly add ignored active work and remove historical archives:

```bash
python3 scripts/check_links.py <repo> --include .scratch/active --exclude .scratch/archive
python3 scripts/check_references.py <repo> --include .scratch/active --exclude .scratch/archive
```

Use the same scope for both. Omit `--include` when no active directory exists. `--exclude` is a repository-relative file or directory prefix, not a glob; a missing include fails rather than silently narrowing the review. Historical archives stay excluded from `check_references.py` by default because old specs legitimately cite paths that later code changed; when reviewing `.scratch/archive/`, use the dedicated Archive scratch audit below instead of demanding current-code green on historical records. Do not present a scoped green run as repo-wide green.

Both scripts exit non-zero on findings and print `file:line: reason`, plus the effective include/exclude scope. Findings are candidates, not verdicts: a methodology doc may cite paths of the repos it talks about, a runbook may cite paths on the target machine. Every current-scope finding gets fixed or consciously explained in the report — saying "expected, this doc cites external paths" is a valid resolution. Report archive-only findings separately and never rewrite history merely to make the current review green.

When a repository has project skill copies and the upstream skills checkout is available, also run the upstream repository's documented read-only skill-copy comparison. It checks installed copies by name and byte content without requiring every upstream skill to be installed. No upstream checkout means this check is unavailable, not a failure.

## 3. Cold-start walk

Pick 2–3 realistic tasks (derive them from the README, recent commits, or issue titles — for example "fix a bug in X", "add config option Y", "release a version"). When the repository uses `.scratch/`, include a cross-session task that requires delegation: root guide → work-item rules → discussion/spec → ready ticket → worker packet and delivery → implementation review → required Human acceptance → archive. For each, walk the path a fresh agent would take: entry file → routing → landing doc or ticket packet → execution, and record friction:

| Finding | Meaning |
| --- | --- |
| dead end | a task has no route to the facts it needs |
| drowning | required reading is too large to load (a root guide that should route, a long page without an index) |
| drift | the doc states something the code contradicts |
| broken | mechanical failure: link, missing file, dead command |
| stale | `> TODO:` markers, old dates, "coming soon" pages |
| misleading status | a ticket is shown as ready although a blocker or information gate remains, or complete although review/acceptance remains |

Spot-checking cited facts is what makes this a review rather than a lint: take the 3–5 most load-bearing claims in the entry documents (commands, boundaries, "X owns Y") and verify each against source. For a ready ticket, also verify its required reading and acceptance path against the work-item spec. A green script run with misleading routing or an unstartable ready ticket is a failing review.

## 4. Guardrails and rules

### An absent guardrail is a finding

A repo whose lint/type/test command exists but nothing runs it — no CI job, no pre-commit hook — is not neutral ground; it is the standing reason the next mistake ships. Read the repo's own check command first (its `package.json` scripts, its Makefile, its CI workflow): an existing check that sits unwired or silently broken is the finding, not an invitation to write a second one. Report the gap and the smallest wiring that closes it.

### Mechanical or judgement, decided first

A rule with a fixed shape — a banned API, an import order, a file location, a required test command — belongs in a deterministic check: a linter rule, a pre-commit hook, a CI job. Prose in a standards file is for genuine judgement calls (cross-file consistency, "matches the surrounding style"), the ones no check can express. Default to building the check; write the rule only when no check can hold it.

Where a mechanical rule currently lives only in prose, that is a finding: propose the check, and keep the prose only for what the check cannot see.

### Two loads

Every line in an always-loaded file (a root `AGENTS.md`, a global instructions file) is paid for on every turn, whether or not it is used; material behind a pointer costs only the pointer's line. This is why entry-doc weight is a finding rather than a preference. The method behind it — the pointer, disclosure, and pruning rules — is in the `skill-manager` skill's Writing Great Skills reference; reach for it when a finding is about wording rather than structure. Reference the skill by name so project installation can flatten skill directories.

## 5. Observed friction (optional)

When a session log for this repository is available — Claude Code, Codex, or Pi — it answers the one question the walk cannot: **where did an agent actually spend its time?** The walk predicts friction from the docs; the log records it.

Run it when a recent session exists, when the docs were changed since it ran, or when the cold-start walk came back clean but the work still felt slow. A log that predates the current doc layer is evidence about a repository that no longer exists — check the dates before reading anything into it.

The method — locating the log, skipping the machinery, counting repeated reads and failures, and reading failures without being lied to by the harness's own output — is in [references/session-logs.md](references/session-logs.md). Read it before opening a log file; the raw file is not something to read whole.

Findings from the log use the same report format and the same classification as everything else. A fact the agent hunted for is a navigation pointer; a failure a check would have caught is a missing guardrail; a rule stated in prose but never enforced is a check waiting to be written. Do not let the log's concreteness outrank the walk's judgment — a single awkward session is an anecdote, and the walk is what tells you whether the docs are the cause.

## 6. Archive scratch audit (optional)

`.scratch/archive/` is committed to Git, so fresh agents and repository searches still encounter it even though it is excluded from current-work reference checks. Run this audit when `.scratch/archive/` exists and the user asks to review archived scratch work, inspect a specific archived work item, or check closure hygiene before archiving (`scratch-review` still owns pre-closure design and implementation review of active work items).

Follow [references/archive-audit.md](references/archive-audit.md): run `python3 scripts/check_archive.py <repo>` (with optional `--target` paths) to check index symmetry, closure status, internal/exit links, and transient noise, then walk the in-scope archive items to verify authority framing and whether durable conclusions actually landed in maintained docs. Never grade historical specs against today's source tree or rewrite history merely to match newer code.

## 7. Report and fix

Report findings impact-first — what hurts a fresh agent most — each with location, why it hurts, and the smallest fix. Write the report in the conversation's language. Structural gaps (no entry file at all, a root guide that should become a routing layer) point at ax-init rather than being hand-rolled here. Apply fixes only on the user's go-ahead.

Done means: the report records the exact include/exclude scope, both current-scope scripts exit clean or every finding is explained, every cold-start walk is written down with its friction list, the guardrail question is answered (is there a check, does it run), and the user has the prioritized fix list. When the archive scratch audit was requested, report its target scope and findings separately from current-work findings. The session log and archive audit are optional unless requested: neither blocks a standard current-work review when not asked for.
