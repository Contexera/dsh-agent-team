# Release Runbook

English | [中文](release-runbook.zh.md)

This document is the procedure for publishing a version of `@contexera/dsh-agent-team`. It exists so that a maintainer can run a release from this page alone, including checks added because a defect once reached users. It is not a behaviour specification: source and tests define behaviour, and [`dsh-release-compatibility.md`](dsh-release-compatibility.md) owns the separate question of *which* DSH line the bundle supports. Certification decides the peer range; this runbook decides how a version carrying that decision reaches npm.

## 1. Who decides what

- **A maintainer decides the version number and gives the go signal.** A release never starts from CI, a schedule, or an accumulated diff. Fixes are patches, new capabilities are minors; inside `0.x`, a change that only carries compatibility is a patch.
- **Release material is reviewed verbatim before anything ships.** Draft the `CHANGELOG` bullets and the GitHub Release body, paste the exact text in the working Thread, and publish only on explicit approval. Approval of a direction is not approval of wording.
- **A published `name@version` is permanent.** npm never reuses a version number, not even after an unpublish. A metadata mistake is corrected by a new patch — never by re-publishing, rewriting history, or moving a tag behind a version that already exists.

## 2. Pre-flight

1. **Read the change set.** `git log --oneline v<previous>..HEAD`, then read the diff of every feature commit. Commit messages understate scope; a change is user-facing only if a user of the bundle can see or invoke it.
2. **Draft the material**, then send it for review (§4) — no publish without approved text.
3. **Sweep the version-bearing surfaces.** `npm run check:versions` reads every place that restates the certified DSH baseline and refuses a split one: it takes the harness tag in `.github/workflows/ci.yml` as the reference, requires every other spot to state the same version, and requires each `@deepseek-ai/dsh-*` peer range to admit from it.
   - The list of spots lives in [`scripts/check-version-consistency.mjs`](../scripts/check-version-consistency.mjs) — never keep a second copy by hand.
   - The declaration in `.hoplite/settings.json` sits inside a JSON string with escaped quotes, so a naive `grep` reports nothing there; the gate reads it correctly.
   - Advance these spots only in the pass that publishes the version they name.
4. **Sweep the prose for statements this release falsifies.** Grep the maintained documents for sentences conditioned on the release *not* having happened — `latest` is `<previous version>`, a capability described as unpublished, a peer range described as pending, a warm-line pin pairing an older DSH line with the last bundle release that still supports it. Correcting a document's current-state claim belongs in the release commit; rewriting shipped history does not (§7).
5. **Confirm the working tree carries no uncommitted build input.** `prepack` is `npm run build` and `packages/*/lib/**` is inside the published `files` allowlist, so an uncommitted `src/` edit ships in the tarball. Untracked files outside the allowlist (`scripts/`, `.scratch/`) cannot ship and do not block a release. Never stash or revert another member's work to clear the tree — establish whose it is first.
6. **Know what CI will and will not do.** The release commit's own run must be green on **both lanes** before tagging (§5). A documentation-only push produces no run at all: `ci.yml` ignores `**.md`, `docs/**`, and `assets/**`, so its evidence is `git diff --check`, link resolution, and a read-back from the remote.

## 3. Check ladder

Run in this order; a failure stops the release, and a fix re-runs from the failed step.

| Command | It refuses |
| --- | --- |
| `npm run typecheck` | Type errors against the certified harness checkout. |
| `npm test` | Test failures, and the five mechanical gates it bundles: `check:facades`, `check:docs`, `check:core-skills`, `check:boundaries`, `check:versions`. |
| `npm run build` | Build errors; also what `prepack` will run at publish time. |
| `npm run lint` | Lint findings. |
| `npm run test:browser` | Broken composition, Remote mounting, slot takeover, or ordinary-DSH restoration. Needs the adjacent `../deepseek-harness` checkout; browser acceptance is a local step and never runs in CI. |
| `npm pack --dry-run` | Nothing by itself — record the file count for the release report. |
| `npm run check:artifact` | An artifact that would ship broken: stray `.ts`/`.tsx`, a missing `cordis.patch.yml`, or a runtime relative import whose target is not in the tarball. Run it *after* `npm run build`. |
| `npm run check:public-baseline` | A public surface that drifted from the manifest's certified baseline (both READMEs and the pinned compatibility discussion). |
| `git diff --check v<previous>..HEAD` | Whitespace damage anywhere in the release's change set. The bare `git diff --check` inspects only *unstaged* work, so it passes silently once the release is committed — which is when the ladder runs. |

## 4. Release material

**`CHANGELOG.md`** gets a `## [X.Y.Z] - YYYY-MM-DD` section at the top, one theme per bullet, in the same words as the English half of the Release body. An `## [Unreleased]` section written by implementers is a completeness checklist, not draft prose.

