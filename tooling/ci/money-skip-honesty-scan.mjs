#!/usr/bin/env node
/**
 * MONEY SKIP HONESTY — D26-P2-13 seal.
 *
 * Skip-honesty-scan already forbids *new private probes* repo-wide. That is
 * necessary and not sufficient for money: a money suite can still grow a new
 * conditional skip (or a hard `it.skip`) that looks like coverage in turbo's
 * "N successful" line, without ever opening a private connection the other
 * gate knows how to see.
 *
 * This gate freezes the inventory of money-path skips forever:
 *
 *   · every skip under MONEY_PATH_ROOTS must be registered, or deleted
 *   · every register row must still skip (or the row is deleted)
 *   · private-probe rows must stay coupled to unreported-suites PRIVATE_PROBE
 *   · infra-journalled rows must still call a sanctioned probe
 *
 * Exit 0 = inventory matches the tree. Exit 1 = register or delete.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MONEY_PATH_ROOTS, MONEY_SKIP_REGISTER } from './money-skip-inventory.mjs';
import { PRIVATE_PROBE as UNREPORTED_PRIVATE } from './unreported-suites.mjs';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.git', 'vendor']);
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;

const SKIP_SHAPES = [
  /describe\.skipIf\s*\(/,
  /describe\.runIf\s*\(/,
  /\bit\.runIf\s*\(/,
  /\btest\.runIf\s*\(/,
  /\bit\.skipIf\s*\(/,
  /\btest\.skipIf\s*\(/,
  /describe\.skip\s*\(/,
  /\bit\.skip\s*\(/,
  /\btest\.skip\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /\bxtest\s*\(/,
  /\b(it|test|describe)\.concurrent\.skip(?:If)?\s*\(/,
  /\b(it|test|describe)\.skip\.each\s*\(/,
  /\b(it|test)\.todo\s*\(/,
  /\bthis\.skip\s*\(/,
  /=\s*[a-zA-Z_][\w.]*\s*\?\s*describe\s*:\s*describe\.skip/,
  /=\s*[^;\n]*\?\s*describe\.skip\s*:\s*describe/,
  /=\s*[a-zA-Z_][\w.]*\s*\?\s*(?:it|test)\s*:\s*(?:it|test)\.skip/,
  /=\s*[^;\n]*\?\s*(?:it|test)\.skip\s*:\s*(?:it|test)\b/,
];

const SANCTIONED = [/\bpostgresAvailable\b/, /\bdevChainReachable\b/, /\brecordInfraProbe\b/];

const PRIVATE_PROBE_SHAPES = [
  { re: /\bpostgres\s*\(\s*[^)]*connect_timeout/, what: 'its own Postgres connection with a connect timeout' },
  { re: /createPublicClient\s*\(/, what: 'its own JSON-RPC client' },
  { re: /\bconnect\s*\(\s*\{[^}]*servers\s*:/, what: 'its own NATS connection' },
];

/** Strip line + block comments so a probe name in a comment cannot fake honesty. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

function hasSkip(content) {
  return SKIP_SHAPES.some((re) => re.test(content));
}

function hasSanctioned(content) {
  return SANCTIONED.some((re) => re.test(content));
}

function privateProbeWhat(content) {
  for (const p of PRIVATE_PROBE_SHAPES) {
    if (p.re.test(content)) return p.what;
  }
  return null;
}

// ── Discovery ──────────────────────────────────────────────────────────────
const rooted = MONEY_PATH_ROOTS.filter((r) => existsSync(join(ROOT, r)));
if (rooted.length === 0) {
  console.error('\n✖ MONEY SKIP HONESTY FAILED — no money-path roots found under this checkout\n');
  console.error('  Expected at least one of:');
  for (const r of MONEY_PATH_ROOTS) console.error(`    · ${r}`);
  console.error('\n  A seal that walks nothing is not a seal. Restore the tree or fix MONEY_PATH_ROOTS.\n');
  process.exit(1);
}

/** @type {string[]} */
const files = [];
for (const r of rooted) walk(join(ROOT, r), files);
// Paid rows only warn (owner decision 2026-10-27), so roots that hold no test file must refuse on their own.
if (files.length === 0) {
  console.error('\n✖ MONEY SKIP HONESTY FAILED — the money-path roots hold no test file. A seal that walks nothing is not a seal.\n');
  process.exit(1);
}

/** @type {Map<string, string>} rel → stripped content for skipping files */
const skipping = new Map();
for (const file of files) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const content = stripComments(raw);
  if (!hasSkip(content)) continue;
  skipping.set(relative(ROOT, file).replace(/\\/g, '/'), content);
}

const register = new Map(MONEY_SKIP_REGISTER.map((e) => [e.file, e]));
const unreportedPrivate = new Set(UNREPORTED_PRIVATE.map((e) => e.file));

/** @type {string[]} */
const problems = [];
/** Rows whose skip is gone: debt paid. They warn so a fix never needs a gate PR (owner decision 2026-10-27). */
/** @type {string[]} */
const paid = [];

