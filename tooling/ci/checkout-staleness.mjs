#!/usr/bin/env node
/**
 * checkout-staleness — how far behind origin/main this working copy is.
 *
 * WHY THIS EXISTS, and why it is worth its own file:
 * a board generated from a stale checkout reports work that does not exist.
 * Measured on 2026-08-06 (#958): a checkout 178 commits behind reported
 * `freeImplementable=6 blocked=0` while origin/main reported `0` and `15`.
 * An agent reading the stale board spawns workers onto work that is gone.
 *
 * This used to live inside thrift-preflight. Thrift was deleted on 2026-08-07
 * (the deleted throttle was a private-repo bill; the staleness guard is unrelated).
 * The staleness guard survived the deletion because it never had anything to
 * do with spend — it is the one honest thing that file did.
 *
 * Fails open: no git, no origin ref, or a detached state returns null. A
 * guard that crashes the tool it guards is worse than no guard.
 */
import { execFileSync } from 'node:child_process';

/** @returns {number|null} commits this checkout is behind origin/main, or null if unknowable. */
export function checkoutStaleness() {
  try {
    const n = execFileSync('git', ['rev-list', '--count', 'HEAD..origin/main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch {
    return null;
  }
}

/** Loud banner for any board that prints numbers. Empty string when current. */
export function stalenessBanner(behind = checkoutStaleness()) {
  if (behind === null || behind <= 0) return '';
  return [
    `  STALE CHECKOUT — this copy is ${behind} commit(s) behind origin/main.`,
    '  Numbers below describe a tip that no longer exists. Run `git fetch origin`',
    '  and re-run before spawning anything off this board.',
  ].join('\n');
}

// Self-check: the function must never throw, whatever git says.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const n = checkoutStaleness();
  console.log(`checkout-staleness: behind=${n === null ? 'unknown' : n}`);
  const banner = stalenessBanner(n);
  if (banner) console.log(banner);
  process.exit(0);
}
