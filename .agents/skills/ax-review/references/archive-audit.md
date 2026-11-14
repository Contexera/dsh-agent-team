# Auditing `.scratch/archive/`

Archived work items are committed to Git, so fresh agents and repository searches still encounter them. Reviewing `.scratch/archive/` is an agent-experience audit of **boundary hygiene and knowledge graduation** — not a demand that historical specs match today's source tree.

Use this procedure when the user asks to review `.scratch/archive/`, audits a specific archived work item, or runs a pre-archive closure check. Compare against the repository's `.scratch/AGENTS.md` (and `scratch-review` owns pre-closure design or implementation review of active work items).

## Core boundary

- **Do not grade history against current source.** Old `spec.md`, `DESIGN.md`, `materials/`, and `issues/` legitimately cite code paths, symbol names, or workflow rules from their time. Never run `check_references.py` on `.scratch/archive/` as a pass/fail gate, and never rewrite historical decisions or paths to match later code.
- **Do grade what misleads a fresh agent today.** Missing index rows, ambiguous closure status, ungraduated conclusions, transient noise, and broken internal or maintained-exit links all affect current agent experience and are fixable.

## 1. Mechanical pass

Run from the `ax-review` skill directory, with `<repo>` the repository under review:

```bash
python3 scripts/check_archive.py <repo>
python3 scripts/check_archive.py <repo> --target .scratch/archive/YYYY-MM/<work>
```

The script checks four deterministic invariants:

1. **Index symmetry:** every directory under `.scratch/archive/` appears under `## Archived` in `.scratch/README.md`, and every link there resolves inside the archive rather than pointing into `active/`, `local/`, or missing targets.
2. **Closure hygiene:** each archived work item has an entry `README.md`, no ticket in `issues/*.md` still carries an unclosed status (`pending`, `ready`, `in-progress`, `review`), and no transient artifacts (`local/`, `.log`, `.tmp`, `.bak`, `.swp`) or loose files sit in the archive.
3. **Internal and exit links:** links inside an archived work item resolve, no archived document links into `.scratch/active/` or `.scratch/local/`, and entry `README.md` exit links to maintained docs resolve.
4. **No active backlinks in maintained docs:** non-template Markdown outside `.scratch/` does not link into `.scratch/active/` or `.scratch/local/`.

Exit status `0` clears the mechanical checks; exit status `1` prints candidate findings as `file:line: reason`.

## 2. Judgment walk

Mechanical checks cannot read intent. Walk each in-scope archived work item (all of `.scratch/archive/` for a full audit, or a targeted subset for large histories) across four questions:

1. **Authority framing:** Does the work item's `README.md` make it unmistakable on first read that the item is closed, historical only, and where its **maintained exit** lives? If a fresh agent landed directly on `spec.md` or an issue file via search, would rejected alternatives or old plans look like active instructions?
2. **Graduation audit (most important):** Read the work item's claimed maintained exit and delivered conclusion, then inspect the target maintained owners (`AGENTS.md`, `README.md`, `docs/`, skills, or source/tests). Confirm durable rules, boundaries, and decisions actually landed there and do not contradict the archive without explanation.
3. **Closure and provenance:** Confirm required `reviews/` and `validation/` evidence (or explicit cancellation notes on unfinished tickets) exist so later agents can tell what shipped and why. Flag raw scratchpad noise or unsanitized local paths/credentials that should not have been committed.
4. **Legacy tolerance:** Older archives (for example items using `DESIGN.md` or older ticket formats) are exempt from modern layout normalization. Report only issues that confuse current agents (missing index entry, absent archive framing, dangling `active/` links, or ungraduated durable rules).

## 3. Finding classes and smallest fixes

Report findings impact-first using the same `ax-review` report structure, keeping archive findings distinct from current-work findings:

| Finding | Meaning | Smallest fix |
| --- | --- | --- |
| `ungraduated` | Durable rules or conclusions stayed in the archive instead of landing in maintained owners | Move or reconcile the missing fact in `AGENTS.md`, `docs/`, or the owning doc; leave the archive body untouched |
| `authority-leak` | Missing closed/historical framing, unclear maintained exit, or tickets still marked `ready`/`in-progress` | Add a short archive-status and maintained-exit note at the top of the archive `README.md`; annotate cancelled/closed ticket status honestly |
| `index-drift` | `.scratch/README.md` `## Archived` mismatches archive dirs, or maintained docs link to `.scratch/active/` | Sync the `## Archived` table and update maintained links away from `active/` |
| `transient-noise` | Committed debug logs, scratch drafts without provenance value, or unsanitized local paths | Remove transient artifacts without provenance value; sanitize tracked paths/secrets |
| `broken-internal` | Broken links inside the archive item or broken maintained-exit links from its `README.md` | Repair the internal or exit link (ignore historical code-path citations in `spec.md`/`issues/`/`materials/`) |

Apply fixes only on the user's go-ahead, and never rewrite historical decisions or code-path citations merely to make non-archive checks green.
