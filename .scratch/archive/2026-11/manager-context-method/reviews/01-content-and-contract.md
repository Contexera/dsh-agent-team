# Independent content and contract review

Reviewer: Reeve, 2026-11-16. Prompt delivery reviewed: `26369d2`; tool deliveries: `177527f` and `3d9dea4`.

## Current disposition

Tools: review passed. Prompt/skills: review passed through `510be41`; all same-ticket findings below are resolved by `5cc41c9` and `510be41`.

Final checks independently run by Reeve:

- Tool readback/rendering: 3 files / 57 tests passed (command below).
- Manager memory unit/integration, Member skill isolation and shipping: 4 files / 29 tests passed.
- Final Host-opened manager model-issued skill call and shipping: 2 files / 15 tests passed (shipping repeats 9 from the prior group).
- `npm run check:core-skills`, `npm run check:docs`, `git diff --check HEAD`: passed.

The final actual-request case calls `ctx.agentTeam.openManagerSession`, captures the first model request's catalog and `skill` schema, emits a model tool call, and asserts the skill body in the following request. The reviewer read all delivery diffs and manager skill bodies; no production files were edited by the reviewer.

Persona body: 3,990 characters; deliberately reviewed ceiling: 4,500, so preserving authority/qualifiers no longer requires cutting them to fit. The five manager skills each remain within the existing 7,850-character ceiling.

Scope caveat: no paid live-model behavior comparison or existing GUI process reload was performed. The tests prove content delivery and role isolation, not improved judgment under a real model. No Team configuration, lifecycle, permission or UI change belongs to this prompt slice; no push or release was performed.

## Tool evidence

Read complete tool diffs and source at `member-runtime.installMemberToolPolicy`, `applyMemberEditEffects`, `managerMemberEntry`, and status projection. Corrected two initial overclaims: runtime ignores unknown allow-list entries without changing the stored list; overview's model is configured intent, not necessarily the live model.

Independently confirmed built `packages/tool-agent-team/lib/index.js` carries the corrected strings, then ran:

```sh
npx vitest run packages/tool-agent-team/tests/manager-tools-render.spec.ts packages/agent-team/tests/manager-member-adjust.spec.ts packages/agent-team/tests/manager-reads.spec.ts
```

Result: 3 files / 57 tests passed, exit 0. Includes real Host → tool → render readback and preserved invalid stored allow-list entry. No Client/Remote activation changes; browser run not required for this tool-text slice.

## Prompt/content findings returned

- Restore explicit Human-only authorization/escalation conditions and preference for reversibility removed from persona. Trim duplicate authority prose rather than losing boundaries to the size budget.
- Memory: remove transient `in hand`; keep a short binding rule resident and details in notes; do not require a three-tier/3–6-cluster scaffold; distinguish baseline index from later stale-copy notice.
- Domain skill: retain the current-Human-request exception for confirmed Member private assets, while Session logs remain forbidden.
- Event loops: a no-op reminder is not automatically unhealthy; absent visible events do not prove a successful source read; DM does not carry responsibility/decisions; resume a paused subscription before replay; independent verification follows risk; Human-triggered work is not categorically broken.
- Actual skill request coverage currently uses user `/team-management-guide` expansion. Add a real manager opened by the Host whose model emits a `skill` tool call, and inspect its next request for the body.
- Changelog: enumerate delivered fields instead of claiming every writable fact is read back.

Stable refs and complete instructions are on task:3a303e8a-e777-4b8d-acb9-325d7e13a9c9. No production files were edited by the reviewer.
