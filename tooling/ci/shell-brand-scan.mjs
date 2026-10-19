#!/usr/bin/env node
/**
 * NARROWED 2026-10-13 (Nitro's decision), DELETED 2026-10-19: the legacy Vue customer
 * site (vendor 05_Web_Front, replaced by the React app apps/customer, #4511) was retired,
 * then removed from the tree; it is no longer built, deployed, gated or present. This scan
 * therefore no longer walks any Vue project root; it keeps only the vendored
 * Java CORS-adjacent half (CorsConfig / CorsAllowlist / CORS ApplicationConfig),
 * which is still shipped surface. The history below describes the original,
 * wider scope and is kept as the record of why the relaxed `\b` matters.
 *
 * SHELL BRAND SCAN — Doctrine §0.7 applied to the product surface, which
 * `brand-scan.mjs` has never once read.
 *
 * ── THE HOLE THIS FILLS, STATED PLAINLY ─────────────────────────────────────
 *
 * `brand-scan.mjs` carries `vendor` in its `SKIP_DIRS`. Its green line —
 * "clean — N files, 0 forbidden names" — has therefore never included a single
 * file of the shell. Every change to the shell that "passed brand-scan" passed
 * a scan that did not open it. That is not a weak gate; for this tree it is no
 * gate at all, and the shell is now the sole product surface, which makes it
 * the one place a partner's name is most likely to reach a user.
 *
 * Measured the first time this ran: 8 occurrences across 4 files, none of them
 * previously visible to any gate.
 *
 * ── WHY A SECOND SCAN RATHER THAN DELETING THAT SKIP ────────────────────────
 *
 * Removing `vendor` from `SKIP_DIRS` was measured before it was rejected. It
 * takes the repo-wide gate from 0 findings to 59, and 51 of those are not
 * product surface at all: compose bind-mount paths, a rebranding script whose
 * entire job is naming what it renames, a market seeder naming Java entity
 * classes and a Mongo database, and the upstream's own attribution documents.
 * Freezing those into the repo-wide ALLOWLIST would double the length of a file
 * ten branches append to, and would bury the eight findings that matter.
 *
 * The second reason is decisive on its own: `brand-scan.mjs`'s `EXTENSIONS`
 * list has no `.vue`. The product surface is 70 single-file components. Even
 * with the skip removed, the shell's actual user-facing markup would still go
 * unread. This scan adds `.vue`, and it can do that without changing what the
 * repo-wide number means for the other 1009 files.
 *
 * ── ONE LIST OF NAMES, NOT TWO ──────────────────────────────────────────────
 *
 * The forbidden names are not restated here. They are PARSED out of
 * `brand-scan.mjs` at run time, so a name added there is enforced here on the
 * same commit, and this file cannot drift into a weaker copy of the rule. If
 * that parse ever yields nothing, this scan FAILS rather than reporting a clean
 * tree it never checked.
 *
 * It also means no forbidden name appears in this file's source, so this file
 * needs no ALLOWLIST entry and stays scanned by the gate it extends. That was
 * deliberate: `brand-scan.mjs` bans the upstream's name in source with no CI
 * exemption, and buying an exemption in order to enforce the rule would be a
 * strange way to strengthen it. The same constraint is why the shell's path is
 * DISCOVERED below and never written down.
 *
 * ── WORD BOUNDARIES ARE RELAXED, AND THAT IS THE POINT ──────────────────────
 *
 * The repo-wide patterns are `\b`-anchored, which is right for our own code: we
 * never embed a vendor's name inside an identifier, so anchoring buys precision
 * for free. In a vendored tree the opposite holds — the name is INSIDE the
 * identifiers, the package names and the filenames. `README.md:1` is the proof:
 * its title carries the upstream name welded to a suffix by an underscore, and
 * `\b` cannot see it because `_` is a word character. Anchored, this scan finds
 * 7 hits; relaxed, 8. The eighth is the title of the product surface's README.
 *
 * Measured cost of relaxing: zero. Across 130 product-surface files the relaxed
 * patterns find the same 7 plus that one, and no false positive.
 *
 * ── WHY A FROZEN BASELINE AND NOT A FIX ─────────────────────────────────────
 *
 * An agent swarm owns this tree at the time of writing, and dual-editing a file
 * somebody else is mid-change on costs more than the day it saves. So this is a
 * RATCHET, the same instrument and the same rules as
 * `fabricated-money-scan.mjs` (deleted 2026-10-13): today's findings are frozen exactly, the queue
 * can only shrink, and the ninth occurrence fails the build today.
 *
 * This is not a TODO pointing at "later" (§14.8). Every frozen item is written
 * out below, it is enforced on every `pnpm verify`, and it cannot grow. Nothing
 * is ever ADDED to BASELINE to make a build green — a new name on the product
 * surface is fixed by not shipping it.
 *
 * ── WHY THE BASELINE IS HASHED ──────────────────────────────────────────────
 *
 * `fabricated-money-scan.mjs` (deleted 2026-10-13) freezes the exact matched TEXT, because naming
 * the string is the whole point of a ratchet — a count lets a fixed violation
 * and a fresh one cancel out silently. The same is wanted here, but the matched
 * text IS a forbidden name, and writing it down would make this file a
 * violation of the rule it enforces.
 *
 * So rows freeze `sha256(matched text)` truncated to 12 hex, which is exact,
 * order-free and countable in the same way, and carries a written note saying
 * what the string is in plain terms. This is a workaround for a naming ban, not
 * secrecy: the strings are in the tree, and every failure prints them in full.
 *
 * Line numbers are deliberately absent, for the reason the money scan gives:
 * they drift on every edit above them, and a baseline that goes stale for a
 * reason unrelated to branding is a baseline someone deletes.
 *
 * ── A SCAN THAT WALKS NOTHING IS A FAILURE, NOT A PASS ──────────────────────
 *
 * The bug that made this file necessary was a gate reporting success over a
 * tree it never opened. Refusing to repeat that is cheap. Four conditions exit
 * 1 rather than reporting clean: no forbidden names parsed, FEWER parsed than
 * the other file declares, no shell root discovered, or a root found and no
 * files read. A green tick over zero files is the one outcome this scan will
 * not produce — and all four branches have been run and seen to fire, which is
 * a different claim from having written them.
 *
 * Exit 0 = at or below the frozen baseline. Exit 1 = it grew, a row is stale,
 * or nothing was scanned.
 *
 * ── D26-P2-14: JAVA CORS-ADJACENT COPY ──────────────────────────────────────
 *
 * #1742 taught `brand-scan.mjs` to INCLUDE-walk Vue shell projects and Java
 * `src/main/resources` catalogues. That still skips `.java`. CORS filter /
 * allowlist classes sit under `00_framework/**` — a sibling of the Vue project,
 * not inside it — so this scan's Vue walk never opened them either. Partner
 * names in comments, string literals, or error copy on those files would have
 * shipped green. This scan now walks CORS-adjacent `.java` (filename matches
 * cors, or ApplicationConfig/ContextConfig whose body mentions cors).
 *
 * Package and import lines stay unread: those are load-bearing groupIds, not
 * copy, and renaming them is a Java rebrand mountain. A planted name in a
 * comment on CorsConfig.java fails. `--self-test` (also run on every gate)
 * plants that case in a throwaway tree so the hole cannot close itself.
 *
 *   node tooling/ci/shell-brand-scan.mjs
 *   node tooling/ci/shell-brand-scan.mjs --self-test
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const REPO_SCAN = join('tooling', 'ci', 'brand-scan.mjs');

const posix = (p) => p.split(sep).join('/');
const fingerprint = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

// ── The names, taken from the repo-wide gate rather than restated ───────────

/**
 * Pull `pattern: /…/flags` (and the `reason:` beside it) out of the FORBIDDEN
 * array in `brand-scan.mjs`.
 *
 * A source parse rather than an import, because `brand-scan.mjs` runs its scan
 * and calls `process.exit` at module scope — importing it would run the other
 * gate instead of reading its rules. A source parse rather than a copy, because
 * a copy is a second list, and a second list is one somebody forgets.
 *
 * The failure direction is safe: if the shape of that file changes, this parse
 * finds fewer names or none, and finding none is a hard failure below rather
 * than a clean report.
 */
