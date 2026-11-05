#!/usr/bin/env bash
# One JSON line per active work item whose last-checked date is stale, and
# nothing at all when every item is current — that silence is what keeps a
# weekly subscription from turning into noise.
set -euo pipefail
exec node scripts/scratch-stale.mjs --json
