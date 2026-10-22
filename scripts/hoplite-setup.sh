#!/bin/sh
# Hoplite sandbox setup: steps 1-5 of docs/development/environments-and-install.md
# § "Sandbox and CI environments". Step 6 (typecheck + tests) is the Hoplite `check` script.
set -eu

TEAM_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$TEAM_ROOT/../deepseek-harness"
cd "$TEAM_ROOT"

# The certified Harness tag is the lower bound of the DSH peer range.
DSH_LOWER_BOUND="$(node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { dshPeerRanges } from './scripts/dsh-peers.mjs'
const ranges = [...dshPeerRanges(JSON.parse(readFileSync('package.json', 'utf8')))]
const lower = ranges.length === 1 ? /^>=(\S+)/.exec(ranges[0])?.[1] : undefined
if (lower === undefined) {
  console.error('expected exactly one DSH peer range with a >= lower bound, got: ' + ranges.join(', '))
  process.exit(1)
}
console.log(lower)
")"
HARNESS_TAG="dsh-v$DSH_LOWER_BOUND"

HEAD_BEFORE=""
if [ -d "$HARNESS/.git" ]; then
  HEAD_BEFORE="$(git -C "$HARNESS" rev-parse HEAD)"
  git -C "$HARNESS" fetch --depth 1 --force origin "refs/tags/$HARNESS_TAG:refs/tags/$HARNESS_TAG"
  git -C "$HARNESS" checkout -f "$HARNESS_TAG"
else
  git clone --depth 1 --branch "$HARNESS_TAG" https://github.com/deepseek-ai/deepseek-harness.git "$HARNESS"
fi

# The certified Harness scripts call a bare `pnpm`, so the corepack shim must exist.
corepack enable pnpm
cd "$HARNESS"
corepack pnpm install

# tsdown's `packages/*/*` workspace glob treats directories without a package.json
# as members, and build:lib fails on them.
for residue in "$HARNESS"/packages/*/*; do
  if [ -d "$residue" ] && [ ! -f "$residue/package.json" ]; then rm -rf "$residue"; fi
done

# Clear lib/ and tsbuildinfo together: with lib/ alone removed, `tsc -b` skips emit.
if [ "$HEAD_BEFORE" != "$(git rev-parse HEAD)" ] || [ ! -d packages/core/agent/lib/types ]; then
  find packages apps \( -type d -name lib -o -type d -name dist \) -not -path "*/node_modules/*" -prune -exec rm -rf {} +
  find packages apps -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete
fi

corepack pnpm build:lib
# The host addon is gitignored and only the Harness's own test script builds it.
corepack pnpm build:native-system
corepack pnpm build:web

# Never `npm install` here: it breaks the workspace symlinks into the Harness checkout.
cd "$TEAM_ROOT"
corepack pnpm install
node scripts/link-harness-packages.mjs
npm run build

# test:browser expects /usr/bin/google-chrome; fall back to Playwright's Chromium.
if ! command -v google-chrome >/dev/null 2>&1; then
  (cd "$HARNESS/apps/web" && corepack pnpm exec playwright install chromium)
  CHROME_BIN="$(ls "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)"
  if [ -n "$CHROME_BIN" ]; then ln -sf "$CHROME_BIN" /usr/bin/google-chrome; fi
fi

node scripts/sync-paths.mjs
