#!/usr/bin/env node
/**
 * Which journeys a pull request touches, from its changed paths.
 *
 * What a pull request runs, and the merge seal (journey-seal.mjs) holds it to, is prJourneys below, never the full suite
 * (U4 C1; project-state OWNER 249 (3), the owner's words: "a PR runs only the journeys it touches, the full suite runs
 * on main after a merge, a red main is reverted"): the journeys its title names, the journey test files it changes, and
 * the journeys whose tests read a stack helper (tooling/scripts/local-stack-services/<svc>.mjs) it changes, in at most
 * PR_MAX_SHARDS shards; none of them, nothing. Main's full run after a merge and its automatic revert are the backstop.
 * (Failure it prevents: with the rules below alone, about 3 of 50 product pull requests ran fewer than the whole suite,
 * so pull requests' full runs held the runners main's verdict waits on.)
 *
 * journeyTouch and the kinds below still say what a change can reach (the seal's re-check and which seal inputs it
 * waits for read them, and prJourneys logs it). They were the yardstick before C1. (Failure they prevented: on 7 Nov
 * 2026 a pull request that changed product code, #7415, merged on its own named steps and broke another journey's step,
 * J-copy-bots-otc-01 #1, on main; builders then dispatched the full suite, 36 shards, on nearly every branch to be safe.)
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
 *   TITLE=… BODY=… node tooling/ci/journey-touch.mjs --pr --base origin/main   (what this pull request runs: prJourneys;
 *                                                             --json --files-from f is real-app-journeys.yml's touch job)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import { JOURNEY_TEST, exemptions, isSharedSetup, revertOf, titleSteps } from './journey-seal.mjs';
import { SUBSCRIBES, builtMap, loadMap, newerMap, reachSelect, runsBehind } from './journey-reach-map.mjs';

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
  // Main trust's post-merge job runs it after each journeys run on main, and main-bisect.yml's journeys revert jobs.
  'tooling/ci/journeys-revert.mjs',
  'tooling/ci/journeys-revert-probe.mjs',
  'tooling/ci/journeys-revert-probe.sh',
  // journeys-revert.mjs mints its App token with it.
  'tooling/ci/factory-builder.mjs',
  // journeys-revert.mjs reads its test and job lists (the revert on main for CI reds).
  'tooling/ci/bisect-main.mjs',
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
  // Markdown at the repository root (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md): no journey, stack script or
  // harness file reads it (U6 on project-state#1574: an AGENTS.md-only PR paid for a full run, 42547155694). docs/ stays
  // full: journeys read docs/roadmap and docs/runbooks.
  (p) => /^[^/]+\.md$/.test(p),
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

// ---- What a pull request runs (U4 C1; project-state OWNER 249 (3)) ----

/** A stack service helper: `tooling/scripts/local-stack-services/<svc>.mjs`, the file that holds that service's env and
 *  TEST values on the journey stack. */
export const STACK_HELPER = /^tooling\/scripts\/local-stack-services\/[A-Za-z0-9._-]+\.mjs$/;
const REAL_APP_DIR = 'apps/customer/tests/real-app';
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
/** The most shards a pull request's journeys run takes (real-app-journeys.yml passes it to journey-shards.mjs --max). */
export const PR_MAX_SHARDS = 10;

/**
 * The journey files (names in the real-app folder) whose tests read a changed stack helper (STACK_HELPER among
 * `changed`): the file imports it, directly or through the real-app folder's own helper modules, or names its path
 * (`local-stack-services/trade.mjs`; journey files name the helper whose TEST value or switch a step depends on, as
 * J-cex-spot-17 does for trade.mjs). Imports are followed only through the real-app folder, never through
 * tooling/scripts: every journey reaches every helper through the stack script, which would make this the full suite.
 * `journeyFiles`: the names at the head; `read(path)`: a file's text at the head, or null. Sorted names.
 */
export async function helperReaders({ changed, journeyFiles, read }) {
  const want = new Set((changed ?? []).map(String).filter((p) => STACK_HELPER.test(p)));
  if (!want.size || !journeyFiles) return [];
  const named = [...want].map((p) => p.slice('tooling/scripts/'.length));
  const texts = new Map();
  const textOf = (p) =>
    texts.has(p)
      ? texts.get(p)
      : texts
          .set(
            p,
            Promise.resolve(read(p)).catch(() => null),
          )
          .get(p);
  const imports = async (p, seen) => {
    if (seen.has(p)) return false;
    seen.add(p);
    const text = await textOf(p);
    if (typeof text !== 'string') return false;
    for (const m of text.matchAll(RELATIVE_IMPORT)) {
      const to = posix.normalize(posix.join(posix.dirname(p), m[1]));
      if (want.has(to)) return true;
      if (to.startsWith(`${REAL_APP_DIR}/`) && !to.endsWith('.pw.mjs') && (await imports(to, seen))) return true;
    }
    return false;
  };
  const out = [];
  for (const f of [...journeyFiles].sort()) {
    const p = `${REAL_APP_DIR}/${f}`;
    const text = await textOf(p);
    if (typeof text !== 'string') continue;
    if (named.some((n) => text.includes(n)) || (await imports(p, new Set()))) out.push(f);
  }
  return out;
}

/** The journey files (at the head, `journeyFiles`) of the steps a title names that no `Left-or-replaced:` line leaves:
 *  the files the seal's named steps live in (journey-seal.mjs titleSteps and exemptions). Sorted names. */
export function titleFiles({ title, body, journeyFiles }) {
  const left = exemptions(body).steps;
  const ids = new Set(
    titleSteps(title)
      .filter((k) => !left.has(k))
      .map((k) => k.split('#')[0]),
  );
  return [...(journeyFiles ?? [])]
    .filter((f) => {
      const m = JOURNEY_TEST.exec(`${REAL_APP_DIR}/${f}`);
      return m && ids.has(m[1]);
    })
    .sort();
}

