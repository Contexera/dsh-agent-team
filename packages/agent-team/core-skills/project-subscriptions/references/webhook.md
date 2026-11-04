# Webhook registration and signatures

## Register a GitHub hook

1. The Human must configure the Host's public webhook origin and make its isolated listener reachable through a tunnel or reverse proxy. A missing-origin refusal is configuration, not a script failure.
2. Create a webhook-enabled subscription with a sample envelope. The signed script below needs the event header and JSON body but no test signature: only the Host-controlled `test` trigger bypasses verification. Save the complete address returned once by create/update-enable/reset.
3. Keep the address in a shell variable; do not post it to Team or echo it from scripts. Register only the required event with a `gh` identity allowed to administer hooks:

```bash
REPO=owner/repo
WEBHOOK_URL='the one-time address returned by team_subscription'
gh api --method POST "repos/${REPO}/hooks" \
  -f name=web -F active=true -f 'events[]=workflow_run' \
  -F "config[url]=${WEBHOOK_URL}" -f 'config[content_type]=json' --silent
```

For a signed hook, add `-F "config[secret]=${GITHUB_WEBHOOK_SECRET}"` only if the secret is already available without printing it. The Human registers the same value as the subscription's credential reference. Never invent a secret in a command or send it through Team.

4. Check GitHub deliveries for 202 (durable admission, not script success), then `logs`; after exhausted retries use `deliveries` and `replay`. Reset a leaked address and update GitHub.

## Verify GitHub HMAC and emit CI failures

This webhook-only bash script requires Python 3 and verifies the exact UTF-8 body before parsing. `DSH_TEAM_TRIGGER=test` is the only bypass, set by the Host rather than request input. Declare `GITHUB_WEBHOOK_SECRET` as a credential reference; never paste its value into the file.

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -c '
import hashlib, hmac, json, os, sys
envelope = json.load(sys.stdin.buffer)
headers = envelope.get("headers", {})
body = envelope.get("body", "")
if os.environ.get("DSH_TEAM_TRIGGER") != "test":
    secret = os.environ.get("GITHUB_WEBHOOK_SECRET")
    if not secret:
        raise SystemExit("GITHUB_WEBHOOK_SECRET is not injected")
    expected = "sha256=" + hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(headers.get("x-hub-signature-256", ""), expected):
        raise SystemExit("invalid webhook signature")
if headers.get("x-github-event") != "workflow_run":
    raise SystemExit(0)
payload = json.loads(body)
run = payload.get("workflow_run", {})
if (payload.get("action") != "completed"
        or run.get("conclusion") != "failure"
        or run.get("head_branch") != "main"):
    raise SystemExit(0)
print(json.dumps({
    "id": "ci-run:" + str(run["id"]),
    "title": "CI failed on main · run " + str(run["run_number"]),
    "url": run["html_url"]
}, ensure_ascii=False, separators=(",", ":")))
'
```

Never echo the envelope or signature. Test synthetic bodies with valid and invalid signatures. Non-matching events exit 0 with no event; bad signatures, missing credentials, malformed JSON, and missing run fields fail.
