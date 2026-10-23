# Contributing to dsh-agent-team

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh.md)

Thanks for taking the time to contribute. This repository is an external, opt-in DeepSeek Harness bundle: it publishes one package from the repository root, keeps three build targets under `packages/`, and verifies itself against a pinned Harness checkout. [`AGENTS.md`](AGENTS.md) carries the rules every change must satisfy; this page carries what a contributor needs before opening a pull request.

## Before you start

- **Set up the environment contract.** Development and verification need the adjacent Harness checkout at `../deepseek-harness`, and installs go through `corepack pnpm` — never `npm install`, which breaks the workspace symlinks. Setup, generated artifacts, and the certified-tag rule: [`docs/development/README.md`](docs/development/README.md).
- **Agree on boundary changes first.** Host authority, the Team ledger, the model-facing tool surface, and Client slot wiring are guarded by [`AGENTS.md`](AGENTS.md) and [`docs/architecture/README.md`](docs/architecture/README.md). An issue that settles the shape up front is cheaper than a rewritten pull request.
- **Reporting instead of fixing?** Use the issue templates. They route installation problems through the certified-version check, because most "broken after install" reports are a DSH version mismatch.
- **Say who benefits before you build.** Open an issue that names the outcome you want, who it is for, and the problem that already exists — not a solution looking for a merge.
- **Automated or AI-assisted contributor?** Read [`AGENTS.md`](AGENTS.md) and [`docs/README.md`](docs/README.md) before you open anything — they carry the rules and the architecture this repo enforces, and most rejected pull requests miss one of them. The person running the agent answers the questions above and owns the result; the agent does not answer them on its own, and when context is missing it asks and waits rather than guessing.

## Verify before you open the pull request

Run the smallest sufficient set for the change, then escalate with its surface:

| The change touches | Run |
| --- | --- |
| Markdown in `docs/` or a README pair | `npm run check:docs` |
| A skill under `packages/agent-team/core-skills/` | `npm run check:core-skills` |
| Types, Host logic, tests | `npm run typecheck` and `npm test` |
| Visible UI, Client loading, slot takeover, Remote activation | the above plus `npm run test:browser` |
| Build outputs, `exports`, manifests, release layout | the above plus `npm run build` and `npm pack --dry-run` |

`npm test` runs six mechanical gates before Vitest: `check:facades`, `check:docs`, `check:core-skills`, `check:boundaries`, `check:versions`, and `check:comments`. The complete ladder — `lint` and `duplication` included — is [`docs/development/start-and-checks.md`](docs/development/start-and-checks.md) § "Verification gradient".

**Report only the checks you actually ran**, and say what each one covered. A claim nobody can reproduce costs a review round trip.

## What CI runs

A pull request runs two lanes, `ubuntu-latest` and `windows-latest`. Each lane executes the same six-step environment contract — corepack shims, pinned Harness checkout, Harness install and build, this repository's install, bundle build, path facades — and then `npm run typecheck` and `npm test`. A documentation-only push to `master` skips the gate; a pull request never does. `npm run test:browser` is deliberately not in CI, so browser acceptance stays a local step: include that evidence yourself when your change is visible. The contract and the three files that must move together with the pinned tag: [`docs/development/environments-and-install.md`](docs/development/environments-and-install.md) § "Sandbox and CI environments".

## What a pull request should contain

- **Target `master`**, and rebase your own branch when it moves. `master` history is never rewritten.
- **One Conventional Commits subject line** per commit — `type: lowercase imperative summary` (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`) — with no body. Pull requests land as one squashed commit, so the title is what history keeps.
- **Every change, not the headline one.** A body that covers half the diff makes the reviewer reverse-engineer the rest.
- **A user-visible change updates [`CHANGELOG.md`](CHANGELOG.md)** under `Unreleased`. Substantive means the change a user or a caller meets: a new behavior, a changed contract, a fix they would otherwise hit. Refactors with no observable difference, internal renames, and mechanical churn do not earn a bullet — say so in the pull request instead. Write one bullet per theme in the register the file already uses, and keep `Unreleased` as the only such section: the release pass consumes it, as [`docs/release-runbook.md`](docs/release-runbook.md) § "Release material" describes.
- **Maintained docs are bilingual pairs**: change `foo.zh.md` in the same change as `foo.md` — [`docs/AGENTS.md`](docs/AGENTS.md) routes an edit to the document that owns its facts.
- **Evidence for visible changes**: screenshots at desktop and 390×844, plus keyboard/focus and dialog/menu states, per [`docs/frontend-design/README.md`](docs/frontend-design/README.md).
- **Generated files stay generated**: never hand-edit `packages/agent-team/lib/typert.*` or the generated `tsconfig*.json` path facades — change `scripts/sync-paths.mjs` and regenerate.
- **Do not modify the adjacent Harness checkout.** A change that needs one belongs upstream, or behind a public extension point.
- **Flaky tests**: name the race and prove it — a deterministic reproduction beats a retry, and a retry over a genuine loss hides the defect that caused it.
- **Nothing incidental**: no credentials, temporary profiles, browser overlays, generated test files, browser artifacts, or build residue. Keep `git diff --check` clean.

## What we don't merge

Checked before anything else, so check them yourself first:

- **A change to the adjacent Harness checkout.** It belongs upstream, or behind a public extension point.
- **A speculative registry, compatibility layer, fallback authority, or duplicate store.** One authoritative formatter/projection per domain concept.
- **A hand-edited generated file** — `packages/agent-team/lib/typert.*` or a generated `tsconfig*.json` path facade. Change the generator and regenerate.
- **Unrelated changes bundled together**, or a body that covers only part of the diff.
- **Half of a bilingual doc pair** — `foo.md` without its `foo.zh.md`, or the reverse.
- **A retry that papers over a flaky test.** Name the race and prove it with a deterministic reproduction; a retry over a genuine loss hides the defect that caused it.
- **Incidental residue** — credentials, temporary profiles, browser overlays, generated test files, browser artifacts, build output. Keep `git diff --check` clean.

A bug fix links evidence of a failure that already happened — an issue, a failing log, or a reproduction. Reviews here ask for evidence, not style, so a fix with nothing to reproduce reads as a change looking for a reason.

## How review works here

Day-to-day work happens in Agent Team Threads, where a change is reviewed alongside the evidence behind it; some commits and reviews are authored by the team's agent members, and automated pull requests may arrive from the `hoplite` bot. Reviews ask for evidence rather than style. Merges are squash commits on `master`, and releases are batched rather than continuous — [`docs/development/environments-and-install.md`](docs/development/environments-and-install.md) § "Profiles and release cadence".

Unsure whether a change is wanted? Open an issue first; it is cheaper than a rejected pull request.
