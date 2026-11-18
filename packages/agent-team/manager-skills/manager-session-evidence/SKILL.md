---
name: manager-session-evidence
description: How to answer "what did this Member actually do, see, or get told" — locate its current Session with team_overview, index the stored log, read a bounded raw window, and separate fact from inference — using the shipped read-only reader. Read when a question is about a Member's own inputs or behavior rather than current Team state.
---

# Session evidence

A Member's Session log records what the model was given and what it did: why it keeps asking for permission, whether it ever saw a decision, what a tool returned, where a turn went wrong. It does not record file side effects or decisions made outside a Session.

Not for current state: Team, Project, Member and Task facts come from `team_overview` — its summary and the Member rows — and a decision recorded in a log is history, not the current one. Ask what observation would change your answer; if nothing in the log could, do not read it.

## Locate

`team_overview` with `memberRef` adds `sessionEvidence`:

| field | meaning |
| --- | --- |
| `sessionId` | the Session the Member is running now |
| `state` | `stored` — a durable log exists; `pending` — created, not yet flushed; `missing` — no durable log; `unreadable` — a log exists and the backend refused it |
| `location` | the backend-resolved log path: provenance only, never open it yourself |
| `reader` | `script` — the shipped reader; `anchor` — the installed Harness package whose backend it resolves |
| `failure` | for `unreadable`: `kind` (`missing`/`refused`/`corrupt`/`io`/`unknown`) + `detail` |

The locator covers that one Session id: an older generation of the same Member has its own id and is not included, so name the Session you read when the question is about earlier work.

`pending` and `missing` are not evidence that the Member did no work: an unflushed Session has no log yet. Report the state you found.

## Index, then window

The reader is read-only and needs no checkout, `tsx` or repository:

```sh
node <reader.script> index --session <sessionId> --log <location.path> [--anchor <reader.anchor>] [--limit 40] [--type tool/call] [--tool team_] [--from-seq N] [--to-seq N]
node <reader.script> window --session <sessionId> --log <location.path> --seq N [--before 3] [--after 3] [--offset N]
```

`index` returns rows — `seq`, `type`, `time`, `turn`/`step`, `callId`, `toolName`, `dataLength` — and no bodies: find the turn, call or request there, then `window` around one `seq` for the raw events. Every answer is one JSON object: exit 0 means the log was read, including "no events matched"; exit 2 means it could not be read and the JSON names why; exit 1 is a refusal — that `--log` is not the Session's current artifact, so re-read `team_overview` instead of trusting it.

Bounded output is not a bounded read: the backend validates the whole stored log to answer, and only the rows come back. `window` caps each event and the whole window; `budget.outputCharacters` is the size it printed. A cut event carries `dataSegment` (`offset`, `nextOffset`, `totalCharacters`, `remaining`): continue with `--offset <nextOffset>` until `remaining` is 0 — the pieces concatenate into the original JSON, and you never open the log to finish an event.

## Read the turn in order

The request and injected context (`user/message`, `system/message`), whether the authority it needed was already there (asking again is not proof it lacked it), and what each `tool/result` returned. A refusal is evidence about the tool, not the Member's judgment.

## Judge

Keep three apart in what you report: **fact** (an event you read, with its seq), **inference** (what you conclude), **unknown** (what the log cannot show — what the Member believed or saw elsewhere).

Five causes explain most of "why did it do that", and each has an observation that would rule it out:

| cause | what you would see | what rules it out |
| --- | --- | --- |
| the goal was unclear | the request is ambiguous, or a later message contradicts it | a clear request, correctly read |
| the evidence was unreachable | the needed fact was never in the context, or a read failed | the fact present in a `tool/result` before the decision |
| a tool or trigger failed | a refusal or error it could act on | every call succeeded |
| capacity or route | the turn never completed, or a model failure | completed turns on the same route |
| responsibility was missing | nobody owned the next step, so it asked | an owner already named for that step |

If the log cannot separate two causes, name the missing segment — an earlier Session, another Member's log, a decision made outside one — and what would settle it; never turn an unread segment into a conclusion.

## Report and boundaries

Report the Session id, the seq range, what it shows, what remains unknown, and the one change you would make. Quote the minimum: never copy credentials, private injected content or whole bodies into a Thread, a goal or a memory file — a locator plus a seq is enough for whoever needs the rest.

The log is read-only evidence: it authorizes no write and replaces no `team_overview`. This round adds no collaboration writes either — you still cannot message, remind, subscribe or delegate a Worker.

[One worked diagnosis](references/worked-diagnosis.md) walks these steps on "why does this Member keep asking for permission".
