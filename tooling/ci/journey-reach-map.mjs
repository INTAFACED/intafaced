#!/usr/bin/env node
/**
 * The touched-journeys map: which journeys a product path can break, from what each journey was recorded reaching on
 * main's own full Real-app journeys runs (tooling/scripts/journey-reach.mjs, the `journey-reach` report attachments),
 * so a pull request runs only those journeys instead of the whole suite (project-state research/factory-2026-11-08
 * R3 C4, approved whole by the owner in OWNER 240; OWNER 248, phase 0: "merges a normal PR within about an hour on
 * honest checks"). journey-touch.mjs asks reachSelect; the merge seal holds the run to the same answer.
 *
 * The map (journey-reach-map.json, committed; this repository is public, so it holds only repository paths, service
 * directory names and journey file names, never text a record's request or page carried):
 *   { v, mode: 'reach' | 'full', why?, runs: [{ id, head, created }], journeys: [file], full: { [file]: reason },
 *     services: { 'services/svc-x': [journey index] }, packages: { 'packages/x': [journey index] },
 *     customer: { 'apps/customer/src/…': [journey index] }, consumers: { 'packages/x': [consumer dir] },
 *     dependents: { 'packages/x': [package dir] }, harness: [dir], subscribers: [service dir], money: [dir],
 *     importers?: { 'apps/customer/src/…': [path] } (only the customer files no run recorded), built?: [path],
 *     computed?: [path], busLogged?: true (every record it is built from ran with a bus that logs each delivery) }
 * Built (buildMap) only from main's full runs that are whole: every journey file at the run's head in its report, and a
 * record for each. A journey whose record is incomplete (a reason code, or an afterAll record that never came) or that
 * has no record in a run where it existed reaches everything: it runs for every product change. With fewer than
 * MIN_RUNS whole runs the builder refuses: it writes a map whose mode is 'full', and nothing narrows.
 * A journey's reach comes only from the runs where every one of its tests passed, or where each test that didn't pass is
 * a step main's journey baseline calls unbuilt (or a test skipped after one), red in every run the map is built from,
 * all of which hold the file (speaksFor); with no such run it reaches everything. The baseline is the checkout's own
 * copy, so `verify` on main rebuilds it from the same baseline. Open edge, not covered: a service that publishes an
 * event from background work without logging while a journey runs is not tied to the journey that sees the
 * subscriber's effect (review 7561-R1 #3;
 * subscribers are full). A pull request that changes the committed map is held to `verify` (the Doctrine gates job in
 * ci.yml, main's copy of this file in a worktree of main): it rebuilds the map from main's runs up to the newest run the
 * map names and compares it byte for byte, so a hand-edited map, or one built from hand-picked runs, fails (review
 * 7561-R1 #2). The Touched-journeys map workflow (journey-reach-map.yml) builds it in CI with the workflow's own
 * read-only token and keeps it as an artifact; nothing pushes it to main.
 *
 * What a product path selects (reachSelect), else the full suite:
 *   - services/svc-x/…: the journeys whose stack log shows svc-x served or logged while they ran. Full when no journey
 *     reached it, when svc-x subscribes to bus events and the map isn't `busLogged` (a handler that logs nothing is
 *     recorded nowhere; since the bus writes a line for each delivery, intafaced #8657, a handler's run is in the log),
 *     or when the changed file subscribes, itself or through a file of its service it imports (subscribesVia: a new
 *     subscription runs a handler in journeys no record ties to the service);
 *   - apps/customer/src/…: the journeys whose pages ran a function of that file or loaded a built script holding it.
 *     A file no journey reached (a new file, a style sheet, one the build doesn't map) runs only where a file loading it
 *     runs, so it takes the journeys of the files that load it at the head (`importers`, read at the map's newest run's
 *     head; the files main changed since, up to the pull request's merge base; and the pull request's own changed files
 *     that name it), followed up through files no journey reached either. Full when the map holds no `importers`, the
 *     head or main's changes since the map can't be read whole, a file the map doesn't know is on the pull request's
 *     merge base (main added it after the map was built) or shares its import name with another at the head (`x.ts` beside `x.tsx`: an
 *     unchanged import may now load it), the app's Node code runs it (`built`), something outside the customer source
 *     or a page loads it, or the chain ends at a file nothing but tests loads;
 *   - packages/x/…: the journeys whose pages ran its built code (the customer bundles `packages/x/dist`, read back to
 *     the package) and the journeys that reached a service depending on it. Full when the package is not in the map,
 *     when an app no record covers depends on it (apps/admin, apps/mobile, apps/invitation), when the journey harness
 *     imports it (tooling/scripts, the real-app helpers: every journey runs it), when a service that subscribes to bus
 *     events depends on it and the map isn't `busLogged`, or when it reaches no journey;
 *   - any other product path (apps/admin, other apps, apps/customer outside src): full.
 * Every journey the map can't speak for runs too: the map's `full` journeys and a journey file at the head the map
 * doesn't know. A selection holding every journey is the full run. The whole map is off, and every product change
 * full, when REACH_MAP_MODE is 'full', the map is missing, unreadable, of another version or built from fewer than
 * MIN_RUNS runs, or when more than STALE_RUNS of main's finished full runs came after its newest run (or that count
 * can't be read).
 *
 *   node tooling/ci/journey-reach-map.mjs build [--runs <id,id,id>] [--until <run id>] [--out <file>]
 *                                                    (GH_TOKEN; writes the map; --until: only runs up to that run)
 *   node tooling/ci/journey-reach-map.mjs verify [--map <file>]
 *                                                    (GH_TOKEN; rebuilds the map up to its newest run, compares bytes)
 *   node tooling/ci/journey-reach-map.mjs show [--map <file>]                         (what the map holds)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainRun, manifestsAt, moneyCodeDirs, rootInputs, stepOf, testPassed } from './journey-verdict.mjs';

/**
 * The off switch: 'full' sends every product change to the full suite, whatever the map says. 'reach' uses the map.
 * On since REVIEW.md's C4 entry (OWNER 240, 249) and a map built from MIN_RUNS whole main runs; only a reviewed code
 * change moves it, never a data-only map commit. Setting it to 'full' is the way back.
 */
export const REACH_MAP_MODE = 'reach';
/** Money code beyond moneyCodeDirs (journey-verdict.mjs): the ledger service itself. */
export const MONEY_SERVICES = ['services/svc-ledger'];
// Not bumped for project-state#1574: a new version makes the committed map unusable, so every PR would run full until rebuilt.
export const MAP_VERSION = 1;
/** The plan's "build the map from the next 3 full main runs": fewer whole runs build no map. */
export const MIN_RUNS = 3;
/**
 * The most finished full main runs that may come after the map's newest run before the map is stale (full). Main runs
 * the full suite on every push; about 24 such runs finish in a day (7–8 Nov 2026: 18 in the 18 hours before this
 * was written), so 24 is about one day of merges. Reach drifts only as fast as main's code does, every main push's full
 * run catches a journey a narrowed pull request missed within the hour, and the nightly full run is the backstop; a
 * map older than a day of merges has seen too much code change to speak for it.
 */
