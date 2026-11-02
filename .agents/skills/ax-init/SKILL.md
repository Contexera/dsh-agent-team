---
name: ax-init
description: Bootstrap a repository's agent layer - a short root AGENTS.md, a .scratch/ cross-session work area, and an optional docs/ skeleton. Run when starting a new repo or retrofitting an existing one for agent work.
disable-model-invocation: true
---

# ax-init

`ax` = agent experience: the layer an agent needs to work in a repository across sessions. This skill builds it:

| Piece | Role | Default |
| --- | --- | --- |
| Root `AGENTS.md` | Only the rules every task must know, plus routing. Loaded into every session, so it stays short (~60 lines) | always |
| `.scratch/` | Cross-session work items: design snapshots, research, tickets, validation evidence — never an authority on current behavior | always |
| `docs/` skeleton | Maintained engineering docs: `docs/README.md` routing index + `docs/AGENTS.md` maintenance discipline | only when the repo warrants maintained docs |

The pattern is proven in real agent-driven repositories (Loom, dsh-agent-team): a fat root guide drowns every session, so the root file routes instead of explaining; in-progress work lives in `.scratch/active/` where it can change hourly without polluting history; durable conclusions graduate into `docs/` when the work closes.

## Map the repository before writing

- Read the top-level tree, then the smallest authoritative files: `README.md`, build manifests, test and lint config, existing architecture docs.
- Infer the stack from real files (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Makefile`, CI config); prefer exact commands the repo already uses over ecosystem defaults.
- Extract only durable contributor knowledge: purpose and scope, top-level directory responsibilities, build/test/lint/run commands, conventions, boundaries, secret-handling rules.
- If the repo does not expose a fact, write `> TODO:` — never invent commands, architecture, or policies.
- **Greenfield repos**: a new or empty repository has little to extract. Take facts from the session's plan and the user — stack choice, commands, boundaries — and write them as chosen conventions, `> TODO:` whatever is not yet decided. The root file is then a statement of intent the code grows into, not a report of what exists; expect a tightening pass once the stack actually lands.

## Write the root AGENTS.md

Short by design. Five parts, in this order:

1. **Scope and authority** — what this repository is, in one short paragraph, then the authority order: source and tests define current behavior; maintained `docs/` explains it; `.scratch/` is work history and never overrides either.
2. **Reading discipline** — start from the files a task names, expand by need, do not read the whole repo; route through `docs/README.md` when it exists.
3. **Always-on constraints** — at most ~8 rules every task genuinely needs: the build/test entrypoints, the few architecture guardrails that are easy to violate, commit discipline.
4. **Pointers** — one line each for `docs/AGENTS.md` (if present) and `.scratch/AGENTS.md`.
5. Nothing else. Long structure maps, per-command detail, and research history belong in `docs/` and `.scratch/`, not in the file every session loads.

Write it in the repository's dominant documentation language (translate the headings; keep technical terms as-is). A greenfield repo has no dominant language yet — ask, or default to the conversation's language.

## Create the .scratch work area

Copy `assets/scratch-AGENTS.md` to `.scratch/AGENTS.md` and `assets/scratch-README.md` to `.scratch/README.md`, adapting the prose the way you would adapt any boilerplate: drop what does not apply, keep the discipline. The templates define the work-item structure (`active/<work>/` with a five-item continuation README, `DESIGN.md`, `issues/NN-<slug>.md` tickets), ticket discipline (vertical slices, self-contained, frontier workflow), the closing lifecycle, and git tracking. Do not rewrite these rules per repo unless the repo genuinely works differently — their value is being the same everywhere. Templates are English; when the repository's documentation language is not, translate the prose while keeping the structure, headings order, and technical terms.

On a greenfield repo, the design work that follows initialization starts as an `active/<work>/` item, not in `docs/` — until source lands, `active/` is the primary design authority (the template says so).

Add to `.gitignore` (create the entries; keep the file's existing content):

```gitignore
.scratch/active/
.scratch/local/
```

Create the directories `active/` and `local/` (empty; `local/` is ignored anyway).

## Add the docs skeleton when warranted

Skip it for small repos — a root file plus `.scratch/` is enough, and an empty routing index pointing at nothing is worse than no index. Create it when the repo already has (or will soon grow) multiple maintained docs — architecture pages, runbooks, domain models:

- `assets/docs-README.md` → `docs/README.md`: task-based routing table ("you want to do X → read Y") plus a fact-ownership table (which document owns which class of fact). Fill rows from the repo's real documents; two honest rows beat ten stub rows.
- `assets/docs-AGENTS.md` → `docs/AGENTS.md`: maintenance discipline — one fact one home, a change that invalidates a documented fact updates the owning document in the same change, uncertain facts as `> TODO:`, no empty shells for modules that do not exist.

Do not pre-create empty subsystem pages. The skeleton is governance, not filler. A terminology or domain page is typically the first real page once terms stabilize — add it then, not empty.

## Re-runs and retrofitting

Re-running on an already-initialized repository adds the missing pieces — most often the `docs/` skeleton once the repo grows into needing one — and never regenerates or overwrites files that already exist.

Never overwrite an existing root `AGENTS.md`. When one exists, read it, separate always-on rules from long-form explanation, and propose the restructure: rules stay in the root file, explanation moves to `docs/` pages (create the skeleton in the same pass if it is missing), work-history notes move to `.scratch/`. Apply it only with the user's go-ahead, since the existing file may be load-bearing for other tooling.

## Validation checklist

- Every command in the generated files comes from the repo or is marked `> TODO:`.
- Root `AGENTS.md` fits on one screen and contains no content that belongs in `docs/` or `.scratch/`.
- The `.gitignore` entries are committed together with the skeleton, before any `active/` work could leak into a commit.
- `.scratch/AGENTS.md` and `.scratch/README.md` exist; `.gitignore` covers `active/` and `local/`.
- If `docs/` was created, every routing row points at a file that exists.
- All generated files use the repository's dominant documentation language consistently.
