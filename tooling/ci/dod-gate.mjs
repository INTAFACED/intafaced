#!/usr/bin/env node
/**
 * DEFINITION OF DONE GATE — §14, enforced.
 *
 *   "Never half done. A module ships when its Definition of Done passes — not
 *    before, and nothing 'temporary' survives to the next phase." (§0.1)
 *
 * Run: `pnpm gate [service-name]`
 * Self-test: `node tooling/ci/dod-gate.mjs --self-test`
 *
 * Checks, per service:
 *   1. README with API contract, event subjects, and ledger recipes used
 *   2. Zero TODOs referencing "later" without a §13 socket entry
 *   3. Tests exist for every money path (a file that posts to the ledger or
 *      builds a recipe is reachable from some test in the service)
 *   4. Observability wired — the service registers a tracer
 *   5. Admin controls — the module has a kill-switch the operator can reach
 *
 * REPO-WIDE doctrine scans (brand, custody, secrets, dual-book, migrations,
 * kill-switch reachability, …) are NOT here. They live in one list —
 * `tooling/ci/gates.mjs` — which `pnpm verify` and CI's `gates` job both run.
 * Run them with `pnpm gates`. See the note in the run section below for why
 * they moved.
 *
 * Checks 1–6 are mechanical. The DoD items that cannot be automated (SLO
 * dashboard panel, e2e failure paths) are printed as a manual checklist so the
 * reviewer signs them explicitly rather than by silence.
 */
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, basename, resolve } from 'node:path';

const ROOT = process.cwd();
const SERVICES = join(ROOT, 'services');
const target = process.argv[2];

