# Agent Team architecture and layout

This work item started as a read-only audit of the repository's file and package structure. It is now **delivered**: the useful changes from that audit have landed. Written so that someone opening this directory for the first time — including a Human who has not followed the technical discussion — can see the result, the reasoning, and the current state without reading the code.

## Status

**Closed and archived 2026-09-17.** All required work is complete and both optional items were delivered; the Human accepted the landing and directed the archive. Everything landed in one commit on top of `021af8f` — `909ba2e` on `master` — and the full check set passes on it.

Note for readers of the tickets below: the hashes recorded there (`aca89c3` in ticket 02, the interim hashes in ticket 01) are working hashes from before the final fold. Only `909ba2e` and its ancestors are in `master`.

What landed, in plain terms:

1. The Client's member panel used to route through a pointless middle file that only forwarded its props; the panel is now registered directly and the forwarding file is gone. One stale, unread field on the footer contract went with it.
2. The development documentation no longer claims that the three `packages/*` directories are independent workspace packages. That statement was false — this repository publishes **one** npm package, and the three directories are its build/export seams. The same confusion had already nearly caused another Member to delete `pnpm-workspace.yaml`, which is load-bearing.
3. The documentation now contains the checklist for adding a Host operation: which six places must change together. This was the largest genuine gap — without it, the only way to learn the answer is to read roughly 4,000 lines of ledger code.
4. The Client now reaches the Team Remote through the declared subpath `@wowyuarm/dsh-agent-team/remote` instead of climbing into another package's generated directory. The build output is byte-identical in size to before, so behavior did not change. The underlying cause was a working-directory bug in the bundler config, not the resolution-priority problem it first looked like — see ticket 01 for the corrected account.
5. A new mechanical check (`npm run check:boundaries`, part of `npm test`) now fails the build if any file under `packages/*/src/` crosses a package boundary by a relative path, so item 4 cannot silently regress.

last-checked: 2026-09-15 (all tickets complete; the two optional items were approved by the Human and delivered).

## Goal

Make future Agent Team extensions easier to place and review, without inventing generic layers or moving files for appearance's sake. The work turns the seams that already exist into written rules, preserves a package boundary that already exists, and defines the condition under which a later activation refactor may start.

## Current frontier

1. **Ticket 01 — use the public Remote entrypoint: complete.** The Client imports `@wowyuarm/dsh-agent-team/remote`, the bundler resolves that subpath through an explicit, cwd-anchored resolver, and no generated facade or generator was touched. The ticket records the corrected root cause: a working-directory bug in the bundler config, not the resolution-priority conflict it first appeared to be.
2. **Client settings forwarder cleanup: done.** Covered in item 1 of the Status list above.
3. **Member activation extraction: deferred by design.** The audit measured that `activateMember` owns no state of its own and would produce a 20-plus-field dependency bag if extracted now. Reopen only when a new Member-level capability makes the ownership question real; the first step then is to move activation-owned state into an existing owner, not to extract a module.
4. **Boundary guard: done.** `scripts/check-package-boundaries.mjs` runs inside `npm test` and rejects an escaping relative specifier between packages. Its scope is deliberately narrow — `import type` is exempt and test files are out of scope — and the ticket records the first version's bug so it is not repeated.

## Completion conditions

- A Client import cannot bypass the public Remote package subpath without an explicit, reviewed exception. **(met — and now mechanically enforced by `npm run check:boundaries`)**
- A maintainer can locate each package's authority, composition root, and extension point from maintained documentation. **(met)**
- Adding one Host operation has a written cross-layer checklist, while operation-kind semantics stay concentrated in the ledger implementation. **(met)**
- No generic `services/`, `utils/`, or `adapters/` directory is introduced without a real second adapter or a deep interface. **(rule written; the package-boundary case is now guarded, the rest stays a review matter)**
- The activation refactor stays gated by a real extension need and does not create a 20-plus-field dependency bag. **(met — deferred by design)**

## Formal-doc exit

All exits are satisfied:

- Package ownership and dependency direction → `docs/architecture/package-ownership.md`. **Done.**
- The operation-extension workflow, the seam rules, and the new `check:boundaries` gate → `docs/development/start-and-checks.md`. **Done.**
- The activation-owner rule → stated in `architecture.md` and in frontier item 3 here. **Done as a rule; the refactor itself is deliberately not scheduled.**
- The Client settings forwarder → removed rather than documented. **Done.**
- The Remote entrypoint correction → recorded in ticket 01 rather than in maintained prose, because it is an implementation constraint with no user-visible contract.

Archived under `.scratch/archive/2026-09/agent-team-architecture/` on 2026-09-17, after the Human accepted the landing commit. Nothing was outstanding.