**The GitHub Release body** ships both languages: Chinese first, English below, with a language switcher at the top and the sections 新增功能 / 体验优化 / 问题修复 / 其他变更 mirrored in English.

- Open with one line naming the previous version; close with the install block, the compatibility line, and a Full Changelog compare link.
- Write the register of DeepSeek Harness's own release notes: about eight bullets of one sentence each, naming the theme rather than its sub-behaviours.
- Leave out metrics, internal nouns, and file names; state what the version *is*, not what changed about it.
- GitHub rewrites raw HTML anchor ids, so the switcher's jump has not worked since 0.1.7; the switcher line is still the required shape, pending a maintainer decision.

**The pinned compatibility discussion** in `deepseek-ai/deepseek-harness` (discussion 4303) is a public surface with no sync path, which is why `check:public-baseline` exists. Maintenance is a rotation over three comments of our own: post the new release comment, fold the previous version into the version-history comment, then delete our own previous release comment by node id — post, verify, then delete. Never edit or delete anyone else's comment; the thread legitimately carries external comments and replies beyond our three.

## 5. Publish

Assert all four release-semantics facts **before** pushing or publishing:

1. The tag is exactly `v<package.json version>` — no drift between manifest and tag.
2. A prerelease suffix matches the GitHub Release's prerelease flag; a stable release is not flagged prerelease.
3. Publishing names the dist-tag explicitly — `npm publish --tag <dist-tag> --access public`, with `<dist-tag>` `latest` for a stable version and the prerelease's own tag otherwise. npm refuses a prerelease published under the default tag, so an omitted `--tag` cannot express this release at all: the run stops there rather than moving `latest`.
4. A release that takes `latest` never moves it backwards: the current `latest` must be semver-lower than the version being published.

```sh
git add package.json CHANGELOG.md
git commit -m "chore: release X.Y.Z"
git push --dry-run origin master            # fence: this must list exactly master
git push origin master
```

Wait for this run to be green on both lanes (§2.6) before tagging:

```sh
git tag vX.Y.Z
git push --dry-run origin vX.Y.Z            # fence: this must list exactly the tag
git push origin vX.Y.Z
npm publish --tag <dist-tag> --access public
```

The explicit refspecs and their dry-run fences are load-bearing, not ceremony. A clone can carry pre-rewrite backup branches and local-only tags whose commits are deliberately absent from the remote, and `--all` / `--tags` publish them silently. This repository is public: a stray ref cannot be withdrawn. If a dry run lists a third ref, stop and find out whose it is.

Pushing master before the tag costs nothing and keeps the tag's evidence honest: the run that certifies a tag is the run of the commit the tag names. A tag may be re-pointed only while nothing references it yet — no GitHub Release, no npm version, no consumer.

## 6. Post-publish verification

1. `npm view @contexera/dsh-agent-team dist-tags.<dist-tag>` — equals `X.Y.Z`, the tag §5 published under. A release that took `latest` also moves the packument's own `version`; a prerelease on its own tag leaves `latest` where it was.
2. The GitHub Release exists, carries an explicit title, and renders both language sections.
3. The pinned compatibility discussion shows the new release comment.
4. The stable profile installs the release by **exact version**: `dsh plugin --profile web add @contexera/dsh-agent-team@X.Y.Z`. A plain `update` can report "Already up to date" because the lockfile pins the resolution; the profile must not be left reading a newer ledger with an older bundle, since both profiles share `$DSH_HOME/storages/`.
5. A **fresh install in an empty directory** loads the bundle from the registry — not from the checkout, and not through a source symlink.
6. The prose corrected in §2 step 4 still says the right thing when read back from `raw.githubusercontent.com`, not just from the working tree.
7. `npm run check:public-baseline` is green against the published version.

Registry reads lag right after a publish: the version document can be served before the full packument, so `npm view <name>` may briefly report the previous version, or `E404` for a package that is live. Never re-publish to "fix" a lag — poll the packument, or prove the artifact by installing from the tarball URL.

## 7. Never

- Never re-publish, unpublish, or move a tag that an existing release references. `npm deprecate` is the only sanctioned cleanup.
- Never rewrite shipped release material — the `CHANGELOG` entry, the Release body, or the release comment of a version that already published. Fix forward in the next patch. The single exception is a factual error found within minutes, corrected with maintainer approval.
- Never widen `peerDependencies` before certification has passed; a range claim is a support claim.
- Never publish from a tree with an uncommitted change to a build input.
- Never `git push --all` or `git push --tags`.
- Never `git add -A` in the shared worktree; stage your own paths.
