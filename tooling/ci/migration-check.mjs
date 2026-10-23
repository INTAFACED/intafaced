#!/usr/bin/env node
/**
 * MIGRATION CHECK — §14 DoD: "All schema migrations reversible and applied in CI."
 *
 * For every service with a drizzle output directory:
 *   1. Every `NNNN_name.sql` has a matching `NNNN_name.down.sql`.
 *   2. The journal is consistent with the files on disk.
 *   3. No migration silently drops a column or table without a marker comment —
 *      destructive changes are allowed, but they must be declared, because on a
 *      ledger a dropped column is a lost audit trail.
 *   4. A migration this change ADDS is named for the UTC time it was written,
 *      `YYYYMMDDHHMMSS_name.sql`, so two PRs never claim the same name and
 *      neither has to renumber when the other merges first.
 *
 *   node tooling/ci/migration-check.mjs --self-test   checks rule 4 on fixed cases
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SERVICES = join(ROOT, 'services');

/**
 * `DELETE FROM` was not on this list, and neither was constraint removal.
 *
 * A migration that deletes rows from the ledger was not destructive as far as
 * this gate was concerned — which is the one table in the platform where losing
 * rows is unrecoverable, because the book IS the rows. Dropping a CHECK or a
 * FOREIGN KEY is the same shape one level down: it destroys an invariant rather
 * than data, silently, and every row written afterwards is written without it.
 *
 * None of these are forbidden. They need the `-- intafaced:destructive <reason>`
 * acknowledgement, which is a sentence somebody has to write on purpose.
 */
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bDROP\s+(?:NOT\s+NULL|DEFAULT)\b/i,
  /\bDROP\s+(?:VIEW|TYPE|SEQUENCE)\b/i,
];

/**
 * Constraints and indexes that are dropped and NEVER PUT BACK.
 *
 * `DROP CONSTRAINT` cannot be a flat pattern here. Every migration in this repo
 * opens with the idempotent re-create idiom —
 *
 *     ALTER TABLE … DROP CONSTRAINT IF EXISTS "orders_hold_positive_ck";
 *     ALTER TABLE … ADD  CONSTRAINT        "orders_hold_positive_ck" CHECK (…);
 *
 * — so a flat rule flagged 28 of 48 migrations, none of which lose anything.
 * That is worse than no rule: a gate that fires on the house style trains
 * everyone to paste the acknowledgement without reading it, and then it is
 * decoration on the one migration that really does drop an invariant.
 *
 * So the check is the DIFFERENCE: dropped names minus restored names. A
 * constraint re-added under the SAME name in the SAME file is a re-create. One
 * that is not is a real loss and needs the acknowledgement — which is exactly
 * how `0006_paper_markets.sql` is caught, because it drops
 * `orders_hold_positive_ck` and adds `orders_hold_non_negative_ck`: a different
 * name, a genuinely relaxed rule, and previously invisible to this gate.
 */
