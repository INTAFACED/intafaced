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
 * RUST'S PACKAGES ARE HELD TO THE SAME RATCHET
 *
 * `pnpm audit` reads only the npm tree. The Rust workspace's outside crates are the
 * registry packages in `Cargo.lock` (CI builds with `--locked`, so a crate change
 * without a lock change fails before anything runs). Each is asked of OSV
 * (api.osv.dev, which carries the RustSec database), with no tool to install. An
 * informational RustSec notice (unmaintained, unsound) or a withdrawn advisory is
 * printed and passes, as `cargo audit` treats it; a vulnerability joins the same
 * list as npm's, and a GHSA that only repeats a RustSec id is counted once.
 *
 * Usage:  pnpm scan:deps          (needs network — the advisory DB is remote)
 *         node tooling/ci/dependency-audit.mjs --base HEAD^1   (CI, pull requests)
 *         node tooling/ci/dependency-audit.mjs --self-test
 * Exit 0 = no new advisories (stale entries only warn), or a PR that changes no
 * dependency.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  'Cargo.lock',
];

/**
 * Advisories in the tree that cannot be updated yet. The thirteen entries frozen when this gate was installed
 * (2026-08-06) have all left the tree and their lines are deleted.
 *
 * `note` is the reason it is still here: a path, and the work it is waiting on.
 */
const KNOWN = {
  'GHSA-fc5q-39xc-vjpf': {
    severity: 'high',
    module: 'picomatch',
    note:
      'vitest, vite and @tailwindcss/vite > picomatch (dev dependencies only; `pnpm why picomatch -r --prod` is empty). ' +
      'Test and build tooling; never runs in a service. No patched picomatch exists yet (affected <= 4.0.7, the latest).',
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

/** Where third-party crates live with a fix of ours (`crates/vendor/<crate>/VENDORED.md`), named by path, so with no `source`. */
export const VENDOR_DIR = 'crates/vendor';

/**
 * Each vendored crate's name and version, read from its own `Cargo.toml`. A vendored crate is still that release of that
 * crate and is asked about like a registry one; one whose name or version cannot be read stops the run, never drops out.
 */
export function vendoredCrates(root = ROOT) {
  const dir = join(root, VENDOR_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const manifest = readFileSync(join(dir, d.name, 'Cargo.toml'), 'utf8');
      const pkg = manifest.split(/^\[(?!package\])/m)[0].split(/^\[package\]$/m)[1] ?? '';
      const field = (key) => pkg.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];
      const [name, version] = [field('name'), field('version')];
      if (!name || !version) throw new Error(`${VENDOR_DIR}/${d.name}/Cargo.toml: no [package] name and version to audit`);
      return { name, version };
    });
}

/**
 * The crates in a `Cargo.lock` that OSV is asked about: every registry crate, and each vendored crate (`vendored`, from
 * `vendoredCrates`), which has no `source`. The workspace's own crates have no `source` either and are not asked about.
 */
export function cargoPackages(lockText, vendored = []) {
  const out = [];
  for (const block of String(lockText)
    .split(/^\[\[package\]\]$/m)
    .slice(1)) {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];
    const [name, version, source] = [field('name'), field('version'), field('source')];
    const isVendored = !source && vendored.some((v) => v.name === name && v.version === version);
    if (name && version && (source?.startsWith('registry+') || isVendored)) out.push({ name, version });
  }
  return out;
}

/**
 * From OSV's answers, the advisories that count: per crate, `ids` is what the batch query listed and `details` each id's
 * record. A withdrawn record or an informational RustSec notice is set apart; a GHSA that a RustSec id it was listed
 * with names as an alias (or that names it) is the same advisory, counted once under the RustSec id.
 */
export function rustAdvisories(packages, ids, details) {
  const found = new Map();
  const notices = [];
  packages.forEach((pkg, i) => {
    const list = ids[i] ?? [];
    const same = (a, b) => (details[a]?.aliases ?? []).includes(b) || (details[b]?.aliases ?? []).includes(a);
    for (const id of list) {
      const d = details[id] ?? {};
      const informational = (d.affected ?? []).map((a) => a.database_specific?.informational).find(Boolean);
      if (d.withdrawn || informational) {
        notices.push(`${id} ${pkg.name} ${pkg.version}: ${d.withdrawn ? 'withdrawn' : informational}`);
        continue;
      }
      if (!id.startsWith('RUSTSEC-') && list.some((other) => other.startsWith('RUSTSEC-') && same(id, other))) continue;
      const rated = [id, ...list.filter((other) => other !== id && same(id, other))]
        .map((x) => details[x]?.database_specific?.severity)
        .find((sev) => typeof sev === 'string');
      found.set(id, { severity: rated ? rated.toLowerCase() : 'unrated', module: `${pkg.name}@${pkg.version} (crate)` });
    }
  });
  return { found, notices };
}

