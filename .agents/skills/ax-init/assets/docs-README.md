# <repo> Documentation

This directory contains the maintained engineering documentation for this repository. The root `AGENTS.md` keeps only rules that every task must know; [`AGENTS.md`](AGENTS.md) here routes doc edits and maintenance — read it before changing anything under `docs/`.

## From the task at hand

Read the material a task explicitly names first, then fill gaps from the table; do not read the whole directory end to end. Current behavior is defined by source and tests; these documents provide the understanding and verification entry points. (Replace the example rows with the repository's real documents; two honest rows beat ten stub rows.)

| You want to… | Read first | Then locate |
| --- | --- | --- |
| (example) Start developing or run a check | `development.md` | the script or config it names |
| (example) Change a cross-cutting behavior | `architecture.md` | the implementation and tests it links |
| (example) Understand a term or boundary | `domain-model.md` | — |

## Where each kind of fact lives

| Home | Owns |
| --- | --- |
| Root `AGENTS.md` | constraints and reading discipline that apply to every task |
| `AGENTS.md` (this directory) | writing and maintenance discipline for `docs/` |
| `architecture.md`-style pages | how the parts cooperate; where each fact is owned |
| `development.md`-style pages | how to build, verify, and release |
| `.scratch/README.md` | work history — design, research, and evidence; never an authority on current behavior |
