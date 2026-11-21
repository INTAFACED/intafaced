#!/usr/bin/env node
// The call-records codemod over every service at once, report only: per service and per reason, what it would move and
// what it would leave, so each kind of gap is fixed once in the script before any service is run for real.
//
//   node tooling/codemod/call-records/report.mjs [--deep] [--out report.json]
//
// Without --deep it only plans (index.mjs without --write). With --deep it also writes every service's records into
// this checkout, builds contracts, runs the samples step, typechecks the apps and runs the secret scan, then puts the
// checkout back exactly as it was. It starts only on a clean tree, as run.mjs does.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const here = (f) => join(REPO, 'tooling/codemod/call-records', f);
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

/** One hand reason, as a kind a single change to the script (or one product decision) can close. */
export function reasonOf(why) {
  const rules = [
    [/no refusal reader this file can import/, 'service has no exported refusal reader (one file per service)'],
    [/comes from @intafaced\/[a-z-]+, wh|is not declared/, 'answer or input schema from another package or generic'],
    [/named by a template/, 'service or call named by a template'],
    [/builds the schema/, "schema built by the caller's own function"],
    [/own schema checks the answer/, 'caller schema checks the answer (.refine and the like)'],
    [/no accepted input found|no refused input/, 'no sample inputs'],
    [/can't be exported|cannot be exported/, "record can't be exported as written"],
    [/has no procedure/, 'procedure the codemod cannot find'],
    [/clashes with another/, 'helper name clash (a rerun places it)'],
    [/is not a declaration in/, 'helper the closure cannot follow'],
    [/scopedProcedure with a scope or options/, 'scopedProcedure scope or options a record cannot copy'],
    [/guard .*chained/, 'guard chained with .use()'],
    [/guard /, 'guard a record cannot name'],
    [/no \.output\(\)/, 'no answer schema in the router'],
    [/takes no input|as a (query|mutation)/, 'caller disagrees with the router (input or kind)'],
    [/already exports|mounted from a record/, 'record name or file clash'],
  ];
  return rules.find(([re]) => re.test(why))?.[1] ?? 'other';
}

const services = () =>
  readdirSync(join(REPO, 'services'))
    .filter(
      (d) =>
        d.startsWith('svc-') &&
        (existsSync(join(REPO, 'services', d, 'src/router.ts')) || existsSync(join(REPO, 'services', d, 'src/index.ts'))),
    )
    .sort();

function plan(service, write) {
  const json = join(tmpdir(), `call-records-report-${process.pid}-${service}.json`);
  const run = spawnSync(
    'node',
    [here('index.mjs'), '--module', service.slice(4), '--service', service, '--json', json, ...(write ? ['--write'] : [])],
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

function deep(rows) {
  const recordFiles = () =>
    git('status', '--porcelain', '--', 'packages/contracts/src')
      .split('\n')
      .map((l) => l.slice(3))
      .filter((f) => f.endsWith('-procedures.ts'));
  const touched = new Map();
  for (const row of rows) {
    if (!row.sites) continue;
    const before = new Set(recordFiles());
    const s = plan(row.service, true);
    if (s.error) {
      row.writeError = s.error;
      continue;
    }
    for (const f of s.touched ?? []) if (!touched.has(f)) touched.set(f, row.service);
    row.recordFiles = recordFiles().filter((f) => !before.has(f));
  }
  const build = () => {
    const r = spawnSync('pnpm', ['--filter', '@intafaced/contracts', 'build'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return r.status === 0 ? [] : `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /error TS/.test(l));
  };
  const buildErrors = build();
  for (const row of rows) {
    if (!row.recordFiles?.length) continue;
    const out = join(tmpdir(), `call-records-report-unportable-${process.pid}-${row.service}.json`);
    const r = spawnSync('node', [here('samples.mjs'), '--unportable', out, ...row.recordFiles], { cwd: REPO, encoding: 'utf8' });
    const skipped = r.status === 0 && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
    row.samples = count(Object.values(skipped).map(reasonOf));
  }
  build();
  // Type errors in app files a service's run touched, after its records were written.
  const typeErrors = {};
  for (const app of readdirSync(join(REPO, 'apps'))) {
    if (!existsSync(join(REPO, 'apps', app, 'tsconfig.json'))) continue;
    const r = spawnSync('npx', ['tsc', '--noEmit', '-p', '.'], {
      cwd: join(REPO, 'apps', app),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /^([^(]+)\(\d+,\d+\): error TS/.exec(line);
      if (!m) continue;
      const file = `apps/${app}/${m[1]}`;
      const owner = touched.get(file) ?? 'not a touched file';
      typeErrors[owner] = (typeErrors[owner] ?? 0) + 1;
    }
  }
  // Credential-shaped literals the secret scan finds in what the codemod wrote.
  const scan = spawnSync('node', ['tooling/ci/secret-scan.mjs'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secrets = {};
  // Only the failures (stderr); the known-disclosed list on stdout is not the codemod's.
  for (const line of (scan.stderr ?? '').split('\n')) {
    const m = /^\s+\[[^\]]+\] (packages\/contracts\/[^\s:]+|apps\/[^\s:]+|services\/[^\s:]+)/.exec(line);
    if (!m) continue;
    const owner = touched.get(m[1]) ?? rows.find((r) => r.recordFiles?.includes(m[1]))?.service ?? 'not a touched file';
    secrets[owner] = (secrets[owner] ?? 0) + 1;
  }
  for (const row of rows) {
    row.typeErrors = typeErrors[row.service] ?? 0;
    row.secretLiterals = secrets[row.service] ?? 0;
  }
  return {
    contractsBuildErrors: buildErrors.length,
    contractsBuildSample: buildErrors.slice(0, 10),
    untouchedTypeErrors: typeErrors['not a touched file'] ?? 0,
    untouchedSecretLiterals: secrets['not a touched file'] ?? 0,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
  const dirty = git('status', '--porcelain', '--', 'apps', 'services', 'packages/contracts').trim();
  if (argv.includes('--deep') && dirty) {
    console.error(`commit or put back these first, so the report can put back exactly what it wrote:\n${dirty}`);
    process.exit(1);
  }
  const rows = services().map((service) => {
    const s = plan(service, false);
    // No tRPC router to read (svc-edge, svc-fix, svc-ws; svc-matching serves REST): no app calls it by name.
    if (s.error && /no src\/router\.ts|no create\*Router function/.test(s.error)) return { service, sites: 0, noTrpcRouter: true };
    if (s.error) return { service, error: s.error };
    return { service, sites: s.sites, wouldMove: s.rewritten, records: s.records.length, left: count(s.hand.map((h) => reasonOf(h.why))) };
  });
  // A checkout without its install (`pnpm install`) can't load the parser: every plan fails, and the totals would read 0.
  const failed = rows.filter((r) => r.error);
  if (failed.length === rows.length || failed.length > rows.length / 2) {
    console.error(`the codemod could not plan ${failed.length} of ${rows.length} services (run \`pnpm install\` first):`);
    for (const r of failed.slice(0, 5)) console.error(`  ${r.service}: ${r.error}`);
    process.exit(1);
  }
  let extra = {};
  if (argv.includes('--deep')) {
    try {
      extra = deep(rows);
    } finally {
      git('checkout', '--', 'apps', 'services', 'packages/contracts');
      git('clean', '-fdq', '--', 'apps', 'services', 'packages/contracts/src');
    }
  }
  const totals = { sites: 0, wouldMove: 0, left: {} };
  for (const r of rows) {
    totals.sites += r.sites ?? 0;
    totals.wouldMove += r.wouldMove ?? 0;
    for (const [k, n] of Object.entries(r.left ?? {})) totals.left[k] = (totals.left[k] ?? 0) + n;
    for (const [k, n] of Object.entries(r.samples ?? {})) totals.left[`after write: ${k}`] = (totals.left[`after write: ${k}`] ?? 0) + n;
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
  totals.seenByNoServiceRun = totals.ruleFindings - totals.sites;
  const report = { at: new Date().toISOString(), head: git('rev-parse', 'HEAD').trim(), totals, ...extra, services: rows };
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ totals, ...extra }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
