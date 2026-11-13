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
 *     the journeys verdict and the baseline, build and environment files, every doc the journeys run can read (DOCS_READ:
 *     docs/roadmap, docs/runbooks and the docs code names), and every product path (apps/, services/, packages/) other than a unit test, unless the next
 *     kind takes it. A static guess at which journeys reach which code would miss journeys (a journey runs through the
 *     customer app, svc-edge and whatever services they call and the events those raise), so only evidence narrows it;
 *   - reach (the touched-journeys map, journey-reach-map.mjs, with --reach): a product path runs only the journeys main's
 *     own full runs recorded reaching it, when no full path above is in the change and the map can speak for every
 *     product path in it (shared setup, scripts, admin-app paths, packages it can't map, a switched-off, missing or
 *     stale map: full). Its journeys join the `files` list, and `reach` says why;
 *   - named (theo-01 part 1, project-state#2065, OWNER 296): a pull request whose title or branch names a journey
 *     (`J-<area>-<n>`, namedJourneyIds) that has a journey file at its head is judged on that journey. Its product paths
 *     go to neither the full run nor the map: it runs the journeys it names, every journey test file it changes, and the
 *     map's always-run list (the map's `full` journeys, which no recorded run speaks for). Every other full path above
 *     still makes it full. Main runs every journey after every merge and is the backstop: a break of another journey is
 *     caught there and reverted (OWNER 249 (3): "a PR runs only the journeys it touches, the full suite runs on main
 *     after a merge, a red main is reverted"). A product pull request that names no journey keeps the rules above;
 *   - stack (theo-01 part 2, OWNER 296: "A change to one service's own test-stack file runs the journeys that use that
 *     file"): a named pull request's change to a service's own stack file (STACK_FILE: `local-stack-services/<service>.mjs`,
 *     `test-owner-values/<service>.json`), or to a root deploy file the stack never reads (ROOT_DEPLOY_FILE), also
 *     runs the journeys whose tests use it (stackImporters), when nothing else makes it full. Without a name, or when
 *     the journey files can't be read, it stays full, and stack-wide files (local-test-stack.mjs and the rest of
 *     SHARED_SETUP) always are;
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
 *   node tooling/ci/journey-touch.mjs --reuse               (env TARGET, HEAD_SHA: the target less what runs by hand on
 *                                                              that head already run; real-app-journeys.yml's reuse step)
 *   … --title <t> --branch <b>                                (the journeys the pull request names; with --reach, the
 *                                                              env's TITLE and GITHUB_HEAD_REF when not given, which is
 *                                                              how real-app-journeys.yml's touch step passes them)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JOURNEY_TEST, isSharedSetup } from './journey-seal.mjs';
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
  // The scoreboard's shard download ("Merge the shards").
  'tooling/ci/shard-download.mjs',
  // The touched-journeys map and what reads it: they decide which journeys a product change runs.
  'tooling/ci/journey-reach-map.mjs',
  'tooling/ci/journey-reach-map.json',
  'tooling/ci/post-merge-trust.mjs',
  'tooling/ci/review-marker.mjs',
  'tooling/ci/workflow-concurrency.test.mjs',
  'tooling/ci/factory-switch.mjs',
  // The seal's scripts word a spent API budget with it (judge down).
  'tooling/ci/api-budget.mjs',
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
  // journeys-revert.mjs refresh tells main-bisect's revert by its branch and author.
  'tooling/ci/exact-revert.mjs',
  // Reached through the seal's imports (review-marker.mjs) and the test-infra action; journey-touch.test.mjs finds them.
  'tooling/ci/assert-test-db-env.mjs',
  'tooling/ci/look-baselines.mjs',
  'tooling/ci/test-judge.mjs',
  'tooling/ci/judged-paths.mjs',
  'tooling/ci/test-judge/JUDGE.md',
];

/**
 * The docs a journeys run can read: the journeys index and the baseline (docs/roadmap, docs/runbooks), and every doc a
 * product source, a journey file or a script the journeys run executes names by path. A file ends without `/`, a folder
 * with it. Every other path under docs/ runs no journeys (the 9 Nov 09:41 UTC item on project-state#1574: a docs-only
 * pull request paid for the whole suite). journey-touch.test.mjs fails when that code names a doc this list misses.
 */
export const DOCS_READ = [
  'docs/roadmap/',
  'docs/runbooks/',
  'docs/audits/',
  'docs/agents/',
  'docs/adr/2026-11-10-launch-money-model.md',
  'docs/decisions/s2s-body-bind.md',
  'docs/pay/MERCHANT-PUBLIC-API-QUICKSTART.md',
  'docs/CODEOWNERS',
  'docs/OPS-KILL-SWITCH-RUNBOOK.md',
  'docs/OWNER-OPS-CHECKLIST-2026-07-31.md',
  'docs/OWNER-SETTINGS.md',
  'docs/ROADMAP.md',
  'docs/RUNNING.md',
  'docs/THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md',
];

const FULL_RULES = [
  [
    /^tooling\/scripts\//,
    'a script under tooling/scripts (the stack, the TEST market maker, the seed, world-restore or a script journeys import)',
  ],
  [/^\.github\/workflows\/real-app-journeys\.yml$/, 'the journeys workflow'],
  [/^\.github\/actions\//, 'an action the journeys workflow uses'],
  [
    { test: (p) => DOCS_READ.some((d) => (d.endsWith('/') ? p.startsWith(d) : p === d)) },
    'a doc the journeys run, the stack or a service reads or names (DOCS_READ)',
  ],
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
  // harness file reads it (U6 on project-state#1574: an AGENTS.md-only PR paid for a full run, 42547155694).
  (p) => /^[^/]+\.md$/.test(p),
  // A doc outside DOCS_READ (that list is full, and is checked first).
  (p) => p.startsWith('docs/'),
];

const PRODUCT = 'product code, and no map recorded from real runs says which journeys reach it yet';

/** A journey id as the seal reads one in a title (journey-seal.mjs JOURNEY_ID). */
const JOURNEY_ID = /\bJ-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/gi;

/** The journey ids a pull request's title or branch names (`J-bank-13`, branch `j/j-bank-13` or `agents-j-agents-19`),
 *  in the seal's case (`J-` then lower case), sorted. */
export function namedJourneyIds({ title = '', branch = '' } = {}) {
  const ids = new Set();
  for (const t of [title, branch]) for (const m of String(t ?? '').matchAll(JOURNEY_ID)) ids.add(m[0].toLowerCase().replace(/^j-/, 'J-'));
  return [...ids].sort();
}

/**
 * What a named-journey pull request runs besides its changed journey files (journeyTouch's `named`), or null when it
 * names no journey with a file at its head (then the other rules decide). `journeyFiles`: the journey file names at the
 * head (a Set), or null when they can't be read (then null: fail to the other rules, never fewer). `map`: the
 * touched-journeys map the run chose (journey-reach-map.mjs newerMap), whose `full` keys are the always-run list.
 */
export function namedInputs({ ids, journeyFiles, map, importers = null }) {
  if (!ids?.length || !journeyFiles) return null;
  const want = new Set(ids);
  const files = [...journeyFiles].filter((f) => want.has(JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1])).sort();
  if (!files.length) return null;
  const always = Object.keys(map?.full ?? {})
    .filter((f) => journeyFiles.has(f))
    .sort();
  return { ids: [...ids], files, always, ...(importers ? { importers } : {}) };
}

/** A service's own stack file: what `local:stack` starts that one service with. A test file beside them, or any other
 *  name, isn't one. */
export const STACK_FILE = /^tooling\/(?:scripts\/local-stack-services\/[a-z0-9-]+\.mjs|profiles\/test-owner-values\/[a-z0-9-]+\.json)$/;

/** A root deploy file the journeys stack never starts from: `pnpm local:stack` reads no compose file or .env.example
 *  (deploys and the tester profile do), and a journey that reads one names it (J-home-ia-11 reads both compose files and
 *  .env.example). The Dockerfile is not one: J-home-ia-11 builds the app image without naming it, so it stays full. A
 *  journey build adds its service's env here beside its stack file, and one of them was in 34 of 41 journey-build runs
 *  on 12-13 Nov 2026 that ran the full suite. So a named pull request treats it like a stack file: it runs the journeys
 *  that name it (stackImporters); without a name it stays full, and main's full run judges the rest
 *  (project-state#2344 row d55). */
export const ROOT_DEPLOY_FILE = /^(?:docker-compose[^/]*\.ya?ml|\.env\.example)$/;

/** Text with a path split over `'a', 'b'` arguments or a line of comment joined up, so each spelling reads as one path. */
const joinedPaths = (t) =>
  String(t)
    .replace(/['"`]\s*,\s*['"`]/g, '/')
    .replace(/\/[ \t]*\r?\n[ \t]*(?:\/\/|\*)[ \t]*/g, '/');

/**
 * The journey files whose tests use a changed stack file (OWNER 296; blueprint file 10 item 6), from `texts`: the head's
 * .mjs files in the real-app folder, name to text. A file uses it when it names it by path anywhere, in code or in a
 * comment (most journeys that lean on a stack value say so in a comment and restart the service, and never `import` it;
 * running one too many is safe), or imports a helper in that folder that does.
 */
export function stackImporters(paths, texts) {
  const names = [...new Set(paths)].map((p) => String(p).replace(/^tooling\/(?:scripts|profiles)\//, ''));
  const sources = new Map([...texts].map(([f, t]) => [f, joinedPaths(t)]));
  const reaches = new Set([...sources].filter(([, t]) => names.some((n) => t.includes(n))).map(([f]) => f));
  const uses = new Map([...sources].map(([f, t]) => [f, [...t.matchAll(/(['"`])\.\/([A-Za-z0-9._-]+\.mjs)\1/g)].map((m) => m[2])]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [f, deps] of uses)
      if (!reaches.has(f) && deps.some((d) => reaches.has(d))) {
        reaches.add(f);
        grew = true;
      }
  }
  return [...reaches].filter((f) => JOURNEY_TEST.test(`apps/customer/tests/real-app/${f}`)).sort();
}

/** One path's kind: { kind: 'full', why, stack? } | { kind: 'file', file } | { kind: 'none' }. `stack`: a service's own
 *  stack file, which only a pull request that names a journey narrows (journeyTouch). */
export function pathKind(path) {
  const k = kindOf(String(path));
  return STACK_FILE.test(String(path)) || ROOT_DEPLOY_FILE.test(String(path)) ? { ...k, stack: true } : k;
}

function kindOf(p) {
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
 * reach?: [lines] }. `named`: what namedInputs gives for a pull request that names a journey, or null; with it, product
 * paths run the named journeys and the always-run list instead of the full suite or the map, and `named` says why. With
 * it, a service's own stack file adds the journeys that use it, when nothing else is full (`stack` lists those paths,
 * `importers` those journeys); otherwise it is full like any other.
 */
export function journeyTouch(paths, atHead = () => true, reach = null, named = null) {
  const full = [];
  const product = [];
  const stack = [];
  const files = new Set();
  for (const p of [...new Set(paths ?? [])].sort()) {
    const k = pathKind(p);
    if (k.kind === 'full' && k.product) product.push(p);
    else if (k.stack) stack.push({ path: printable(p), why: k.why });
    else if (k.kind === 'full') full.push({ path: printable(p), why: k.why });
    else if (k.kind === 'file' && atHead(p)) files.add(k.file);
  }
  let because;
  let byName;
  if (product.length && named) {
    // Judged on the journeys it names (theo-01 part 1); another full path still makes the whole change full.
    if (full.length) for (const p of product) full.push({ path: printable(p), why: PRODUCT });
    else {
      for (const f of [...named.files, ...named.always]) files.add(f);
      byName = `it names ${named.ids.join(', ')}, so its ${product.length} product path(s) run ${named.files.join(', ')} and the ${named.always.length} always-run journey file(s), and main's full run judges the rest`;
    }
  } else if (product.length && !full.length && reach) {
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
  // Decided last, so any other full path, product code included, makes the stack files full with it.
  const importers = stack.length && !full.length ? (named?.importers?.(stack.map((x) => x.path)) ?? null) : null;
  if (importers) {
    for (const f of [...named.files, ...named.always, ...importers]) files.add(f);
    byName = `${byName ? `${byName}; ` : ''}it names ${named.ids.join(', ')}, so its ${stack.length} stack file(s) run ${named.files.join(', ')}, the ${named.always.length} always-run journey file(s) and the ${importers.length} journey file(s) using them`;
  } else full.push(...stack);
  full.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const list = [...files].sort();
  const out = { mode: full.length ? 'full' : list.length ? 'files' : 'none', full, files: list };
  if (byName && !full.length)
    return { ...out, named: printable(byName), ...(importers ? { stack: stack.map((x) => x.path), importers } : {}) };
  return because && !full.length ? { ...out, reach: because } : out;
}

/** A run by hand's title (real-app-journeys.yml `run-name`): the journeys it was given, or `full`. */
export const DISPATCH_TITLE = /^Real-app journeys by hand, (.+)$/;
const JOURNEY_FILE_NAME = /^[A-Za-z0-9._-]+\.pw\.mjs$/;
/** A shard job of the journeys run (real-app-journeys.yml `journeys` job). */
export const SHARD_JOB = /^Journeys \(shard \d+ of \d+\)$/;

/**
 * One journeys run per head (project-state#2065 row d32 part (b)): the journey files that targeted runs by hand of this
 * workflow on the pull request's exact head (the builder's run before it opened the pull request) already run, so the
 * pull request's own run leaves them out. A run counts when it is this repository's, dispatched by hand on `sha`, and
 * targeted: its title (DISPATCH_TITLE) names journey files, each a journey file at the head (`journeyFiles`, a Set; null:
 * none counts). A full run by hand never counts: it may be deferred and run nothing for now (main-first.mjs), it fails
 * fast on unbuilt steps where a pull request's run keeps the ordinary limits, and one still going is cancelled by the
 * pull request's run, which shares its concurrency group. A targeted run still going counts (the seal waits for it); a
 * finished one counts only when its shards ran (`ranShards`, a Set of run ids with a finished shard job), never when it
 * was cancelled or skipped or stopped before its shards. The seal still reads every run on the head by its report
 * (journey-seal.mjs), so a red there stands. Returns Map(file → run id).
 */
export function reusableRuns(runs, { sha, repo, journeyFiles, ranShards, workflow = '.github/workflows/real-app-journeys.yml' }) {
  const files = new Map();
  for (const r of runs ?? []) {
    if (r?.event !== 'workflow_dispatch' || r?.head_sha !== sha || r?.path !== workflow) continue;
    if (r?.repository?.full_name !== repo || r?.head_repository?.full_name !== repo) continue;
    if (r.status === 'completed' && (['cancelled', 'skipped'].includes(r.conclusion) || !ranShards?.has(r.id))) continue;
    const m = DISPATCH_TITLE.exec(String(r.display_title ?? ''));
    if (!m || m[1] === 'full') continue;
    const names = m[1].split(/[\s,]+/).filter(Boolean);
    if (!journeyFiles || !names.length || !names.every((f) => JOURNEY_FILE_NAME.test(f) && journeyFiles.has(f))) continue;
    for (const f of names) if (!files.has(f)) files.set(f, r.id);
  }
  return files;
}

/**
 * What a pull request's run runs after leaving out the journey files `reused` (reusableRuns) already runs on its head.
 * `target`: the touch job's journey file names separated by spaces; '' (the full suite) is never narrowed. Returns
 * { target, mode: 'run'|'none', why }.
 */
export function afterReuse(target, reused) {
  const want = String(target ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const rest = want.filter((f) => !reused.has(f));
  if (!want.length || rest.length === want.length) return { target: want.join(' '), mode: 'run', why: '' };
  const ids = [...new Set(want.filter((f) => reused.has(f)).map((f) => reused.get(f)))];
  const why = `${want.length - rest.length} of its ${want.length} journey file(s) already run by hand on this head (run ${ids.join(', ')}), so this run leaves them out`;
  return rest.length ? { target: rest.join(' '), mode: 'run', why } : { target: '', mode: 'none', why: `${why} and runs nothing` };
}

/** The .mjs files directly in a checkout's real-app folder, name to text, or null when they can't be read. */
export function checkoutJourneyTexts(root = '.') {
  try {
    const dir = `${root}/apps/customer/tests/real-app`;
    return new Map(
      readdirSync(dir)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]),
    );
  } catch {
    return null;
  }
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

/** --reuse: the pull request run's target after reusableRuns (env TARGET, HEAD_SHA, GITHUB_REPOSITORY, GH_TOKEN), as
 *  JSON { target, mode, why }. Any read that fails leaves the target as it was (never fewer journeys). */
function reuseMain() {
  const target = process.env.TARGET ?? '';
  const sha = process.env.HEAD_SHA ?? '';
  const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
  let out = { target, mode: 'run', why: '' };
  try {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('no head');
    const runs = JSON.parse(
      ghApi(`repos/${repo}/actions/workflows/real-app-journeys.yml/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`),
    ).workflow_runs;
    // A finished run counts only when a shard of it finished (reusableRuns); one jobs read per such run.
    const ranShards = new Set();
    for (const r of runs ?? [])
      if (
        r?.event === 'workflow_dispatch' &&
        r?.head_sha === sha &&
        r?.status === 'completed' &&
        DISPATCH_TITLE.test(String(r.display_title ?? ''))
      ) {
        const jobs = JSON.parse(ghApi(`repos/${repo}/actions/runs/${Number(r.id)}/jobs?per_page=100`)).jobs ?? [];
        if (jobs.some((j) => SHARD_JOB.test(String(j?.name)) && ['success', 'failure'].includes(j?.conclusion))) ranShards.add(r.id);
      }
    out = afterReuse(target, reusableRuns(runs, { sha, repo, journeyFiles: checkoutJourneyFiles(), ranShards }));
  } catch (e) {
    out.why = `the runs by hand on this head couldn't be read (${printable(e.message).slice(0, 200)}), so nothing is left out`;
  }
  console.log(JSON.stringify(out));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--reuse') return reuseMain();
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
  // --reach: product paths run only the journeys main's touched-journeys map says reach them, judged against this
  // checkout of the head. The map is the newest one main's map workflow built and verified before this run was created
  // (journey-reach-map.mjs builtMap), or this file's own committed copy (the default branch's, in the journeys workflow)
  // when that one is newer or the build can't be read.
  const arg = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  const ids = namedJourneyIds({
    title: arg('--title') ?? (args.includes('--reach') ? process.env.TITLE : ''),
    branch: arg('--branch') ?? (args.includes('--reach') ? process.env.GITHUB_HEAD_REF : ''),
  });
  let reach = null;
  let map = null;
  if (args.includes('--reach')) {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const built = await builtMap({
      get: (path) => JSON.parse(ghApi(path.replace(/^\//, ''))),
      raw: (path) => ghApi(path.replace(/^\//, ''), 'buffer'),
      before: runCreated(),
      repo,
    });
    map = newerMap(built, loadMap());
    reach = { map, behind: behindFromApi(map), journeyFiles: checkoutJourneyFiles(), subscribes: subscribesIn() };
  }
  const texts = paths.some((p) => pathKind(p).stack) ? checkoutJourneyTexts() : null;
  const named = namedInputs({
    ids,
    journeyFiles: checkoutJourneyFiles(),
    map: map ?? loadMap(),
    importers: texts ? (stack) => stackImporters(stack, texts) : null,
  });
  const t = journeyTouch(paths, atHead, named ? null : reach, named);
  if (t.named && args.includes('--json')) console.error(`journey-touch: ${t.named}`);
  if (args.includes('--json')) return console.log(JSON.stringify(t));
  if (t.mode === 'full') {
    console.log('full: this change needs a clean full Real-app journeys run on its exact head (no journeys input), because of:');
    for (const x of t.full.slice(0, 20)) console.log(`  ${x.path}: ${x.why}`);
    if (t.full.length > 20) console.log(`  … ${t.full.length - 20} more`);
  } else if (t.mode === 'files') {
    for (const l of t.reach ?? []) console.log(`  reach: ${l}`);
    if (t.named) console.log(`  named: ${t.named}`);
    console.log(`files: gh workflow run real-app-journeys.yml -R INTAFACED/intafaced --ref <branch> -f journeys="${t.files.join(' ')}"`);
  } else console.log('none: no journeys run executes or reads what this change touches');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
