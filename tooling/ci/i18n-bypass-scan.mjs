#!/usr/bin/env node
/**
 * i18n BYPASS RATCHET — the `copy = {}` queue, counted and frozen.
 *
 * WHAT THIS IS ABOUT. `apps/web` does not use `@intafaced/i18n`. Every surface
 * declares a local `const copy = { … } as const` of English strings, each one
 * introduced by the same comment: "Placeholder for the i18n system being built
 * in a separate worktree." That worktree landed. The placeholder did not go
 * away, and — this is the part that matters — it became the pattern that every
 * new screen copies, because it is what the neighbouring file does.
 *
 * That is the failure mode this file exists to stop. Not the 164 strings that
 * are already there; the 165th.
 *
 * WHY A GATE AND NOT A MIGRATION. Moving the existing strings into the catalog
 * is not the mechanical job it looks like, for two reasons that are worth
 * writing down so nobody re-litigates it from scratch:
 *
 *   1. There is nothing to move them INTO yet. `@intafaced/i18n` is a pure data
 *      + function package with no React binding: no provider, no `useT()`, no
 *      locale negotiation in the Next.js request path, no way for a user to
 *      choose a language. Migrating today means inventing that adoption layer
 *      first, and that is a feature with a design, not a cleanup.
 *   2. English is the only catalog, and the standing instruction is English
 *      only. So the migration buys a user exactly nothing today, while touching
 *      164 strings — 24 of them in the order ticket, 27 in the protocol plane,
 *      11 in sign-in. Money-adjacent copy is product law. A "confirm withdrawal"
 *      that changes wording in transit is a real loss, and the odds of 164
 *      hand-moves being word-perfect are not good.
 *
 * So: freeze it, count it, and make the number only go down. This is not a TODO
 * pointing at "later" (§14.8) — the queue is enumerated below with exact counts,
 * it is enforced on every `pnpm verify`, and it cannot grow.
 *
 * HOW TO SHRINK IT. Key a file's strings into `packages/i18n/src/catalog.ts`,
 * render them through a translator, delete the `copy` object, and lower or
 * remove the file's row here. The scan tells you the exact number to write.
 *
 * Exit 0 = the queue is at or below baseline. Exit 1 = it grew, or a baseline
 * row is stale.
 *
 *   node tooling/ci/i18n-bypass-scan.mjs
 *
 * Related: `pnpm scan:i18n` is the fuzzy JSX-literal heuristic and stays
 * advisory. This one counts a specific named binding, so it has no false
 * positives and can block.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const APPS = join(ROOT, 'apps');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage', '__snapshots__']);

/**
 * THE QUEUE. Every file that still hardcodes copy, and how many strings it
 * holds. Frozen 2026-08-03 at 15 files / 164 strings.
 *
 * A file absent from this map may not have a `copy` object at all. A file
 * present may not have more strings than its number. Both directions are
 * enforced — a stale row that reads higher than reality is the same kind of
 * dishonesty this whole change is about.
 *
 * **EMPTY SINCE 2026-08-04, and that is a deletion, not an achievement.** All 15
 * rows were `apps/web` files and the directory was deleted with the one-surface
 * ADR. The 164 strings were not keyed into `@intafaced/i18n`; they went away with
 * the app that held them, so this queue draining to zero says nothing about
 * whether the product is translatable.
 *
 * The scan still runs and the queue is now CLOSED: any `.ts`/`.tsx` file under a
 * scanned root that introduces a `copy` object is a new bypass and fails. What it
 * does NOT cover is anything outside the scanned roots (the old Vue shell under
 * `vendor/` that this sentence once described was deleted 2026-10-19). Reading a green
 * result here as "the product has no hardcoded copy" is exactly the inference
 * this file exists to prevent.
 */
const BASELINE = {};

/** `apps/admin` is operator tooling — English-only by design (§14.6), same as the i18n scan. */
const ALLOWLIST = [{ path: join('apps', 'admin'), reason: 'operator console — internal tooling, English-only by design (§14.6)' }];

const COPY_BINDING = /\b(?:const|let|var)\s+copy\s*=\s*\{/;

function isAllowlisted(relPath) {
  return ALLOWLIST.some((entry) => relPath === entry.path || relPath.startsWith(entry.path + sep));
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) yield full;
  }
}

/**
 * The object literal that follows a `copy = {`, brace-matched with quote
 * awareness so a `{` inside a string (`'{count} results'`) does not end it.
 */
function extractObject(source, openBrace) {
  let depth = 0;
  let quote = null;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  return null;
}

/** How many string literals a `copy` object holds — the unit of the queue. */
function countStrings(objectSource) {
  return [...objectSource.matchAll(/:\s*'(?:[^'\\]|\\.)*'|:\s*"(?:[^"\\]|\\.)*"|:\s*`(?:[^`\\]|\\.)*`/g)].length;
}

