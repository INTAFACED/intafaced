#!/usr/bin/env bash
# Purge Charting Library blobs from git history (rediscovery risk after #106 tree delete).
#
# DESTRUCTIVE: rewrites commit SHAs. Requires:
#   1. Collaborators re-clone or hard-reset after the force-push
#   2. Open PRs rebased onto new main
#   3. git-filter-repo installed (brew install git-filter-repo)
#
# Usage from a throwaway clone (not your daily worktree):
#   git clone --mirror git@github.com:ORG/REPO.git purge-mirror && cd purge-mirror
#   /path/to/repo/tooling/scripts/purge-charting-library-history.sh .
#   git push --force --all   # coordinated window only
#
set -euo pipefail
TARGET="${1:-.}"
cd "$TARGET"
if ! command -v git-filter-repo >/dev/null; then
  echo "git-filter-repo required (brew install git-filter-repo)" >&2
  exit 1
fi
ARGS=(--force --invert-paths --path vendor/upstream-exchange/05_Web_Front/src/assets/js/charting_library)
if [[ "${FILTER_ALL_REFS:-0}" != "1" ]]; then
  ARGS+=(--refs refs/heads/main)
fi
echo "Running: git filter-repo ${ARGS[*]}"
git filter-repo "${ARGS[@]}"
echo "Verify: git log --all -- vendor/upstream-exchange/05_Web_Front/src/assets/js/charting_library | head"
echo "Then force-push ONLY after collaborators are ready."
