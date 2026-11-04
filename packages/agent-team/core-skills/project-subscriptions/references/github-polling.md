# GitHub polling examples

Each script needs bash and GitHub CLI (`gh`). Replace `REPO=owner/repo` and declare a configured credential as `GITHUB_TOKEN=GH_TOKEN`. Authentication failure must fail the run, not silently emit nothing. Keep the default baseline unless existing findings should publish.

## Main-branch CI failure

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO=owner/repo

gh api "repos/${REPO}/actions/runs?branch=main&status=failure&per_page=30" --jq '
  .workflow_runs[] | {
    id: ("ci-run:" + (.id | tostring)),
    title: ("CI failed on main · run " + (.run_number | tostring)),
    url: .html_url,
    detail: ("Commit " + .head_sha)
  } | @json'
```

The workflow run id is stable across GitHub retries. Increase `per_page` only when more failures can appear between polls.

## New open issue with the bug label

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO=owner/repo

gh api "repos/${REPO}/issues?state=open&labels=bug&per_page=100" --jq '
  .[] | select(.pull_request | not) | {
    id: ("bug-issue:" + (.id | tostring)),
    title: ("Bug #" + (.number | tostring) + ": " + .title[:150]),
    url: .html_url,
    detail: ("Opened " + .created_at + " by " + .user.login)
  } | @json'
```

The issues API also returns PRs, so keep the filter. Stable issue ids prevent old open issues from repeating.

## Open PR requesting my review

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO=owner/repo

gh search prs --review-requested=@me --repo "$REPO" --state open --limit 100 \
  --json id,number,title,url,updatedAt --jq '
    .[] | {
      id: ("review-request:" + .id),
      title: ("Review PR #" + (.number | tostring) + ": " + .title[:140]),
      url: .url,
      detail: ("Updated " + .updatedAt)
    } | @json'
```

`@me` uses the injected token's identity. For team review requests, adapt and test the qualifier before creation.
