# .scratch Work-Item Index

`.scratch/` holds cross-session work items: design snapshots, research, delegable tickets, prototypes, reviews, and acceptance evidence. It does not define current product behavior, public APIs, or architecture boundaries — those are defined by source, tests, and the maintained docs.

**How to work here (work-item structure, information authority, ticket readiness, delegation, review, and lifecycle) is defined in [AGENTS.md](AGENTS.md).**

## Layout

```text
.scratch/
├── active/                 # open work items (ignored by default)
├── archive/YYYY-MM/<work>/ # history of closed work items (tracked)
└── local/                  # personal drafts and transient output (gitignored)
```

New work items use `spec.md` for the current design snapshot; older records may use `DESIGN.md`. Implementation-review records live in a work item's `reviews/`; required Human or named acceptance evidence lives in `validation/`.

## Open work items

This section lists only work items that are not yet closed; closed ones are in the next section. Name them in prose, without links — `active/` is ignored by default, so a link would not resolve for anyone cloning the repository.

- (none yet)

## Archived

These work items have landed in source. **Current behavior is defined by source and docs**; the material below only represents the design context of its time and does not override landed behavior. Add each work item to this table when closing it.

| Month | Work item | Delivered conclusion | Link |
| --- | --- | --- | --- |
