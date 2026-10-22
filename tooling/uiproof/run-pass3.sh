#!/bin/bash
# Pass 3 + optional full B proof — run on a real macOS Terminal (not agent sandbox).
# Usage from repo root: bash tooling/uiproof/run-pass3.sh
# Or: pnpm ui:proof:pass3
set -euo pipefail
WORKTREE="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WORKTREE"
export PATH="${WORKTREE}/../.tools/bin:/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export STREAM_A_NODE="${STREAM_A_NODE:-$WORKTREE/.tools/node18/bin/node}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$WORKTREE/.tools/ms-playwright}"
export PORT="${PORT:-8090}"
mkdir -p .artifacts/uiproof
echo "=== Pass 3 auth proof $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee .artifacts/uiproof/pass3-run.log
pnpm ui:boot 2>&1 | tee -a .artifacts/uiproof/pass3-run.log
set +e
pnpm ui:proof:auth 2>&1 | tee -a .artifacts/uiproof/pass3-run.log
EC=${PIPESTATUS[0]}
set -e
echo "EXIT_CODE=$EC" | tee -a .artifacts/uiproof/pass3-run.log
echo "SHOTS:" | tee -a .artifacts/uiproof/pass3-run.log
ls -la .artifacts/uiproof/shots-auth/ 2>&1 | tee -a .artifacts/uiproof/pass3-run.log || true
if [ "$EC" -eq 0 ]; then
  echo PASS3_GREEN > .artifacts/uiproof/pass3-status.txt
else
  echo PASS3_FAIL > .artifacts/uiproof/pass3-status.txt
fi
echo "Done. Status: $(cat .artifacts/uiproof/pass3-status.txt)"
exit "$EC"
