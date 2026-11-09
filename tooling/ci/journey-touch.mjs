#!/usr/bin/env node
/**
 * Which journeys a pull request touches, from its changed paths: the yardstick the merge seal (journey-seal.mjs) holds
 * a pull request's own Real-app journeys runs to, so a pull request runs the journeys it can break and no more.
 * (Failure it prevents: on 7 Nov 2026 a pull request that changed product code, #7415, merged on its own named steps
 * and broke another journey's step, J-copy-bots-otc-01 #1, on main; builders then dispatched the full suite, 36
 * shards, on nearly every branch to be safe, and runners became the factory's binding constraint.)
 *
 * Each changed path is one of three kinds, and the most demanding kind among a pull request's paths decides:
 *   - full: the pull request needs a clean full run on its exact head. The journey stack's shared setup (SHARED_SETUP in
 *     journey-seal.mjs), every script under tooling/scripts (the stack, the TEST market maker, the seed, world-restore,
 *     the shard planner and the scripts journeys import), the journeys workflow and its actions, the seal and this file,
 *     the journeys verdict and the baseline, build and environment files, every doc (journeys read docs/roadmap and
 *     docs/runbooks), and every product path (apps/, services/, packages/) other than a unit test, unless the next
 *     kind takes it. A static guess at which journeys reach which code would miss journeys (a journey runs through the
 *     customer app, svc-edge and whatever services they call and the events those raise), so only evidence narrows it;
 *   - reach (the touched-journeys map, journey-reach-map.mjs, with --reach): a product path runs only the journeys main's
 *     own full runs recorded reaching it, when no full path above is in the change and the map can speak for every
 *     product path in it (shared setup, scripts, admin-app paths, packages it can't map, a switched-off, missing or
 *     stale map: full). Its journeys join the `files` list, and `reach` says why;
 *   - files: a journey test file (`apps/customer/tests/real-app/J-<id>[-part].pw.mjs`, JOURNEY_TEST) touches the
 *     journeys in that file only. (Another run file there, a look sweep, holds no journey steps, so no report lists it:
 *     it is full.) Journey files are independent: each makes its own accounts and keeps its own run
 *     file (real-app-journeys.yml splits shards by file on that basis), and a helper they share is shared setup, so
 *     full. A file the head removed runs nothing and needs nothing.
 *   - none: a path no journeys run executes or reads: another workflow under .github (not real-app-journeys.yml, not
 *     .github/actions), a CI check under tooling/ci that the journeys run does not use (JOURNEY_CI lists the ones it
 *     does; journey-touch.test.mjs fails when an import or a reference from the journeys run reaches one not listed),
 *     and a unit test (`*.test.*`, `*.spec.*`).
 * A path that matches none of the rules is full.
 *
 *   node tooling/ci/journey-touch.mjs --base origin/main     (this checkout's branch against a base; prints what to run)
 *   node tooling/ci/journey-touch.mjs --files a b c          (named paths)
 *   node tooling/ci/journey-touch.mjs --json --files-from f  (one path a line; JSON { mode, full, files }; real-app-journeys.yml's plan)
 *   … --reach                                                 (product paths by the touched-journeys map; GH_TOKEN for its age)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JOURNEY_TEST, isSharedSetup } from './journey-seal.mjs';
import { SUBSCRIBES, loadMap, reachSelect, runsBehind } from './journey-reach-map.mjs';

/** A journey test file the Real-app journeys run runs by name: directly in the real-app folder, ending `.pw.mjs`. */
export const RUN_FILE = /^apps\/customer\/tests\/real-app\/([A-Za-z0-9._-]+\.pw\.mjs)$/;

/** A changed path as printed in a log line: a pull request names its own paths, so a control character (a newline that
 *  would start a workflow command) is shown as `?`, never written. */
export const printable = (p) => String(p).replace(/[\u0000-\u001f\u007f]/g, '?');

/** The CI checks under tooling/ci that the journeys run executes or imports (real-app-journeys.yml, the seal, Main
 *  trust's post-merge job). A change to one of them changes how a journeys run is judged, so it needs the full run. */
