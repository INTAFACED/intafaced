#!/usr/bin/env node
/**
 * teamwork — the two numbers, and the rule that produces them.
 *
 *   node tooling/scripts/teamwork.mjs
 *
 * WHY THIS IS A SCRIPT AND NOT A NUMBER IN A DOC.
 * On 2026-08-07 the same two counts were quoted as 476/67, then 602/71, then
 * 617/78 — all "correct" hours apart, because the repo moves and because three
 * people counted different things. A number written into a document is wrong by
 * the next morning. A number you can re-run is an instrument.
 *
 * THE COUNTING RULES ARE THE LISTS BELOW. They are deliberately explicit rather
 * than clever: changing what counts requires editing this file, which shows up
 * as a reviewable diff. A heuristic that silently re-scopes itself is how you
 * get three different answers to one question.
 *
 * Run it from a checkout that is level with origin/main, or the numbers describe
 * a tip that no longer exists. The script says so itself.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * NUMBER 1 — places recording who owns what.
 *
 * RULE: a HAND-MAINTAINED file (or directory of files) in which a human or an
 * agent writes down who owns a unit of work. Generated boards are excluded —
 * they are derived views, not sources, and counting them double-counts.
 * TARGET: 3 — features.mjs (does this feature have an owner), open PRs (is
 * anyone in these files right now), residual-register.json (was this non-tracker
 * item already finished).
 */
const OWNERSHIP_SURFACES = [
  ['tooling/tracker/features.mjs', 'feature owner + status'],
  ['.github/CODEOWNERS', 'path ownership GitHub enforces'],
  ['tooling/frontend/residual-register.json', 'non-tracker residual status'],
  ['docs/ops/claims', 'per-claim lock/completion files'],
  ['docs/LIVE-LANES.md', 'session lanes'],
];

/**
 * NUMBER 2 — words an agent must read before its first edit.
 *
 * RULE: the auto-loaded entry files, plus every document AGENTS.md's numbered
 * "Read these, in order" list names as mandatory. Excludes the per-task service
 * README (varies) and anything marked read-on-demand.
 * TARGET: under 1,000.
 */
const MANDATED_READ = [
  'CLAUDE.md',
  'AGENTS.md',
  'INTAFACED_DEFINITIVE_BUILD.md',
  'tooling/agent-protocol/AGENT_PROTOCOL.md',
  'CONTRIBUTING.md',
  'docs/ops/README.md',
  'docs/LIVE-LANES.md',
  'docs/ops/SWARM-MANDATE.md',
];

const words = (p) => {
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').split(/\s+/).filter(Boolean).length;
};

let behind = null;
try {
  behind = Number(
    execFileSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
  );
} catch {
  /* no git, no origin — report unknown rather than lying */
}

const surfaces = OWNERSHIP_SURFACES.filter(([p]) => existsSync(p));
const total = MANDATED_READ.reduce((n, p) => n + words(p), 0);

console.log('TEAMWORK — two numbers\n');
if (behind === null) console.log('  ⚠ cannot compare to origin/main — numbers may describe a stale tip\n');
else if (behind > 0) console.log(`  ⚠ STALE: this checkout is ${behind} commit(s) behind origin/main. Fetch and re-run.\n`);

console.log(`1. Places recording who owns what : ${surfaces.length}   (target 3)`);
for (const [p, why] of surfaces) console.log(`     · ${p} — ${why}`);
console.log(`\n2. Words before an agent's first edit : ${total.toLocaleString()}   (target < 1,000)`);
for (const p of MANDATED_READ) {
  const w = words(p);
  if (w) console.log(`     · ${String(w).padStart(6)}  ${p}`);
}
console.log('\nRule: both lists are written in this file. Changing what counts is a reviewable diff.');
process.exit(0);
