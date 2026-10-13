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
 *   EVERY ENTRY EXPIRES.
 *
 *   · Each entry carries an `owner` and an `expires` date (YYYY-MM-DD). The
 *     day after that date the run FAILS, even if the advisory is still real:
 *     an exception is a loan, and it has to be renewed on purpose, in a PR
 *     someone reads. A baseline that never expires turns "known" into "ignored".
 *   · An entry must expire within MAX_EXPIRY_DAYS (90) of today. A longer date
 *     is accepted only with a written `longReason` (and then within
 *     MAX_LONG_EXPIRY_DAYS, 365).
 *   · A missing owner, a missing or malformed date, or a missing note also fails.
 *
 * The list is meant to shrink to zero. When it does, flip this to a plain
 * `--audit-level=high` and delete the baseline.
 *
 * Usage:  pnpm scan:deps          (needs network — the advisory DB is remote)
 * Exit 0 = no new advisories and no stale baseline entries.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Who answers for an entry when it expires. Rename per entry if it moves. */
const OWNER = 'platform-tooling';
export const MAX_EXPIRY_DAYS = 90;
export const MAX_LONG_EXPIRY_DAYS = 365;

/**
 * Advisories present when this gate was installed (2026-08-06, tip 7207d6ec).
 *
 * `note` is the reason it is still here — a path, or the work it is waiting on.
 * `owner` and `expires` are mandatory (see "EVERY ENTRY EXPIRES" above); the
 * entries below were dated on 2026-10-13, the day expiry was introduced.
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
export const KNOWN = {
  'GHSA-6g55-p6wh-862q': {
    severity: 'high',
    module: 'postcss',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'apps/admin > next > postcss. Build-time CSS, not a request path.',
  },
  'GHSA-r28c-9q8g-f849': {
    severity: 'high',
    module: 'postcss',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'apps/admin > next > postcss. Build-time CSS, not a request path.',
  },
  'GHSA-fxqj-rqcc-2cmp': {
    severity: 'moderate',
    module: 'postcss',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'apps/admin > next > postcss. Build-time CSS, not a request path.',
  },
  'GHSA-qx2v-qp2m-jg93': {
    severity: 'moderate',
    module: 'postcss',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'apps/admin > next > postcss. Build-time CSS, not a request path.',
  },
  'GHSA-mh99-v99m-4gvg': {
    severity: 'high',
    module: 'brace-expansion',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-rgw5-rvv9-x895': {
    severity: 'high',
    module: 'brace-expansion',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'eslint and rimraf > glob > minimatch. Lint and clean tooling; never runs in a service.',
  },
  'GHSA-ph9p-34f9-6g65': {
    severity: 'high',
    module: 'tmp',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'svc-indexer > solc > tmp. Solidity compiler, build-time only.',
  },
  'GHSA-52f5-9888-hmc6': {
    severity: 'low',
    module: 'tmp',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'svc-indexer > solc > tmp. Solidity compiler, build-time only.',
  },
  'GHSA-67mh-4wv8-2f99': {
    severity: 'moderate',
    module: 'esbuild',
    owner: OWNER,
    expires: '2026-12-12',
    note: 'packages/db > drizzle-kit > esbuild. Migration tooling, build-time only.',
  },
  'GHSA-82fw-gwwq-j7x9': {
    severity: 'moderate',
    module: '@vitest/mocker',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'vitest > @vitest/mocker. Test/dev-server tooling; never runs in a service. Patch is vitest 4.1.11.',
  },
  'GHSA-2883-xcg3-v3hh': {
    severity: 'high',
    module: 'js-yaml',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'eslint > @eslint/eslintrc > js-yaml. Lint tooling; never runs in a service. Patch is js-yaml 4.3.2.',
  },
  // Advisory DB moved on 2026-10-01. None of these packages were added by the
  // recovery-enum change. A version bump is its own supply-chain PR.
  'GHSA-3wwx-pv8p-q78v': {
    severity: 'moderate',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-pmjh-fq2x-6v4x': {
    severity: 'moderate',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-r53p-7pc4-xj5r': {
    severity: 'low',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-rfgv-xxqx-mfg5': {
    severity: 'high',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-3xpg-4rpp-hhhm': {
    severity: 'moderate',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-2jfj-6hjv-fm6j': {
    severity: 'moderate',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-2gqq-gqf2-x968': {
    severity: 'low',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-w293-vg96-wgc3': {
    severity: 'high',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-8436-99hf-9mmv': {
    severity: 'low',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-rx4f-c7p8-82vq': {
    severity: 'moderate',
    module: 'undici',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > undici. Test-only Docker client. Not a service request path.',
  },
  'GHSA-q2hr-2g5m-vwhr': {
    severity: 'moderate',
    module: 'brace-expansion',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-qhr7-859c-m2p7': {
    severity: 'high',
    module: 'brace-expansion',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-6j4f-fj2g-mc7p': {
    severity: 'high',
    module: 'brace-expansion',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'eslint > minimatch. Lint tooling; never runs in a service.',
  },
  'GHSA-m9gg-hp2v-232j': {
    severity: 'high',
    module: '@grpc/grpc-js',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > dockerode > @grpc/grpc-js. Test-only Docker client. Not a service request path.',
  },
  'GHSA-f596-whhp-79r4': {
    severity: 'low',
    module: '@grpc/grpc-js',
    owner: OWNER,
    expires: '2027-01-11',
    note: 'testcontainers > dockerode > @grpc/grpc-js. Test-only Docker client. Not a service request path.',
  },
};

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD as a UTC day. Returns NaN for anything that is not a real date. */
function parseDay(text) {
  if (typeof text !== 'string' || !DATE_RE.test(text)) return Number.NaN;
  const ms = Date.parse(`${text}T00:00:00Z`);
  // Date.parse rolls 2026-02-31 over to March; reject by round-tripping.
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text ? Number.NaN : ms;
}

