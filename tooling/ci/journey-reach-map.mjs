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
 *     harness: [dir], subscribers: [service dir], money: [dir] }
 * Built (buildMap) only from main's full runs that are whole: every journey file at the run's head in its report, and a
 * record for each. A journey whose record is incomplete (a reason code, or an afterAll record that never came) or that
 * has no record in a run where it existed reaches everything: it runs for every product change. With fewer than
 * MIN_RUNS whole runs the builder refuses: it writes a map whose mode is 'full', and nothing narrows.
 * A journey's reach comes only from the runs where every one of its tests passed (a failed step stops it short); with
 * no such run it reaches everything. Open edge, not covered: a service that publishes an event from background work
 * without logging while a journey runs is not tied to the journey that sees the subscriber's effect (review 7561-R1 #3;
 * subscribers are full). Before the first 'reach' map merges, CI should rebuild it from the run ids it names and
 * compare it byte for byte (review 7561-R1 #2, with the rebuild follow-up).
 *
 * What a product path selects (reachSelect), else the full suite:
 *   - services/svc-x/…: the journeys whose stack log shows svc-x served or logged while they ran. Full when no journey
 *     reached it, when svc-x subscribes to bus events (a handler that logs nothing is recorded nowhere), or when the
 *     changed file itself subscribes;
 *   - apps/customer/src/…: the journeys whose pages ran a function of that file or loaded a built script holding it.
 *     Full when no journey reached it (a new file, a style sheet, a file the build doesn't map);
 *   - packages/x/…: the journeys whose pages ran its built code (the customer bundles `packages/x/dist`, read back to
 *     the package) and the journeys that reached a service depending on it. Full when the package is not in the map,
 *     when an app no record covers depends on it (apps/admin, apps/mobile, apps/invitation), when the journey harness
 *     imports it (tooling/scripts, the real-app helpers: every journey runs it), or when it reaches no journey;
 *   - any other product path (apps/admin, other apps, apps/customer outside src): full.
 * Every journey the map can't speak for runs too: the map's `full` journeys and a journey file at the head the map
 * doesn't know. A selection holding every journey is the full run. The whole map is off, and every product change
 * full, when REACH_MAP_MODE is 'full', the map is missing, unreadable, of another version or built from fewer than
 * MIN_RUNS runs, or when more than STALE_RUNS of main's finished full runs came after its newest run (or that count
 * can't be read).
 *
 *   node tooling/ci/journey-reach-map.mjs build [--runs <id,id,id>] [--out <file>]   (GH_TOKEN; writes the map)
 *   node tooling/ci/journey-reach-map.mjs show                                         (what the committed map holds)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainRun, manifestsAt, moneyCodeDirs } from './journey-verdict.mjs';

/**
 * The off switch: 'full' sends every product change to the full suite, whatever the map says. 'reach' uses the map.
 * It ships 'full' (the CI review on b26447ca): narrowing turns on only in a reviewed code change, once a map built from
 * MIN_RUNS whole runs is committed and REVIEW.md records the owner's decision for it, never by a data-only map commit.
 */
export const REACH_MAP_MODE = 'full';
/** Money code beyond moneyCodeDirs (journey-verdict.mjs): the ledger service itself. */
export const MONEY_SERVICES = ['services/svc-ledger'];
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
 * The journey files a report ran that did not pass whole: a test with no result, or whose last result is not `passed`
 * (failed, timedOut, interrupted, skipped). A failed step stops its journey, so its record holds less than the journey
 * reaches (review 7561-R1): buildMap takes a file's reach only from runs where it passed whole. Returns a Set of names.
 */
export function reportUnclean(report) {
  const bad = new Set();
  const walk = (s, file) => {
    const here = s.file ?? file;
    for (const sp of s.specs ?? []) {
      const f = String(sp.file ?? here ?? '')
        .split('/')
        .pop();
      if (!JOURNEY_FILE.test(f)) continue;
      const tests = sp.tests ?? [];
      if (!tests.length || tests.some((t) => (t.results ?? []).at(-1)?.status !== 'passed')) bad.add(f);
    }
    for (const c of s.suites ?? []) walk(c, here);
  };
  for (const s of report?.suites ?? []) walk(s, s.file);
  return bad;
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
export function buildMap({ runs, services, consumers, harness, subscribers: subs, money, minRuns = MIN_RUNS }) {
  const whole = [];
  const skipped = [];
  for (const r of runs) {
    const ran = reportFiles(r.report);
    const records = reportRecords(r.report);
    const lost = [...r.files].filter((f) => !ran.has(f));
    if (!records.length) skipped.push(`${r.id}: no journey-reach records (before the recorder)`);
    else if (lost.length) skipped.push(`${r.id}: its report lacks ${lost.length} journey file(s) at its head (a lost shard)`);
    else whole.push({ ...r, ran, records, unclean: reportUnclean(r.report) });
    if (whole.length === minRuns) break;
  }
  const base = { v: MAP_VERSION, runs: whole.map(({ id, head, created }) => ({ id, head, created })), skipped };
  if (whole.length < Math.max(minRuns, 1))
    return {
      ...base,
      mode: 'full',
      why: `built from ${whole.length} whole main run(s) holding records; it needs ${minRuns}, so every product change runs the full suite`,
    };
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
    whole.forEach((r, i) => {
      if (why || !r.files.has(f)) return;
      const x = reach[i][f];
      if (!x) why = `run ${r.id} holds no record of it`;
      else if (x.full) why = `run ${r.id}: ${x.full}`;
      else if (r.unclean.has(f))
        return; // a step that didn't pass stopped the journey short: this run can't speak for it
      else {
        clean += 1;
        for (const k of Object.keys(union)) for (const v of x[k]) union[k].add(v);
      }
    });
    if (!why && !clean) why = 'no run the map is built from passed every one of its tests';
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
    harness: [...harness].sort(),
    subscribers: [...subs].sort(),
    money: [...new Set([...(money ?? []), ...MONEY_SERVICES])].sort(),
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

/** Why the map can't be used at all, or null when it can. */
export function mapProblem(map, behind, mode = REACH_MAP_MODE) {
  if (mode !== 'reach') return `the touched-journeys map is switched off (REACH_MAP_MODE is '${mode}')`;
  if (!map) return 'the touched-journeys map is missing or unreadable';
  if (map.v !== MAP_VERSION) return `the touched-journeys map is version ${map.v}, not ${MAP_VERSION}`;
  if (map.mode !== 'reach') return `the touched-journeys map is full (${map.why ?? 'no reason given'})`;
  if (!Array.isArray(map.runs) || map.runs.length < MIN_RUNS) return `the touched-journeys map holds fewer than ${MIN_RUNS} runs`;
  if (!Array.isArray(map.journeys) || !map.journeys.length) return 'the touched-journeys map lists no journeys';
  if (!Array.isArray(map.money) || !map.money.length) return 'the touched-journeys map lists no money code';
  if (behind === null || behind === undefined || !Number.isFinite(behind))
    return "how many main runs came after the touched-journeys map's newest run couldn't be read";
  if (behind > STALE_RUNS)
    return `the touched-journeys map is stale: ${behind} finished main runs came after its newest run (more than ${STALE_RUNS})`;
  return null;
}

/**
 * The journeys a product path's recorded reach touches: { journeys: [index] } or { full: why }. `subscribesHere`:
 * whether the changed file itself, at the head, calls the bus's subscribe.
 */
export function pathReach(map, path, subscribesHere = false) {
  const p = String(path);
  const pkgOf = /^(packages\/[a-z0-9-]+)\//.exec(p)?.[1];
  if (map.harness?.includes(p) || (pkgOf && map.harness?.includes(pkgOf))) return { full: 'the journey harness imports it' };
  const svc = /^(services\/svc-[a-z0-9-]+)\//.exec(p)?.[1];
  // Money code always runs the full suite (AGENTS.md "How work flows" 8: packages/ledger-client, its direct dependents,
  // svc-edge, svc-ops, svc-protocol, svc-fix; and svc-ledger), and so does a package money code depends on.
  const money = Array.isArray(map.money) ? map.money : null;
  if (!money) return { full: 'the map lists no money code' };
  if ((svc && money.includes(svc)) || (pkgOf && money.includes(pkgOf))) return { full: 'money code, which always runs the full suite' };
  if (pkgOf && (map.consumers?.[pkgOf] ?? []).some((d) => money.includes(d)))
    return { full: `money code depends on ${pkgOf}, and money code always runs the full suite` };
  if (svc) {
    if (subscribesHere) return { full: 'it subscribes to bus events, and a handler that logs nothing is recorded nowhere' };
    if (map.subscribers?.includes(svc))
      return { full: `${svc} subscribes to bus events, and a handler that logs nothing is recorded nowhere` };
    const js = map.services?.[svc];
    return js?.length ? { journeys: js } : { full: `no journey was recorded reaching ${svc}` };
  }
  if (p.startsWith('apps/customer/src/')) {
    const js = map.customer?.[p];
    return js?.length ? { journeys: js } : { full: 'no journey was recorded running this customer source file' };
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
      if (map.subscribers?.includes(d)) return { full: `${d} depends on ${pkg} and subscribes to bus events` };
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
 * `subscribesHere`. Every journey the map can't speak for (its `full` journeys, and a journey file at the head it
 * doesn't know) is selected too; a selection holding every journey at the head is the full run.
 */
export function reachSelect({ map, paths, behind, atHead, subscribes = () => false, mode = REACH_MAP_MODE }) {
  const problem = mapProblem(map, behind, mode);
  if (problem) return { mode: 'full', why: problem };
  if (!(atHead instanceof Set)) return { mode: 'full', why: "the journey files at the head couldn't be listed" };
  const picked = new Set();
  const because = [];
  for (const p of paths) {
    let r;
    try {
      r = pathReach(map, p, subscribes(p));
    } catch (e) {
      r = { full: `its reach couldn't be worked out (${e.message})` };
    }
    if (r.full) return { mode: 'full', why: `${p}: ${r.full}` };
    for (const i of r.journeys) picked.add(map.journeys[i]);
    because.push(`${p}: ${r.journeys.length} journey file(s) reach it`);
  }
  const known = new Set(map.journeys);
  const always = [...Object.keys(map.full ?? {}), ...[...atHead].filter((f) => !known.has(f))];
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

/** Main's finished full runs since the recorder, newest first: the candidates buildMap reads. */
function mainCandidates(ids) {
  const list = JSON.parse(gh(['api', `repos/${REPO}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&status=completed&per_page=60`]));
  return (list.workflow_runs ?? [])
    .filter((r) => isMainRun(r, REPO) && !['cancelled', 'skipped'].includes(r.conclusion))
    .filter((r) => !ids || ids.includes(String(r.id)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
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
  if (cmd !== 'build') {
    console.error('usage: journey-reach-map.mjs build [--runs <id,id,id>] [--out <file>] | show [--map <file>]');
    process.exit(2);
  }
  const ids = opt('--runs')?.split(',').filter(Boolean);
  const ws = workspace();
  const services = new Set(ws.dirs.filter((d) => SERVICE_DIR.test(d)));
  const runs = [];
  for (const r of mainCandidates(ids)) {
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
    if (reportRecords(report).length === 0) break; // older runs come before the recorder
  }
  const map = buildMap({
    runs,
    services,
    consumers: consumersOf(ws),
    harness: harnessImports(ROOT, ws),
    subscribers: subscribers(),
    money: [...moneyCodeDirs(manifestsAt(ROOT))],
  });
  writeFileSync(opt('--out') ?? MAP_FILE, `${JSON.stringify(map)}\n`);
  console.log(
    map.mode === 'reach' ? `map built from runs ${map.runs.map((r) => r.id).join(', ')}` : `refused: ${map.why}; the map written is full`,
  );
  for (const s of map.skipped) console.log(`  passed over: ${s}`);
  if (map.mode !== 'reach') process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
