# Subscription patterns

Choose the trigger before choosing a provider.

## Poll an API

Use polling for facts that still exist: open incidents, overdue work, expiring certificates, or unhealthy services.

```bash
#!/usr/bin/env bash
set -euo pipefail
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${STATUS_API_TOKEN}" \
  "https://status.example.test/api/incidents?state=open" |
python3 -c '
import json, sys
for x in json.load(sys.stdin):
 print(json.dumps({"id":"incident:"+str(x["id"]), "title":"Open incident: "+x["title"][:180], "url":x.get("url"), "detail":x.get("summary", "")[:2000]}, ensure_ascii=False, separators=(",", ":")))
'
```

```text
team_subscription({
  action: "create", name: "open-status-incidents", intervalMinutes: 15,
  scriptPath: "scripts/open-status-incidents.sh",
  credentials: ["STATUS_API_TOKEN=STATUS_TOKEN"]
})
```

Use a stable object id. For a state transition, include the announced state, such as `certificate-expiring:<certificate-id>`.

## Receive an event

Use a webhook when the source can push events:

```text
provider POST → Host admission → stdin {headers, body}
  → verify signature → select event → emit JSONL facts
```

```text
team_subscription({
  action: "create", name: "failed-deployments", webhook: true,
  scriptPath: "scripts/failed-deployments.sh",
  credentials: ["WEBHOOK_SECRET=DEPLOYMENT_WEBHOOK_SECRET"]
})
```

Use a stable provider event id, or a business id plus announced state. The script verifies and extracts; the Host handles delivery state. See [webhook registration and signatures](webhook.md).

## Combine push and recovery

Use both triggers when push is fast but gaps are possible:

```text
team_subscription({
  action: "create", name: "deployment-status-with-recovery",
  intervalMinutes: 30, webhook: true,
  scriptPath: "scripts/deployment-status.sh",
  credentials: ["API_TOKEN=DEPLOYMENT_API_TOKEN", "WEBHOOK_SECRET=DEPLOYMENT_WEBHOOK_SECRET"]
})
```

For timer input, query a bounded recent window; for webhook input, parse stdin. Keep the same event identity so recovery does not republish an accepted fact.

## Choose another tool

Use a reminder for “remind me tomorrow”, a one-off query for “show current incidents”, and a subscription for “publish observed incidents as they appear”. Follow-up mutations need a separate authorized, idempotent design.
