---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to an agent.
---

Run the investigation in whatever mode this harness offers, best first:

- **Background subagent** — spin one up and keep working while it reads.
- **Agent team** — if teammates are available, assign one the question and the save location; collect the file when they report.
- **Yourself** — no subagent support: do it as a focused pass in this conversation. Say that you are blocking on reading, then read.

Whichever mode runs it, the job is:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