export const JOURNEY_CI = [
  'tooling/ci/journey-seal.mjs',
  'tooling/ci/journey-touch.mjs',
  'tooling/ci/journey-verdict.mjs',
  'tooling/ci/journey-verdict.test.mjs',
  // The touched-journeys map and what reads it: they decide which journeys a product change runs.
  'tooling/ci/journey-reach-map.mjs',
  'tooling/ci/journey-reach-map.json',
  'tooling/ci/post-merge-trust.mjs',
  'tooling/ci/review-marker.mjs',
  'tooling/ci/workflow-concurrency.test.mjs',
  'tooling/ci/factory-switch.mjs',
  // real-app-journeys.yml's `Main's journeys first` job runs it.
  'tooling/ci/main-first.mjs',
  // Reached through the seal's imports (review-marker.mjs) and the test-infra action; journey-touch.test.mjs finds them.
  'tooling/ci/assert-test-db-env.mjs',
  'tooling/ci/look-baselines.mjs',
  'tooling/ci/test-judge.mjs',
  'tooling/ci/judged-paths.mjs',
  'tooling/ci/test-judge/JUDGE.md',
];

const FULL_RULES = [
  [
    /^tooling\/scripts\//,
    'a script under tooling/scripts (the stack, the TEST market maker, the seed, world-restore or a script journeys import)',
  ],
  [/^\.github\/workflows\/real-app-journeys\.yml$/, 'the journeys workflow'],
  [/^\.github\/actions\//, 'an action the journeys workflow uses'],
  [/^docs\//, 'a doc (journeys read docs/roadmap and docs/runbooks, and the verdict reads the baseline)'],
  [/^tooling\/(profiles|infra)\//, 'the stack’s environment (tooling/profiles, tooling/infra)'],
  [
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|\.npmrc|\.nvmrc|\.node-version|\.env\.example|docker-compose[^/]*\.ya?ml)$/,
    'a root build or environment file',
  ],
];

const NONE_RULES = [
  (p) => p.startsWith('.github/') && !/^\.github\/(workflows\/real-app-journeys\.yml|actions\/)/.test(p),
  (p) => p.startsWith('tooling/ci/') && !JOURNEY_CI.includes(p),
  (p) => /^(apps|services|packages)\//.test(p) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && !p.startsWith('apps/customer/tests/real-app/'),
];

const PRODUCT = 'product code, and no map recorded from real runs says which journeys reach it yet';

/** One path's kind: { kind: 'full', why } | { kind: 'file', file } | { kind: 'none' }. */
export function pathKind(path) {
  const p = String(path);
  if (isSharedSetup(p)) return { kind: 'full', why: 'the journey stack’s shared setup (SHARED_SETUP)' };
  const run = RUN_FILE.exec(p);
  if (run && JOURNEY_TEST.test(p)) return { kind: 'file', file: run[1] };
  if (run)
    return {
      kind: 'full',
      why: 'a run file that holds no journey steps (a look sweep), which no report lists, so only a clean full run shows it broke nothing',
    };
  if (JOURNEY_CI.includes(p)) return { kind: 'full', why: 'a check the journeys run uses (JOURNEY_CI)' };
  for (const [re, why] of FULL_RULES) if (re.test(p)) return { kind: 'full', why };
  if (NONE_RULES.some((r) => r(p))) return { kind: 'none' };
  if (/^(apps|services|packages)\//.test(p)) return { kind: 'full', why: PRODUCT, product: true };
  return { kind: 'full', why: 'a path no rule places, so the safe default' };
}

/**
 * What a pull request with these changed paths must run. `atHead(file)`: whether a journey test file still exists at
 * the head (a removed file runs nothing). `reach`: what the touched-journeys map needs (journey-reach-map.mjs
 * reachSelect: { map, behind, journeyFiles, subscribes }), or null: then every product path is full. With it, product
 * paths run only the journeys whose recorded reach touches them, when every other path allows it and the map can speak
 * for each of them; anything else is full. Returns { mode: 'full'|'files'|'none', full: [{ path, why }], files: [names],
 * reach?: [lines] }.
 */
export function journeyTouch(paths, atHead = () => true, reach = null) {
  const full = [];
  const product = [];
  const files = new Set();
  for (const p of [...new Set(paths ?? [])].sort()) {
    const k = pathKind(p);
    if (k.kind === 'full' && k.product) product.push(p);
    else if (k.kind === 'full') full.push({ path: printable(p), why: k.why });
    else if (k.kind === 'file' && atHead(p)) files.add(k.file);
  }
  let because;
  if (product.length && !full.length && reach) {
    const sel = reachSelect({
      map: reach.map,
      paths: product,
      behind: reach.behind,
      atHead: reach.journeyFiles,
      subscribes: reach.subscribes,
      ...(reach.mode ? { mode: reach.mode } : {}),
    });
    if (sel.mode === 'files') {
      for (const f of sel.files) files.add(f);
      because = sel.because.map(printable);
    } else for (const p of product) full.push({ path: printable(p), why: printable(sel.why) });
  } else for (const p of product) full.push({ path: printable(p), why: PRODUCT });
  full.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const list = [...files].sort();
  const out = { mode: full.length ? 'full' : list.length ? 'files' : 'none', full, files: list };
  return because && !full.length ? { ...out, reach: because } : out;
}

/** The journey files in a checkout's real-app folder, or null when it can't be listed. */
export function checkoutJourneyFiles(root = '.') {
  try {
    return new Set(
      readdirSync(`${root}/apps/customer/tests/real-app`).filter((f) => JOURNEY_TEST.test(`apps/customer/tests/real-app/${f}`)),
    );
  } catch {
    return null;
  }
}

/** Whether a changed file, in a checkout of the head, calls the bus's subscribe (a removed file does not). */
export const subscribesIn =
  (root = '.') =>
  (p) => {
    const f = `${root}/${p}`;
    return existsSync(f) && SUBSCRIBES.test(readFileSync(f, 'utf8'));
  };

/** How many of main's finished full runs came after the map's newest run, read with gh (GH_TOKEN), or null. The same
 *  list the seal reads (journey-seal.mjs makeIo mainRuns: the newest 30), so the two count the same age. */
function behindFromApi(map) {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const out = execFileSync(
      'gh',
      ['api', `repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=completed&per_page=30`],
      { encoding: 'utf8', maxBuffer: 64 * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return runsBehind(map, JSON.parse(out).workflow_runs, repo);
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  let paths;
  let atHead = (p) => existsSync(p);
  const b = args.indexOf('--base');
  const f = args.indexOf('--files');
  const from = args.indexOf('--files-from');
  if (from >= 0 && args[from + 1]) {
    // One changed path a line (a pull request's files, from the API), judged against this checkout of its head: a
    // journey test file the head removed runs nothing.
    paths = readFileSync(args[from + 1], 'utf8')
      .split('\n')
      .filter(Boolean);
  } else if (b >= 0 && args[b + 1]) {
    paths = execFileSync('git', ['diff', '--name-only', '--no-renames', `${args[b + 1]}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } else if (f >= 0) {
    paths = args.slice(f + 1);
    atHead = () => true;
  } else {
    console.error('usage: journey-touch.mjs [--json] --base <ref> | --files <path>... | --files-from <file>');
    process.exit(2);
  }
  // --reach: product paths run only the journeys main's touched-journeys map says reach them (this file's own map, the
  // default branch's copy in the journeys workflow), judged against this checkout of the head.
  let reach = null;
  if (args.includes('--reach')) {
    const map = loadMap();
    reach = { map, behind: behindFromApi(map), journeyFiles: checkoutJourneyFiles(), subscribes: subscribesIn() };
  }
  const t = journeyTouch(paths, atHead, reach);
  if (args.includes('--json')) return console.log(JSON.stringify(t));
  if (t.mode === 'full') {
    console.log('full: this change needs a clean full Real-app journeys run on its exact head (no journeys input), because of:');
    for (const x of t.full.slice(0, 20)) console.log(`  ${x.path}: ${x.why}`);
    if (t.full.length > 20) console.log(`  … ${t.full.length - 20} more`);
  } else if (t.mode === 'files') {
    for (const l of t.reach ?? []) console.log(`  reach: ${l}`);
    console.log(`files: gh workflow run real-app-journeys.yml -R INTAFACED/intafaced --ref <branch> -f journeys="${t.files.join(' ')}"`);
  } else console.log('none: no journeys run executes or reads what this change touches');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
