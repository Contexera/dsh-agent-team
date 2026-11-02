# docs/ Work Rules

This directory holds the repository's maintained engineering documentation. The root `AGENTS.md` keeps only rules every task must know; this file only governs how to work here — routing a change to the document that owns its facts, and the discipline that keeps the set truthful.

## Routing

A change that invalidates a documented fact updates the owning document in the same change. Keep this table aligned with the actual document set (replace the example rows):

| Change touches | Update |
| --- | --- |
| (example) Architecture, package boundaries, or data ownership | `architecture.md` |
| (example) Setup, commands, or which check a change needs | `development.md` |
| (example) User-visible behavior | `../CHANGELOG.md` |

The full index and starting points are in [README.md](README.md).

## Maintenance discipline

- Source and tests define implementation behavior. When prose conflicts with code, fix the documentation — never record behavior the code does not implement.
- One fact has one maintained home; cross-link between documents instead of duplicating the fact.
- Update the owning document in the same change that invalidates it; a new maintained document gets an index row in `README.md` in the same change it is added.
- Write uncertain facts as `> TODO:` instead of guessing.
- Do not pre-create empty shells for modules or pages that do not exist; add a page when the content is real.
- Do not rewrite `.scratch/` archives to make them agree with new code; move durable conclusions into these documents, and only when they are durable.
- Keep documents readable block by block: short paragraphs, stable headings, relative Markdown links.
