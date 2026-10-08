# Package ownership

English | [中文](package-ownership.zh.md)

```text
packages/agent-team
  Host service + operation ledger + projections + Agent lifecycle + Remote declarations
        │
        ├── packages/tool-agent-team
        │     model-facing team_inbox / team_thread / team_message / team_claim / team_view
        │
        └── packages/client-agent-team
              typed Remote client + Team mode + browser presentation
```

These three directories are the build and export seams of one published package, `@contexera/dsh-agent-team`, declared by the root `package.json`; none has a manifest of its own. Dependency direction is one-way: Host never imports Client or tool implementation internals, tools resolve the live Host service at execution time, and Client consumes typed Remote plus public types and Harness slots — never another seam's generated `lib/` by relative path.

[`generated-and-seams.md`](../development/generated-and-seams.md) owns the seam mechanics, the Host module layout, and the operation-extension checklist.

- `packages/agent-team` owns Team capability. Its service keeps ledger, handles, notifications, and recovery orchestration, and its modules split as:
  - `src/index.ts` assembles the service and declares Remote methods;
  - `member-runtime.ts` owns per-Member runtime state (tool-policy restrictions, capability warnings, private skill mounts and selections, private-memory provisioning) behind a three-dependency seam (`ctx`, live member context, shared running-agents set);
  - `ledger.ts` commits operations;
  - `spec.ts` defines records;
  - `types.ts` re-exports the domain split (`types/entities.ts`, `types/operations.ts`, `types/requests-results.ts`) as the single public import path;
  - `invariant.ts` checks relationships.
- `packages/tool-agent-team` resolves the live Team service at execution time. It does not create another service or write projections directly.
- `packages/client-agent-team` has a Node half (`src/index.ts`) and browser half (`src/client/`). The browser half reads Host projections through typed Remote and renders them through public Client slots.

A seam is earned by a second caller, a second adapter, or independently owned state — never by line count. `index.ts` and `ledger.ts` are large because they hold composition and authority, not because a layer is missing; do not split either to make a file smaller, and do not introduce `services/`, `utils/`, or `adapters/` directories before a real second implementation exists. A module that only re-exports, only forwards props, or only renames a call carries no state and no invariant: keep that call inline or delete the dead side of the contract.
