#!/usr/bin/env node
// The call-records codemod over every service at once, report only: per service and per reason, what it would move and
// what it would leave, so each kind of gap is fixed once in the script before any service is run for real.
//
//   node tooling/codemod/call-records/report.mjs [--deep] [--out report.json]
//
// Every finding of `garden/no-call-by-name` is one site the codemod finds, and each site is counted once, under the
// service its call names: planned (a TypeScript router, or a door the Rust crate serves, its router read from the commit
// before it was deleted), refused (its port in flight, or its plan failed: the reason and the count), or named by why it
// has no service run (no service of that name; no service named at all). The totals add up to the rule's count, with
// `wrapperSenders` for a wrapper whose sender the rule counts once where the codemod finds each caller.
//
// Without --deep it only plans (index.mjs without --write): `planned` is what the plan rewrites, before the run's own
// export, samples and type checks, so it is not what a run moves. With --deep each planned service is run for real
// (run.mjs, the very steps a service's run takes), one at a time: `wouldMove` is what that run moved and `left` names each
// call it left, with the export's own reason (.refine, transform, regex lookaround, ...); then the apps are typechecked
// and the secret scan run over what it wrote, and the checkout is put back exactly as it was before the next service. It
// starts only on a clean tree, as run.mjs does.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { portInFlight } from './index.mjs';
import { findSites } from './sites.mjs';
import { toolShape } from './tool-forms.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const here = (f) => join(REPO, 'tooling/codemod/call-records', f);
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

