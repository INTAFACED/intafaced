#!/usr/bin/env node
/**
 * DEPENDENCY AUDIT — the ratchet.
 *
 * WHY THIS EXISTS
 *
 * Phase B §5 kills "Hot-wallet random npm — custody supply chain". We wrote the
 * ban and then installed nothing that checks it. At the commit that added this
 * file the tree carried 12 distinct advisories, 8 of them high, and nobody knew
 * — because there was no dependabot config, no renovate config, no `pnpm audit`
 * anywhere in CI, and no SBOM. A mutation-tested secret scanner sat beside a
 * dependency tree nothing had ever looked at.
 *
 * WHY A RATCHET AND NOT A BLOCKING SEVERITY GATE
 *
 * `pnpm audit --audit-level=high` on day one exits non-zero, so wiring that as
 * required would red main immediately and the gate would be deleted within the
 * day. That is the same trap `shell-i18n-scan.mjs` (deleted 2026-10-13) documents for its 200+
 * hardcoded strings, and it is why that one is deliberately NOT a gate.
 *
 * So this uses the pattern the repo already trusts — the one behind
 * `i18n-bypass-scan` and `CLASS_B_AWAITING_A_DECISION`:
 *
 *   THE LIST CANNOT GROW.
 *
 *   · A NEW advisory fails the run. That is the property worth having: a
 *     dependency added today cannot bring a known vulnerability with it.
 *   · A KNOWN advisory is printed every run, with its severity and the reason
 *     it is still here. It cannot rot into blanket cover, because you read it
 *     on every push.
 *   · A known advisory that has DISAPPEARED also fails, and that is deliberate.
 *     A stale entry is a fix somebody already made and nobody recorded, and a
 *     baseline that only ever grows stops describing anything. Removing the
 *     line is part of the fix.
 *
 * The list is meant to shrink to zero. When it does, flip this to a plain
 * `--audit-level=high` and delete the baseline.
 *
 * Usage:  pnpm scan:deps          (needs network — the advisory DB is remote)
 * Exit 0 = no new advisories and no stale baseline entries.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Advisories present when this gate was installed (2026-08-06, tip 7207d6ec).
 *
 * `note` is the reason it is still here — a path, or the work it is waiting on.
 *
 * BOTH PRODUCTION-PATH ENTRIES ARE GONE as of this bump, and that is the
 * ratchet's whole point rather than an aside. `drizzle-orm` (direct, 13
 * dependents, every service that touches Postgres) and `fast-uri` (transitive
 * under `fastify`, reached by every service) were the two that mattered. The
 * scan refused this PR until their lines were deleted — a fix nobody records
 * leaves a baseline describing a tree that no longer exists.
 *
 * What remains reaches no request path: it arrives through build or lint
 * tooling.
 */
