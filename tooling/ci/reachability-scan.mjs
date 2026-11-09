#!/usr/bin/env node
/**
 * REACHABILITY GATE - a module nothing can reach is not shipped work.
 *
 * WHY THIS EXISTS
 * ---------------
 * Between #905 and #946 the L3 slice factory produced 151 modules that
 * re-declared a constant already defined elsewhere and asserted the copy
 * against a hardcoded literal. Every one passed doctrine gates, format,
 * typecheck, tests and CI. The stamp-mill gate led with `docsOnly`, so it never
 * looked at them (#884). 22k lines, zero reachable behaviour - and each copy
 * was a silent drift trap: change the real list and the copy disagrees while CI
 * stays green.
 *
 * THE RULE
 * --------
 * A non-test source module fails when BOTH are true:
 *   1. it imports nothing from this repo, and
 *   2. nothing outside its own test file imports it.
 *
 * Both halves matter. A real drift guard imports the live source it guards, so
 * it passes on (1) - that is exactly what separates the nine kept
 * `*-honesty.ts` files from the 151 deleted ones. A feature that is built but
 * not yet wired imports real code too, so it passes as well: this gate catches
 * MANUFACTURED code, not unfinished code. Law: docs/NITRO-L3-SLICE-FACTORY-LAW.md (removed).
 *
 * ponytail: importer detection is a basename match over import specifiers, not
 * a module resolver. It errs toward finding an importer, so the failure mode is
 * a miss, never a false accusation. Swap in a real resolver if a miss costs us.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PARKED - built, specced, not yet wired. Each entry is a real Stage-1/Stage-2
 * module with a TRK spec and no caller yet. Parking them here is the point:
 * unwired work stays VISIBLE and owned instead of quietly collecting dust.
 *
 * This list may only SHRINK. When a parked module gains a caller the scan warns
 * and the row is deleted - that is the whole mechanism. Adding a row is a
 * decision to owe the wiring, not a way to pass the gate.
 */
/** Empty when every Stage-1 residual that was parked has a real caller. List may only shrink. */
const PARKED = new Map([]);

/**
 * POSIX-shaped paths, on every platform.
 *
 * This was `new URL('../..', import.meta.url).pathname`, which on Windows is
 * `/C:/Users/…` — a leading slash the filesystem does not use — while `walk()`
 * returns `C:\Users\…` from `join`. Three things then broke at once, and every
 * one of them SILENTLY:
 *
 *   · `f.includes('/src/')` matched nothing, so `sources` was EMPTY and the
 *     scan inspected zero modules.
 *   · `relative(ROOT, f)` produced `..\..\..\Users\…`, which matches no
 *     PARKED key.
 *   · so every PARKED row looked "freed", and the gate instructed the operator
 *     to delete six rows for modules that are still imported by nothing but
 *     their own test.
 *
 * Following that instruction would have DISARMED the gate for those six
 * modules — the exact outcome it exists to prevent. Linux CI was unaffected
 * (no drive letter, `/` separators), so this was green there and wrong on every
 * Windows checkout, which is the worst place for a gate to disagree with itself.
 *
 * Normalising here and at the walk keeps both platforms on one shape.
 */
const posix = (p) => p.replaceAll('\\', '/');
const ROOT = posix(fileURLToPath(new URL('../..', import.meta.url))).replace(/\/$/, '');
const ROOTS = ['services', 'packages'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', 'fixtures', '__fixtures__']);
const SKIP_FILE = /(\.test\.ts|\.d\.ts)$/;
const ENTRY = new Set(['index.ts', 'main.ts', 'server.ts']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile() && /\.(ts|tsx|vue|mjs)$/.test(e.name)) {
      // Normalised at the boundary, so every comparison below — `/src/`,
      // `relative()`, `importer !== ownTest` — sees one separator.
      out.push(posix(join(dir, e.name)));
    }
  }
  return out;
}

const all = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const sources = all.filter((f) => f.includes('/src/') && f.endsWith('.ts') && !SKIP_FILE.test(f) && !ENTRY.has(basename(f)));

/** every (importer, specifier) pair written anywhere in the repo */
const pairs = [];
for (const f of all) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) pairs.push([f, m[1]]);
}