const REQUIRED_README_SECTIONS = [
  { heading: /##\s*API/i, name: 'API contract' },
  { heading: /##\s*Events/i, name: 'Event subjects' },
  { heading: /##\s*Ledger/i, name: 'Ledger recipes used' },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'drizzle', '.next']);

function* walk(dir, extensions) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, extensions);
    else if (extensions.some((e) => name.endsWith(e))) yield full;
  }
}

function checkService(serviceDir) {
  const service = basename(serviceDir);
  const failures = [];

  // 1 · README with the three contract sections
  const readme = join(serviceDir, 'README.md');
  if (!existsSync(readme)) {
    failures.push('README.md is missing (§14: "Docs: service README with API contract, event subjects, ledger recipes used")');
  } else {
    const content = readFileSync(readme, 'utf8');
    for (const { heading, name } of REQUIRED_README_SECTIONS) {
      if (!heading.test(content)) failures.push(`README.md has no "${name}" section`);
    }
  }

  // 2 · No "later" TODOs without a §13 socket
  for (const file of walk(join(serviceDir, 'src'), ['.ts', '.tsx'])) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\b(TODO|FIXME|HACK|XXX)\b/i.test(line)) return;
      if (!/\blater\b|\bfor now\b|\btemporar/i.test(line)) return;
      if (/§13|Section 13|SOCKET:/i.test(line)) return;
      failures.push(`${relative(ROOT, file)}:${i + 1} — deferred work with no §13 socket entry: "${line.trim().slice(0, 90)}"`);
    });
  }

  // 3 · Every module touching money has tests beside it
  const srcDir = join(serviceDir, 'src');
  const moneyFiles = [];
  for (const file of walk(srcDir, ['.ts'])) {
    if (file.includes('.test.')) continue;
    const content = readFileSync(file, 'utf8');
    // A file MOVES value if it posts to the ledger or builds a recipe.
    //
    // Merely importing `@intafaced/ledger-client` is not enough — svc-matching
    // imports it for `Amount`/`parseAmount` and posts nothing at all, so the
    // old test flagged its router as an untested money path. Widening a gate
    // until it cries wolf is how a gate gets ignored.
    if (/ledger\.post\(|recipes\.[a-zA-Z]/.test(content)) moneyFiles.push(file);
  }
  const testFiles = [...walk(srcDir, ['.test.ts'])];

  /** Relative import specifiers in a file, resolved to absolute .ts paths. */
  function importsOf(sourceFile) {
    if (!existsSync(sourceFile)) return [];
    const source = readFileSync(sourceFile, 'utf8');
    const dir = join(sourceFile, '..');
    return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => resolve(dir, m[1].replace(/\.js$/, '.ts')));
  }

  /**
   * Everything reachable from the tests, following imports transitively.
   *
   * Transitive on purpose. A test that drives `bank-service.ts`, which delegates
   * to `earn/earn-service.ts`, genuinely exercises the earn money paths — and
   * requiring a direct import would be checking the shape of the call graph
   * rather than whether the code is covered.
   */
  const reachable = new Set();
  const queue = [...testFiles];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const imported of importsOf(current)) {
      if (reachable.has(imported)) continue;
      reachable.add(imported);
      queue.push(imported);
    }
  }

  for (const file of moneyFiles) {
    // A money file is covered when SOME test in the service actually imports it.
    //
    // Two failure modes to avoid, and this sits between them:
    //
    //   · "any .test.ts anywhere under src/" — the original, a false green. One
    //     unrelated test satisfied the check for every money path in the
    //     service. Found by partner audit.
    //   · "a test in the same directory" — my first fix, too prescriptive. It
    //     dictates layout rather than checking coverage: svc-bank keeps its
    //     money paths in src/earn/ and src/transfers/ with one integration
    //     suite at the service root, which is a perfectly good structure and
    //     would have failed. Found by the agent building it.
    //
    // Following the import graph checks the thing we actually care about —
    // that the file is exercised — and leaves the layout to the author.
    const covered = reachable.has(file);

    if (!covered) {
      failures.push(
        `${relative(ROOT, file)} moves value but no test in this service imports it ` +
          `(§14: money paths ≥ 95% coverage). Import it from a test, or add ${basename(file, '.ts')}.test.ts.`,
      );
    }
  }

  // 4 · Observability
  const hasTracing = [...walk(srcDir, ['.ts'])].some((f) => /@opentelemetry|initTracing|withSpan/.test(readFileSync(f, 'utf8')));
  if (existsSync(srcDir) && !hasTracing) {
    failures.push('no OpenTelemetry instrumentation found (§14: traces + one SLO dashboard panel)');
  }

  // 5 · Admin kill-switch
  //
  // This was `flags.includes("'<moduleId>'")` — a substring search over the
  // whole file, which a flag KEY, a description, or an unrelated import could
  // satisfy without any kill-switch existing. A gate that can be passed by
  // coincidence is not a gate. It now parses the module argument of each
  // `def(...)` call, which is the thing that actually confers the switch.
  //
  // A missing packages/config/src/flags.ts used to skip this check, so a
  // service passed §14 with no switch at all. Absence is a failure. Do not
  // invent a flag key or a module id and count it as declared.
  failures.push(...adminKillSwitchFailures(service, join(ROOT, 'packages', 'config', 'src', 'flags.ts')));

  return { service, failures };
}

/**
 * Kill-switch failures for one service.
 * `flagsFile` absent → the registry is missing, so the operator has no switch.
 * A present file counts only a real `def('key', 'module', …)` second argument.
 */