/** Asks OSV about every registry crate in Cargo.lock; `problem` when OSV could not be read, so nothing was cleared. */
async function readRustAudit() {
  let lock;
  try {
    lock = readFileSync(join(ROOT, 'Cargo.lock'), 'utf8');
  } catch {
    return { found: new Map(), notices: [] };
  }
  const packages = cargoPackages(lock, vendoredCrates());
  if (packages.length === 0) return { found: new Map(), notices: [] };
  try {
    const ask = async (url, init) => {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    };
    const batch = await ask('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: packages.map((p) => ({ package: { ecosystem: 'crates.io', name: p.name }, version: p.version })),
      }),
    });
    if (!Array.isArray(batch?.results) || batch.results.length !== packages.length) {
      throw new Error(`querybatch answered ${JSON.stringify(batch).slice(0, 300)}`);
    }
    if (batch.results.some((r) => r?.next_page_token)) throw new Error('querybatch paged its answer; read every page');
    const ids = batch.results.map((r) => (r?.vulns ?? []).map((v) => v.id));
    const details = {};
    for (const id of new Set(ids.flat())) details[id] = await ask(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`);
    return rustAdvisories(packages, ids, details);
  } catch (err) {
    return { problem: String(err?.message ?? err).slice(0, 800) };
  }
}

/** A GitHub annotation on the run, so a passing PR still shows what main has to fix. */
function warn(message) {
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Dependency audit::${message}` : `! ${message}`);
}

async function main() {
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
  let rust;
  for (let attempt = 1; attempt <= 3 && !rust?.found; attempt++) {
    rust = await readRustAudit();
    if (!rust.found) console.error(`dependency-audit: attempt ${attempt} could not read OSV for Cargo.lock: ${rust.problem}`);
  }
  if (!rust.found) {
    report = undefined;
    problem = `OSV (Rust crates): ${rust.problem}`;
  }
  if (!report && !strict) {
    warn('could not read `pnpm audit --json` or OSV (the advisory databases are remote). This PR changes no dependency, so it passes.');
    process.exit(0);
  }
  if (!report) {
    console.error('\n✖ dependency-audit could not read `pnpm audit --json` or OSV for Cargo.lock.');
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
  for (const [id, meta] of rust.found) seen.set(id, meta);
  for (const notice of rust.notices) console.log(`  notice (passes, as \`cargo audit\` does): ${notice}`);

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
  for (const id of added)
    console.error(
      `    ${bySeverity(id, seenById)}  ${id}  ${id.startsWith('GHSA-') ? 'https://github.com/advisories/' : 'https://osv.dev/vulnerability/'}${id}`,
    );
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
  eq(dependencyChanges(['Cargo.lock']), ['Cargo.lock'], 'the Rust lock file');
  const lock = [
    'version = 4',
    '',
    '[[package]]',
    'name = "smallvec"',
    'version = "0.6.9"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    '',
    '[[package]]',
    'name = "svc-tax"',
    'version = "0.0.0"',
    '',
  ].join('\n');
  eq(cargoPackages(lock), [{ name: 'smallvec', version: '0.6.9' }], 'registry crates only, the workspace crate left out');
  const withVendored = `${lock}\n[[package]]\nname = "tiny_http"\nversion = "0.12.0"\n`;
  eq(
    cargoPackages(withVendored, [{ name: 'tiny_http', version: '0.12.0' }]),
    [
      { name: 'smallvec', version: '0.6.9' },
      { name: 'tiny_http', version: '0.12.0' },
    ],
    'a vendored crate is asked about as its release, the workspace crate still left out',
  );
  eq(cargoPackages(withVendored), [{ name: 'smallvec', version: '0.6.9' }], 'a path crate not vendored is not asked about');
  const vendored = vendoredCrates();
  eq(
    vendored.some((v) => v.name === 'tiny_http' && v.version === '0.12.0'),
    existsSync(join(ROOT, VENDOR_DIR, 'tiny_http')),
    "this tree's vendored tiny_http is read from its Cargo.toml",
  );
  const pkgs = [{ name: 'smallvec', version: '0.6.9' }];
  const details = {
    'RUSTSEC-2019-0009': { aliases: ['GHSA-mm7v-vpv8-xfc3'] },
    'GHSA-mm7v-vpv8-xfc3': { aliases: ['RUSTSEC-2019-0009'], database_specific: { severity: 'CRITICAL' } },
    'GHSA-only': { database_specific: { severity: 'HIGH' } },
    'RUSTSEC-unmaintained': { affected: [{ database_specific: { informational: 'unmaintained' } }] },
    'RUSTSEC-withdrawn': { withdrawn: '2024-01-01T00:00:00Z' },
  };
  const got = rustAdvisories(pkgs, [Object.keys(details)], details);
  eq(
    [...got.found],
    [
      ['RUSTSEC-2019-0009', { severity: 'critical', module: 'smallvec@0.6.9 (crate)' }],
      ['GHSA-only', { severity: 'high', module: 'smallvec@0.6.9 (crate)' }],
    ],
    'a GHSA repeating a RustSec id counts once, rated by its alias',
  );
  eq(got.notices.length, 2, 'an unmaintained notice and a withdrawn advisory pass as notices');
  eq(judge([...got.found.keys()], {}, true).fail, true, 'a vulnerable crate fails a strict run');
  console.log('✓ dependency-audit --self-test OK (18 fixtures)');
}

// Nothing imports this file, so there is no main-module guard to fail open on an odd checkout path.
if (process.argv.includes('--self-test')) selfTest();
else await main();