const failures = [];
for (const f of sources) {
  const text = readFileSync(f, 'utf8');
  const readsRepoCode = /from\s+['"]\.{1,2}\//.test(text) || /from\s+['"]@intafaced\//.test(text);
  if (readsRepoCode) continue;

  const stem = basename(f, '.ts');
  const ownTest = f.replace(/\.ts$/, '.test.ts');
  const imported = pairs.some(
    ([importer, spec]) => importer !== f && importer !== ownTest && (spec.endsWith(`/${stem}.js`) || spec.endsWith(`/${stem}`)),
  );
  if (!imported) failures.push(posix(relative(ROOT, f)));
}

/**
 * KEEPERS - files a cleanup sweep must never remove, asserted by machine.
 *
 * #953 deleted 151 `*-honesty.ts` modules and kept 9. The keep-list existed only
 * as prose in docs/NITRO-L3-SLICE-FACTORY-LAW.md (removed), so nothing mechanically stopped
 * the next sweep from globbing `*-honesty.ts` and taking the survivors with it.
 * Four of these guard the agent money-tool deny lists: deleting one silently
 * removes a safety property while every other gate stays green - the exact shape
 * of failure this repo has now hit twice.
 *
 * A missing keeper is a hard failure, not a warning. If one is deliberately
 * retired, delete its line here in the same PR and say why in the body.
 */
const KEEPERS = [
  'packages/config/src/fiat-currency-honesty.ts',
  'packages/config/src/module-id-honesty.ts',
  'packages/config/src/marketing-language.ts',
  'packages/contracts/src/analytics-metric-honesty.ts',
  'services/svc-agents/src/copy-intel/money-deny-honesty.ts',
  'services/svc-agents/src/merchant/guardrail-honesty.ts',
  'services/svc-agents/src/navigator/money-deny-honesty.ts',
  'services/svc-agents/src/support-agent/money-deny-honesty.ts',
  'services/svc-identity/src/affiliates/commission-tier-honesty.ts',
  'services/svc-notify/src/channels/refusal-code-honesty.ts',
];

const missingKeepers = KEEPERS.filter((k) => !existsSync(join(ROOT, k)));
if (missingKeepers.length) {
  console.error(`\n  x REACHABILITY - ${missingKeepers.length} protected module(s) were deleted:\n`);
  for (const k of missingKeepers) console.error(`      ${k}`);
  console.error('\n  These import a live source and assert against it. Four guard agent money-tool');
  console.error('  deny lists - removing one drops a safety property with every other gate green.');
  console.error('  Never sweep by filename pattern. Restore them, or retire a line here with a reason.');
  console.error('  Law: docs/NITRO-L3-SLICE-FACTORY-LAW.md (removed), protected keep-list.\n');
  process.exit(1);
}

/** a parked module that gained a caller: the row is now stale and must go */
const freed = [...PARKED.keys()].filter((p) => !failures.includes(p));
const unparked = failures.filter((f) => !PARKED.has(f));

// A freed row warns rather than fails: a fix never fails the build (owner decision 2026-10-27).
for (const f of freed) {
  const msg = `PARKED module ${f} now has a caller. Good - delete its row from PARKED in tooling/ci/reachability-scan.mjs.`;
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Reachability::${msg}` : `  ! ${msg}`);
}

if (unparked.length) {
  const failures2 = unparked;
  failures.length = 0;
  failures.push(...failures2);
} else {
  console.log(`  reachability clean - ${sources.length} modules, 0 unreachable, ${PARKED.size} parked (built, specced, awaiting a caller)`);
  process.exit(0);
}

if (failures.length) {
  console.error(`\n  x REACHABILITY - ${failures.length} module(s) import nothing and are imported by nothing:\n`);
  for (const f of failures) console.error(`      ${f}`);
  console.error(
    [
      '',
      '  Each of these is unreachable: no code path leads to it, and it reads no',
      '  code either. A test asserting it is a test asserting itself.',
      '',
      '  Fix one of three ways:',
      '    - wire it: import it from the code that should use it;',
      '    - guard something real: import the live source it mirrors, assert on that;',
      '    - delete it.',
      '',
      '  Law: docs/NITRO-L3-SLICE-FACTORY-LAW.md (removed), Reachability law',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
console.log(`  reachability clean - ${sources.length} modules, 0 unreachable`);
