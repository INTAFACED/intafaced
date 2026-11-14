#!/usr/bin/env node
/**
 * Which shards of a pull request's full Real-app journeys run retry a failed test once, as main's do: the shards that
 * hold none of the journeys the pull request touches. A shard with one of them keeps no retry, so the pull request's
 * own journey can't pass on its retry.
 * (Failure it prevents: on 14 Nov 2026 the full runs of tooling-only pull requests #8375, #8385 and #8391 went red on
 * steps their change could not reach, J-cex-spot-03 #9, J-charts-desk-09 #5 and J-agents-01 #6, each passing on main and
 * on another attempt of the same head. Over that day's 11 full runs on main and 14 on pull requests, built steps failed
 * their first try at 0.11 % on main and 0.02 % on pull requests: main's runs are no steadier, main retries. With about
 * 1,500 built steps and no retry, about every other full pull-request run went red on a step it never touched, and each
 * re-run took 35 to 50 minutes.)
 *
 * A changed path touches every journey, so no shard retries, unless the shards can't execute it:
 *   - journey-touch.mjs calls it none (nothing the journeys run executes or reads);
 *   - it is a journey test file: it touches its own journey's files (withSiblings), whose shards keep no retry;
 *   - it is on JUDGE_ONLY: CI code that plans, judges or reverts the run from the jobs around the shards and never runs
 *     inside one (journey-retries.test.mjs fails when anything a shard runs imports or names one).
 * Everything else (product code, the stack, the harness, a journey helper, the workflow, its actions, a build file)
 * touches every journey. The journeys the title names are touched too. An empty or unreadable list touches every journey.
 *
 *   node tooling/ci/journey-retries.mjs --changed <file> --named "<journey files>" --shards '<plan JSON>'
 * prints a JSON array for the workflow's matrix: index 0 unused, then '1' (retry once) or 'none' for each shard.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkoutJourneyFiles, pathKind, withSiblings } from './journey-touch.mjs';

/** CI code that runs only before the shards (the plan), after them (the verdict, the seal, Main trust) or in another
 *  workflow (the reverts): a change to it can't change what a journey does, only how the run is planned or read. */
export const JUDGE_ONLY = [
  'tooling/ci/api-budget.mjs',
  'tooling/ci/bisect-main.mjs',
  'tooling/ci/exact-revert.mjs',
  'tooling/ci/factory-builder.mjs',
  'tooling/ci/factory-switch.mjs',
  'tooling/ci/journey-reach-map.json',
  'tooling/ci/journey-reach-map.mjs',
  'tooling/ci/journey-retries.mjs',
  'tooling/ci/journey-seal.mjs',
  'tooling/ci/journey-touch.mjs',
  'tooling/ci/journey-verdict.mjs',
  'tooling/ci/journey-verdict.test.mjs',
  'tooling/ci/journeys-revert-probe.mjs',
  'tooling/ci/journeys-revert-probe.sh',
  'tooling/ci/journeys-revert.mjs',
  'tooling/ci/main-first.mjs',
  'tooling/ci/post-merge-trust.mjs',
  'tooling/ci/review-marker.mjs',
  'tooling/ci/shard-download.mjs',
];

/**
 * The journey files a pull request touches: 'all', or a sorted list. `changed`: its paths; `named`: the journey files
 * its title names; `journeyFiles`: the head's journey files (a Set, or null).
 */
export function touchedJourneys({ changed, named = [], journeyFiles }) {
  if (!Array.isArray(changed) || changed.length === 0) return 'all';
  const own = new Set(named);
  for (const p of changed) {
    const k = pathKind(p);
    if (k.kind === 'none' || JUDGE_ONLY.includes(p)) continue;
    if (k.kind === 'file' && !k.stack) own.add(k.file);
    else return 'all';
  }
  return withSiblings(own, journeyFiles);
}

/** Per shard of `shards` (the plan: one string of journey files a shard), '1' when it holds no touched journey. */
export function shardRetries(shards, touched) {
  if (!Array.isArray(shards) || shards.length === 0) throw new Error('no shard plan');
  const own = touched === 'all' ? null : new Set(touched);
  return [
    'none',
    ...shards.map((s) =>
      own &&
      !String(s)
        .split(/\s+/)
        .some((f) => own.has(f))
        ? '1'
        : 'none',
    ),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const shards = JSON.parse(arg('--shards') ?? '');
  const changed = readFileSync(arg('--changed'), 'utf8').split('\n').filter(Boolean);
  const named = (arg('--named') ?? '').split(/\s+/).filter(Boolean);
  const touched = touchedJourneys({ changed, named, journeyFiles: checkoutJourneyFiles() });
  const out = shardRetries(shards, touched);
  const n = out.filter((x) => x === '1').length;
  console.error(
    touched === 'all'
      ? 'journey-retries: this change can reach every journey, so no shard retries'
      : `journey-retries: ${n} of ${shards.length} shards retry a failed test once; the ${shards.length - n} holding the ${touched.length} journey file(s) this pull request touches do not`,
  );
  console.log(JSON.stringify(out));
}