const KNOWN = {
  'GHSA-mh99-v99m-4gvg': {
    severity: 'high',
    module: 'brace-expansion',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-rgw5-rvv9-x895': {
    severity: 'high',
    module: 'brace-expansion',
    note: 'eslint and rimraf > glob > minimatch. Lint and clean tooling; never runs in a service.',
  },
  'GHSA-ph9p-34f9-6g65': { severity: 'high', module: 'tmp', note: 'svc-indexer > solc > tmp. Solidity compiler, build-time only.' },
  'GHSA-52f5-9888-hmc6': { severity: 'low', module: 'tmp', note: 'svc-indexer > solc > tmp. Solidity compiler, build-time only.' },
  'GHSA-67mh-4wv8-2f99': {
    severity: 'moderate',
    module: 'esbuild',
    note: 'packages/db > drizzle-kit > esbuild. Migration tooling, build-time only.',
  },
  'GHSA-82fw-gwwq-j7x9': {
    severity: 'moderate',
    module: '@vitest/mocker',
    note: 'vitest > @vitest/mocker. Test/dev-server tooling; never runs in a service. Patch is vitest 4.1.11.',
  },
  'GHSA-2883-xcg3-v3hh': {
    severity: 'high',
    module: 'js-yaml',
    note: 'eslint > @eslint/eslintrc > js-yaml. Lint tooling; never runs in a service. Patch is js-yaml 4.3.2.',
  },
  // Advisory DB moved on 2026-10-01. None of these packages were added by the
  // recovery-enum change. A version bump is its own supply-chain PR.
  'GHSA-3wwx-pv8p-q78v': {
    severity: 'moderate',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-pmjh-fq2x-6v4x': {
    severity: 'moderate',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-r53p-7pc4-xj5r': {
    severity: 'low',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-rfgv-xxqx-mfg5': {
    severity: 'high',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-3xpg-4rpp-hhhm': {
    severity: 'moderate',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-2jfj-6hjv-fm6j': {
    severity: 'moderate',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-2gqq-gqf2-x968': {
    severity: 'low',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-w293-vg96-wgc3': {
    severity: 'high',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-8436-99hf-9mmv': {
    severity: 'low',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-rx4f-c7p8-82vq': {
    severity: 'moderate',
    module: 'undici',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-q2hr-2g5m-vwhr': {
    severity: 'moderate',
    module: 'brace-expansion',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-qhr7-859c-m2p7': {
    severity: 'high',
    module: 'brace-expansion',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-6j4f-fj2g-mc7p': {
    severity: 'high',
    module: 'brace-expansion',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-m9gg-hp2v-232j': {
    severity: 'high',
    module: '@grpc/grpc-js',
    note: 'testcontainers > dockerode > @grpc/grpc-js. Test-only Docker client. Not a service request path.',
  },
  'GHSA-f596-whhp-79r4': {
    severity: 'low',
    module: '@grpc/grpc-js',
    note: 'testcontainers > dockerode > @grpc/grpc-js. Test-only Docker client. Not a service request path.',
  },
};

const audit = spawnSync('pnpm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });

// `pnpm audit` exits non-zero whenever it finds anything, so the exit code says
// nothing useful here. An unparseable body is the real failure — it means the
// registry was unreachable and this run proved nothing either way.
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error('\n✖ dependency-audit could not read `pnpm audit --json`.');
  console.error('  This needs network: the advisory database is remote. A run that cannot');
  console.error('  reach it has not cleared anything and must not be reported as clean.\n');
  console.error((audit.stderr || audit.stdout || '').slice(0, 800));
  process.exit(1);
}

const advisories = Object.values(report.advisories ?? {});
const seen = new Map();
for (const a of advisories) {
  const id =
    a.github_advisory_id ??
    String(a.url ?? '')
      .split('/')
      .pop();
  if (id) seen.set(id, { severity: a.severity, module: a.module_name });
}

const added = [...seen.keys()].filter((id) => !(id in KNOWN));
const stale = Object.keys(KNOWN).filter((id) => !seen.has(id));

const bySeverity = (id, from) => `${(from[id]?.severity ?? '?').padEnd(8)} ${from[id]?.module ?? '?'}`;

console.log(`\ndependency-audit — ${seen.size} advisory(ies) in the tree, ${Object.keys(KNOWN).length} on the frozen list\n`);

for (const [id, meta] of Object.entries(KNOWN)) {
  const mark = stale.includes(id) ? '·' : '✓';
  console.log(`  ${mark} ${meta.severity.padEnd(8)} ${meta.module.padEnd(16)} ${id}`);
  console.log(`      ${meta.note}`);
}

if (added.length === 0 && stale.length === 0) {
  console.log('\n✓ no new advisories, and every frozen entry is still real.\n');
  process.exit(0);
}

if (added.length > 0) {
  console.error(`\n✖ ${added.length} NEW advisory(ies) — the list cannot grow:\n`);
  for (const id of added) console.error(`    ${bySeverity(id, Object.fromEntries(seen))}  ${id}  https://github.com/advisories/${id}`);
  console.error('\n  Update the dependency, or add it to KNOWN with the reason it cannot');
  console.error('  be updated yet. Adding it without a reason is how this list stops meaning anything.\n');
}

if (stale.length > 0) {
  console.error(`\n✖ ${stale.length} frozen entry(ies) no longer present — remove them:\n`);
  for (const id of stale) console.error(`    ${bySeverity(id, KNOWN)}  ${id}`);
  console.error('\n  Somebody fixed these and did not record it. Delete the lines: a baseline');
  console.error('  that only grows stops describing the tree it claims to describe.\n');
}

process.exit(1);
