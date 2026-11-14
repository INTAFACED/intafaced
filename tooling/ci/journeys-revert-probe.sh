#!/usr/bin/env bash
# One probe of the journeys revert (journeys-revert-probe.mjs): the local test stack on commit $1, set up the way a
# Real-app journeys shard sets it up (.github/workflows/real-app-journeys.yml, the `journeys` job: start, the TEST
# gates, markets and market maker, the TEST content, the first trade), then only $JOURNEY_FILES, with no retry.
# Exits 0 when the journeys ran (pass or fail: the report says which), non-zero when the stack didn't come up.
# It runs from a copy outside the checkout, since it checks out $1. Expects LOCAL_STACK_STATE, LOCAL_STACK_NATS_BIN,
# LOCAL_STACK_ANVIL_BIN, JOURNEY_REPORT and JOURNEY_BLOB_DIR (the shard's Paths step).
set -euo pipefail
sha="$1"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "not a sha: $sha"; exit 2; }

# The stack the last probe started, stopped with that commit's own script.
if [ -f tooling/scripts/local-test-stack.mjs ]; then node tooling/scripts/local-test-stack.mjs stop || true; fi
rm -rf "$LOCAL_STACK_STATE"
git checkout --quiet --force "$sha"
pnpm install --frozen-lockfile
pnpm exec playwright install chromium

node tooling/scripts/local-test-stack.mjs start
node tooling/scripts/local-test-stack.mjs restart matching
node tooling/scripts/local-test-gates.mjs apply
node tooling/scripts/local-test-market.mjs
for _ in $(seq 1 30); do
  grep -Eq 'taker (created|existing) \(test_taker\)' "$LOCAL_STACK_STATE/logs/market.log" 2>/dev/null && break
  sleep 2
done
node tooling/scripts/local-test-market.mjs stop
node tooling/scripts/local-test-gates.mjs verify
node tooling/scripts/local-test-market.mjs history --markets journeys
node tooling/scripts/local-test-market.mjs
LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs apply --state "$LOCAL_STACK_STATE"
traded=0
for _ in $(seq 1 60); do
  if grep -q 'BTC/USDT crossing trade by test_taker: .* -> HTTP 201' "$LOCAL_STACK_STATE/logs/market.log" 2>/dev/null; then traded=1; break; fi
  sleep 5
done
[ "$traded" = 1 ] || { echo "no BTC/USDT trade within 5 minutes"; exit 1; }

# The red run's leave-out list, set by journeys-revert-probe.mjs only on a commit whose own journeys run leaves tests out
# (leavesOut): those tests stay out here as there, so a break made by leaving a test out reproduces.
leave=()
if [ -n "${JOURNEY_LEAVE_OUT_FILE:-}" ] && [ -s "$JOURNEY_LEAVE_OUT_FILE" ]; then leave=(--test-list-invert "$JOURNEY_LEAVE_OUT_FILE"); fi
export JOURNEY_FILES JOURNEY_RETRIES=0 JOURNEY_FAIL_FAST=0
code=0
pnpm exec playwright test --config apps/customer/tests/real-app/real-app.playwright.config.mjs --trace off "${leave[@]}" || code=$?
# 1 is "journeys failed", which the report holds; anything else is the run itself breaking.
[ "$code" -le 1 ] || exit "$code"
