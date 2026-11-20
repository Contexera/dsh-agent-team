# dsh-agent-team / deepseek-harness Navigation

English | [中文](harness-navigation.zh.md)

Use this page when a Team change depends on a Harness capability. The Team repository owns Team behavior; Harness owns the services and extension points that Team uses.

## 1. Start with the right checkout

Use the pinned `../deepseek-harness` checkout described in [development setup](development/environments-and-install.md). All paths in the Harness column are relative to that checkout. Read the relevant upstream guide, then verify the contract in upstream source and tests.

If a public extension point is insufficient, record the limitation and choose a Team-owned plugin or design. Do not alter ordinary Harness behavior to make a Team change work. See the [repository guardrails](../AGENTS.md#architecture-guardrails).

## 2. Find the contract by change type

| Change | Team: start here | Harness: inspect next |
| --- | --- | --- |
| Host, ledger, or lifecycle | [Host authority](architecture/host-authority.md); `packages/agent-team/src/{index,ledger,spec,types}.ts` and Host tests | `docs/architecture.md`, `docs/agent-lifecycle.md`, `docs/subsystems/storage.md` |
| Model-facing tool or preset | [Tool contracts](team-collaboration/tools.md), `packages/tool-agent-team/src/`, and the isolated preset rows in [cordis.patch.yml](../cordis.patch.yml) | `docs/cookbook/adding-a-tool.md`, `docs/subsystems/permission-presets.md`, `docs/subsystems/system-prompt.md` |
| Client plugin, slots, or loading | [Client and Remote](architecture/client-and-remote.md), then `packages/client-agent-team/src/client/` | `packages/client/AGENTS.md`, `docs/subsystems/client-modules.md`, `docs/subsystems/slots.md`, `docs/cordis-tutorial/02-lifecycle-and-effects.md` |
| Typed Remote, RPC, or generated files | Host `@Remote` declarations in `packages/agent-team/src/index.ts` and [the generator](../scripts/generate-typert.mjs) | `docs/subsystems/typert.md`, `packages/typert/{generator,loader,protocol,registry}/`, `packages/api/remotes/` |
| Workspace, Session, or directory selection | [Workspace, Session, and storage](architecture/workspace-session-storage.md) and Workspace reads in `packages/client-agent-team/src/client/index.ts` | `docs/subsystems/{workspace,session,working-directory,storage}.md` |
| Persistence, replay, or Thread Inbox | [Host authority](architecture/host-authority.md), [Inbox and messaging](team-collaboration/attention-and-messaging.md), and ledger tests | `docs/subsystems/{storage,persistence}.md`, `docs/defensive-patterns/` |
| CSS, UI primitives, or responsive layout | [UI design guide](frontend-design/README.md), then the component and its CSS Module | `docs/web-styling.md`, `packages/client/AGENTS.md`, `packages/client/ui-primitives/` |
| Publishing or bundle installation | [Compatibility record](dsh-release-compatibility.md), [package.json](../package.json), and [cordis.patch.yml](../cordis.patch.yml) | `apps/cli/reference/README.md`, `docs/user/develop/basic/publish.md` |
| Real Web acceptance | [Browser lanes](development/e2e-lanes.md), `scripts/e2e/`, and the current run's output | `docs/testing.md` and `packages/client/` tests |

## 3. Verify at the boundary

- **Host or persistence:** keep one durable commit path. Use Session logs as evidence for new model-visible input. For lifecycle changes, cover package behavior and real composition; for storage or replay, test failure and recovery rather than adding a silent fallback.
- **Remote:** `InvocationDescriptor` is reflection metadata, not wire data. Follow the [generated-file workflow](development/generated-and-seams.md#generated-files) for regeneration, typecheck, build, and checking that output is stable. Never hand-edit `packages/agent-team/lib/typert.*`.
- **Workspace:** the Team Client reads `ctx.workspaces.list`. It does not pick directories or create Workspaces; users do that in the ordinary DSH UI. Preserve branded Workspace IDs and Host-owned working-directory rules.
- **Client or Web:** follow the [repository browser checks](../AGENTS.md#choose-checks-for-the-change). Verify that ordinary Sessions do not acquire Team tools, guidance, or UI. Do not commit temporary overlays, browser tests, or generated files to Harness.

## 4. Install or develop the bundle

Use the [published quick start](../README.md#quick-start) for installation without a sibling checkout. For local builds and verification, use [development setup](development/environments-and-install.md) and the [check guide](development/start-and-checks.md), including when to run preview or browser tests.

The root manifest points `dsh.bundle.patch` at `cordis.patch.yml`. The patch mounts the Host inside `contexera-agent-team-scope`, with a private `agentPresets` registry for `team-member` and `team-manager`. Client and invariant rows sit outside that group.

For local generation, `generate:typert` uses Harness's `WorkspaceAnalyzer` and `FaceModelEmitter`. `scripts/sync-paths.mjs` generates the root TypeScript facades: tests use Harness source; typecheck and build use declarations. Do not hand-edit the facades or add `include` or `files` to them.

## 5. Maintain these routes

Recheck upstream paths and contracts when the pinned Harness checkout changes. Keep implementation details in their owning docs, and label any linked `.scratch/` material as design or history, not a contract.