const found = new Map();

/**
 * The denominator. `found` only counts files that carry a `copy` object, so it
 * is 0 both when the queue is genuinely clean and when the gate opened nothing
 * at all. Those are opposite facts and they printed the same line.
 */
let candidates = 0;
let inspected = 0;
const allowlisted = [];

for (const file of walk(APPS)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  candidates++;
  if (isAllowlisted(relative(ROOT, file))) {
    allowlisted.push(rel);
    continue;
  }
  inspected++;

  const source = readFileSync(file, 'utf8');
  const match = COPY_BINDING.exec(source);
  if (!match) continue;

  const object = extractObject(source, source.indexOf('{', match.index));
  if (object === null) {
    console.error(`  ✖ ${rel} — a \`copy = {\` object does not close. Fix the file, not the scan.`);
    process.exit(1);
  }
  found.set(rel, countStrings(object));
}

// ── Compare against the frozen queue ────────────────────────────────────────

const problems = [];

for (const [file, count] of found) {
  const allowed = BASELINE[file];
  if (allowed === undefined) {
    problems.push({
      file,
      severity: 'new',
      detail: `${count} hardcoded string(s) in a new \`copy\` object`,
      fix: 'Key these in packages/i18n/src/catalog.ts and render them with a translator. The bypass queue is closed to new files.',
    });
  } else if (count > allowed) {
    problems.push({
      file,
      severity: 'grew',
      detail: `${count} strings, baseline is ${allowed}`,
      fix: 'This file is already in the migration queue — adding to it makes the queue longer. Key the new strings instead.',
    });
  }
}

for (const [file, allowed] of Object.entries(BASELINE)) {
  const count = found.get(file);
  if (count === undefined) {
    problems.push({
      file,
      severity: 'stale',
      detail: `baseline claims ${allowed} strings; the file has no \`copy\` object`,
      fix: 'Migrated or deleted? Remove this row from BASELINE in tooling/ci/i18n-bypass-scan.mjs.',
    });
  } else if (count < allowed) {
    problems.push({
      file,
      severity: 'stale',
      detail: `baseline claims ${allowed} strings; the file has ${count}`,
      fix: `Good — the queue shrank. Lower this row to ${count} so the number stays true.`,
    });
  }
}

const total = [...found.values()].reduce((a, b) => a + b, 0);
const baselineTotal = Object.values(BASELINE).reduce((a, b) => a + b, 0);

/**
 * EMPTY DENOMINATOR — same defect as its sibling `i18n-scan.mjs`, same cause.
 * `apps/web` went in #757, the one project left under `apps/` is allowlisted in
 * full, so this gate walked zero un-allowlisted files and printed
 * "✓ i18n-bypass — 0 file(s), 0 hardcoded string(s), at the frozen baseline (0)".
 * Every number in that sentence is true and the sentence means nothing.
 *
 * An all-allowlisted scope is a declared state, so it stays exit 0 — but it
 * says so instead of claiming a clean baseline. A scope with no candidates at
 * all is undeclared, and that one fails.
 */
if (inspected === 0 && problems.length === 0) {
  if (candidates === 0) {
    console.error('\n✖ i18n-bypass — scope is EMPTY: apps/ exists but holds no .tsx file at all.\n');
    console.error('  A frozen baseline compared against nothing is not a frozen baseline.');
    process.exit(1);
  }
  console.log(`⚠ i18n-bypass INSPECTED NOTHING — 0 of ${candidates} candidate file(s) reached the check; all are allowlisted.`);
  for (const rel of allowlisted) console.log(`    allowlisted: ${rel}`);
  console.log(`  The frozen baseline (${baselineTotal}) was compared against an empty scan, not against a clean tree.`);
  console.log('  The gate re-arms by itself when an un-allowlisted surface lands under apps/.');
  process.exit(0);
}

if (problems.length === 0) {
  console.log(`✓ i18n-bypass — ${found.size} file(s), ${total} hardcoded string(s), at the frozen baseline (${baselineTotal})`);
  console.log(
    '  These bypass @intafaced/i18n. The queue cannot grow; see tooling/ci/i18n-bypass-scan.mjs for why it is a gate and not a migration.',
  );
  process.exit(0);
}

console.error(`\n✖ i18n-bypass — ${problems.length} problem(s). Queue is ${total} string(s) against a baseline of ${baselineTotal}.\n`);
for (const problem of problems) {
  console.error(`  ${problem.file}`);
  console.error(`    ${problem.detail}`);
  console.error(`    → ${problem.fix}\n`);
}
process.exit(1);
