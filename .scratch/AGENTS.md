# .scratch Work Rules

This subtree holds cross-session work items: design snapshots, research, implementation tickets, prototypes, and acceptance evidence. It is not an implementation or API authority — current behavior is defined by `packages/` source and tests, and maintenance rules by [`../docs/AGENTS.md`](../docs/AGENTS.md). This file only governs how to work here.

## Work-item structure

Each `active/<work>/` is one directory with a short `README.md` as its single continuation entry, covering five items: status, last-checked date, current frontier (who is doing what and what is blocked), completion conditions, and the formal-doc exit.

```
active/<work>/
├── README.md      # continuation entry (the five items above)
├── spec.md        # confirmed decision snapshot — written once discussion converges
├── issues/        # tracer-bullet implementation tickets, one file per ticket
│   ├── 01-<slug>.md
│   └── 02-<slug>.md
├── materials/     # research and external material (keep only what is worth re-reading)
└── validation/    # human-confirmed acceptance evidence (see the development doc)
```

## Ticket discipline

Each `issues/NN-<slug>.md` uses a fixed skeleton, numbered from `01` in dependency order (blockers first):

```markdown
# NN — title

**What to build:** the end-to-end behavior this ticket demonstrably delivers once done (user perspective, not a layered task list)
**Blocked by:** the tickets blocking it, or "None — can start immediately"
**Status:** pending | ready | in-progress | complete

- [ ] acceptance criterion 1
- [ ] acceptance criterion 2
```

- **Vertical slices**: each ticket cuts one narrow, complete path through every layer (schema → API → UI → tests), independently verifiable when done; no horizontal division of labor by layer.
- **Self-contained tickets**: each ticket can start in a new context without reading the whole work-item history. Avoid concrete file paths and code snippets (they go stale); exception: decision-dense fragments from prototypes (state machines, type shapes) may be inlined with their source noted.
- **Frontier workflow**: tickets whose blockers are all done form the frontier and are ready to start; a serial chain runs top to bottom. Tickets that are written but still carry unfinished blockers stay **pending**, so `ready` always means startable now.
- **Wide-refactor exception**: when one mechanical change's blast radius covers the whole repository, do not force it into a tracer bullet — order it as expand–contract: expand first (old and new coexist), migrate in batches, then contract (delete the old form).

## Lifecycle

- **Closing a work item**: close or delete unfinished tickets → move durable conclusions into the `../docs/` maintained documents → delete process material without provenance value → move into `archive/YYYY-MM/`.
- **Archive is history**: archived states and terminology only represent the working context of their time and never override current implementation; do not rewrite archives to match new code.
- **Transient artifacts**: logs, debug screenshots, and downloads go in `local/` or `artifacts/` (gitignored), never into active or archive.

## Directory index

See [README.md](README.md).
