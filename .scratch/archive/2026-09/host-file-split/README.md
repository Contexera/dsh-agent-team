# Host file split research

- Status: **implemented** — both phases landed (`bc9e848` types split, `5f749c0` MemberRuntime extraction + ablation pass); see `prototype-findings.md` "IMPLEMENTED" section for corrections to the prototype and final measurements.
- Last checked: 2026-09-02
- Scope: boundary study AND execution for splitting the large Host files (`index.ts`, `types.ts`); Human authorized direct implementation in the Task Thread (2026-09-02).
- End condition: met — `index.ts` 1552 → 1386, `types.ts` 1220 → 12-line barrel + 3 split files (357/319/596), `member-runtime.ts` 254 lines with a 3-dependency seam. Zero test edits; full verification green.
- Formal-document exit: met — the member-runtime module ownership note is in `docs/architecture/package-ownership.md`.
- `ledger.ts` still deferred (2026-08 verdict); `TeamThreadPage.tsx` untouched.

## Why now

0.1.5 → 0.1.6 grew `index.ts` 1136 → 1552 and `types.ts` 1042 → 1220 through the member-runtime feature cluster. Unlike the 8 月 audit verdict on `ledger.ts` (39-method authority closure, do not split), this new block has a natural seam: it is a cohesive responsibility cluster (capabilities schema, tool policy lifecycle, skill provider mount, private memory) with weak coupling to the ledger authority closure.

## Plan of record (from Thread discussion, 2026-09-02)

1. `index.ts` → extract `member-runtime.ts` (capabilities validation/freeze, tool policy apply/reapply/release + turn-boundary wait, skill provider mount, private memory init/cleanup). Target: `index.ts` back to ~1100 lines. Pure move + explicit DI, no behavior change.
2. `types.ts` → physical split. Prototype revised this to **3 files** (`entities.ts` / `operations.ts` / `requests-results.ts`) instead of 5 — actors/activities interleave with entities and requests share the receipt section; see `prototype-findings.md`. Existing path re-exports, no public import path changes.
3. `ledger.ts` deferred: 8 月 verdict still applies; revisit when Runtime Revision manifests land a real second consumer.
4. `TeamThreadPage.tsx` untouched: prior seam trial proved no small return surface.
