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
 *   · A known advisory that has DISAPPEARED warns, naming the line to delete.
 *     A fix never fails the build (owner decision 2026-10-27). Removing the
 *     line needs no one's go-ahead: a deletion only makes the list stricter
 *     (owner decision 2026-10-25).
 *
 * WHO THE RATCHET HOLDS (owner decision 2026-10-25)
 *
 * The advisory database moves on its own. On 2026-10-23 one new zod advisory
 * turned this required check red on every open PR for over seven hours, and 22
 * of the 24 PRs it held changed no dependency at all. CI installs with
 * `--frozen-lockfile`, so a PR that leaves the files in DEPENDENCY_FILES alone
 * cannot change the tree, and cannot bring an advisory in. So:
 *
 *   · `--base <ref>` (pull requests into main): when the diff from <ref> touches
 *     none of DEPENDENCY_FILES (which include this file, so an edit to KNOWN is
 *     always judged), a new entry is a WARNING and the run passes.
 *     An unreachable registry warns and passes too: nothing this PR did needed
 *     checking. A PR that touches them is held to the full ratchet above.
 *   · No `--base` (pushes to main, `workflow_dispatch`, `pnpm scan:deps`): the
 *     full ratchet. On main a red goes to Main trust, which re-runs it once and
 *     then opens one "Broken on main" issue, so the advisory gets an owner
 *     without holding every journey PR hostage.
 *
 * Comparing advisory ids between base and head was rejected: `pnpm audit
 * --json` lists one path per finding, so a PR adding a new importer on an
 * already-vulnerable version would read as "nothing introduced".
 *
 * The list is meant to shrink to zero. When it does, flip this to a plain
 * `--audit-level=high` and delete the baseline.
 *
 * Usage:  pnpm scan:deps          (needs network — the advisory DB is remote)
 *         node tooling/ci/dependency-audit.mjs --base HEAD^1   (CI, pull requests)
 *         node tooling/ci/dependency-audit.mjs --self-test
 * Exit 0 = no new advisories (stale entries only warn), or a PR that changes no
 * dependency.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The files that decide the installed tree (and what `pnpm audit` reads), at the repo root, plus this file, because
 * it holds KNOWN: a PR that edits the frozen list is held to it. A workspace package.json is not here: a dependency
 * change there without a lockfile change fails `--frozen-lockfile` before anything runs.
 */
