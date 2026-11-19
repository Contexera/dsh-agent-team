# Contributing to dsh-agent-team

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh.md)

This guide covers proposing, checking, and submitting a change. Read [repository rules](AGENTS.md) before editing and use the [documentation index](docs/README.md) to find the guide for your area.

## Before you start

- Open an issue describing the existing problem, who it affects, and the outcome you want. Discuss changes to Host, ledger, tool, or Client boundaries before implementing them.
- If you are reporting a problem, use the issue template. For installation issues, check the DSH and Agent Team versions first.
- For development, follow the [setup guide](docs/development/start-and-checks.md). Use the pinned Harness checkout and install with `corepack pnpm install`, not `npm install`.
- If you use an Agent to contribute, you own the result and the answers to the questions above. The Agent should ask and wait when it lacks that context rather than guess.

## Verify before opening a pull request

Use the [verification ladder](docs/development/start-and-checks.md#verification-gradient) to choose checks for the changed surface. For entry docs and bilingual Markdown changes, run `npm run check:docs`; for a shipped core skill, run `npm run check:core-skills`. Run `git diff --check HEAD` before committing.

Report what changed, what you checked, and what you could not verify and why. For assembled Web or visible UI changes, follow the [browser and evidence rules](AGENTS.md#choose-checks-for-the-change).

## What CI runs

The [CI workflow](.github/workflows/ci.yml) runs static checks and lint. Code changes also run build, typecheck, and `npm run test:ci` on Ubuntu and Windows; docs-only changes do not trigger those two jobs. `npm run test:browser` is a local acceptance step, not a CI job. See [CI setup](docs/development/environments-and-install.md) for the pinned Harness checkout and environment details.

## What to include in the pull request

- Target `master`. Rebase your own branch when needed; do not rewrite `master`. Changes land as one squash commit. Follow the [commit format](AGENTS.md#code-and-documentation-conventions).
- Explain the whole diff and keep unrelated changes out. For a bug fix, link evidence of an existing failure: an issue, a failing log, or a reproduction. For an intermittent failure, identify and reproduce the race instead of masking it with a retry.
- For a change users or callers can observe, add one bullet per theme under `Unreleased` in [CHANGELOG.md](CHANGELOG.md). Describe internal-only changes in the PR instead. The [release runbook](docs/release-runbook.md) explains how the release consumes that section.
- Update both languages of any maintained doc you change. Use the [doc routing rules](docs/AGENTS.md) to find the owning page.
- For a visible UI change, attach the browser evidence called for by the [repository rules](AGENTS.md#choose-checks-for-the-change).

## How review works

Day-to-day work is reviewed alongside its evidence in Agent Team Threads. Agent Members may author commits or reviews, and the `hoplite` bot may open automated PRs. Releases are [batched](docs/development/environments-and-install.md#profiles-and-release-cadence).