function adminKillSwitchFailures(service, flagsFile) {
  if (!existsSync(flagsFile)) {
    return [
      'FLAG_REGISTRY is missing (packages/config/src/flags.ts) — the operator has no kill-switch (§14 admin controls)',
    ];
  }

  const moduleId = service.replace(/^svc-/, '');
  const flags = readFileSync(flagsFile, 'utf8');

  // def('some.key', 'module-id', …) — the second argument names the module.
  const declared = new Set([...flags.matchAll(/\bdef\(\s*'[^']+'\s*,\s*'([^']+)'/g)].map((m) => m[1]));

  if (!declared.has(moduleId)) {
    return [
      `module "${moduleId}" has no flag declared against it in FLAG_REGISTRY — ` +
        `the operator has no kill-switch (§14 admin controls)`,
    ];
  }
  return [];
}

function selfTest() {
  const fails = [];
  const assert = (cond, message) => {
    if (!cond) fails.push(message);
  };
  const killSwitchFailure = (failures) => failures.some((f) => f.includes('no kill-switch'));

  const absent = join(tmpdir(), 'l434-flags-absent-does-not-exist.ts');
  if (existsSync(absent)) rmSync(absent);
  const absentFailures = adminKillSwitchFailures('svc-probe', absent);
  assert(killSwitchFailure(absentFailures), 'absent flags file must record a kill-switch failure');
  assert(
    absentFailures.some((f) => f.includes('FLAG_REGISTRY is missing')),
    'absent flags file must say the flag registry is missing',
  );
  assert(
    absentFailures.every((f) => !/module "[^"]+"/.test(f) && !/\bdef\(/.test(f)),
    'absent flags file must not invent a flag key or module id',
  );

  const dir = mkdtempSync(join(tmpdir(), 'l434-flags-'));
  try {
    const present = join(dir, 'flags.ts');
    writeFileSync(
      present,
      "function def(key, module, drop, description, enforcement) { return { key, module }; }\n" +
        "def('trade.spot', 'trade', null, 'Spot order book live', null);\n",
    );
    const declared = adminKillSwitchFailures('svc-trade', present);
    assert(!killSwitchFailure(declared), 'a real def() for the module must not add a kill-switch failure');
    assert(declared.length === 0, 'a real def() for the module must not add any §14 kill-switch failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (fails.length) {
    console.error(`dod-gate --self-test FAIL (${fails.length}):`);
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log('dod-gate --self-test OK (2 cases)');
  console.log('  absent flags.ts → kill-switch failure, registry missing, no invented module id');
  console.log("  def('trade.spot', 'trade', …) → no kill-switch failure");
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

// ── Run ─────────────────────────────────────────────────────────────────────

const services = existsSync(SERVICES)
  ? readdirSync(SERVICES)
      .map((s) => join(SERVICES, s))
      .filter((d) => statSync(d).isDirectory())
      .filter((d) => !target || basename(d) === target || basename(d) === `svc-${target}`)
  : [];

if (target && services.length === 0) {
  console.error(`✖ no service matching "${target}" under services/`);
  process.exit(1);
}

console.log('\n══ DEFINITION OF DONE GATE (§14) ══\n');

// The repo-wide doctrine scans used to run here, from a list this file kept:
// brand, custody, vendor-shell, vendor-java-money, dual-book-door, secret,
// migration-check, killswitch-reachability.
//
// They have moved to `tooling/ci/gates.mjs`, the ONE list that `pnpm verify`
// and the `gates` job in ci.yml both consume. Nothing was dropped — all eight
// are in that list, which now also carries the two gates CI ran and verify
// never did (`dual-book-door-paths`, `test-db`).
//
// Two reasons for the move. They were running twice per CI run, once in the
// `gates` job and again here in the `dod` job. And, worse, they ran LAST in
// `pnpm verify` — behind build, typecheck and the entire test suite — so an
// engineer with one failing test never saw a doctrine result at all. Two
// seconds of structural checks belong in front of a two-minute build.
//
// This file is now what its name says: the per-service §14 Definition of Done.
console.log('  Repo-wide doctrine gates run separately — `pnpm gates` (tooling/ci/gates.mjs).');
console.log('  `pnpm verify` runs those FIRST; this gate is the per-service §14 DoD.\n');

let serviceFailed = false;
for (const dir of services) {
  const { service, failures } = checkService(dir);
  if (failures.length === 0) {
    console.log(`  ✓ ${service}`);
  } else {
    serviceFailed = true;
    console.log(`  ✖ ${service} — ${failures.length} DoD failure(s)`);
    for (const f of failures) console.log(`      · ${f}`);
  }
}

if (services.length === 0) {
  console.log('  (no services built yet — Phase 0 is foundations; the gate re-arms as each service lands)');
}

console.log('\n── Manual sign-off required (not automatable) ──');
console.log('  □ e2e happy path + top-3 failure paths green in CI');
console.log('  □ Every user-facing string i18n-keyed');
console.log('  □ At least one SLO dashboard panel exists in Grafana');
console.log('  □ Kill-switch verified reachable from apps/admin');
console.log('');

if (serviceFailed) {
  console.error('✖ DoD GATE FAILED — the module does not ship (Doctrine §0.1: never half done)\n');
  process.exit(1);
}

console.log('✓ DoD gate passed\n');
