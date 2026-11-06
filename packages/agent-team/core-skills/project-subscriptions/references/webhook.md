# Webhook registration and signatures

The Human makes the Host's public origin reachable and registers the one-time address returned by `team_subscription`. The script verifies the signature and emits facts.

## Register GitHub

```bash
REPO=owner/repo
WEBHOOK_URL='the one-time address returned by team_subscription'
gh api --method POST "repos/${REPO}/hooks" -f name=web -F active=true -f 'events[]=workflow_run' -F "config[url]=${WEBHOOK_URL}" -f 'config[content_type]=json' --silent
```

Add the provider secret only when already available without printing it. A 202 confirms admission; inspect `logs` and use `deliveries`/`replay` after retries.

## Verify and emit

The Host sends `{headers, body}` on stdin. Verify the exact UTF-8 body before parsing it; `DSH_TEAM_TRIGGER=test` is the Host-controlled test bypass.

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -c '
import hashlib, hmac, json, os, sys
e=json.load(sys.stdin.buffer); h=e.get("headers", {}); body=e.get("body", "")
if os.environ.get("DSH_TEAM_TRIGGER") != "test":
 s=os.environ.get("WEBHOOK_SECRET")
 if not s: raise SystemExit("WEBHOOK_SECRET is not injected")
 expected="sha256="+hmac.new(s.encode(), body.encode(), hashlib.sha256).hexdigest()
 if not hmac.compare_digest(h.get("x-provider-signature", ""), expected): raise SystemExit("invalid webhook signature")
event=json.loads(body)
if event.get("type") != "deployment.failed": raise SystemExit(0)
d=event["deployment"]
print(json.dumps({"id":"deployment:"+str(d["id"]), "title":"Deployment failed: "+d["service"], "url":d.get("url"), "detail":d.get("reason", "")[:2000]}, ensure_ascii=False, separators=(",", ":")))
'
```

Adapt the header, signature scheme, and fields. Test valid and invalid signatures, malformed JSON, and a non-matching event. A non-matching event exits successfully without an event; invalid input fails.
