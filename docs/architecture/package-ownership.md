# Package ownership

English | [中文](package-ownership.zh.md)

This page owns the published package boundary and import direction. For runtime authority, continue to [Host authority](host-authority.md); for exact tool rosters, use [Tools and preset](tools-and-preset.md).

## One package, three source seams

The root `package.json` publishes one package, `@contexera/dsh-agent-team`. The three directories below have no manifests of their own; they are build and export seams, not separately released packages.

| Directory | Owns | Entry points |
| --- | --- | --- |
| `packages/agent-team` | Host service, operation ledger, projections, Agent lifecycle, manager runtime, and Remote declarations | `src/index.ts` |
| `packages/tool-agent-team` | Model-facing tool declarations and handlers | `src/index.ts`, `src/subscription.ts` |
| `packages/client-agent-team` | Client loading and browser presentation | Node: `src/index.ts`; browser: `src/client/` |

Dependency arrows below mean “consumes,” not “imports implementation internals”:

```text
tool-agent-team   → live Host service
client-agent-team → typed Remote + public Team types
agent-team       → neither tool nor Client implementation
```

Tools resolve the live Host service at execution time. They neither create another service nor write projections directly. The browser reads Host projections through typed Remote and renders them through public Harness slots. No seam reaches another seam's generated `lib/` by relative path.

[Generated files and seams](../development/generated-and-seams.md) owns the build mechanics and operation-extension checklist.

## Host module map

Under `packages/agent-team/src/`, the main responsibilities are:

| Module | Owns |
| --- | --- |
| `index.ts` | Host composition, lifecycle orchestration, and typed Remote adapters. |
| `member-runtime.ts` | Per-Member tool restrictions, skill mounts, capability warnings, and private-memory provisioning. |
| `ledger.ts` | Durable commits, authorization, replay validation, and projections. |
| `spec.ts` | Stored operation schemas and the Team storage-domain specification. |
| `types.ts` | Public type barrel over `types/entities.ts` (ids and entities), `types/operations.ts` (ledger records), and `types/requests-results.ts` (requests, results, receipts, and views). |
| `invariant.ts` | Companion plugin that validates the ledger at mount and rechecks it after commits. |

`MemberRuntimeDeps` keeps the runtime seam to three dependencies: Host `ctx`, a `liveMemberContext` resolver, and the shared read-only `runningAgents` set. The Host retains the ledger, Agent handles, notifications, and recovery orchestration.

## When to introduce a seam

A second caller, a second adapter, or independently owned state justifies a seam; line count alone does not. `index.ts` holds composition and `ledger.ts` holds authority. Do not split them merely to shorten files, or add `services/`, `utils/`, or `adapters/` before a real second implementation exists.

Keep a call inline when a proposed module only forwards props, renames the call, or re-exports it without owning state or an invariant. Remove dead forwarding contracts rather than preserving an empty layer.

A rule used by more than one module belongs in one imported implementation. For example, `packages/agent-team/src/text.ts` owns character counting and truncation in code points: judging a bound in code points but slicing in UTF-16 units breaks that rule.
