# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/Contexera/dsh-agent-team/security/advisories/new).
Please do not open a public issue for a security problem.

Include what you can: the affected version, the DeepSeek Harness version you ran
it on, the smallest reproduction you have, and what an attacker gains. A partial
report is more useful than a withheld one.

## What to expect

We acknowledge reports within a few days and tell you whether we consider it a
vulnerability. Because Agent Team runs inside your Harness with the authority you
granted it, a report that only restates a capability the operator deliberately
enabled is not a vulnerability — say what crosses a boundary the operator did not
grant.

We will credit you in the advisory unless you ask us not to.

## Supported versions

Security fixes ship on the current release line. Agent Team is certified against a
specific DSH range — see
[`docs/dsh-release-compatibility.md`](docs/dsh-release-compatibility.md) — and a
release outside that range is unsupported rather than patched.