function forbiddenFromRepoScan() {
  const src = readFileSync(join(ROOT, REPO_SCAN), 'utf8');
  const block = /const FORBIDDEN\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!block) return { rules: [], declared: 0 };

  /**
   * How many names the other file MEANT to declare, counted independently of
   * whether this parse can read them.
   *
   * Without this, drift is silent in the one direction that matters: the
   * extractor below reads regex LITERALS only, so a name declared any other way
   * is counted by nobody and enforced by nobody, and this scan still prints a
   * green tick over the shorter list.
   *
   * The realistic case is `pattern: new RegExp(…)` — a computed or composed
   * pattern, which is how a list like this usually grows once it gets long. A
   * `pattern: SOME_CONST` reference behaves the same way. (A URL in a literal
   * does NOT: `/` inside a regex literal must be written `\/`, and the extractor
   * handles escapes. That was the first guess when this guard was written, and
   * testing it disproved it — the guard stayed because the real cause is worse,
   * being the one that arrives when someone tidies the list.)
   *
   * "Parsed some" and "parsed all" are not the same claim, so they are not
   * allowed to look the same. A mismatch is a hard failure at the call site.
   */
  const declared = (block[1].match(/^\s*(?:\{\s*)?pattern:/gm) ?? []).length;

  const out = [];
  const declaration = /pattern:\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/g;
  let m;
  while ((m = declaration.exec(block[1])) !== null) {
    const [, source, flags] = m;
    // The reason sits after the pattern in the same object literal; take the
    // first quoted string within a short window and fall back if it is written
    // some other way. A missing reason must not lose the pattern.
    const tail = block[1].slice(m.index, m.index + 600);
    const reason = /reason:\s*(?:'([^']*)'|"([^"]*)")/.exec(tail);
    out.push({
      // `\b` removed: see the header. A vendored tree welds the name into
      // identifiers, and that is exactly where the anchor stops working.
      //
      // Deliberately NOT global. A `g` regex carries `lastIndex` between calls,
      // so a shared one used for a whole-file `.test()` starts the next file
      // part-way through and silently misses early matches. That cost this scan
      // one of its eight findings on the first run — the package name on line 2
      // of the manifest, missed because the lockfile scanned before it left the
      // cursor past it. The per-line global copy is built fresh below.
      pattern: new RegExp(source.replace(/\\b/g, ''), flags.replace('g', '')),
      reason: (reason && (reason[1] ?? reason[2])) || `forbidden name declared in ${posix(REPO_SCAN)}`,
    });
  }
  return { rules: out, declared };
}