export const DEPENDENCY_FILES = [
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  'tooling/ci/dependency-audit.mjs',
];

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
  'GHSA-2883-xcg3-v3hh': {
    severity: 'high',
    module: 'js-yaml',
    note: 'eslint > @eslint/eslintrc > js-yaml. Lint tooling; never runs in a service. Patch is js-yaml 4.3.2.',
  },
  // Advisory DB moved on 2026-10-01. None of these packages were added by the
  // recovery-enum change. A version bump is its own supply-chain PR.
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
  'GHSA-g3hv-75wg-m249': {
    severity: 'moderate',
    module: 'minimatch',
    note:
      'eslint, rimraf > glob, and testcontainers > archiver > glob / readdir-glob > minimatch. Lint, clean and test tooling; ' +
      'never runs in a service. The patch is minimatch 11, a major none of them accepts yet (eslint pins the 3.x API).',
  },
  'GHSA-3g3m-2fjr-6pw4': {
    severity: 'moderate',
    module: 'glob',
    note:
      'rimraf > glob and testcontainers > archiver > archiver-utils > glob. Clean and test tooling; never runs in a service, ' +
      'and neither passes an AbortSignal. The patch is glob 14, a major neither accepts yet.',
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

/** The changed files that decide the tree or the frozen list; any of them holds the PR to the full ratchet. */
export function dependencyChanges(changedFiles) {
  return changedFiles.filter((f) => DEPENDENCY_FILES.includes(f));
}

/** New and stale ids against the frozen list, and whether they fail this run. */
export function judge(seenIds, known, strict) {
  const added = seenIds.filter((id) => !(id in known));
  const stale = Object.keys(known).filter((id) => !seenIds.includes(id));
  return { added, stale, fail: strict && added.length > 0 };
}

/** The files a PR changes against `base` (a rename lists both paths), or null when git cannot say (then the run stays strict). */
function changedSince(base) {
  const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (diff.status !== 0) return null;
  return diff.stdout.split('\n').filter(Boolean);
}

// `pnpm audit` exits non-zero whenever it finds anything, so the exit code says
// nothing useful here. An unreadable body is the real failure — it means the
// registry was unreachable and this run proved nothing either way. A registry
// timeout comes back as parseable JSON with only an `error` key, which used to
// read as "no advisories" and flag every frozen entry as stale; it is unreadable
// too. The registry times out often enough that a run asks up to three times.
function readAudit() {
  const audit = spawnSync('pnpm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  try {
    const body = JSON.parse(audit.stdout);
    if (body && typeof body === 'object' && body.advisories && typeof body.advisories === 'object' && !body.error) {
      return { report: body };
    }
    return { problem: JSON.stringify(body?.error ?? body).slice(0, 800) };
  } catch {
    return { problem: (audit.stderr || audit.stdout || '').slice(0, 800) };
  }
}

/** A GitHub annotation on the run, so a passing PR still shows what main has to fix. */
function warn(message) {
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Dependency audit::${message}` : `! ${message}`);
}

function main() {
  const at = process.argv.indexOf('--base');
  const base = at > 0 ? process.argv[at + 1] : null;
  const changed = base ? changedSince(base) : null;
  const touched = changed ? dependencyChanges(changed) : [];
  const strict = !changed || touched.length > 0;
  if (base) {
    console.log(
      !changed
        ? `dependency-audit: could not diff against ${base}; holding this run to the full ratchet.`
        : strict
          ? `dependency-audit: this PR changes ${touched.join(', ')}; full ratchet.`
          : 'dependency-audit: this PR changes no dependency file, so advisories from outside it warn and pass.',
    );
  }

  let report;
  let problem = '';
  for (let attempt = 1; attempt <= 3 && !report; attempt++) {
    ({ report, problem } = readAudit());
    if (!report) console.error(`dependency-audit: attempt ${attempt} could not read \`pnpm audit --json\`: ${problem}`);
  }
  if (!report && !strict) {
    warn('could not read `pnpm audit --json` (the advisory database is remote). This PR changes no dependency, so it passes.');
    process.exit(0);
  }
  if (!report) {
    console.error('\n✖ dependency-audit could not read `pnpm audit --json`.');
    console.error('  This needs network: the advisory database is remote. A run that cannot');
    console.error('  reach it has not cleared anything and must not be reported as clean.\n');
    console.error(problem);
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

  const { added, stale, fail } = judge([...seen.keys()], KNOWN, strict);
  const seenById = Object.fromEntries(seen);

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

  for (const id of stale) warn(`frozen entry ${id} (${KNOWN[id].module}) is no longer in the tree; delete its line.`);
  if (!fail) {
    for (const id of added) warn(`new advisory ${id} (${bySeverity(id, seenById).replace(/\s+/g, ' ')}) is on main, not from this PR.`);
    console.log(
      added.length
        ? '\n✓ this PR changes no dependency file; the warnings above belong to main (see "Broken on main: PR checks").\n'
        : '\n✓ no new advisories.\n',
    );
    process.exit(0);
  }

  console.error(`\n✖ ${added.length} NEW advisory(ies) — the list cannot grow:\n`);
  for (const id of added) console.error(`    ${bySeverity(id, seenById)}  ${id}  https://github.com/advisories/${id}`);
  console.error('\n  Update the dependency, or add it to KNOWN with the reason it cannot');
  console.error('  be updated yet. Adding it without a reason is how this list stops meaning anything.\n');

  process.exit(1);
}

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const known = { 'GHSA-a': {}, 'GHSA-b': {} };
  eq(dependencyChanges(['services/svc-bank/src/router.ts', 'apps/customer/package.json']), [], 'code and a workspace manifest');
  eq(dependencyChanges(['docs/x.md', 'pnpm-lock.yaml']), ['pnpm-lock.yaml'], 'the lockfile');
  eq(dependencyChanges(['package.json']), ['package.json'], 'the root manifest');
  eq(dependencyChanges(['pnpm-workspace.yaml']), ['pnpm-workspace.yaml'], 'workspace overrides');
  eq(dependencyChanges(['.npmrc']), ['.npmrc'], 'registry settings');
  eq(dependencyChanges(['tooling/ci/dependency-audit.mjs']), ['tooling/ci/dependency-audit.mjs'], 'an edit to KNOWN');
  eq(dependencyChanges([]), [], 'an empty diff');
  eq(judge(['GHSA-a', 'GHSA-b'], known, true), { added: [], stale: [], fail: false }, 'clean');
  eq(judge(['GHSA-a', 'GHSA-b', 'GHSA-new'], known, true), { added: ['GHSA-new'], stale: [], fail: true }, 'new fails a strict run');
  eq(judge(['GHSA-a'], known, true), { added: [], stale: ['GHSA-b'], fail: false }, 'stale only warns, even a strict run');
  eq(judge(['GHSA-a', 'GHSA-new'], known, false), { added: ['GHSA-new'], stale: ['GHSA-b'], fail: false }, 'both only warn a PR');
  console.log('✓ dependency-audit --self-test OK (11 fixtures)');
}

// Nothing imports this file, so there is no main-module guard to fail open on an odd checkout path.
if (process.argv.includes('--self-test')) selfTest();
else main();
