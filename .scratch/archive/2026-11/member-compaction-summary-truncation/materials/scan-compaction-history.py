#!/usr/bin/env python3
"""List real `compaction/end` failures across every retained DSH session log.

Run: python3 scan-compaction-history.py [--all]

Default prints only `summarization truncated` events (the phenomenon in this
work item); --all prints every compaction failure with its error string.

Why this shape (each is a measured trap, see
`notes/operations/session-log-scanning-pitfalls.md`):
  * session files are multi-frame zstd -> `zstd -dc`, never a one-shot decoder;
  * the error string appears inside message bodies and tool results, so the
    literal-string hit count is meaningless -- only `{"type":"compaction/end"}`
    events count;
  * rollover/recycle files can interleave members -> attribute by the nearest
    preceding `session/title`; models by the nearest preceding
    `request/header.config` (never `model/selection`, which is not the route);
  * compaction failure durations come from start->end pairs, keyed by
    compactionId.
"""

import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
SESSIONS = os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")
THRESHOLD = "summarization truncated"


def fmt(ms):
    return datetime.fromtimestamp(ms / 1000, TZ).strftime("%m-%d %H:%M:%S") if ms else "?"


def scan(path):
    raw = subprocess.run(["zstd", "-dc", path], capture_output=True, check=False).stdout
    title = None
    model = None
    starts = {}
    events = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        data = event.get("data") or {}
        when = event.get("time")
        if kind == "session/title" and data.get("title"):
            title = data["title"]
        elif kind == "request/header":
            config = (data.get("header") or {}).get("config") or {}
            model = f"{config.get('provider')}/{config.get('model')}"
        elif kind == "compaction/start":
            starts[data.get("compactionId")] = when
        elif kind == "compaction/end":
            begin = starts.get(data.get("compactionId"))
            events.append(
                {
                    "when": when,
                    "seconds": (when - begin) / 1000 if begin and when else None,
                    "error": data.get("error"),
                    "turn": data.get("turn"),
                    "title": title,
                    "model": model,
                }
            )
    return events


def main():
    show_all = "--all" in sys.argv
    rows = []
    for path in glob.glob(SESSIONS):
        for event in scan(path):
            if not event["error"]:
                continue
            if not show_all and THRESHOLD not in event["error"]:
                continue
            rows.append(event)
    rows.sort(key=lambda row: row["when"] or 0)
    for row in rows:
        print(
            f"{fmt(row['when'])}  {str(row['title']):<8} turn={str(row['turn']):<5} "
            f"{row['seconds'] or 0:6.1f}s  {str(row['model']):<45} {row['error'][:80]}"
        )
    print(f"\n{len(rows)} event(s)")


if __name__ == "__main__":
    main()