// Growth: skip not on register.
for (const rel of skipping.keys()) {
  if (!register.has(rel)) {
    problems.push(
      `${rel} skips but is not on tooling/ci/money-skip-inventory.mjs.\n` +
        '      Register it with a kind + why, or delete the skip. Money suites do not get silent absences.',
    );
  }
}

// Stale / misclassified rows.
for (const entry of MONEY_SKIP_REGISTER) {
  const full = join(ROOT, entry.file);
  if (!existsSync(full)) {
    paid.push(`${entry.file} is on the money-skip inventory but does not exist — delete the row.`);
    continue;
  }
  const content = skipping.get(entry.file);
  if (!content) {
    paid.push(`${entry.file} is on the money-skip inventory but no longer skips — debt paid; delete the row.`);
    continue;
  }

  const sanctioned = hasSanctioned(content);
  const privWhat = privateProbeWhat(content);

  if (entry.kind === 'infra-journalled') {
    if (!sanctioned) {
      problems.push(
        `${entry.file} is kind infra-journalled but does not call postgresAvailable / ` +
          'recordInfraProbe / devChainReachable — fix the suite or change the kind.',
      );
    }
    if (privWhat && !sanctioned) {
      problems.push(`${entry.file} still opens ${privWhat} while claiming infra-journalled.`);
    }
  } else if (entry.kind === 'private-probe') {
    if (!privWhat) {
      problems.push(
        `${entry.file} is kind private-probe but no private probe shape remains — ` +
          'if it now journals, change kind to infra-journalled or delete the skip; then prune unreported-suites.',
      );
    }
    if (!unreportedPrivate.has(entry.file)) {
      problems.push(
        `${entry.file} is money private-probe debt but missing from ` +
          'tooling/ci/unreported-suites.mjs PRIVATE_PROBE — keep both registers coupled.',
      );
    }
  } else if (entry.kind === 'pending') {
    if (!/\b(it|test)\.skip\s*\(/.test(content) && !/\bxit\s*\(/.test(content)) {
      problems.push(`${entry.file} is kind pending but has no hard it.skip / test.skip / xit — ` + 'delete the row or fix the kind.');
    }
  } else if (entry.kind === 'opaque') {
    if (!entry.why || entry.why.length < 20) {
      problems.push(`${entry.file} is kind opaque without a real why (≥20 chars) — name what lifts it.`);
    }
  } else {
    problems.push(`${entry.file} has unknown kind "${entry.kind}" — use infra-journalled|private-probe|pending|opaque.`);
  }

  if (!entry.why || entry.why.length < 12) {
    problems.push(`${entry.file} needs a real why on the inventory row.`);
  }
}

// Money files on unreported PRIVATE_PROBE must also be on this inventory as private-probe.
for (const e of UNREPORTED_PRIVATE) {
  if (!e.file.startsWith('services/svc-') && !e.file.startsWith('packages/ledger-client/')) continue;
  const underMoney = MONEY_PATH_ROOTS.some((r) => e.file === r || e.file.startsWith(r + '/'));
  if (!underMoney) continue;
  const row = register.get(e.file);
  if (!row) {
    problems.push(
      `${e.file} is on unreported PRIVATE_PROBE under a money root but missing from ` +
        'money-skip-inventory — register it as kind private-probe.',
    );
  } else if (row.kind !== 'private-probe') {
    problems.push(
      `${e.file} is on unreported PRIVATE_PROBE but money-skip inventory kind is ` +
        `"${row.kind}" — must be private-probe until the probe is journalled.`,
    );
  }
}

for (const p of paid) {
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Money skip inventory::${p}` : `! ${p}`);
}

if (problems.length > 0) {
  console.error(`\n✖ MONEY SKIP HONESTY FAILED — ${problems.length} problem(s) (D26-P2-13)\n`);
  for (const p of problems) console.error(`  · ${p}\n`);
  console.error('  Rule: on money paths, every skip is registered or deleted. The list cannot grow');
  console.error('  quietly and cannot outlive the skip it describes.\n');
  console.error('  Fix: edit tooling/ci/money-skip-inventory.mjs (and unreported-suites.mjs when');
  console.error('  the kind is private-probe), or remove the skip from the suite.\n');
  process.exit(1);
}

const byKind = { 'infra-journalled': 0, 'private-probe': 0, pending: 0, opaque: 0 };
for (const e of MONEY_SKIP_REGISTER) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

console.log(
  `✓ money-skip-honesty — ${MONEY_SKIP_REGISTER.length} registered money-path skip(s) ` +
    `(${byKind['infra-journalled']} journalled, ${byKind['private-probe']} private-probe debt, ` +
    `${byKind.pending} pending, ${byKind.opaque} opaque) across ${rooted.length}/${MONEY_PATH_ROOTS.length} roots, ` +
    `${files.length} test file(s) walked`,
);
