# GitHub polling examples

These are provider-specific adapters. Use Bash and GitHub CLI, replace `REPO=owner/repo`, and declare `GITHUB_TOKEN=GH_TOKEN`.

## Main-branch CI failure

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO=owner/repo
gh api "repos/${REPO}/actions/runs?branch=main&status=failure&per_page=30" --jq '.workflow_runs[] | {id:("ci-run:"+(.id|tostring)), title:("CI failed on main · run "+(.run_number|tostring)), url:.html_url} | @json'
```

The run id is stable across retries.

## Open bug issue

```bash
gh api "repos/${REPO}/issues?state=open&labels=bug&per_page=100" --jq '.[] | select(.pull_request | not) | {id:("bug-issue:"+(.id|tostring)), title:("Bug #"+(.number|tostring)+": "+.title[:150]), url:.html_url} | @json'
```

The issues endpoint includes pull requests, so retain the filter.
