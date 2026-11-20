# Security Model

This document states where Agent Team draws its security boundaries, which
risks it accepts by design, and what therefore counts as a vulnerability.
[`SECURITY.md`](SECURITY.md) explains how to report one.

## Purpose and scope

Agent Team is an opt-in Cordis bundle that runs inside a locally started
DeepSeek Harness (DSH). It has no hosted service: everything below runs on the
operator's machine, under the operator's operating-system account.

This model covers the code in this repository. DSH itself — its web server,
browser authentication, agent loop, shell executor, sandbox, and credential
store — is upstream; report problems there to the DSH project.

When this document and the code disagree, the code is the current behavior and
this document is wrong.

## System and trust boundaries

One DSH server hosts one Team: one Human and any number of Agent Members, each
an LLM Session, plus a Host-managed Team manager Session. The bundle crosses
five boundaries:

| Boundary | What crosses it | Where it lives |
| --- | --- | --- |
| Browser ↔ Host | The Human Web Client calls the typed Remote served by the DSH browser web server. | `@Remote` methods in `packages/agent-team/src/index.ts`; Client in `packages/client-agent-team/src/` |
| Internet ↔ webhook ingress | `POST <prefix>/<token>` deliveries from external providers, through a tunnel or reverse proxy the operator sets up. | `packages/agent-team/src/webhook-ingress.ts`, `webhook.ts`, `subscription-webhook.ts` |
| Agent ↔ Host authority | Members act on the Team only through model-facing Team tools; the Host decides whether each call is allowed. | `packages/tool-agent-team/src/`; enforcement in `packages/agent-team/src/` |
| Host ↔ filesystem and shell | Attachments, Human avatar, Member private memory, subscription scripts run through the DSH shell executor with injected credentials, optional Worker engines. | `attachments.ts`, `human-avatar.ts`, `private-memory.ts`, `subscription-runner.ts`, `worker-*.ts` in `packages/agent-team/src/` |
| Team preset ↔ ordinary Sessions | Team tools and guidance exist only inside the isolated `team-member` and `team-manager` presets. | `isolate.agentPresets` in `cordis.patch.yml` |

## Assets, ranked

1. **Host files and credentials.** The operator's files, the credentials the
   Host resolves for subscriptions, and webhook tokens.
2. **Team authority.** The integrity of the append-only ledger and its rules:
   who may accept, close, reopen, or transfer work, and the revision and
   idempotency fences on every write.
3. **Team content.** Thread and Main messages, attachments, and each Member's
   private memory.

## Actors

| Actor | Reaches the bundle through | Trusted with |
| --- | --- | --- |
| Human | A browser session the DSH web server admits. | Everything. Every admitted Remote call acts as the Human. |
| Team manager | Manager tools in the `team-manager` preset. | Creating Members and Projects and changing Member settings, including `capabilities.tools.allow`. It is an LLM Session and may be steered by what it reads. |
| Agent Member | Member tools in the `team-member` preset, plus whatever non-Team tools its preset and restriction admit. | Its own Team permissions only. Treated as possibly prompt-injected by content it reads. |
| Webhook sender | The public webhook route. | Nothing beyond the token in the URL. |

## Boundaries the bundle enforces

Each of these is a promise the code keeps. Breaking one is a vulnerability.

- **Host-enforced Team authority.** Membership, Project ownership, the
  accept/close/reopen/transfer rules, revisions, unread fences, and
  idempotency are decided by the Host for every write, whichever surface sent
  it. The Client is non-optimistic and holds no authority of its own. See
  [`docs/team-collaboration/boundaries.md`](docs/team-collaboration/boundaries.md)
  and [`docs/architecture/host-authority.md`](docs/architecture/host-authority.md).
- **Member tool restriction.** The tool restriction the Host installs for a
  Member is a limit on what that Member can do. No Team tool may hand back a
  capability the restriction removed. In particular, `team_subscription`
  refuses `create`, `update`, `test`, `resume`, and `replay` for a Member
  whose enforced tools include neither `bash` nor `pwsh`
  (`subscription_shell_required`), before any script is read or run
  (`enforcesShellTool` in `packages/agent-team/src/member-runtime.ts`,
  `scriptRunningMemberCall` in `packages/agent-team/src/index.ts`).
- **Subscription script paths.** A `scriptPath` from an Agent must resolve
  inside that Agent's working directory, checked lexically and again after
  `realpath`, so an absolute path elsewhere, `..`, or a symlink cannot read
  another Host file (`readAgentScript` in `packages/agent-team/src/index.ts`).
- **Subscription run policy.** An unattended subscription run uses an explicit
  `workspace-write` sandbox policy built from the Host's Workspace record and
  never inherits an Agent's escalated mode
  (`packages/agent-team/src/subscription-runner.ts`).
- **Webhook ingress.** The route lives on a second web server in an isolated
  realm, bound to `127.0.0.1` by default, so a provider never reaches the
  browser API. It accepts only `POST`, bounds the body and the read time,
  requires valid UTF-8, and never logs the path. Tokens are stored only as
  SHA-256 hashes and compared with `timingSafeEqual`
  (`packages/agent-team/src/webhook.ts`,
  `packages/agent-team/src/subscription-webhook.ts`).
- **File storage containment.** Attachment and Human avatar files are checked
  with `realpath` and `lstat` to stay inside their storage roots
  (`packages/agent-team/src/attachments.ts`,
  `packages/agent-team/src/human-avatar.ts`).
- **Preset isolation.** Team tools and guidance are registered only in the
  isolated Team preset registry; an ordinary DSH Session never acquires them
  (`cordis.patch.yml`,
  [`docs/architecture/tools-and-preset.md`](docs/architecture/tools-and-preset.md)).

## Accepted risks

These follow from deliberate design. A report that only restates one of them is
not a vulnerability.

- **Members run with full access.** Member and manager Sessions are forced into
  `danger-full-access`, and Workers default to it. A Member whose restriction
  admits a shell can do anything the operator's account can, including reading
  credentials or Team storage directly; the Team boundaries above constrain
  what it does *through Team tools*, not what its shell can reach.
- **The tool restriction is not a sandbox.** It decides which tools a Member
  can call; it does not confine a tool the Member keeps.
- **The Worker switch is an operator grant.** While the Host Worker switch is
  on, a Project owner can delegate to a Codex or Claude Worker through
  `team_worker`, even without a shell tool of its own. Turning the switch on
  grants that, for every Member.
- **The manager can widen Member settings.** `member_create` and
  `member_update` write `capabilities.tools.allow`. Steering the manager is
  therefore a way to widen a Member's tools, by design.
- **Human-authored scripts run with credentials.** A subscription script the
  Human pastes runs unattended with the credentials it declares.

## Out of scope

- DSH's own code, including how its web server listens and admits browser
  requests. DSH binds one concrete address and rejects wildcard addresses.
- An operator choosing to expose the DSH port or the webhook ingress beyond
  the machine, for example to a LAN, without their own protection.
- Anything the admitted Human does.
- Releases outside the certified DSH range in
  [`docs/dsh-release-compatibility.md`](docs/dsh-release-compatibility.md).

## What counts as a vulnerability

A finding is a vulnerability when it breaks a promise under
[Boundaries the bundle enforces](#boundaries-the-bundle-enforces) without the
operator granting it. For example:

- A Member whose shell tools were removed reads Host files or runs commands
  through a Team tool.
- A Member accepts its own work, or acts in a Workspace or Project it does not
  belong to, through a Team tool.
- A webhook request without the right token is delivered, or a delivery
  reaches the browser API.
- An ordinary DSH Session gains a Team tool.
