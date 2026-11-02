# Reading a Session Log

How to turn a local agent session into evidence an ax-review finding can stand on.

A session log is not a transcript you can read. A single session can reach several megabytes, most of it machinery, and loading it whole destroys the review it was meant to inform. What you want from it is a few aggregates and a short timeline. Everything below serves that.

## Locate the log

| Harness | Path |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<session-id>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Pi | `~/.pi/agent/sessions/<slug>/*.jsonl` |

A Claude project slug is the absolute path with `/` replaced by `-`, plus a leading `-`. A Pi slug wraps the same form in `--`. Codex nests by date instead, with the project in the first `session_meta` record.

When you cannot name the file, let the `ai-discussion-recap` skill find it — it owns the per-harness discovery, including the fallback scans when a slug directory is missing. A session running right now is reachable directly too: `CLAUDE_CODE_SESSION_ID` holds its id.

## Skip the machinery

Two thirds of a log is plumbing, and which two thirds differs per harness. Getting this wrong is what turns a review into noise.

**Claude.** Real turns are `type: user` / `assistant` records whose `message.content` is text. Skip `progress`, `attachment`, `file-history-snapshot`, `system`, and `api-request*`. Also skip user records whose text opens with `<local-command-*>`, `<command-*>`, `<system-reminder>`, `<task-notification>`, a continuation summary, or a `Base directory for this skill:` preamble — they look like user turns and are not. A compacted session opens with a long summary; that is a summary, not something the user said.

**Codex.** Real turns are `response_item` records whose payload is `message` with role `user` or `assistant`. Skip `event_msg`, `token_usage_record`, `turn_context`, and payloads of type `reasoning`, `function_call`, `custom_tool_call*`. Messages beginning with `# AGENTS.md instructions for ` or `<environment_context>` are injected setup.

**Pi.** Real turns are `type: message` records with `message.role` of `user` or `assistant`, text blocks only. Skip `session`, `model_change`, `thinking_level_change`, `custom`, and nested `thinking` / `toolCall` blocks.

**Subagent transcripts are not sessions.** Claude nests them at `<session-id>/subagents/agent-*.jsonl` and marks every record `isSidechain: true`; Codex and Pi keep their helpers inside the same file. Each subagent transcript is one prompt handed to a helper, so its evidence says nothing about how the session went. Counting it as a session is how a review reports friction nobody hit.

## The aggregates

Each answers one ax-review question, so each maps onto a finding type.

**Repeated reads — did the agent know where to look?** Count tool calls by their path argument. A file touched three or more times means the agent did not know where that fact lived. The fix is a navigation pointer, not a rewrite.

**Failures — would a check have caught it?** See below; this one needs care.

**Large results — was the tool shape economical?** A single tool result over roughly 20k characters means a command dumped what should have been selected. Check the call before blaming the tool — some reads are simply that big.

**Turn shape — was the session converging or thrashing?** Count user turns against assistant turns. Many short assistant turns between two user turns is exploration; the fix is a pointer or a check, not more instructions.

### Claude

```bash
python3 - "$HOME/.claude/projects/<slug>/<session-id>.jsonl" <<'EOF'
import json,sys,collections
reads=collections.Counter(); calls=collections.Counter(); big=[]
for l in open(sys.argv[1],encoding='utf-8',errors='replace'):
    try: d=json.loads(l)
    except: continue
    m=d.get('message')
    if not isinstance(m,dict) or not isinstance(m.get('content'),list): continue
    for b in m['content']:
        if not isinstance(b,dict): continue
        if b.get('type')=='tool_use':
            calls[b.get('name')]+=1
            fp=(b.get('input') or {}).get('file_path')
            if fp: reads[fp]+=1
        elif b.get('type')=='tool_result':
            s=str(b.get('content') or '')
            if len(s)>=20000: big.append(len(s))
print('calls:',dict(calls.most_common(5)))
print('reads 3+:',[(k,v) for k,v in reads.most_common(6) if v>=3])
print('results >=20k:',len(big))
EOF
```

Codex and Pi need the same loop with their record shapes substituted; the aggregates do not change.

## Reading failures without being lied to

This is the part that costs the most, because the harness's error flag under-reports and its output is not safe to pattern-match naively.