/** One hand reason, as a kind a single change to the script (or one product decision) can close. */
export function reasonOf(why) {
  const rules = [
    [/no refusal reader this file can import/, 'service has no exported refusal reader (one file per service)'],
    [/which depends on @intafaced\/contracts, so contracts can't import it/, 'schema from a package that depends on contracts (it stays)'],
    [/comes from @intafaced\/[a-z-]+, wh|is not declared/, 'answer or input schema from another package or generic'],
    [/named by a template/, 'service or call named by a template'],
    [/has a record form its callers move to one by one/, 'tool kept while a caller is left (each caller named under its own reason)'],
    [
      /call name passed through a wrapper|another caller of its wrapper|but its wrapper/,
      'wrapper that takes its call name (named, with its reason)',
    ],
    [/sends one input value to \d+ records/, 'one input sent to each of a closed set of calls'],
    [/builds the schema/, "schema built by the caller's own function"],
    [/own schema checks the answer/, 'caller schema checks the answer (.refine and the like)'],
    [/no accepted input found|no refused input/, 'no sample inputs'],
    [/can't be exported|cannot be exported/, exportReason],
    [/has no procedure/, 'procedure the codemod cannot find'],
    [/two procedures under one path/, 'two procedures under one path (a switch router)'],
    [/clashes with another/, 'helper name clash (a rerun places it)'],
    [/is not a declaration in/, 'helper the closure cannot follow'],
    [/scopedProcedure with a scope or options/, 'scopedProcedure scope or options a record cannot copy'],
    [/guard \S+ kept by hand/, 'guard kept by hand (named, with its reason)'],
    [/guard .*chained/, 'guard chained with .use()'],
    [/guard /, 'guard a record cannot name'],
    [/no \.output\(\)/, 'no answer schema in the router'],
    [/takes no input|as a (query|mutation)/, 'caller disagrees with the router (input or kind)'],
    [/already exports|mounted from a record/, 'record name or file clash'],
  ];
  const kind = rules.find(([re]) => re.test(why))?.[1] ?? 'other';
  return typeof kind === 'function' ? kind(why) : kind;
}

/** The constructs the export refused, each named once in a fixed order (one script change closes each). */
const EXPORT_CONSTRUCTS = [
  [/\.refine\/\.superRefine/, '.refine'],
  [/transform \(a value computed/, 'transform'],
  [/uses lookaround or backreferences/, 'regex lookaround'],
  [/z\.lazy/, 'z.lazy'],
  [/Date object/, 'Date'],
  [/z\.unknown|z\.any/, 'z.unknown or z.any'],
  [/optional root/, 'optional root'],
];
function exportReason(why) {
  const found = EXPORT_CONSTRUCTS.filter(([re]) => re.test(why)).map(([, name]) => name);
  return `record can't be exported as written${found.length ? `: ${found.join(' + ')}` : ''}`;
}

/**
 * What the rule counts beyond the sites for wrappers that take their call name (wrapper.mjs): the codemod finds one site
 * per caller, while the rule counts the wrapper's sender once, and a caller only where it names the call in a property
 * (`procedure: 'x.y'`). The sum over wrappers of (rule findings - sites), negative when callers pass plain strings.
 */
export function wrapperSenders(sites) {
  const by = new Map();
  for (const s of sites) {
    if (!s.wrapper) continue;
    const w = by.get(s.wrapper.key) ?? by.set(s.wrapper.key, { sites: 0, findings: 1 }).get(s.wrapper.key);
    w.sites += 1;
    if (s.node?.type === 'Property') w.findings += 1;
  }
  return [...by.values()].reduce((a, w) => a + w.findings - w.sites, 0);
}

/**
 * The sites the rule does not count: a tool's caller that names its call bare (`query('x.y', ...)` taken from the portal's
 * tools, `validatedMutation(pay, 'x.y', ...)`; tool-forms.mjs). The rule counts the tool's own sender, its caller none.
 */
const toolCallers = (sites) => [...sites].filter((s) => toolShape(s)).length;

/** The commit that deleted services/<service>: its parent holds the router a door's records are read from. */
const deletedAt = (service) => git('log', '--diff-filter=D', '-1', '--format=%H', '--', `services/${service}/src/router.ts`).trim();

/**
 * How one service is planned: `{ door, fromRev }` for a service the Rust door serves now (crates/<service>, its
 * TypeScript deleted), `{}` for a TypeScript router, `{ refused }` for one the codemod will not run on, or undefined when
 * no service has that name.
 */
export function howToPlan(service, root = REPO, deleted = deletedAt) {
  const inFlight = portInFlight(service, root);
  if (inFlight) return { refused: inFlight };
  if (existsSync(join(root, 'services', service, 'src/router.ts')) || existsSync(join(root, 'services', service, 'src/index.ts')))
    return {};
  if (existsSync(join(root, 'crates', service, 'src/door/calls.rs'))) {
    const rev = deleted(service);
    return rev
      ? { door: `crates/${service}`, fromRev: `${rev}^` }
      : { refused: `crates/${service} has a door but git has no commit deleting services/${service}` };
  }
  return undefined;
}

const services = () =>
  readdirSync(join(REPO, 'services'))
    .filter((d) => d.startsWith('svc-'))
    .concat(readdirSync(join(REPO, 'crates')).filter((d) => d.startsWith('svc-')))
    .filter((d, i, all) => all.indexOf(d) === i)
    .filter((d) => howToPlan(d) !== undefined)
    .sort();

function plan(service, write, how = howToPlan(service) ?? {}) {
  const door = how.door ? ['--door', how.door, '--from-rev', how.fromRev] : [];
  const json = join(tmpdir(), `call-records-report-${process.pid}-${service}.json`);
  const run = spawnSync(
    'node',
    [here('index.mjs'), '--module', service.slice(4), '--service', service, '--json', json, ...door, ...(write ? ['--write'] : [])],
    {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (run.status !== 0) return { error: (run.stderr || run.stdout).split('\n').find((l) => /Error/.test(l)) ?? `exit ${run.status}` };
  return JSON.parse(readFileSync(json, 'utf8'));
}

const count = (rows) => rows.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

const putBack = () => {
  git('checkout', '--', 'apps', 'services', 'packages/contracts');
  git('clean', '-fdq', '--', 'apps', 'services', 'packages/contracts/src', 'packages/contracts/procedures');
};

/**
 * Each planned service run for real (run.mjs), one at a time, and put back: what it moved, what it left and why, the
 * type errors in the apps after its run (in files it touched, or not), and the credential-shaped literals it wrote.
 * `runOne` and `checkOne` are the run and the checks after it (tests plant them).
 */
export function deep(rows, runOne = runService, checkOne = checksAfter, restore = putBack) {
  for (const row of rows) {
    if (!row.planned) continue;
    try {
      const s = runOne(row);
      if (s.error) {
        row.runError = s.error;
        row.wouldMove = 0;
        continue;
      }
      row.wouldMove = s.rewritten;
      row.records = s.records;
      row.left = count(s.hand.map((h) => reasonOf(h.why)));
      Object.assign(row, checkOne());
    } finally {
      restore();
    }
  }
}

function runService(row) {
  const json = join(tmpdir(), `call-records-report-run-${process.pid}-${row.service}.json`);
  const door = row.door ? ['--door', row.door, '--from-rev', row.fromRev] : [];
  const r = spawnSync('node', [here('run.mjs'), '--module', row.service.slice(4), '--service', row.service, ...door, '--summary', json], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || !existsSync(json))
    return { error: `${r.stderr}\n${r.stdout}`.split('\n').find((l) => /^\w*Error: /.test(l)) ?? `exit ${r.status}` };
  return JSON.parse(readFileSync(json, 'utf8'));
}

function checksAfter() {
  const touched = new Set(
    git('status', '--porcelain', '--', 'apps')
      .split('\n')
      .map((l) => l.slice(3))
      .filter(Boolean),
  );
  let typeErrors = 0;
  let untouchedTypeErrors = 0;
  for (const app of readdirSync(join(REPO, 'apps'))) {
    if (!existsSync(join(REPO, 'apps', app, 'tsconfig.json'))) continue;
    const r = spawnSync('node', [join(REPO, 'tooling', 'scripts', 'tsc.mjs'), '--noEmit', '-p', '.'], {
      cwd: join(REPO, 'apps', app),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /^([^(]+)\(\d+,\d+\): error TS/.exec(line);
      if (!m) continue;
      if (touched.has(`apps/${app}/${m[1]}`)) typeErrors++;
      else untouchedTypeErrors++;
    }
  }
  // Credential-shaped literals the secret scan finds (stderr: the known-disclosed list on stdout is not the codemod's).
  const scan = spawnSync('node', ['tooling/ci/secret-scan.mjs'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secretLiterals = (scan.stderr ?? '')
    .split('\n')
    .filter((line) => /^\s+\[[^\]]+\] (packages\/contracts\/|apps\/|services\/)/.test(line)).length;
  return { typeErrors, untouchedTypeErrors, secretLiterals };
}

function main() {
  const argv = process.argv.slice(2);
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
  const dirty = git('status', '--porcelain', '--', 'apps', 'services', 'packages/contracts').trim();
  if (argv.includes('--deep') && dirty) {
    console.error(`commit or put back these first, so the report can put back exactly what it wrote:\n${dirty}`);
    process.exit(1);
  }
  // Each site the rule counts, once (a call named by a `? :` or a closed set is one finding, and one site per value).
  const nodes = new Map();
  for (const s of findSites(REPO)) if (!nodes.has(s.node)) nodes.set(s.node, s);
  const named = count([...nodes.values()].map((s) => s.module ?? ''));
  const rows = services().map((service) => {
    const how = howToPlan(service);
    const found = named[service.slice(4)] ?? 0;
    if (how.refused) return { service, sites: found, refused: how.refused };
    // A door with no caller left by name: nothing to plan (its crate need not be indexed).
    if (how.door && !found) return { service, door: how.door, sites: 0, planned: 0, records: 0, left: {} };
    const s = plan(service, false, how);
    // No tRPC router to read (svc-edge, svc-fix, svc-ws; svc-matching serves REST): no app calls it by name.
    if (s.error && /no src\/router\.ts|no create\*Router function/.test(s.error)) return { service, sites: found, noTrpcRouter: true };
    if (s.error) return { service, sites: found, error: s.error };
    return {
      service,
      ...(how.door ? { door: how.door, fromRev: how.fromRev } : {}),
      sites: s.sites,
      planned: s.rewritten,
      records: s.records.length,
      left: count(s.hand.map((h) => reasonOf(h.why))),
    };
  });
  // Sites no service run sees, each kind named: a module no service has, or no module named at all.
  const planned = new Set(rows.map((r) => r.service.slice(4)));
  const noService = {};
  for (const s of nodes.values()) {
    if (s.module && planned.has(s.module)) continue;
    const why = s.module
      ? `names a call where the service goes, which no service is (a client bound to one service, given the call's name first: "${s.module}")`
      : `names no service: ${s.problem ?? s.shape}`;
    noService[why] = (noService[why] ?? 0) + 1;
  }
  // A checkout without its install (`pnpm install`) can't load the parser: every plan fails, and the totals would read 0.
  const failed = rows.filter((r) => r.error && !r.noTrpcRouter);
  if (failed.length === rows.length || failed.length > rows.length / 2) {
    console.error(`the codemod could not plan ${failed.length} of ${rows.length} services (run \`pnpm install\` first):`);
    for (const r of failed.slice(0, 5)) console.error(`  ${r.service}: ${r.error}`);
    process.exit(1);
  }
  if (argv.includes('--deep')) deep(rows);
  const totals = { sites: 0, planned: 0, ...(argv.includes('--deep') ? { wouldMove: 0 } : {}), left: {}, refused: {}, noService };
  for (const r of rows) {
    if (r.refused || r.error) {
      totals.refused[r.service] = { sites: r.sites, why: r.refused ?? r.error };
      continue;
    }
    totals.sites += r.sites ?? 0;
    totals.planned += r.planned ?? 0;
    if ('wouldMove' in totals) totals.wouldMove += r.wouldMove ?? 0;
    for (const [k, n] of Object.entries(r.left ?? {})) totals.left[k] = (totals.left[k] ?? 0) + n;
  }
  // Every finding the rule counts, by the shape it names, so what no service run sees is counted too.
  const ox = spawnSync(
    join(REPO, 'node_modules/.bin/oxlint'),
    ['-c', join(REPO, '.oxlintrc.json'), '--format', 'json', 'apps', 'packages'],
    {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  if (ox.status !== 0 && ox.status !== 1) {
    console.error(`oxlint did not run (exit ${ox.status}): ${(ox.stderr || '').split('\n')[0]}`);
    process.exit(1);
  }
  const shapes = {};
  for (const d of JSON.parse(ox.stdout || '{"diagnostics":[]}').diagnostics ?? []) {
    if (!/no-call-by-name/.test(d.code ?? '')) continue;
    const k =
      /^`([^`]+)`/.exec(d.message)?.[1] ?? (/keyed by the call's name/.test(d.message) ? 'hand schema keyed by a call name' : 'other');
    shapes[k] = (shapes[k] ?? 0) + 1;
  }
  totals.ruleFindings = Object.values(shapes).reduce((a, b) => a + b, 0);
  totals.byShape = shapes;
  const refusedSites = Object.values(totals.refused).reduce((a, r) => a + r.sites, 0);
  const noServiceSites = Object.values(noService).reduce((a, b) => a + b, 0);
  totals.wrapperSenders = wrapperSenders(nodes.values());
  totals.toolCallers = toolCallers(nodes.values());
  // What the rule counts and no row above names: 0 when every finding is a site the codemod finds.
  totals.unnamed = totals.ruleFindings - totals.sites - refusedSites - noServiceSites - totals.wrapperSenders + totals.toolCallers;
  const report = { at: new Date().toISOString(), head: git('rev-parse', 'HEAD').trim(), totals, services: rows };
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ totals }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
