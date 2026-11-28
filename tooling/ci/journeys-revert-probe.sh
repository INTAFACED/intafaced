#!/usr/bin/env bash
# One probe of the journeys revert (journeys-revert-probe.mjs): commit $1 checked out, then $JOURNEY_FILES on the local
# test stack set up as a Real-app journeys shard sets it up, by the same script (journey-shard.sh, beside this file:
# custody switch, start, markets, content, first trade, journeys), with no retry. Two differences stay: it always
# writes the TEST chart history (a planned shard skips it when its files read no market's past), and it never takes
# the build job's seeded stack. A shard runs one custody switch,
# so files that take different switches (journey-shard.sh custody) run on one fresh stack each, and their reports are
# merged into $JOURNEY_REPORT. Exits 0 when the journeys ran (pass or fail: the report says which), non-zero when a
# stack didn't come up. It runs from a copy outside the checkout, since it checks out $1. Expects the runner's paths
# (.github/actions/journey-runner).
set -euo pipefail
sha="$1"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "not a sha: $sha"; exit 2; }
shard="$(dirname "${BASH_SOURCE[0]}")/journey-shard.sh"

stop() { if [ -f tooling/scripts/local-test-stack.mjs ]; then node tooling/scripts/local-test-stack.mjs stop || true; fi; }
# The stack the last probe started, stopped with that commit's own script.
stop
git checkout --quiet --force "$sha"
pnpm install --frozen-lockfile
pnpm exec playwright install chromium

# The files by the custody switch a shard would run each on.
declare -A group=()
for f in $JOURNEY_FILES; do
  c=$(bash "$shard" custody "$f")
  group[$c]="${group[$c]:-} $f"
done

# The red run's leave-out list, set by journeys-revert-probe.mjs only on a commit whose own journeys run leaves tests out
# (leavesOut): those tests stay out here as there, so a break made by leaving a test out reproduces.
leave=()
if [ -n "${JOURNEY_LEAVE_OUT_FILE:-}" ] && [ -s "$JOURNEY_LEAVE_OUT_FILE" ]; then leave=(--test-list-invert "$JOURNEY_LEAVE_OUT_FILE"); fi

report="$JOURNEY_REPORT"
parts=()
for c in "${!group[@]}"; do
  echo "custody $c:${group[$c]}"
  stop
  rm -rf "$LOCAL_STACK_STATE"
  export LOCAL_STACK_CUSTODY_LAYER="$c" JOURNEY_FILES="${group[$c]# }" JOURNEY_RETRIES=0 JOURNEY_FAIL_FAST=0
  export JOURNEY_REPORT="$report.$c"
  rm -f "$JOURNEY_REPORT"
  bash "$shard" start
  bash "$shard" markets
  bash "$shard" content
  bash "$shard" first-trade
  code=0
  bash "$shard" journeys "${leave[@]}" || code=$?
  # 1 is "journeys failed", which the report holds; anything else is the run itself breaking.
  [ "$code" -le 1 ] || exit "$code"
  parts+=("$JOURNEY_REPORT")
done
# One report for the probe's verdict, or none (no verdict) when a group wrote none or broke (mergeReports).
node "$(dirname "${BASH_SOURCE[0]}")/journeys-revert-probe.mjs" merge "$report" "${parts[@]}"