**The `is_error` flag catches little.** Most real failures arrive as ordinary output: `Exit code 1`, a traceback, `No such file or directory`. Reading the text is mandatory; trusting the flag is not.

**Read the head, not the whole result.** These harnesses put their own status *before* the command's output, and a script that dies prints its traceback before anything else. So a failure marker is only trusted at the start of a shell result:

```bash
python3 - "$HOME/.claude/projects/<slug>/<session-id>.jsonl" <<'EOF'
import json,sys,collections,re
SHELL={'bash','shell','exec','exec_command'}
MARK=[('exit_code',re.compile(r'Exit code [1-9]')),
      ('traceback',re.compile(r'Traceback \(most recent call last\)')),
      ('interrupted',re.compile(r'^\[Tool call interrupted')),
      ('tool_use_error',re.compile(r'^<tool_use_error>'))]
pend={}; hits=collections.Counter()
for l in open(sys.argv[1],encoding='utf-8',errors='replace'):
    try: d=json.loads(l)
    except: continue
    m=d.get('message')
    if not isinstance(m,dict) or not isinstance(m.get('content'),list): continue
    for b in m['content']:
        if not isinstance(b,dict): continue
        if b.get('type')=='tool_use': pend[b['id']]=b.get('name')
        elif b.get('type')=='tool_result':
            s=str(b.get('content') or '').lstrip()
            name=pend.get(b.get('tool_use_id'),'')
            for tag,pat in MARK:
                if (name in SHELL and pat.match(s)) or (name not in SHELL and pat.search(s[:400])):
                    hits[tag]+=1; break
print(dict(hits.most_common()))
EOF
```

**Why the position rule matters.** A successful run often prints failure words as its *subject* — a log being inspected, a diff, a quoted error, a test printing expected failures. Match anywhere and the count is fiction. The head is where the harness's own status lives and where a dying script's traceback lands.

**Which tools can report failure in text at all:**

| Tool | Failure shows up as |
| --- | --- |
| shell (`Bash`, `exec_command`) | harness status at the head only: `Exit code N`, `<tool_use_error>`, `[Tool call interrupted` |
| read / grep / glob | never in the text — the text is the file. Trust `is_error` only |
| edit / write | `<tool_use_error>` for a failed edit; `EEXIST` / `ENOENT` for filesystem conflicts |
| Codex `exec_command` | `exec_command failed: SandboxDenied { ... }`, or a payload carrying `"timed_out": true`. Check the specific one first — a sandbox denial is also an `exec_command failed` |
| Pi | `message.isError: true`, set often enough to be worth reading |

## The timeline

Aggregates say *that* something happened; the timeline says *what*. Walk the log in file order and keep three things: real user turns, assistant conclusions, and each failure with the call that produced it. One line each, timestamped.

An assistant reply is not evidence — its last paragraph usually is. Keep the conclusion, drop the reasoning that led to it.

Cap the output. The failures are few and go in whole; then the most recent turns, because that is where a session's real cost shows up. If a session needs more than a couple of screens of timeline, the aggregates are carrying the finding, not the timeline.

## Turning a signal into a finding

Every signal needs the same three fields before it is worth reporting:

```
[high] The test command is not in the entry doc; finding it took four files
  evidence  03:14 read package.json -> README -> CONTRIBUTING -> Makefile
  change    AGENTS.md always-on constraints: add `make test`
```

- **evidence** in the agent's own actions, not adjectives
- **change** small enough to apply in one sitting
- **kind**: mechanical (a check can hold it) or judgement (only prose can)

Then classify it. A signal about where a fact lived is a navigation pointer. A failure a check would have caught is a missing guardrail. A rule the repo states in prose but does not enforce is a check waiting to be written. That is the taxonomy ax-review already uses — a session log is one more source of findings, not a separate kind of finding.

## What the log cannot tell you

A log records what the agent did, not what it was prevented from doing. A fact it never reached, a service it could not observe, a permission it lacked — these leave no trace, and the aggregates will not show their absence.

So when a finding seems to need one of those, the log can only support it indirectly: look for a workaround. An agent that hand-rolled a URL because it had no endpoint, or copied output into a file because it could not tee it, leaves the gap visible in what it built rather than in what it failed to find.
