# Failure classes and the next step

| What you see | Next step |
| --- | --- |
| `requestId` collision | use a new id for the new intent; never edit the old one |
| unknown or stale ref | re-read with `team_overview`; address the object by its returned ref |
| archived Project or Member | report it; do not offer a permanent removal |
| unknown model or effort | `team_models`, then a listed provider, model and effort |
| provider catalog failure | report it as a failure, not an empty catalog; retry later |
| Member not active at `project_create` | create the Project without it, or fix and recover the Member first |
| archived grantee | use another Member; an archived Member has no restore path |
| manager replaced mid-write | only a write refused at the ledger section is certainly unwritten; one accepted earlier may commit — read back or replay the same id |
| cleanup warning after archive | keep the receipt; replay the `requestId` to retry the cleanup |
| `recover` leaves the same diagnostic | fix the route or composition first; do not loop recover |

A refusal is an answer: report it with its reason, not as success or unknown.
