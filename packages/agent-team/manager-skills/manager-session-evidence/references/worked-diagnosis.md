# Worked diagnosis

"why does @Vera keep asking for permission instead of doing the work?"

## Locate and index

`team_overview` with `memberRef` returns `sessionEvidence`: `state: stored`, `sessionId`, `location.path`, `reader`.

```sh
node <script> index --session <id> --log <path> --type user/message,assistant/message,tool/call,tool/result --limit 60
```

Read the rows as a shape, not content: which turns exist, where a `tool/call` has no matching `tool/result`, which end early. `dataLength` says which events are worth a window — 40 characters is a nudge, 3,000 carry a decision.

## Window on the ask

Window the `assistant/message` holding the request and the `user/message` that opened the turn, and check the five causes against what you see:

- **The request was ambiguous.** The `user/message` names a goal but no scope, and the Member asks which of two readings to take. Unclear goal: restate it in the Project or the owner's responsibility, not in a reply the next Session will not read.
- **The authority was already there.** An earlier `system/message` or `user/message` in the same Session carries the Human's decision and the Member asks anyway. Then the cause is not missing authorization: window the events between the decision and the ask — a failed `tool/result`, or a context replacement that dropped it.
- **The tool refused.** A `tool/result` reports a refusal and the next `assistant/message` asks the Human instead of reporting it. Fix the tool's precondition; the ask was a reasonable fallback.
- **The turn never completed.** `step/start` without `step/end`, or a `turn/end` with a failure reason. Capacity or route: `team_overview` shows the configured model, `member_update` changes it.
- **Nobody owned the next step.** The Member asks because no owner covers that area, and asking is the only correct move. Fix it with `project_owner` and a responsibility that names the decision.

## Report

"Vera's Session `<id>`, seq 12–31: the Human's decision is at seq 14, Vera asks again at seq 29, and between them a `team_thread read` at seq 21 was refused. The ask followed a failed read, not missing authorization — the decision was in its context. Unknown: an earlier Session. Next: fix the refusal, re-check the next turn."

## What this is not

Not a template: most questions need two of the five causes checked, and some need no log at all. The method is the order — locate, index, window, separate fact from inference — not the checklist.