export const STALE_RUNS = 24;
export const MAP_FILE = fileURLToPath(new URL('./journey-reach-map.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = 'INTAFACED/intafaced';
const JOURNEYS_FILE = 'real-app-journeys.yml';
const REAL_APP = 'apps/customer/tests/real-app';
const JOURNEY_FILE = /^J-[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+(?:-[a-z0-9-]+)?\.pw\.mjs$/;
const SERVICE_DIR = /^services\/svc-[a-z0-9-]+$/;
const PACKAGE_DIR = /^packages\/[a-z0-9-]+$/;
const CUSTOMER_SRC = /^apps\/customer\/src\/[A-Za-z0-9._@/-]+$/;
/** The bus's subscribe call: a service holding one handles events no request log shows. */
export const SUBSCRIBES = /\.subscribe\s*\(|\bconsumers\.get\s*\(|\bpullSubscribe\s*\(/;

// ---- Building the map ----

/** A record's service name (a stack log's name: `bank`, `trade-2`, `migrate-support-empty-catalogue`) as the service
 *  directory it runs from, or null (postgres, the apps, anything that is not a service of this repository). */
export function serviceDir(name, services) {
  let n = String(name).replace(/^migrate-/, '');
  for (;;) {
    if (services.has(`services/svc-${n}`)) return `services/svc-${n}`;
    const cut = n.replace(/-[^-]*$/, '');
    if (cut === n) return null;
    n = cut;
  }
}

/** A recorded source path as what it belongs to: a customer source file, or a package (`packages/x/dist/…` and
 *  `packages/x/src/…` are both `packages/x`), or null. */
export function sourceOwner(p) {
  const s = String(p);
  if (CUSTOMER_SRC.test(s)) return { customer: s };
  const m = /^(packages\/[a-z0-9-]+)\//.exec(s);
  return m ? { package: m[1] } : null;
}

/** The `journey-reach` records of a Playwright JSON report, decoded (a body that isn't a v2 record is skipped). */
export function reportRecords(report) {
  const out = [];
  const walk = (s) => {
    for (const sp of s.specs ?? [])
      for (const t of sp.tests ?? [])
        for (const r of t.results ?? [])
          for (const a of r.attachments ?? []) {
            if (a?.name !== 'journey-reach' || typeof a.body !== 'string') continue;
            try {
              const rec = JSON.parse(Buffer.from(a.body, 'base64').toString('utf8'));
              if (rec?.v === 2 && typeof rec.file === 'string') out.push(rec);
            } catch {
              /* not a record */
            }
          }
    for (const c of s.suites ?? []) walk(c);
  };
  for (const s of report?.suites ?? []) walk(s);
  return out;
}

/** The journey files a report ran (as journey-verdict.mjs readReport's `ran`). */
export function reportFiles(report) {
  const ran = new Set();
  const walk = (s, file) => {
    const here = s.file ?? file;
    for (const sp of s.specs ?? []) {
      const f = String(sp.file ?? here ?? '')
        .split('/')
        .pop();
      if (JOURNEY_FILE.test(f)) ran.add(f);
    }
    for (const c of s.suites ?? []) walk(c, here);
  };
  for (const s of report?.suites ?? []) walk(s, s.file);
  return ran;
}

/**
 * Each journey file's tests in a report, in the report's order: Map(file -> { broken, tests: Map(test key -> { passed,
 * skipped, step, project }) }). A test's key is its title path (describe titles and the spec's title) and project;
 * `passed` is journey-verdict.mjs testPassed (ended expected, or flaky with a pass after a failed attempt), `skipped`
 * that Playwright skipped it, and `step` its journey step (`J-tax-01#3`) or null (a setup or end test). `broken`: a
 * spec of the file holds no test, so what ran can't be told. Every file reportFiles finds is here.
 */
export function reportTests(report) {
  const out = new Map();
  const walk = (s, file, titles) => {
    const here = s.file ?? file;
    const path = s.title && !JOURNEY_FILE.test(String(s.title).split('/').pop()) ? [...titles, s.title] : titles;
    for (const sp of s.specs ?? []) {
      const f = String(sp.file ?? here ?? '')
        .split('/')
        .pop();
      if (!JOURNEY_FILE.test(f)) continue;
      const o = out.get(f) ?? out.set(f, { broken: false, tests: new Map() }).get(f);
      const tests = sp.tests ?? [];
      if (!tests.length) o.broken = true;
      for (const t of tests) {
        const project = t.projectName ?? '';
        const key = JSON.stringify([...path, sp.title ?? '', project]);
        const had = o.tests.get(key);
        o.tests.set(key, {
          passed: (had?.passed ?? true) && testPassed(t),
          skipped: (had?.skipped ?? true) && t.status === 'skipped',
          step: stepOf(sp.title),
          project,
        });
      }
    }
    for (const c of s.suites ?? []) walk(c, here, path);
  };
  for (const s of report?.suites ?? []) walk(s, s.file, []);
  return out;
}

/**
 * The steps main's journey baseline (journey-verdict.mjs BASELINE_PATH, read by rootInputs) calls unbuilt, as
 * Map(step -> journey file name). A step listed twice, or also in `notBaselined`, is left out, as the verdict counts it
 * failing (journey-verdict.mjs judge).
 */
export function unbuiltSteps(baseline) {
  const seen = new Map();
  const dupes = new Set();
  for (const e of baseline?.steps ?? []) seen.has(e.step) ? dupes.add(e.step) : seen.set(e.step, e);
  const not = new Set((baseline?.notBaselined ?? []).map((e) => e.step));
  const out = new Map();
  for (const [step, e] of seen)
    if (e.state === 'unbuilt' && !dupes.has(step) && !not.has(step) && typeof e.file === 'string') out.set(step, e.file.split('/').pop());
  return out;
}

/**
 * Whether each whole run can speak for a journey file: an array of booleans, one per run in `whole` (false where the run
 * doesn't hold the file). `unbuilt`: unbuiltSteps of the baseline. A run counts when the file is not broken in it and
 * every test of it passed there, or when each test that didn't pass is excused:
 *   - it is a numbered step of this file the baseline calls unbuilt, or a test skipped after such a step in the same
 *     file and project; and
 *   - it didn't pass in any whole run, and every whole run the map is built from (at least MIN_RUNS) holds the file.
 * Every other test that didn't pass stops the journey short, so the run doesn't count (review 7561-R1): a setup or end
 * test, a `regression` step, a step the baseline doesn't list, a test skipped with no excused step before it, a test
 * that passed in another run (flaky), a test another run lacks, and any red test of a file some whole run doesn't hold.
 *
 * Why an excused red test leaves the run's reach sound (project-state#1574): the reach taken is still every record of
 * the file in that run (runReach), never only the passing tests' records, since each record holds only what its worker
 * hadn't sent yet (journey-reach.mjs take()).
 *   - A pull request can't make an unbuilt step redder: the journey's verdict already holds it red on main.
 *   - The green tests before it ran whole, and everything they reached is recorded, so a change they can see selects them.
 *   - An unbuilt step that turns green on main can reach code the map doesn't know until the map is rebuilt from runs
 *     where it passed; from then on it passed in some run, so it is excused nowhere, and a map older than STALE_RUNS
 *     main runs is not used at all.
 *   - The pull request that builds the step runs its journey anyway: a journey named in the pull request's title always
 *     runs (real-app-journeys.yml, the "What this run runs" step: `named=` holds the title's journey files, joined to
 *     the files the map selects, and run alone when the map selects none).
 *   - Main's full run after every merge runs every journey, and is the backstop.
 */
export function speaksFor(whole, f, unbuilt = new Map()) {
  const held = whole.map((r) => (r.files.has(f) ? r.tests.get(f) : null));
  const everyRun = whole.length >= MIN_RUNS && held.every(Boolean);
  const persistent = (key) => everyRun && held.every((o) => o.tests.get(key)?.passed === false);
  return held.map((o) => {
    if (!o || o.broken) return false;
    const after = new Set(); // projects in which an excused unbuilt step came before
    for (const [key, t] of o.tests) {
      if (t.passed) continue;
      const isUnbuilt = !!t.step && unbuilt.get(t.step) === f;
      if (!persistent(key) || !(isUnbuilt || (t.skipped && after.has(t.project)))) return false;
      if (isUnbuilt) after.add(t.project);
    }
    return true;
  });
}

/**
 * One run's reach per journey file: { [file]: { full: reason } | { services: Set, packages: Set, customer: Set } }.
 * `records`: reportRecords; `services`: the service directories of the repository. A file's reach is every record
 * naming it (each worker attaches what it had not attached yet), plus every source in the table of each built script
 * its pages loaded (a module's top level runs when its script loads). A record with a reason code, or a file whose
 * afterAll record is due and never came, reaches everything.
 */
export function runReach(records, services) {
  const table = {};
  for (const r of records) for (const [chunk, srcs] of Object.entries(r.table ?? {})) table[chunk] = srcs;
  const by = {};
  for (const r of records) {
    const f = String(r.file);
    const o = (by[f] ??= {
      services: new Set(),
      packages: new Set(),
      customer: new Set(),
      incomplete: new Set(),
      due: false,
      after: false,
    });
    for (const i of r.incomplete ?? []) o.incomplete.add(String(i));
    if (r.afterAllDue) o.due = true;
    if (r.afterAll) o.after = true;
    for (const s of [...(r.active ?? []), ...(r.served ?? []).map((x) => String(x).split(' ')[0])]) {
      const d = serviceDir(s, services);
      if (d) o.services.add(d);
    }
    const sources = [...Object.keys(r.sources ?? {}), ...(r.chunks ?? []).flatMap((c) => table[c] ?? [])];
    for (const s of sources) {
      const own = sourceOwner(s);
      if (own?.customer) o.customer.add(own.customer);
      if (own?.package) o.packages.add(own.package);
    }
  }
  const out = {};
  for (const [f, o] of Object.entries(by)) {
    if (o.incomplete.size) out[f] = { full: `its record is incomplete (${[...o.incomplete].sort().join(', ')})` };
    else if (o.due && !o.after) out[f] = { full: 'its afterAll record never came, so its record is partial' };
    else out[f] = { services: o.services, packages: o.packages, customer: o.customer };
  }
  return out;
}

/** The workspace's apps, services and packages, by directory, with what each depends on in the workspace. */
export function workspace(root = ROOT) {
  const dirs = [];
  for (const g of ['apps', 'services', 'packages'])
    for (const d of existsSync(join(root, g)) ? readdirSync(join(root, g)) : [])
      if (existsSync(join(root, g, d, 'package.json'))) dirs.push(`${g}/${d}`);
  const pkg = Object.fromEntries(dirs.map((d) => [d, JSON.parse(readFileSync(join(root, d, 'package.json'), 'utf8'))]));
  const byName = Object.fromEntries(dirs.map((d) => [pkg[d].name, d]));
  const deps = Object.fromEntries(
    dirs.map((d) => [
      d,
      Object.keys({ ...pkg[d].dependencies, ...pkg[d].devDependencies, ...pkg[d].peerDependencies, ...pkg[d].optionalDependencies })
        .map((n) => byName[n])
        .filter(Boolean),
    ]),
  );
  return { dirs, byName, deps };
}

/** Every package depending on a package, through other packages too: { 'packages/x': [package dir] }. consumersOf keeps
 *  only apps and services, so this is how pathReach sees a package that only a money package depends on (review
 *  7561-R2). */
export function dependentPackages({ dirs, deps }) {
  const pkgs = dirs.filter((d) => PACKAGE_DIR.test(d));
  const out = {};
  for (const p of pkgs) {
    const seen = new Set();
    const queue = [p];
    while (queue.length) {
      const x = queue.shift();
      for (const d of pkgs) if (d !== p && deps[d].includes(x) && !seen.has(d)) seen.add(d) && queue.push(d);
    }
    out[p] = [...seen].sort();
  }
  return out;
}

/** Every app and service depending on a package, through other packages too: { 'packages/x': [dir] }. */
export function consumersOf({ dirs, deps }) {
  const out = {};
  for (const p of dirs.filter((d) => PACKAGE_DIR.test(d))) {
    const seen = new Set();
    const queue = [p];
    while (queue.length) {
      const x = queue.shift();
      for (const d of dirs) if (deps[d].includes(x) && !seen.has(d)) seen.add(d) && queue.push(d);
    }
    out[p] = [...seen].filter((d) => !PACKAGE_DIR.test(d)).sort();
  }
  return out;
}

/**
 * What the journey harness itself runs in Node (tooling/scripts and the real-app files), followed through every import:
 * each workspace package it imports by name or path, with every workspace package that one depends on, and each app or
 * service file it reaches by a relative import (`../../src/app/path-match.ts`), with the files those import in turn. A
 * change there reaches every journey.
 */
export function harnessImports(root = ROOT, ws = workspace(root)) {
  const queue = execFileSync('git', ['ls-files', 'tooling/scripts', REAL_APP], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => SCRIPT.test(f) && !/\.(test|spec)\./.test(f));
  const seen = new Set(queue);
  const found = new Set();
  while (queue.length) {
    const f = queue.shift();
    let text;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      const named = /^(@[a-z0-9-]+\/[a-z0-9-]+)/.exec(spec)?.[1];
      if (named && ws.byName[named]) found.add(ws.byName[named]);
      if (!spec.startsWith('.')) continue;
      const to = resolveImport(root, posix.normalize(posix.join(posix.dirname(f), spec)));
      if (!to || to.startsWith('..')) continue;
      const pkg = /^packages\/[a-z0-9-]+/.exec(to)?.[0];
      if (pkg && ws.dirs.includes(pkg)) found.add(pkg);
      else if (/^(apps|services)\//.test(to)) found.add(to);
      if (!pkg && !seen.has(to)) seen.add(to) && queue.push(to);
    }
  }
  const pkgs = [...found].filter((d) => PACKAGE_DIR.test(d));
  while (pkgs.length) for (const d of ws.deps[pkgs.shift()] ?? []) if (!found.has(d)) found.add(d) && pkgs.push(d);
  return [...found].sort();
}

const SCRIPT = /\.(m?[jt]s|cjs|tsx?|jsx)$/;
/** A relative import's repository path: as written, or with a script extension or an index file added. */
function resolveImport(root, p) {
  const tries = [
    p,
    ...['.ts', '.tsx', '.mjs', '.js', '.jsx'].map((e) => p + e),
    ...['ts', 'tsx', 'mjs', 'js'].map((e) => `${p}/index.${e}`),
  ];
  // TypeScript's `./x.js` for a file `x.ts`.
  if (/\.js$/.test(p)) tries.push(p.replace(/\.js$/, '.ts'), p.replace(/\.js$/, '.tsx'));
  for (const t of tries)
    try {
      if (statSync(join(root, t)).isFile()) return t;
    } catch {
      /* not this one */
    }
  return null;
}

const CUSTOMER_DIR = 'apps/customer/src/';
/** A test no journeys run runs, so it loads nothing into a journey: a unit test (vitest, node:test), and a Playwright file
 *  or config inside the customer source (each run by its own config; the journeys' config runs tests/real-app). */
const isTest = (f) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || (f.startsWith(CUSTOMER_DIR) && /(\.pw\.mjs|playwright\.config\.[cm]?[jt]s)$/.test(f));
/** The files whose text can name another file to load: scripts, style sheets and pages. */
const GRAPH_FILE = /\.(?:[cm]?[jt]sx?|mts|cts|css|html?)$/;
/**
 * What loadersReach needs read at the head for these changed paths, or null when nothing is (every customer path has a
 * record, or the map holds no `importers`): `texts`, the changed scripts, style sheets and pages to read; `unknown`, the
 * changed customer files the map doesn't know, each to be looked up on the pull request's merge base; `dirs`, the folders
 * whose entries at the head say whether such a file shares its import name with another.
 */
export function headWanted(map, paths) {
  const ps = [...new Set([...paths].map(String))];
  if (!map?.importers || !ps.some((p) => p.startsWith(CUSTOMER_DIR) && !map.customer?.[p]?.length)) return null;
  const unknown = ps.filter(
    (p) => p.startsWith(CUSTOMER_DIR) && !isTest(p) && !Object.hasOwn(map.customer ?? {}, p) && !Object.hasOwn(map.importers, p),
  );
  const dirs = new Set();
  for (const u of unknown) {
    dirs.add(posix.dirname(u));
    if (posix.basename(u).startsWith('index.')) dirs.add(posix.dirname(posix.dirname(u)));
  }
  return { texts: ps.filter((p) => GRAPH_FILE.test(p)), unknown, dirs: [...dirs].sort() };
}

/**
 * The text a file holds on one side of GitHub's patch of it (`side`: '+' the new, '-' the old): each hunk's context and
 * that side's lines, the hunks kept apart by `;` so no load runs from one into the next, then each quoted string of the
 * patch as an import of its own (a hunk may cut a load off from its keyword): more loads, never fewer.
 */
export function patchText(patch, side) {
  const hunks = String(patch)
    .split(/^@@.*$/m)
    .slice(1)
    .map((h) =>
      h
        .split('\n')
        .filter((l) => l.startsWith(' ') || l.startsWith(side))
        .map((l) => l.slice(1))
        .join('\n'),
    );
  const quoted = [...String(patch).matchAll(/(['"`])([^'"`\n]+)\1/g)].map((m) => `import ${m[1]}${m[2]}${m[1]}`);
  return `${[...hunks, ...quoted].join('\n;\n')}\n;\n`;
}

/**
 * What main changed between the commit the map's file graph was read at (its newest run's head) and the pull request's
 * merge base, either way round: each script, style sheet and page under apps, packages, services and tooling
 * (GRAPH_FILE, not a test), mapped to what the merge base holds of it, where it may load a file `importers` doesn't
 * name: patchText of its patch, null when the merge base doesn't hold it, undefined when the patch doesn't say (none
 * given, or a rename or copy, whose unchanged lines are new to the graph): read the file. `compare(a, b)`: GitHub's
 * compare of a...b. Throws when it can't be told whole (GitHub lists at most 300 files).
 */
export async function sinceMap(map, mergeBase, compare) {
  const from = map?.runs?.[0]?.head;
  const SHA = /^[0-9a-f]{40}$/;
  if (!SHA.test(String(from)) || !SHA.test(String(mergeBase))) throw new Error('no commits to compare');
  const out = new Map();
  if (from === mergeBase) return out;
  let c = await compare(from, mergeBase);
  // A merge base older than the map: its side is the old one of the map's head compared from it.
  const ahead = c?.status !== 'behind';
  if (!ahead) c = await compare(mergeBase, from);
  if (!['ahead', 'identical'].includes(c?.status) || !Array.isArray(c.files) || c.files.length >= 300)
    throw new Error("main's changes since the map couldn't be listed whole");
  const graph = (p) => typeof p === 'string' && /^(apps|packages|services|tooling)\//.test(p) && GRAPH_FILE.test(p) && !isTest(p);
  const put = (p, t) => {
    if (graph(p) && !out.has(p)) out.set(p, t);
  };
  for (const f of c.files) {
    const told = typeof f?.patch === 'string' && f.patch !== '' && !['renamed', 'copied'].includes(f?.status);
    if (ahead) {
      put(f?.filename, f?.status === 'removed' ? null : told ? patchText(f.patch, '+') : undefined);
      if (f?.status === 'renamed') put(f?.previous_filename, null);
    } else {
      if (f?.status === 'renamed') put(f?.filename, null);
      put(f?.previous_filename ?? f?.filename, f?.status === 'added' ? null : told ? patchText(f.patch, '-') : undefined);
    }
  }
  return out;
}

/**
 * loadersReach's `head` for what headWanted names (`want`), with main's changes since the map (sinceMap): `read(path)`
 * a file's text at the head (null when it has none), `list(dir)` a folder's entry names there, `mergeBase` the pull
 * request's merge base, `atBase(path)` whether it holds a path, `compare` sinceMap's. Throws when anything can't be read.
 */
export async function readHead(map, want, { read, list, mergeBase, atBase, compare }) {
  const since = await sinceMap(map, mergeBase, compare);
  const texts = new Map();
  for (const p of want.texts) texts.set(p, await read(p));
  for (const [p, t] of since) if (!texts.has(p)) texts.set(p, t === undefined ? await read(p) : t);
  const dirs = new Map();
  for (const d of want.dirs) dirs.set(d, new Set(await list(d)));
  // Every file main changed since the map counts as newer than it.
  const based = new Set(since.keys());
  for (const u of want.unknown) if (await atBase(u)) based.add(u);
  return { texts, dirs, based };
}

/** What a spec without an extension may resolve to (Vite's and TypeScript's lookup). */
const RESOLVED = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
/** A load whose target the text doesn't spell: a glob, a computed dynamic import, require.context. In the customer
 *  source it may load any customer file (a template import can climb folders, a glob can name `/src/**`). */
const COMPUTED_LOAD = /import\.meta\.glob|\bimport\s*\(\s*(?!['"\s])|\brequire\.context\s*\(/;

/**
 * The repository paths a file's text names to load: import and export specifiers, dynamic imports, require, `new URL()`,
 * a style sheet's @import and url(), a page's src and href. Each resolved against the file (`/x` from the customer
 * app's root), without its query or hash; a package name is left out. A path named in a comment counts too: more
 * importers, never fewer.
 */
export function importTargets(text, file) {
  const specs = [];
  for (const m of String(text).matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?|\bimport\s+|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*|@import\s+(?:url\(\s*)?|\burl\(\s*|\b(?:src|href)\s*=\s*)(['"`])([^'"`\n]+)\1/g,
  ))
    specs.push(m[2]);
  for (const m of String(text).matchAll(/\burl\(\s*([^'"`)\s]+)\s*\)/g)) specs.push(m[1]);
  const out = new Set();
  for (const raw of specs) {
    const s = raw.split(/[?#]/)[0];
    let p = null;
    if (/^\.\.?(\/|$)/.test(s)) p = posix.normalize(posix.join(posix.dirname(file), s));
    else if (s.startsWith('/') && file.startsWith('apps/customer/')) p = posix.normalize(`apps/customer${s}`);
    if (p && !p.startsWith('..')) out.add(p.replace(/\/$/, ''));
  }
  return [...out];
}

/** The paths an import spec may name a file by: itself, and for a script without its extension, as its folder when it
 *  is an index file, and as `.js` for a `.ts` (TypeScript's spelling). */
export function moduleKeys(f) {
  const keys = [f];
  const ext = posix.extname(f);
  if (RESOLVED.includes(ext)) {
    const base = f.slice(0, -ext.length);
    keys.push(base);
    if (posix.basename(base) === 'index') keys.push(posix.dirname(base));
    if (ext === '.ts' || ext === '.tsx') keys.push(`${base}.js`, `${base}.jsx`);
    if (ext === '.mts') keys.push(`${base}.mjs`);
  }
  return keys;
}

/** Code that runs in Node: the journey harness (tooling/scripts, the real-app files) and the customer app's own
 *  (its build config, deployment scripts and scaffolds: apps/customer outside src and tests, pages aside). */
const nodeRoot = (f) =>
  f.startsWith('tooling/scripts/') ||
  f.startsWith(`${REAL_APP}/`) ||
  (f.startsWith('apps/customer/') && !f.startsWith(CUSTOMER_DIR) && !f.startsWith('apps/customer/tests/') && !/\.html?$/.test(f));
/** A load Node code may build its path for: a dynamic import or require of a non-literal, or Vite's own loaders. */
const NODE_LOAD = /\b(?:import|require)\s*\(\s*(?!['"\s])|\brunnerImport\b|\bssrLoadModule\b|\bcreateRequire\b/;

/**
 * What a Node file's text loads: importTargets, and when it builds a load's path (NODE_LOAD), every quoted string that
 * names a path, from the file (`./`, `../`), the repository root (`apps/customer/src/…`, also inside a longer string)
 * or the customer app (`src/…`). `any`: such a file also quotes a customer path in pieces (`'customer', 'src'`) or
 * a path with a `src` folder it doesn't spell whole (`${HERE}/../src/x.ts`), so it may load any customer file.
 */
export function nodeTargets(text, file) {
  const out = new Set(importTargets(text, file));
  let any = false;
  if (NODE_LOAD.test(String(text))) {
    const quoted = [...String(text).matchAll(/(['"`])([^'"`\n]*)\1/g)].map((m) => m[2].split(/[?#]/)[0]);
    any = /customer['"`]\s*,\s*['"`]src['"`]/.test(String(text));
    for (const s of quoted) {
      const at = s.indexOf(CUSTOMER_DIR);
      if (/^\.\.?\//.test(s)) out.add(posix.normalize(posix.join(posix.dirname(file), s)));
      else if (at >= 0) out.add(posix.normalize(s.slice(at)));
      else if (file.startsWith('apps/customer/') && /^\/?src\//.test(s)) out.add(posix.normalize(`apps/customer/${s.replace(/^\//, '')}`));
      else if (!/\s/.test(s) && !/^(apps|packages|services|tooling)\//.test(s) && /\/src(\/|$)/.test(s)) any = true;
    }
  }
  return { targets: [...out].filter((p) => !p.startsWith('..')).map((p) => p.replace(/\/$/, '')), any };
}

/** The texts of `files` at commit `at`, read in one `git cat-file --batch`: a lookup, undefined for a path that is no blob. */
function blobs(git, at, files) {
  const out = git(['cat-file', '--batch'], Buffer.from(files.map((f) => `${at}:${f}\n`).join('')));
  const texts = new Map();
  let i = 0;
  for (const f of files) {
    const nl = out.indexOf(10, i);
    const head = /^[0-9a-f]{40} (\w+) (\d+)$/.exec(out.toString('utf8', i, nl));
    i = nl + 1;
    if (!head) continue; // "<spec> missing": nothing follows
    if (head[1] === 'blob') texts.set(f, out.toString('utf8', i, i + Number(head[2])));
    i += Number(head[2]) + 1;
  }
  return (f) => texts.get(f);
}

/**
 * Who loads each customer source file (every file under apps/customer/src but a unit test), from the text of every
 * script, style sheet and page under apps, packages, services and tooling (importTargets): { importers: { file: [path] },
 * built, computed }. A test (isTest) loads nothing here. A customer file that loads something it doesn't spell
 * (COMPUTED_LOAD) is taken to load every customer file; `computed` lists them, since they load a new file too. `built`:
 * the customer files Node code runs (nodeRoot: the journey harness and the app's build; nodeTargets), followed down
 * through their imports; a change there reaches every journey, or what the build emits, which no record ties to a
 * journey. `at`: the
 * commit to read (the map reads its newest run's head, so what main changed since is known: sinceMap), else the checkout.
 */
export function customerImporters(root = ROOT, at = null) {
  const git = (args, input) =>
    execFileSync('git', args, { cwd: root, input, encoding: input ? 'buffer' : 'utf8', maxBuffer: 1024 * 2 ** 20 });
  const all = (
    at
      ? git(['ls-tree', '-r', '--name-only', at, '--', 'apps', 'packages', 'services', 'tooling'])
      : git(['ls-files', 'apps', 'packages', 'services', 'tooling'])
  )
    .split('\n')
    .filter(Boolean);
  const read = at
    ? blobs(
        git,
        at,
        all.filter((f) => GRAPH_FILE.test(f) && !isTest(f)),
      )
    : (f) => readFileSync(join(root, f), 'utf8');
  const targets = all.filter((f) => f.startsWith(CUSTOMER_DIR) && !isTest(f));
  const byKey = new Map();
  for (const t of targets) for (const k of moduleKeys(t)) byKey.set(k, [...(byKey.get(k) ?? []), t]);
  const importers = new Map(targets.map((t) => [t, new Set()]));
  const loads = new Map();
  const computed = [];
  for (const f of all) {
    if (!GRAPH_FILE.test(f) || isTest(f)) continue;
    let text;
    try {
      text = read(f);
    } catch {
      continue;
    }
    if (typeof text !== 'string') continue;
    const node = nodeRoot(f) ? nodeTargets(text, f) : { targets: importTargets(text, f), any: false };
    const to = new Set(node.targets.flatMap((p) => byKey.get(p) ?? []));
    // A Node load of a customer path that names no file (a folder, a template) may load any customer file.
    if (node.any || (nodeRoot(f) && node.targets.some((p) => `${p}/`.startsWith(CUSTOMER_DIR) && !byKey.has(p))))
      for (const t of targets) to.add(t);
    if (f.startsWith(CUSTOMER_DIR) && COMPUTED_LOAD.test(text)) {
      computed.push(f);
      for (const t of targets) to.add(t);
    }
    to.delete(f);
    loads.set(f, to);
    for (const t of to) importers.get(t).add(f);
  }
  const queue = [...loads.keys()].filter(nodeRoot);
  const built = new Set();
  while (queue.length)
    for (const t of loads.get(queue.shift()) ?? []) {
      if (built.has(t)) continue;
      built.add(t);
      queue.push(t);
    }
  return {
    importers: Object.fromEntries([...importers].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, s]) => [t, [...s].sort()])),
    built: [...built].sort(),
    computed: computed.sort(),
  };
}

/**
 * Whether a changed service file can add a bus subscription: it calls the bus's subscribe itself, or a file of its own
 * service it imports does, followed through relative imports (svc-notify's `attach(bus, event, …)` takes its event from
 * its caller, so a caller in another file adds a subscription with no subscribe text of its own). `read(path)` gives a
 * file's text at the head, or null when there is none (sync or async). A read that throws, or more than `cap` files
 * read, answers true: unknown is full. Imports that leave the service, or name no file at the head, are not followed.
 */
export async function subscribesVia(path, read, cap = 400) {
  const svc = /^(services\/svc-[a-z0-9-]+)\//.exec(String(path))?.[1];
  const texts = new Map();
  const get = async (p) => {
    if (!texts.has(p)) {
      if (texts.size >= cap) throw new Error('too many files');
      const t = await read(p);
      texts.set(p, typeof t === 'string' ? t : null);
    }
    return texts.get(p);
  };
  const done = new Set();
  const queue = [String(path)];
  try {
    while (queue.length) {
      const p = queue.shift();
      if (done.has(p)) continue;
      done.add(p);
      const t = await get(p);
      if (t === null) continue;
      if (SUBSCRIBES.test(t)) return true;
      if (!svc) continue;
      for (const m of t.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const to = posix.normalize(posix.join(posix.dirname(p), m[1]));
        if (!to.startsWith(`${svc}/`)) continue;
        const stem = to.replace(/\.[cm]?jsx?$/, '');
        const tries = /\.[cm]?[jt]sx?$/.test(to)
          ? [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, to]
          : [`${to}.ts`, `${to}.tsx`, `${to}/index.ts`, `${to}.js`];
        for (const c of tries)
          if ((await get(c)) !== null) {
            queue.push(c);
            break;
          }
      }
    }
  } catch {
    return true;
  }
  return false;
}

/** The services that subscribe to bus events, from their own non-test sources. */
export function subscribers(root = ROOT) {
  const files = execFileSync('git', ['ls-files', 'services'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\/src\/.*\.[cm]?[jt]sx?$/.test(f) && !/\.(test|spec)\./.test(f));
  const out = new Set();
  for (const f of files) if (SUBSCRIBES.test(readFileSync(join(root, f), 'utf8'))) out.add(f.split('/').slice(0, 2).join('/'));
  return [...out].sort();
}

/**
 * The map from whole runs: `runs` newest first, each { id, head, created, report, files } (`files`: the journey files
 * at the run's head). A run with no records (before the recorder), or whose report lacks a journey file at its head (a
 * lost shard), is not whole and is passed over. In a whole run, a journey file it ran with no record of its own is
 * full in the map (it runs with every change). The newest MIN_RUNS whole runs build it; fewer, and its mode is 'full'.
 */
export function buildMap({
  runs,
  services,
  consumers,
  dependents = {},
  harness,
  subscribers: subs,
  money,
  importers = null,
  built = [],
  computed = [],
  graph = null,
  baseline = null,
  minRuns = MIN_RUNS,
}) {
  const unbuilt = unbuiltSteps(baseline);
  const whole = [];
  const skipped = [];
  for (const r of runs) {
    const ran = reportFiles(r.report);
    const records = reportRecords(r.report);
    const lost = [...r.files].filter((f) => !ran.has(f));
    if (!records.length) skipped.push(`${r.id}: no journey-reach records (before the recorder)`);
    else if (lost.length) skipped.push(`${r.id}: its report lacks ${lost.length} journey file(s) at its head (a lost shard)`);
    else whole.push({ ...r, ran, records, tests: reportTests(r.report) });
    if (whole.length === minRuns) break;
  }
  const base = { v: MAP_VERSION, runs: whole.map(({ id, head, created }) => ({ id, head, created })), skipped };
  // A subscriber's handler is in its service's log only on a stack whose bus logs each delivery: every record says so.
  const busLogged = whole.length > 0 && whole.every((r) => r.records.every((x) => x.bus === true));
  if (whole.length < Math.max(minRuns, 1))
    return {
      ...base,
      mode: 'full',
      why: `built from ${whole.length} whole main run(s) holding records; it needs ${minRuns}, so every product change runs the full suite`,
    };
  // The file graph read at the newest run's head (customerImporters), so what main changed since is known (sinceMap).
  if (graph) ({ importers, built, computed } = graph(whole[0].head));
  const journeys = [...whole[0].files].sort();
  const reach = whole.map((r) => runReach(r.records, services));
  const full = {};
  const index = new Map(journeys.map((f, i) => [f, i]));
  const services_ = {};
  const packages = {};
  const customer = {};
  for (const f of journeys) {
    let why = null;
    let clean = 0;
    const union = { services: new Set(), packages: new Set(), customer: new Set() };
    const counts = speaksFor(whole, f, unbuilt);
    whole.forEach((r, i) => {
      if (why || !r.files.has(f)) return;
      const x = reach[i][f];
      if (!x) why = `run ${r.id} holds no record of it`;
      else if (x.full) why = `run ${r.id}: ${x.full}`;
      else if (!counts[i])
        return; // a test that didn't pass here stopped the journey short (speaksFor): a broken spec, a red test other than an
      // unbuilt step red in every run that holds the file, a skip with no such step before it, a red test another run
      // lacks or passed, or a red test of a file some whole run doesn't hold. This run can't speak for it.
      else {
        clean += 1;
        for (const k of Object.keys(union)) for (const v of x[k]) union[k].add(v);
      }
    });
    if (!why && !clean)
      why =
        "no run the map is built from speaks for it: in each, a spec held no test, or a test didn't pass that is not an unbuilt step of main's baseline (or skipped after one) red in every run, all of which hold the file";
    if (why) {
      full[f] = why;
      continue;
    }
    const i = index.get(f);
    for (const d of union.services) (services_[d] ??= []).push(i);
    for (const d of union.packages) (packages[d] ??= []).push(i);
    for (const d of union.customer) (customer[d] ??= []).push(i);
  }
  const sorted = (o) =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  return {
    ...base,
    mode: 'reach',
    journeys,
    full: sorted(full),
    services: sorted(services_),
    packages: sorted(packages),
    customer: sorted(customer),
    consumers: sorted(consumers),
    dependents: sorted(dependents),
    harness: [...harness].sort(),
    subscribers: [...subs].sort(),
    money: [...new Set([...(money ?? []), ...MONEY_SERVICES])].sort(),
    ...(busLogged ? { busLogged: true } : {}),
    // Who loads each customer file no run recorded (customerImporters), for pathReach; recorded files need none.
    ...(importers
      ? {
          importers: sorted(Object.fromEntries(Object.entries(importers).filter(([f]) => !Object.hasOwn(customer, f)))),
          built: [...built].sort(),
          computed: [...computed].sort(),
        }
      : {}),
  };
}

// ---- Using the map ----

/** The committed map (main's copy, beside this file), or null when it is missing or unreadable. */
export function loadMap(file = MAP_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** How many of main's finished full runs came after the map's newest run, from a list of the workflow's newest runs,
 *  or null when it can't be told: no list, or a list that doesn't reach back to the map's newest run (the count
 *  would be short). */
export function runsBehind(map, runs, repo = REPO) {
  const newest = map?.runs?.[0];
  const at = Date.parse(newest?.created ?? '');
  if (!Number.isFinite(at) || !Array.isArray(runs)) return null;
  if (!runs.some((r) => Date.parse(r?.created_at) <= at)) return null;
  return runs.filter(
    (r) =>
      isMainRun(r, repo) &&
      r.status === 'completed' &&
      !['cancelled', 'skipped'].includes(r.conclusion) &&
      Date.parse(r.created_at) > at &&
      r.id !== newest.id,
  ).length;
}

/** The workflow that builds the map after every green full run on main, and the artifact it uploads. */
export const MAP_WORKFLOW = 'journey-reach-map.yml';
export const MAP_ARTIFACT = 'journey-reach-map';

/**
 * Which build of the map speaks for main, from a list of MAP_WORKFLOW's runs: the newest one that succeeded (so its
 * verify step passed) and was started by main's own journeys run (`workflow_run`, which always runs the default
 * branch's workflow and skips its build for any other branch's run; a dispatch runs whatever ref it names, so it never
 * counts), in this repository, and was created no later than `before` (ms; the journeys run's own creation,
 * so its touch job and the seal pick the same build), or null. (Failure it prevents: on 9 Nov 2026 the committed map
 * was built from runs up to 8 Nov 20:39 UTC, and since nobody pays for a map pull request, every product pull request's
 * journeys ran all 33 shards from 18:00 UTC: the OG on project-state#1574, 23:51 UTC.) Pure.
 */
export function mapBuild(runs, { before = Infinity, repo = REPO } = {}) {
  return (
    (runs ?? [])
      .filter(
        (r) =>
          r?.status === 'completed' &&
          r?.conclusion === 'success' &&
          r?.head_branch === 'main' &&
          r?.head_repository?.full_name === repo &&
          r?.event === 'workflow_run' &&
          String(r?.path ?? '').endsWith(`/${MAP_WORKFLOW}`) &&
          Date.parse(r?.created_at) <= before,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
  );
}

/** Whether a map holds what mapProblem needs before its age: version, reach mode, enough runs, journeys. Pure. */
const usable = (m) =>
  m?.v === MAP_VERSION &&
  m?.mode === 'reach' &&
  Array.isArray(m?.runs) &&
  m.runs.length >= MIN_RUNS &&
  Number.isFinite(Date.parse(m.runs[0]?.created)) &&
  Array.isArray(m?.journeys) &&
  m.journeys.length > 0;

/** The map to use: the built one when it is usable and its newest run is newer than the committed map's, else the
 *  committed one (the fallback, so a build that can't be read never makes things worse). Pure. */
export function newerMap(built, committed) {
  if (!usable(built)) return committed;
  if (!usable(committed)) return built;
  return Date.parse(built.runs[0].created) > Date.parse(committed.runs[0].created) ? built : committed;
}

/**
 * The newest built map main's map workflow uploaded no later than `before` (mapBuild), or null when there is none or it
 * can't be read. `get(path)` returns the API's JSON, `raw(path)` an artifact zip's bytes (either may be async).
 */
export async function builtMap({ get, raw, before = Date.now(), repo = REPO }) {
  try {
    const runs = (await get(`/repos/${repo}/actions/workflows/${MAP_WORKFLOW}/runs?branch=main&status=success&per_page=100`))
      ?.workflow_runs;
    const run = mapBuild(runs, { before, repo });
    if (!run) return null;
    const art = ((await get(`/repos/${repo}/actions/runs/${run.id}/artifacts?name=${MAP_ARTIFACT}`))?.artifacts ?? []).find(
      (a) => a?.name === MAP_ARTIFACT && !a?.expired,
    );
    if (!art) return null;
    const dir = mkdtempSync(join(tmpdir(), 'reach-map-'));
    try {
      const zip = join(dir, 'a.zip');
      writeFileSync(zip, await raw(`/repos/${repo}/actions/artifacts/${art.id}/zip`));
      return JSON.parse(execFileSync('unzip', ['-p', zip, 'journey-reach-map.json'], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

/** Why the map can't be used at all, or null when it can. */
export function mapProblem(map, behind, mode = REACH_MAP_MODE) {
  if (mode !== 'reach') return `the touched-journeys map is switched off (REACH_MAP_MODE is '${mode}')`;
  if (!map) return 'the touched-journeys map is missing or unreadable';
  if (map.v !== MAP_VERSION) return `the touched-journeys map is version ${map.v}, not ${MAP_VERSION}`;
  if (map.mode !== 'reach') return `the touched-journeys map is full (${map.why ?? 'no reason given'})`;
  if (!Array.isArray(map.runs) || map.runs.length < MIN_RUNS) return `the touched-journeys map holds fewer than ${MIN_RUNS} runs`;
  if (!Array.isArray(map.journeys) || !map.journeys.length) return 'the touched-journeys map lists no journeys';
  if (behind === null || behind === undefined || !Number.isFinite(behind))
    return "how many main runs came after the touched-journeys map's newest run couldn't be read";
  if (behind > STALE_RUNS)
    return `the touched-journeys map is stale: ${behind} finished main runs came after its newest run (more than ${STALE_RUNS})`;
  return null;
}

/**
 * The journeys a customer source file no run recorded can reach: the recorded journeys of the files that load it, at the
 * head (see the header, apps/customer/src). `head` (what headWanted names, read at the head): { texts: Map(path -> text,
 * null when removed), based: Set of the unknown paths the pull request's merge base holds, dirs: Map(folder -> Set of
 * entry names) }, or null when it couldn't be read.
 */
function loadersReach(map, path, head) {
  const why = 'no journey was recorded running this customer source file';
  if (!map.importers || typeof map.importers !== 'object') return { full: why };
  const { texts, based, dirs } = head ?? {};
  if (!(texts instanceof Map) || !(based instanceof Set) || !(dirs instanceof Map))
    return { full: `${why}, and the files that load it at the head couldn't be read` };
  const known = (f) => Object.hasOwn(map.customer ?? {}, f) || Object.hasOwn(map.importers, f);
  // What runs in Node (the harness, the app's build) may have grown since the map: a file read at the head that runs
  // there and loads a customer file the map doesn't hold as run there may now run it in every journey.
  const inNode = new Set([...(map.harness ?? []), ...(map.built ?? [])].flatMap((h) => moduleKeys(h)));
  const nodeRuns = (g) => inNode.has(g) || (map.harness ?? []).some((h) => g.startsWith(`${h}/`)) || nodeRoot(g);
  for (const [g, t] of texts) {
    if (typeof t !== 'string' || !nodeRuns(g)) continue;
    const node = nodeTargets(t, g);
    if (node.any) return { full: `${why}, and ${g}, which runs in Node, builds a path it may load a customer file by` };
    const to = node.targets.find((x) => x.startsWith(CUSTOMER_DIR) && !inNode.has(x));
    if (to) return { full: `${why}, and ${g}, which runs in Node, loads ${to}, which the map doesn't hold as run there` };
  }
  const stem = (n) => (RESOLVED.includes(posix.extname(n)) ? n.slice(0, -posix.extname(n).length) : null);
  const out = new Set();
  const seen = new Set();
  const queue = [path];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (map.built?.includes(f)) return { full: `${why}, and Node code (the journey harness or the app's build) runs ${f}` };
    if (map.harness?.includes(f)) return { full: `${why}, and the journey harness imports ${f}` };
    const keys = new Set(moduleKeys(f));
    if (!known(f)) {
      // Unknown to the map: new in this pull request, or added on main after the map was built, when files the map
      // never read may load it.
      if (!texts.has(f) || based.has(f)) return { full: `${f} is newer than the map, so the files on main that load it are unknown` };
      const s = stem(posix.basename(f));
      const dir = dirs.get(posix.dirname(f));
      if (s !== null) {
        if (!(dir instanceof Set)) return { full: `${why}, and ${posix.dirname(f)} couldn't be listed at the head` };
        const twin = [...dir].find((n) => n !== posix.basename(f) && (n === s || stem(n) === s));
        const up = s === 'index' ? dirs.get(posix.dirname(posix.dirname(f))) : null;
        if (s === 'index' && !(up instanceof Set)) return { full: `${why}, and the folder above ${f} couldn't be listed at the head` };
        const upTwin = up ? [...up].find((n) => stem(n) === posix.basename(posix.dirname(f))) : null;
        if (twin || upTwin)
          return { full: `${f} is new and shares its import name with ${twin ?? upTwin}, so an unchanged import may now load it` };
      }
    }
    const from = new Set(map.importers[f] ?? []);
    // A customer file that loads what it doesn't spell may load any customer file, a new one too.
    for (const g of map.computed ?? []) if (g !== f) from.add(g);
    for (const [g, t] of texts) {
      if (typeof t !== 'string' || g === f) continue;
      if (importTargets(t, g).some((p) => keys.has(p)) || (g.startsWith(CUSTOMER_DIR) && COMPUTED_LOAD.test(t))) from.add(g);
    }
    const loaders = [...from].filter((g) => !isTest(g));
    if (!loaders.length) return { full: `${why}, and nothing but tests loads ${f} (an entry, or a file outside the app)` };
    for (const g of loaders) {
      if (!g.startsWith(CUSTOMER_DIR) || /\.html?$/.test(g)) return { full: `${why}, and ${g} loads ${f}, which no record covers` };
      if (map.built?.includes(g))
        return { full: `${why}, and Node code (the journey harness or the app's build) runs ${g}, which loads it` };
      if (map.harness?.includes(g)) return { full: `${why}, and the journey harness runs ${g}, which loads it` };
      const js = map.customer?.[g];
      if (js?.length) for (const j of js) out.add(j);
      else queue.push(g);
    }
  }
  return out.size ? { journeys: [...out].sort((a, b) => a - b) } : { full: why };
}

/**
 * The journeys a product path's recorded reach touches: { journeys: [index] } or { full: why }. `subscribesHere`:
 * whether the changed file, at the head, can add a bus subscription (subscribesVia). `head`: loadersReach's.
 */
export function pathReach(map, path, subscribesHere = false, head = null) {
  const p = String(path);
  const pkgOf = /^(packages\/[a-z0-9-]+)\//.exec(p)?.[1];
  if (map.harness?.includes(p) || (pkgOf && map.harness?.includes(pkgOf))) return { full: 'the journey harness imports it' };
  const svc = /^(services\/svc-[a-z0-9-]+)\//.exec(p)?.[1];
  // Money code narrows like any path (REVIEW.md's C4 entry, OWNER 249: no money process holds anything up before real
  // money; main's full run with a revert is the backstop). The map still lists it (`money`), for the record. Since
  // OWNER 297 (until launch hardening) the seal holds money code to no rule of its own either.
  if (svc) {
    if (subscribesHere)
      return {
        full: 'it subscribes to bus events, itself or through a file it imports, and a new subscription runs where no record shows',
      };
    if (map.subscribers?.includes(svc) && map.busLogged !== true)
      return { full: `${svc} subscribes to bus events, and a handler that logs nothing is recorded nowhere` };
    const js = map.services?.[svc];
    return js?.length ? { journeys: js } : { full: `no journey was recorded reaching ${svc}` };
  }
  if (p.startsWith('apps/customer/src/')) {
    const js = map.customer?.[p];
    return js?.length ? { journeys: js } : loadersReach(map, p, head);
  }
  const pkg = /^(packages\/[a-z0-9-]+)\//.exec(p)?.[1];
  if (pkg) {
    const cons = map.consumers?.[pkg];
    if (!cons) return { full: `the map doesn't know ${pkg}` };
    const unrecorded = cons.filter((d) => d !== 'apps/customer' && !SERVICE_DIR.test(d));
    if (unrecorded.length) return { full: `${unrecorded.join(', ')} depend(s) on ${pkg}, and no record covers them` };
    const out = new Set(map.packages?.[pkg] ?? []);
    if (cons.includes('apps/customer') && !map.packages?.[pkg])
      return { full: `the customer app depends on ${pkg}, and no record shows where its built code runs` };
    for (const d of cons) {
      if (map.subscribers?.includes(d) && map.busLogged !== true) return { full: `${d} depends on ${pkg} and subscribes to bus events` };
      for (const j of map.services?.[d] ?? []) out.add(j);
    }
    return out.size ? { journeys: [...out] } : { full: `no journey was recorded reaching ${pkg}` };
  }
  if (p.startsWith('apps/admin/')) return { full: 'the admin app, which no record covers' };
  return { full: 'a product path the map does not cover' };
}

/**
 * The journeys a set of product paths reaches: { mode: 'files', files, because } or { mode: 'full', why }. `atHead`:
 * the journey files at the head (a Set of names), or null when they can't be listed. `subscribes(path)`: pathReach's
 * `subscribesHere`; `head`: its `head`. Every journey the map can't speak for (its `full` journeys, and a journey file at the head it
 * doesn't know) is selected too, unless `unrecorded` is false (a named pull request: main's full run holds those, as
 * journey-touch.mjs says); a selection holding every journey at the head is the full run.
 */
export function reachSelect({
  map,
  paths,
  behind,
  atHead,
  subscribes = () => false,
  head = null,
  mode = REACH_MAP_MODE,
  unrecorded = true,
}) {
  const problem = mapProblem(map, behind, mode);
  if (problem) return { mode: 'full', why: problem };
  if (!(atHead instanceof Set)) return { mode: 'full', why: "the journey files at the head couldn't be listed" };
  const picked = new Set();
  const because = [];
  for (const p of paths) {
    let r;
    try {
      r = pathReach(map, p, subscribes(p), head);
    } catch (e) {
      r = { full: `its reach couldn't be worked out (${e.message})` };
    }
    if (r.full) return { mode: 'full', why: `${p}: ${r.full}` };
    for (const i of r.journeys) picked.add(map.journeys[i]);
    because.push(`${p}: ${r.journeys.length} journey file(s) reach it`);
  }
  const known = new Set(map.journeys);
  const always = unrecorded ? [...Object.keys(map.full ?? {}), ...[...atHead].filter((f) => !known.has(f))] : [];
  for (const f of always) picked.add(f);
  const files = [...picked].filter((f) => atHead.has(f)).sort();
  if (files.length >= atHead.size) return { mode: 'full', why: 'the recorded reach of what it changes holds every journey' };
  if (always.length) because.push(`${always.length} journey file(s) the map can't speak for run with every change`);
  return { mode: 'files', files, because };
}

// ---- The builder's I/O ----

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });

/** The journey files at a commit, from git (the commit must be fetched). */
export const filesAt = (sha, root = ROOT) =>
  new Set(
    execFileSync('git', ['ls-tree', '--name-only', `${sha}:${REAL_APP}`], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => JOURNEY_FILE.test(f)),
  );

/**
 * Which of a list of the workflow's runs the builder reads, newest first: main's finished full runs (not cancelled or
 * skipped), only those named in `ids` when given, and only those created no later than the run `until` (a run object,
 * which must itself be one of main's finished full runs) when given. Pure, for the tests.
 */
export function candidates(list, { ids, until, repo = REPO } = {}) {
  const at = until ? Date.parse(until.created_at) : Infinity;
  return (list ?? [])
    .filter((r) => isMainRun(r, repo) && r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion))
    .filter((r) => !ids || ids.includes(String(r.id)))
    .filter((r) => Date.parse(r.created_at) <= at)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** Main's finished full runs since the recorder, newest first: the candidates buildMap reads. With `until` (a run id),
 *  only the runs created up to that run, so a rebuild sees what the build saw then. */
function mainCandidates(ids, until) {
  let upTo = null;
  let window = '';
  if (until) {
    upTo = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${Number(until)}`]));
    if (!String(upTo.path ?? '').endsWith(`/${JOURNEYS_FILE}`) || !candidates([upTo], { repo: REPO }).length)
      throw new Error(`run ${until} is not one of main's finished full ${JOURNEYS_FILE} runs`);
    window = `&created=${encodeURIComponent(`<=${upTo.created_at}`)}`;
  }
  const list = JSON.parse(
    gh(['api', `repos/${REPO}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&status=completed&per_page=60${window}`]),
  );
  return candidates(list.workflow_runs, { ids, until: upTo });
}

/** Downloads a run's merged report into its own new temp folder and reads it; the folder is removed. */
function downloadReport(id) {
  const dir = mkdtempSync(join(tmpdir(), 'reach-map-'));
  try {
    gh(['run', 'download', String(id), '-R', REPO, '-n', 'real-app-journeys', '-D', dir]);
    return JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The map's keys read from the checkout's code rather than from the runs. */
const WORKSPACE_KEYS = new Set(['consumers', 'dependents', 'harness', 'subscribers', 'money']);

/** The map as the builder writes it: one line of JSON and a newline. */
export const mapText = (map) => `${JSON.stringify(map)}\n`;

/**
 * The map's inputs read from a checkout's code (WORKSPACE_KEYS, and the services the runs' reach is keyed by). `verify`
 * reads them from the pull request's checkout (`--workspace`) while the runs and the builder stay main's: a pull request
 * that adds a package, a money one included, then holds the map its own build writes (B1, #7724: main's workspaces made
 * the map differ in consumers, dependents and money, while tooling tests require the PR's money list).
 */
export function workspaceInputs(root = ROOT) {
  const ws = workspace(root);
  return {
    services: new Set(ws.dirs.filter((d) => SERVICE_DIR.test(d))),
    consumers: consumersOf(ws),
    dependents: dependentPackages(ws),
    harness: harnessImports(root, ws),
    subscribers: subscribers(root),
    money: [...moneyCodeDirs(manifestsAt(root))],
  };
}

/** Builds the map from main's runs (GH_TOKEN), as text: `ids` names the runs to read, `until` the newest run to read,
 *  `root` the checkout whose code gives the workspace inputs (workspaceInputs; this checkout by default). */
function buildFromMain({ ids, until, root = ROOT } = {}) {
  const inputs = workspaceInputs(root);
  const runs = [];
  let whole = 0;
  for (const r of mainCandidates(ids, until)) {
    let files;
    try {
      execFileSync('git', ['cat-file', '-e', `${r.head_sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
      files = filesAt(r.head_sha);
    } catch {
      console.error(`run ${r.id}: its head ${r.head_sha} isn't fetched here; passed over`);
      continue;
    }
    const report = downloadReport(r.id);
    if (!report) {
      console.error(`run ${r.id}: its report couldn't be downloaded; passed over`);
      continue;
    }
    runs.push({ id: r.id, head: r.head_sha, created: r.created_at, report, files });
    const records = reportRecords(report).length;
    if (records === 0) break; // older runs come before the recorder
    // buildMap reads no further than MIN_RUNS whole runs, so nothing older needs downloading (its test of whole).
    const ran = reportFiles(report);
    if ([...files].every((f) => ran.has(f)) && ++whole === MIN_RUNS) break;
  }
  return buildMap({
    runs,
    ...inputs,
    // The file graph is main's at the newest whole run's head (fetched here, as filesAt above needs), whatever the checkout.
    graph: (sha) => customerImporters(ROOT, sha),
    // main's baseline, never the pull request's: `verify` runs main's builder from a worktree of main (ROOT), and the code
    // keys alone follow `--workspace`, so a pull request can't edit the baseline to narrow what its map selects.
    baseline: rootInputs(ROOT).baseline,
  });
}

/**
 * Whether a committed map is exactly what the builder builds from main's runs up to the newest run it names (review
 * 7561-R1 #2): { ok: true } or { ok: false, why }. `rebuild(until)` returns the rebuilt map's text. A map that can't be
 * read, or names no run, can't be rebuilt, so it fails. A difference names the top-level keys that differ, never their
 * values.
 */
export function verifyMap(text, rebuild) {
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the map is not JSON' };
  }
  const until = map?.runs?.[0]?.id;
  if (!Number.isInteger(until)) return { ok: false, why: 'the map names no run, so it cannot be rebuilt' };
  let built;
  try {
    built = rebuild(until);
  } catch (e) {
    return { ok: false, why: `the map couldn't be rebuilt (${String(e?.message ?? e).split('\n')[0]})` };
  }
  if (built === text) return { ok: true };
  let other = null;
  try {
    other = JSON.parse(built);
  } catch {
    /* compared as text below */
  }
  const keys = other
    ? [...new Set([...Object.keys(map), ...Object.keys(other)])].filter((k) => JSON.stringify(map[k]) !== JSON.stringify(other[k]))
    : [];
  // Only key names main's builder writes reach the log: a key only the pull request's map holds is its own text, so it is
  // counted, never printed (review 7578-R1 #1).
  const named = keys.filter((k) => Object.hasOwn(other ?? {}, k));
  const extra = keys.length - named.length;
  const list = [...named, ...(extra ? [`${extra} key(s) main's builder never writes`] : [])].join(', ');
  return {
    ok: false,
    why: keys.length
      ? `the map differs from the one built from main's runs up to run ${until} in: ${list}${
          keys.every((k) => WORKSPACE_KEYS.has(k)) ? " (only what main's code holds: main moved since it was built, so rebuild it)" : ''
        }`
      : `the map is not byte for byte the one built from main's runs up to run ${until} (its layout differs)`,
  };
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  if (cmd === 'show') {
    const map = loadMap(opt('--map') ?? MAP_FILE);
    if (!map) return console.log('no map');
    console.log(`mode ${map.mode}${map.why ? ` (${map.why})` : ''}; runs ${(map.runs ?? []).map((r) => r.id).join(', ') || 'none'}`);
    if (map.mode === 'reach')
      console.log(
        `${map.journeys.length} journeys, ${Object.keys(map.full).length} full; ${Object.keys(map.services).length} services, ${Object.keys(map.packages).length} packages, ${Object.keys(map.customer).length} customer files`,
      );
    for (const s of map.skipped ?? []) console.log(`  passed over: ${s}`);
    return;
  }
  if (cmd === 'verify') {
    const file = opt('--map') ?? MAP_FILE;
    const root = opt('--workspace') ? resolve(opt('--workspace')) : ROOT;
    const r = verifyMap(readFileSync(file, 'utf8'), (until) => mapText(buildFromMain({ until, root })));
    console.log(r.ok ? `ok: ${file} is the map main's builder builds from the runs it names` : `FAIL: ${r.why}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd !== 'build') {
    console.error(
      'usage: journey-reach-map.mjs build [--runs <id,id,id>] [--until <run id>] [--out <file>] | verify [--map <file>] [--workspace <checkout>] | show [--map <file>]',
    );
    process.exit(2);
  }
  const map = buildFromMain({ ids: opt('--runs')?.split(',').filter(Boolean), until: opt('--until') });
  writeFileSync(opt('--out') ?? MAP_FILE, mapText(map));
  console.log(
    map.mode === 'reach' ? `map built from runs ${map.runs.map((r) => r.id).join(', ')}` : `refused: ${map.why}; the map written is full`,
  );
  for (const s of map.skipped) console.log(`  passed over: ${s}`);
  if (map.mode !== 'reach') process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