/**
 * Check every allowlist entry for ownership and expiry. Pure: pass `today` as a
 * Date (or YYYY-MM-DD string) so a test can pin the clock.
 *
 * Returns { expired, invalid } — each an array of { id, reason }. Both fail the
 * audit. "expired" means today is after the entry's date; the date itself is
 * still valid, so an entry set to expire on the 12th fails from the 13th.
 */
export function checkAllowlistExpiry(known, today = new Date()) {
  const todayMs = typeof today === 'string' ? parseDay(today) : parseDay(today.toISOString().slice(0, 10));
  // A clock that is not a real date would make every `ms < todayMs` false, and
  // every entry would silently pass. Refuse instead.
  if (Number.isNaN(todayMs)) throw new Error(`checkAllowlistExpiry: "today" is not a real date: ${String(today)}`);
  const expired = [];
  const invalid = [];
  for (const [id, e] of Object.entries(known)) {
    if (typeof e.owner !== 'string' || e.owner.trim() === '') {
      invalid.push({ id, reason: 'missing owner' });
    }
    if (typeof e.note !== 'string' || e.note.trim() === '') {
      invalid.push({ id, reason: 'missing note (the reason it is still here)' });
    }
    const ms = parseDay(e.expires);
    if (Number.isNaN(ms)) {
      invalid.push({ id, reason: `missing or malformed expires (${JSON.stringify(e.expires)}); need a real YYYY-MM-DD date` });
      continue;
    }
    if (ms < todayMs) {
      expired.push({ id, reason: `expired on ${e.expires} (owner ${e.owner ?? '?'})` });
      continue;
    }
    const days = Math.round((ms - todayMs) / DAY_MS);
    const hasLongReason = typeof e.longReason === 'string' && e.longReason.trim() !== '';
    if (days > MAX_LONG_EXPIRY_DAYS) {
      invalid.push({ id, reason: `expires in ${days} days; the hard cap is ${MAX_LONG_EXPIRY_DAYS}` });
    } else if (days > MAX_EXPIRY_DAYS && !hasLongReason) {
      invalid.push({ id, reason: `expires in ${days} days; the limit is ${MAX_EXPIRY_DAYS} unless the entry has a written longReason` });
    }
  }
  return { expired, invalid };
}

function main() {
  // Expiry is judged first and needs no network: an expired exception fails the
  // run whether or not the advisory database answers.
  // DEPENDENCY_AUDIT_TODAY (YYYY-MM-DD) moves the clock FORWARD only, to ask
  // "what expires by then?" or to test this path. An earlier date is ignored, so
  // it can never be used to keep an expired entry alive.
  const override = process.env.DEPENDENCY_AUDIT_TODAY;
  const real = new Date();
  const realDay = real.toISOString().slice(0, 10);
  let today = real;
  if (override !== undefined && override !== '') {
    if (Number.isNaN(parseDay(override))) {
      console.error(`\n✖ DEPENDENCY_AUDIT_TODAY=${JSON.stringify(override)} is not a real YYYY-MM-DD date.\n`);
      process.exit(1);
    }
    if (override > realDay) today = override;
  }
  const { expired, invalid } = checkAllowlistExpiry(KNOWN, today);

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
    reportExpiry(expired, invalid);
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

  const bad = new Set([...expired, ...invalid].map((x) => x.id));
  for (const [id, meta] of Object.entries(KNOWN)) {
    const mark = bad.has(id) ? '✖' : stale.includes(id) ? '·' : '✓';
    console.log(`  ${mark} ${meta.severity.padEnd(8)} ${meta.module.padEnd(16)} ${id}  until ${meta.expires ?? '?'}`);
    console.log(`      ${meta.note}`);
  }

  if (added.length === 0 && stale.length === 0 && expired.length === 0 && invalid.length === 0) {
    console.log('\n✓ no new advisories, every frozen entry is still real, and none has expired.\n');
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

  reportExpiry(expired, invalid);

  process.exit(1);
}

function reportExpiry(expired, invalid) {
  if (expired.length > 0) {
    console.error(`\n✖ ${expired.length} allowlist entry(ies) EXPIRED — fix the dependency, or renew on purpose:\n`);
    for (const x of expired) console.error(`    ${x.id}  ${x.reason}`);
    console.error('\n  An exception is a loan. Update the package so the advisory goes away, or');
    console.error('  push the date out (90 days at most) in a PR that explains why it is still safe.\n');
  }
  if (invalid.length > 0) {
    console.error(`\n✖ ${invalid.length} allowlist problem(s) — every entry needs an owner, a note and a valid expiry:\n`);
    for (const x of invalid) console.error(`    ${x.id}  ${x.reason}`);
    console.error('');
  }
}

// Compare real paths: run through a symlink, argv[1] is the link and the
// module URL is the target, and a plain comparison would skip main() silently.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