/**
 * The journeys a pull request runs, and the merge seal holds it to (owner decision, project-state OWNER 249 (3): "a PR
 * runs only the journeys it touches, the full suite runs on main after a merge, a red main is reverted"): never the
 * full suite. The union of
 *   - `named`: the journey files of the steps its title names (titleFiles);
 *   - the journey test files it changes that the head still has;
 *   - `readers`: the journey files whose tests read a stack helper it changes (helperReaders).
 * An empty union runs nothing. GitHub's Revert form (`revert`) runs only its stack helpers' readers: a red main is
 * undone within 2 hours (project-state OWNER 180), as before, when only shared setup held a revert to a run.
 * The touched-journeys map (journey-reach-map.mjs) adds nothing here: over the 50 product pull requests merged before
 * 10 Nov 2026 02:45 UTC it could place every product path of 3, and each time it chose 162 to 278 journey files, 28 to
 * 45 shards' worth, so within PR_MAX_SHARDS its longest shard ran 45 to 71 minutes against the 60-minute journeys
 * limit; without it all 50 fit, the longest shard 26 minutes. What this gives up: a change to shared setup, a script,
 * a doc or product code no longer proves the whole suite, or the map's part of it, before it merges; main's full run
 * after the merge and its automatic revert (journeys-revert.mjs) are the backstop (the guide's red-team replay on
 * project-state#1574: 0 of 5 recent main reds would have slipped past a run this narrow). `atHead(path)`: whether a
 * journey test file still exists at the head. Returns { mode: 'files'|'none', files, named, readers, changed, touch:
 * what journeyTouch alone would have asked ('full'|'files'|'none'), for the log }.
 */
export function prJourneys({ paths, atHead = () => true, named = [], readers = [], revert = false }) {
  const all = [...new Set(paths ?? [])];
  const changed = revert ? [] : all.flatMap((p) => (pathKind(p).kind === 'file' && atHead(p) ? [RUN_FILE.exec(p)[1]] : []));
  const files = [...new Set([...changed, ...readers, ...(revert ? [] : named)])].sort();
  return {
    mode: files.length ? 'files' : 'none',
    files,
    named: revert ? [] : [...named].sort(),
    readers: [...readers].sort(),
    changed: changed.sort(),
    touch: journeyTouch(all, atHead).mode,
  };
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
 *  list the seal reads (journey-seal.mjs makeIo mainRuns: the newest 100, so a burst of cancelled runs can't hide the
 *  map's newest run and blank its age), so the two count the same age. */
function behindFromApi(map) {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const out = execFileSync(
      'gh',
      ['api', `repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=completed&per_page=100`],
      { encoding: 'utf8', maxBuffer: 64 * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return runsBehind(map, JSON.parse(out).workflow_runs, repo);
  } catch {
    return null;
  }
}

const ghApi = (path, encoding = 'utf8') =>
  execFileSync('gh', ['api', path], { encoding, maxBuffer: 64 * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'] });

/** When this journeys run was created (GITHUB_RUN_ID, read with gh), so the seal can pick the same map build; now when
 *  it can't be read (a run by hand). */
function runCreated() {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const at = Date.parse(JSON.parse(ghApi(`repos/${repo}/actions/runs/${Number(process.env.GITHUB_RUN_ID)}`)).created_at);
    if (process.env.GITHUB_RUN_ID && Number.isFinite(at)) return at;
  } catch {}
  return Date.now();
}

async function main() {
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
    console.error('usage: journey-touch.mjs [--json] [--reach] [--pr] --base <ref> | --files <path>... | --files-from <file>');
    process.exit(2);
  }
  // --pr: what a pull request runs (prJourneys), what real-app-journeys.yml's touch job runs: its title's journeys (TITLE
  // and BODY in the environment, never an argument: they are the pull request's own text), its changed journey files and
  // its stack helpers' readers, read in this checkout of its head.
  if (args.includes('--pr')) {
    const journeyFiles = checkoutJourneyFiles();
    if (!journeyFiles) throw new Error("the head's journey files couldn't be listed");
    const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
    const revert =
      revertOf({ title: process.env.TITLE, body: process.env.BODY, repo: process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced' }) !== null;
    const t = prJourneys({
      paths,
      atHead,
      revert,
      named: titleFiles({ title: process.env.TITLE, body: process.env.BODY, journeyFiles }),
      readers: await helperReaders({ changed: paths, journeyFiles, read }),
    });
    if (args.includes('--json')) return console.log(JSON.stringify(t));
    if (t.mode === 'none') return console.log('none: this pull request runs no journeys (main runs the full suite after it merges)');
    console.log(
      `title: ${t.named.join(' ') || '-'}; changed: ${t.changed.join(' ') || '-'}; helper readers: ${t.readers.join(' ') || '-'}`,
    );
    return console.log(`files (${t.files.length}): ${t.files.join(' ')}`);
  }
  // --reach: product paths run only the journeys main's touched-journeys map says reach them, judged against this
  // checkout of the head. The map is the newest one main's map workflow built and verified before this run was created
  // (journey-reach-map.mjs builtMap), or this file's own committed copy (the default branch's, in the journeys workflow)
  // when that one is newer or the build can't be read.
  let reach = null;
  if (args.includes('--reach')) {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const built = await builtMap({
      get: (path) => JSON.parse(ghApi(path.replace(/^\//, ''))),
      raw: (path) => ghApi(path.replace(/^\//, ''), 'buffer'),
      before: runCreated(),
      repo,
    });
    const map = newerMap(built, loadMap());
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