// ── The surface, discovered rather than named ───────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', 'drizzle', '.docker-data', 'target', 'build']);

/**
 * Java CORS surface: sibling of the Vue project, never inside it.
 *
 * Filename `/cors/i`, or Spring `ApplicationConfig` / `ContextConfig` whose
 * body mentions cors (the files that actually register the filter). Unrelated
 * `.java` stays unread — that is the vendor-java-money / dual-book mountain,
 * not this gate.
 */
const CORS_JAVA_NAME = /cors/i;
const CORS_CONFIG_CLASS = /^(ApplicationConfig|ContextConfig)\.java$/i;

function collectCorsAdjacentJava(vendorRoot, out = [], depth = 0) {
  if (depth > 16 || !existsSync(vendorRoot)) return out;
  let entries;
  try {
    entries = readdirSync(vendorRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(vendorRoot, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      collectCorsAdjacentJava(full, out, depth + 1);
      continue;
    }
    if (!name.endsWith('.java')) continue;
    if (CORS_JAVA_NAME.test(name)) {
      out.push(full);
      continue;
    }
    if (CORS_CONFIG_CLASS.test(name)) {
      try {
        if (/cors/i.test(readFileSync(full, 'utf8'))) out.push(full);
      } catch {
        /* unreadable */
      }
    }
  }
  return out;
}

/** Load-bearing groupId / type names — not user-facing copy. */
function isJavaIdentityLine(line) {
  return /^\s*(?:package|import)\s+/.test(line);
}

function scanFileHits(file, repoRoot, rules, { javaIdentity }) {
  const reported = posix(relative(repoRoot, file));
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const hits = [];
  for (const { pattern, reason } of rules) {
    if (!pattern.test(content)) continue;
    const perLine = new RegExp(pattern.source, pattern.flags + 'g');
    lines.forEach((line, i) => {
      if (javaIdentity && isJavaIdentityLine(line)) return;
      for (const match of line.matchAll(perLine)) {
        hits.push({
          key: reported,
          reported,
          line: i + 1,
          text: match[0],
          fp: fingerprint(match[0]),
          reason,
          context: line.trim().slice(0, 120),
        });
      }
    });
  }
  return hits;
}

function plantToken(rules) {
  for (const r of rules) {
    const m = r.pattern.source.match(/[A-Za-z][A-Za-z0-9]{3,}/);
    if (m) return m[0];
  }
  return null;
}

/**
 * Hermetic proof that a partner name in CORS Java fails, and that a package-line identity does not force a rebrand.
 */
function selfTest(rules) {
  const fails = [];
  const assert = (c, m) => {
    if (!c) fails.push(m);
  };
  const plant = plantToken(rules);
  assert(Boolean(plant), 'could not derive a plant token from parsed forbidden names');

  const tmp = mkdtempSync(join(tmpdir(), 'shell-brand-p214-'));
  try {
    const vendor = join(tmp, 'vendor');
    const corsDir = join(vendor, 'ex', '00_framework', 'core', 'src', 'main', 'java', 'com', 'example', 'config');
    const daoDir = join(vendor, 'ex', '00_framework', 'core', 'src', 'main', 'java', 'com', 'example', 'dao');
    mkdirSync(corsDir, { recursive: true });
    mkdirSync(daoDir, { recursive: true });
    writeFileSync(
      join(corsDir, 'CorsConfig.java'),
      `package com.example.config;\n/** partner ${plant} must not hide in CORS copy */\npublic class CorsConfig {}\n`,
    );
    writeFileSync(
      join(daoDir, 'WalletDao.java'),
      `package com.example.dao;\n/** partner ${plant} in a non-CORS Java file */\npublic class WalletDao {}\n`,
    );
    writeFileSync(join(corsDir, 'CorsAllowlist.java'), `package com.${plant}.util;\npublic final class CorsAllowlist {}\n`);

    const corsFiles = collectCorsAdjacentJava(vendor);
    assert(
      corsFiles.some((f) => f.endsWith('CorsConfig.java')),
      'CORS-adjacent walk must include CorsConfig.java',
    );
    assert(
      corsFiles.some((f) => f.endsWith('CorsAllowlist.java')),
      'CORS-adjacent walk must include CorsAllowlist.java',
    );
    assert(!corsFiles.some((f) => f.endsWith('WalletDao.java')), 'CORS-adjacent walk must not swallow unrelated Java');

    const corsHits = corsFiles.flatMap((file) => scanFileHits(file, tmp, rules, { javaIdentity: true }));
    assert(
      corsHits.some((h) => h.text.includes(plant) && /CorsConfig\.java$/.test(h.reported)),
      'planted partner name in CORS Java must fail the scan',
    );
    assert(!corsHits.some((h) => /CorsAllowlist\.java$/.test(h.reported)), 'package/import identity lines must not force a Java rebrand');
    assert(!corsHits.some((h) => /WalletDao\.java$/.test(h.reported)), 'planted name in non-CORS Java must remain out of this gate');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (fails.length) {
    console.error('\n✖ shell-brand-scan --self-test FAIL:');
    for (const f of fails) console.error(`  · ${f}`);
    console.error('');
    process.exit(1);
  }
}

/**
 * THE FROZEN QUEUE. Every forbidden name on the product surface today, by the
 * `sha256`-12 fingerprint of the exact text that matched. Frozen 2026-08-03 at
 * 4 files / 8 occurrences.
 *
 * Keys are repo-relative paths (the Vue project root, whose rows were keyed
 * project-relative, is no longer walked — see the NARROWED note at the top).
 * Findings are REPORTED at their repo-relative path, because a path you cannot
 * paste into an editor is not a report.
 *
 * Not fixed here, on purpose: an agent swarm owns this tree, and the four files
 * below are the shell's manifest, lockfile, README and dev-server config —
 * three of which a rename touches anyway. The debt is named so the owner can
 * clear it; delete each row as it goes. Two of the eight are OURS, not the
 * upstream's: the container name in the dev-server config comments was coined
 * by us and welds the vendor's name to our own.
 *
 * A file absent from this map may hold no findings at all. A file present may
 * hold no findings its row does not name. Both directions are enforced, and by
 * multiset — two identical names freeze two rows, so a third is still a
 * failure.
 *
 * @type {Record<string, { fp: string, note: string }[]>}
 */
/* Queue drained 2026-08-09 (L11 wave 5): package/README/config renames.
   A new product-surface hit must be fixed, never re-frozen here. */
const BASELINE = {};

// ── Run ────────────────────────────────────────────────────────────────────

const { rules: FORBIDDEN, declared: DECLARED } = forbiddenFromRepoScan();

/**
 * Four ways this scan can be looking at nothing, or at less than it claims, and
 * all four are failures. A gate that passes over an empty tree is precisely the
 * defect this file exists to remove, so it is refused here rather than reported
 * cheerfully.
 */
if (FORBIDDEN.length === 0) {
  console.error(`\n✖ shell-brand-scan — parsed 0 forbidden names out of ${posix(REPO_SCAN)}.`);
  console.error('  This scan takes its rules from that file and has none. It is not clean; it is blind.');
  console.error('  Fix the FORBIDDEN parse in forbiddenFromRepoScan(), do not ignore this line.\n');
  process.exit(1);
}

if (FORBIDDEN.length !== DECLARED) {
  console.error(`\n✖ shell-brand-scan — ${posix(REPO_SCAN)} declares ${DECLARED} forbidden name(s); this parse read ${FORBIDDEN.length}.`);
  console.error('  Partial is worse than none, because it still prints a green tick over the shorter list.');
  console.error('  The usual cause is a name declared as `new RegExp(…)` or as a reference rather than as a');
  console.error('  regex literal — the extractor reads literals only.');
  console.error('  Fix forbiddenFromRepoScan() until the two numbers agree — do not lower the expectation.\n');
  process.exit(1);
}

selfTest(FORBIDDEN);
if (process.argv.includes('--self-test')) {
  console.log('✓ shell-brand-scan --self-test OK');
  console.log('  planted partner name in CORS Java fails; package identity skipped; unrelated Java unread');
  process.exit(0);
}

const findings = [];
let scanned = 0;

const vendorRoot = join(ROOT, 'vendor');
const corsFiles = collectCorsAdjacentJava(vendorRoot);
if (!existsSync(vendorRoot)) {
  console.error('\n✖ shell-brand-scan — no vendor/ tree found. NOTHING WAS SCANNED.');
  console.error(
    '  If the vendored Java CORS surface still exists, discovery is broken. If it is genuinely gone, delete this gate deliberately rather than leaving it green over nothing.\n',
  );
  process.exit(1);
}
if (corsFiles.length === 0) {
  console.error('\n✖ shell-brand-scan — vendor/ is present but 0 Java CORS-adjacent files were found.');
  console.error('  D26-P2-14: CorsConfig / CorsAllowlist / CORS ApplicationConfig must be in scope.');
  console.error('  Check collectCorsAdjacentJava() — discovery is blind.\n');
  process.exit(1);
}

for (const file of corsFiles) {
  scanned++;
  for (const hit of scanFileHits(file, ROOT, FORBIDDEN, { javaIdentity: true })) {
    findings.push(hit);
  }
}

// ── Compare against the frozen queue ───────────────────────────────────────

const byFile = new Map();
for (const hit of findings) {
  if (!byFile.has(hit.key)) byFile.set(hit.key, []);
  byFile.get(hit.key).push(hit);
}

const problems = [];

for (const [key, hits] of byFile) {
  const remaining = (BASELINE[key] ?? []).map((row) => row.fp);
  for (const hit of hits) {
    const at = remaining.indexOf(hit.fp);
    if (at >= 0) remaining.splice(at, 1);
    else problems.push({ severity: 'new', ...hit });
  }
}

for (const [key, frozen] of Object.entries(BASELINE)) {
  const hits = byFile.get(key) ?? [];
  const remaining = hits.map((h) => h.fp);
  for (const row of frozen) {
    const at = remaining.indexOf(row.fp);
    if (at >= 0) remaining.splice(at, 1);
    else problems.push({ severity: 'stale', key, reported: hits[0]?.reported ?? key, fp: row.fp, note: row.note });
  }
}

const frozenTotal = Object.values(BASELINE).reduce((n, rows) => n + rows.length, 0);

if (problems.length === 0) {
  console.log(
    `✓ shell-brand-scan — ${scanned} Java CORS-adjacent file(s), ${FORBIDDEN.length} forbidden name(s) checked, all findings at the frozen baseline`,
  );
  for (const [key, rows] of Object.entries(BASELINE)) {
    const where = byFile.get(key)?.[0]?.reported ?? key;
    console.log(`  ⚠ ${where} — ${rows.length}: ${rows.map((r) => r.note).join('; ')}`);
  }
  // `gates.mjs` prints only the LAST non-empty line as a gate's summary, so the
  // debt has to be on it. A green tick over an unnamed eight is how a frozen
  // queue becomes a forgotten one.
  console.log(
    `  ⚠ ${frozenTotal} forbidden name(s) frozen across ${Object.keys(BASELINE).length} file(s) — the queue cannot grow. ` +
      'User-facing copy says only: Identity Blueprint · Sovereign Intelligence · Neural Engine.',
  );
  process.exit(0);
}

const grew = problems.filter((p) => p.severity === 'new');
const stale = problems.filter((p) => p.severity === 'stale');

console.error(
  `\n✖ SHELL BRAND SCAN FAILED — ${problems.length} problem(s). ${findings.length} finding(s) against a frozen baseline of ${frozenTotal}.\n`,
);

for (const p of grew) {
  console.error(`  ${p.reported}:${p.line}`);
  console.error(`    ${p.context}`);
  console.error(`    → ${p.reason}`);
  console.error(
    '    → This is the product surface. Remove the name; do NOT add a row to BASELINE —\n' +
      `      that map is a record of debt that predates this gate. (fingerprint ${p.fp})\n`,
  );
}

for (const p of stale) {
  console.error(`  ${p.reported}`);
  console.error(`    baseline freezes ${p.fp} — ${p.note} — which is no longer there`);
  console.error('    → Good — the queue shrank. Delete that row from BASELINE in tooling/ci/shell-brand-scan.mjs.\n');
}

console.error('  User-facing copy says only: Identity Blueprint · Sovereign Intelligence · Neural Engine.\n');
process.exit(1);