function unrestoredDrops(sql) {
  const names = (re) => new Set([...sql.matchAll(re)].map((m) => m[1]));
  const droppedConstraints = names(/\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([\w.]+)"?/gi);
  const addedConstraints = names(/\bADD\s+CONSTRAINT\s+"?([\w.]+)"?/gi);
  const droppedIndexes = names(/\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?([\w."]+?)"?\s*;/gi);
  const createdIndexes = names(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w."]+?)"?\s+ON/gi);

  const bare = (n) => n.replace(/"/g, '').split('.').pop();
  const restored = new Set([...addedConstraints, ...createdIndexes].map(bare));
  return [...droppedConstraints, ...droppedIndexes].map(bare).filter((n) => !restored.has(n));
}

/**
 * A `.down.sql` that reverses nothing.
 *
 * Reversibility was decided by `up.replace(/\.sql$/, '.down.sql')` existing in a
 * filename set — the gate printed "all 48 migrations reversible" having never
 * OPENED a single down file. An empty file satisfied it. So did one holding
 * only a comment. "Reversible" meant "a file with the right name is present."
 *
 * This does not try to prove a down migration is CORRECT; nothing short of
 * running it against a real database can, and that is the integration suite's
 * job. It proves the weaker thing the filename check was silently claiming:
 * that the file contains at least one statement.
 */
const SQL_STATEMENT = /^\s*[A-Za-z]/m;

/** SQL comments, so a down file holding only an explanation does not read as a statement. */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}
const ACKNOWLEDGEMENT = /--\s*intafaced:destructive\b/i;

/** Migration file names under a service's drizzle dir on origin/main, or null when main is not fetched. */
function mainMigrations(service) {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', `services/${service}/drizzle/`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(
      out
        .split('\n')
        .map((l) => l.split('/').pop())
        .filter((f) => f && f.endsWith('.sql')),
    );
  } catch {
    return null;
  }
}

const migrationNumber = (file) => {
  const m = /^(\d+)_/.exec(file);
  return m ? Number(m[1]) : null;
};

/**
 * Rule 4, naming. Four-digit numbers (`0061_x.sql`) made every PR race for main's
 * next number: two open PRs in one service both took it, and whichever merged
 * second had to rename and rebase (svc-bank 0055/0056, svc-trade 0101,
 * svc-identity 0070-0074, 2026-10). A new migration is named for the UTC second
 * it was written instead. The runners apply every file not yet recorded, keyed
 * by name and in name order, so a timestamp sorts after every four-digit file
 * and two PRs' migrations both apply whichever merges first. A migration that
 * builds on a table another PR added must be stamped after that one; CI applies
 * every migration to an empty database in name order, so a wrong order fails
 * there, on the PR.
 *
 * A new four-digit name is still accepted while it is above main's highest, so a
 * PR opened before this rule keeps passing; once one has to be renumbered, it
 * takes a timestamp.
 */
const STAMPED = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+\.sql$/;
const LEGACY = /^\d{4}_/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Problems with the names of `ups` that are not on main. `onMain` is main's file names (null when main is not fetched). */
export function namingProblems(ups, onMain, now = Date.now()) {
  if (!onMain) return [];
  const legacyOnMain = [...onMain].filter((f) => LEGACY.test(f)).map(migrationNumber);
  const legacyHighest = legacyOnMain.length ? Math.max(...legacyOnMain) : -1;
  const stampedOnMain = [...onMain].some((f) => STAMPED.test(f));
  const out = [];
  for (const up of ups) {
    if (onMain.has(up)) continue;
    const m = STAMPED.exec(up);
    if (m) {
      const [, y, mo, d, h, mi, se] = m.map(Number);
      const at = Date.UTC(y, mo - 1, d, h, mi, se);
      const real = new Date(at).toISOString().replace(/\D/g, '').slice(0, 14) === up.slice(0, 14);
      if (!real) out.push({ file: up, problem: `${up.slice(0, 14)} is not a real UTC date and time (YYYYMMDDHHMMSS)` });
      else if (at > now + DAY_MS)
        out.push({ file: up, problem: `${up.slice(0, 14)} is in the future: stamp it with the UTC time you write it` });
      continue;
    }
    const n = LEGACY.test(up) ? migrationNumber(up) : null;
    if (n !== null && !stampedOnMain && n > legacyHighest) continue;
    out.push({
      file: up,
      problem:
        `name a new migration for the UTC time you write it, \`$(date -u +%Y%m%d%H%M%S)_<what>.sql\` with its .down.sql ` +
        `(lower-case name), so no other PR can claim the same number`,
    });
  }
  return out;
}

function selfTest() {
  const now = Date.UTC(2026, 9, 23, 22, 0, 0);
  const main = new Set(['0060_a.sql', '0061_b.sql']);
  const check = (ups, onMain = main) => namingProblems(ups, onMain, now).map((p) => p.file);
  const cases = [
    ['a stamped migration passes', check(['0060_a.sql', '0061_b.sql', '20261023213000_c.sql']), []],
    ['two PRs stamped out of merge order both pass', check(['20261023100000_x.sql'], new Set([...main, '20261023110000_y.sql'])), []],
    ['a four-digit name above main passes while main has no stamped one', check(['0062_c.sql']), []],
    ["a four-digit name at main's highest fails", check(['0061_c.sql']), ['0061_c.sql']],
    [
      'a four-digit name fails once main has a stamped one',
      check(['0099_c.sql'], new Set([...main, '20261023110000_y.sql'])),
      ['0099_c.sql'],
    ],
    ['a date that does not exist fails', check(['20261332000000_c.sql']), ['20261332000000_c.sql']],
    ['a stamp more than a day ahead fails', check(['20261025000000_c.sql']), ['20261025000000_c.sql']],
    ['an upper-case name fails', check(['20261023213000_Bad.sql']), ['20261023213000_Bad.sql']],
    ['files already on main are never judged', check(['0060_a.sql']), []],
    ['main not fetched judges nothing', check(['0001_c.sql'], null), []],
  ];
  let failed = 0;
  for (const [name, got, want] of cases) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✖'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  }
  if (failed) process.exit(1);
  console.log(`✓ migration-check --self-test OK (${cases.length} cases)`);
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

const problems = [];
let migrationsChecked = 0;
let servicesChecked = 0;
/** Reversal files actually OPENED — the number the old success line implied and never had. */
let downsRead = 0;

if (!existsSync(SERVICES)) {
  console.log('✓ migration-check — no services yet');
  process.exit(0);
}

for (const service of readdirSync(SERVICES)) {
  const drizzleDir = join(SERVICES, service, 'drizzle');
  if (!existsSync(drizzleDir) || !statSync(drizzleDir).isDirectory()) continue;
  servicesChecked++;

  const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'));
  const ups = files.filter((f) => !f.endsWith('.down.sql'));
  const downs = new Set(files.filter((f) => f.endsWith('.down.sql')));

  for (const up of ups) {
    migrationsChecked++;
    const expectedDown = up.replace(/\.sql$/, '.down.sql');

    if (!downs.has(expectedDown)) {
      problems.push({
        service,
        file: relative(ROOT, join(drizzleDir, up)),
        problem: `missing reversal — write ${expectedDown}`,
      });
    } else {
      // OPEN IT. The filename proved a file exists, never that it reverses
      // anything — see SQL_STATEMENT above.
      const downSql = stripSqlComments(readFileSync(join(drizzleDir, expectedDown), 'utf8'));
      downsRead++;
      if (!SQL_STATEMENT.test(downSql)) {
        problems.push({
          service,
          file: relative(ROOT, join(drizzleDir, expectedDown)),
          problem: 'reversal file contains no SQL — an empty .down.sql is not a reversal, it is a filename',
        });
      }
    }

    const sql = readFileSync(join(drizzleDir, up), 'utf8');
    const orphaned = unrestoredDrops(sql);
    const destructive =
      DESTRUCTIVE.find((p) => p.test(sql)) || (orphaned.length > 0 ? `dropped and not restored: ${orphaned.join(', ')}` : null);
    if (destructive && !ACKNOWLEDGEMENT.test(sql)) {
      problems.push({
        service,
        file: relative(ROOT, join(drizzleDir, up)),
        problem:
          'destructive statement without acknowledgement — add "-- intafaced:destructive <reason>" ' + 'at the top if this is intended',
      });
    }
  }

  // Naming: a migration absent from origin/main is stamped with the UTC time it was written.
  for (const { file, problem } of namingProblems(ups, mainMigrations(service))) {
    problems.push({ service, file: relative(ROOT, join(drizzleDir, file)), problem });
  }

  // Journal consistency.
  const journalPath = join(drizzleDir, 'meta', '_journal.json');
  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const entries = journal.entries ?? [];
    for (const entry of entries) {
      const tag = `${entry.tag}.sql`;
      if (!ups.includes(tag)) {
        problems.push({ service, file: relative(ROOT, journalPath), problem: `journal references missing migration ${tag}` });
      }
    }
    if (entries.length !== ups.length) {
      problems.push({
        service,
        file: relative(ROOT, journalPath),
        problem: `journal has ${entries.length} entries but ${ups.length} migration files exist`,
      });
    }
  }
}

if (problems.length > 0) {
  console.error(`\n✖ MIGRATION CHECK FAILED — ${problems.length} problem(s) (§14 DoD)\n`);
  for (const p of problems) {
    console.error(`  [${p.service}] ${p.file}`);
    console.error(`    → ${p.problem}\n`);
  }
  process.exit(1);
}

console.log(
  `\u2713 migration-check clean \u2014 ${migrationsChecked} migration(s) across ${servicesChecked} service(s), ` +
    `${downsRead} reversal file(s) opened and non-empty`,
);
