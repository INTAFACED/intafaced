/**
 * svc-ledger's two source scans, held against the Rust service (`crates/svc-ledger`) once the TypeScript one is gone.
 *
 * 1. `services/svc-ledger/src/dual-book-scan.test.ts`, case for case: the one book. The scanner below is that file's,
 *    rule for rule; it now walks `crates/svc-ledger/migrations` (SQL), `src` (Rust) and `scripts` (JavaScript), and
 *    reads Rust through a comment stripper that keeps strings (a lifetime is not a quote), so SQL a Rust string holds is
 *    scanned and a comment is not.
 * 2. `services/svc-ledger/src/db/assets-decimals.test.ts`, case for case: `assets.decimals` is read by no production code
 *    in the ledger (`crates/svc-ledger/src`) or `packages/ledger-client/src`, and every seeded scale is one the ledger
 *    cannot honour yet (storage is numeric(38,18)). It is a tripwire on an open product question: the moment code reads the
 *    column, decide where the sub-unit remainder goes first. Delete this half once that policy is written down.
 *
 * Usage: node --test tooling/ci/svc-ledger-source-scans.test.mjs   (run on every PR by tooling/scripts/tooling-tests.mjs)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICE_ROOT = join(REPO, 'crates', 'svc-ledger');
const MIGRATIONS = join(SERVICE_ROOT, 'migrations');

/**
 * Rust with its comments removed and its strings, raw strings and char literals kept: `//` to the line's end, nested
 * `/* *\/` blocks, `"…"` with escapes, `r#"…"#`, and `'x'` / `'\\n'` told apart from a lifetime (`'a`).
 */
export function stripRustCommentsKeepStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += ' ';
      continue;
    }
    const raw = /^r(#*)"/.exec(source.slice(i, i + 260));
    if (raw && !/[\w]/.test(source[i - 1] ?? '')) {
      const close = '"' + raw[1];
      const end = source.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? n : end + close.length;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const lit = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/u.exec(source.slice(i, i + 16));
      if (lit) {
        out += lit[0];
        i += lit[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── 1. the one book (dual-book-scan.test.ts) ─────────────────────────────────────────────────────────────────────────

/** The one book. `__migrations` is the runner’s apply log, not a balance. */
const ONE_BOOK_TABLES = new Set([
  'assets',
  'accounts',
  'ledger_tx',
  'ledger_entries',
  'balance_snapshots',
  'chain_tip',
  'posting_freeze',
  '__migrations',
  // Emit log for ledgerTxPosted (same tx as the book). Not a second balance store.
  'ledger_tx_outbox',
  // Emit log for ledgerFreezeUpdated (same transaction as posting_freeze). Not a second balance store.
  'ledger_freeze_outbox',
  // Append-only idempotency claim (idempotency_key, tx_id). Not a second balance store.
  'ledger_posted_keys',
  // One row per reconciliation attempt (ok / mismatch / incomplete) with the tip it covered. Proof history, holds no balance.
  'reconcile_runs',
  // One row per operator read of an owner's balances (actor, target, time). Append-only read audit, holds no balance.
  'operator_access_log',
  // One row per applied founder edit of the asset registry (who proposed, approved, sent). Append-only, holds no balance.
  'asset_edits',
  // Operator reconciliation controls, their append-only audit, and run rows (OPS-reconciliation-01). No balance is stored.
  'reconciliation_controls',
  'reconciliation_control_audit',
  'reconciliation_control_runs',
  // Operator labels on an account and their append-only change record (0029, OPS-ledger-desk-01). Text only, no balance.
  'account_metadata',
  'account_metadata_changes',
]);

const JAVA_WALLET_IDS = [
  { id: 'member_wallet', re: /\bmember_wallet\b/i, why: 'Java member_wallet table' },
  { id: 'MemberWallet', re: /\bMemberWallet(?:Dao|Service)?\b/, why: 'Java MemberWallet entity' },
  { id: 'increaseBalance', re: /\bincreaseBalance\s*\(/, why: 'Java wallet mutator' },
  { id: 'decreaseBalance', re: /\bdecreaseBalance\s*\(/, why: 'Java wallet mutator' },
  { id: 'freezeBalance', re: /\bfreezeBalance\s*\(/, why: 'Java wallet mutator' },
  { id: 'thawBalance', re: /\bthawBalance\s*\(/, why: 'Java wallet mutator' },
  { id: 'legal_wallet', re: /\blegal_wallet\b/i, why: 'Java legal-wallet table' },
  { id: 'heldBalances', re: /\bheldBalances\b/, why: 'service-held balance map' },
  { id: 'serviceHeldBalance', re: /\bserviceHeldBalance/, why: 'service-held balance' },
];

const CREATE_TABLE =
  /CREATE\s+(?:(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMPORARY|TEMP)\s+|UNLOGGED\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:"([^"]+)"|([A-Za-z_][\w]*))\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w]*))/gi;

/**
 * Postgres: CREATE [ [ GLOBAL | LOCAL ] { TEMPORARY | TEMP } | UNLOGGED ] TABLE.
 * LOCAL and GLOBAL apply to temp only. UNLOGGED is a real table, never scratch.
 */
const SESSION_TEMP = /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMPORARY|TEMP)\s+TABLE\b/i;
const BALANCE_BOOK_NAME = /(?:^|_)(?:balances?|wallets?)(?:_|$)/i;
/** balance, balances, balance_after, cash_balance, and the same prefix/suffix shape. */
const BALANCE_COLUMN_NAME = /^(?:[A-Za-z_][\w]*_)?balances?(?:_[A-Za-z_][\w]*)?$/i;
const RELATION_NAME = /(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w]*))/;

const DRIZZLE_TABLE = /\.table\(\s*['"]([^'"]+)['"]/g;
const PG_TABLE = /\bpgTable\(\s*['"]([^'"]+)['"]/g;
const PG_SCHEMA = /\bpgSchema\(\s*['"]([^'"]+)['"]/g;
const CREATE_SCHEMA = /CREATE\s+SCHEMA(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][\w]*))/gi;

function stripSqlComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function stripTsCommentsKeepStrings(source) {
  const literals = [];
  const masked = source.replace(/(['"`])(?:\\.|[^\\])*?\1/g, (s) => {
    literals.push(s);
    return `"\uE000${literals.length - 1}\uE000"`;
  });
  const decommented = masked.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return decommented.replace(/"\uE000(\d+)\uE000"/g, (_, i) => literals[Number(i)] ?? '');
}

/** A semicolon inside quotes does not end the statement. */
function statementUntilSemicolon(afterName) {
  let i = 0;
  let quote = null;
  while (i < afterName.length) {
    const c = afterName[i];
    if (quote) {
      if (c === quote) {
        if (afterName[i + 1] === quote) {
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === ';') break;
    i += 1;
  }
  return afterName.slice(0, i);
}

function stripSingleQuoted(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "'") {
      out += source[i];
      i += 1;
      continue;
    }
    i += 1;
    while (i < source.length) {
      if (source[i] === "'") {
        if (source[i + 1] === "'") {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      i += 1;
    }
    out += ' ';
  }
  return out;
}

function isBalanceColumnName(name) {
  return BALANCE_COLUMN_NAME.test(name);
}

function namesBalanceWalletOrOneBook(name) {
  return name != null && (ONE_BOOK_TABLES.has(name) || BALANCE_BOOK_NAME.test(name));
}

function relationKeywordHitsBook(stmt, keyword) {
  const re = new RegExp(`\\b${keyword}\\s+(?:ONLY\\s+)?${RELATION_NAME.source}`, 'gi');
  for (const m of stmt.matchAll(re)) {
    if (namesBalanceWalletOrOneBook(m[1] ?? m[2])) return true;
  }
  return false;
}

/**
 * Ledger session temp is scratch only when the name is not a balance, wallet,
 * or one-book table, the column list has no balance column, and the statement
 * is not LIKE or AS SELECT of a balance, wallet, or one-book table.
 * A temp table in any other schema is never scratch.
 */
function isLedgerScratchTemp(table, afterName) {
  if (ONE_BOOK_TABLES.has(table) || BALANCE_BOOK_NAME.test(table)) return false;
  const stmt = stripSingleQuoted(statementUntilSemicolon(afterName));
  const ident = /[A-Za-z_][\w]*/g;
  for (const m of stmt.matchAll(ident)) {
    if (isBalanceColumnName(m[0])) return false;
  }
  if (relationKeywordHitsBook(stmt, 'LIKE')) return false;
  if (/\bAS\s+(?:\(\s*)?SELECT\b/i.test(stmt) && (relationKeywordHitsBook(stmt, 'FROM') || relationKeywordHitsBook(stmt, 'JOIN'))) {
    return false;
  }
  return true;
}

function excerptAt(text, index) {
  return text
    .slice(Math.max(0, index - 24), Math.min(text.length, index + 48))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scan one source blob. Kind picks the comment stripper: `sql`, `ts` (TypeScript and JavaScript) or `rs` (Rust). */
export function scanDualBookText(text, kind) {
  const body =
    kind === 'sql' ? stripSqlComments(text) : kind === 'rs' ? stripRustCommentsKeepStrings(text) : stripTsCommentsKeepStrings(text);
  const hits = [];

  for (const rule of JAVA_WALLET_IDS) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(body);
    if (m) hits.push({ id: rule.id, why: rule.why, excerpt: excerptAt(body, m.index) });
  }

  CREATE_TABLE.lastIndex = 0;
  for (const m of body.matchAll(CREATE_TABLE)) {
    const schema = m[1] ?? m[2] ?? 'ledger';
    const table = m[3] ?? m[4];
    if (!table) continue;
    const sessionTemp = SESSION_TEMP.test(m[0]);
    if (sessionTemp && schema === 'ledger' && isLedgerScratchTemp(table, body.slice(m.index + m[0].length))) continue;
    if (schema !== 'ledger') {
      hits.push({
        id: `schema:${schema}.${table}`,
        why: 'table outside ledger schema',
        excerpt: excerptAt(body, m.index),
      });
    }
    if (!ONE_BOOK_TABLES.has(table) || sessionTemp) {
      hits.push({
        id: `table:${table}`,
        why: sessionTemp && ONE_BOOK_TABLES.has(table) ? 'temp table shadows the one book' : 'CREATE TABLE is not the one book',
        excerpt: excerptAt(body, m.index),
      });
    }
  }

  if (kind !== 'sql') {
    DRIZZLE_TABLE.lastIndex = 0;
    for (const m of body.matchAll(DRIZZLE_TABLE)) {
      const table = m[1];
      if (!ONE_BOOK_TABLES.has(table)) {
        hits.push({ id: `drizzle:${table}`, why: 'drizzle table is not the one book', excerpt: excerptAt(body, m.index) });
      }
    }
    PG_TABLE.lastIndex = 0;
    for (const m of body.matchAll(PG_TABLE)) {
      hits.push({ id: `pgTable:${m[1]}`, why: 'pgTable (public schema) is a second book', excerpt: excerptAt(body, m.index) });
    }
    PG_SCHEMA.lastIndex = 0;
    for (const m of body.matchAll(PG_SCHEMA)) {
      if (m[1] !== 'ledger') {
        hits.push({ id: `pgSchema:${m[1]}`, why: 'schema other than ledger', excerpt: excerptAt(body, m.index) });
      }
    }
  }

  CREATE_SCHEMA.lastIndex = 0;
  for (const m of body.matchAll(CREATE_SCHEMA)) {
    const schema = m[1] ?? m[2];
    if (schema && schema !== 'ledger') {
      hits.push({ id: `createSchema:${schema}`, why: 'CREATE SCHEMA besides ledger', excerpt: excerptAt(body, m.index) });
    }
  }

  return hits;
}

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage' || name === 'target') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, pred, out);
    else if (pred(name, full)) out.push(full);
  }
  return out;
}

const kindOf = (file) => (file.endsWith('.sql') ? 'sql' : file.endsWith('.rs') ? 'rs' : 'ts');

function scanProductionTree() {
  const files = [
    ...walk(MIGRATIONS, (n) => n.endsWith('.sql')),
    ...walk(join(SERVICE_ROOT, 'scripts'), (n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')),
    ...walk(join(SERVICE_ROOT, 'src'), (n) => n.endsWith('.rs')),
  ];
  const java = walk(SERVICE_ROOT, (n) => n.endsWith('.java'));
  const hits = [];
  for (const file of java) {
    hits.push({ file: relative(SERVICE_ROOT, file).replace(/\\/g, '/'), id: 'java-file', why: 'Java source in svc-ledger', excerpt: file });
  }
  for (const file of files) {
    const rel = relative(SERVICE_ROOT, file).replace(/\\/g, '/');
    for (const hit of scanDualBookText(readFileSync(file, 'utf8'), kindOf(file))) hits.push({ file: rel, ...hit });
  }
  return { files: files.length, hits };
}

function createdOneBookTables() {
  const names = new Set();
  const files = [
    ...walk(MIGRATIONS, (n) => n.endsWith('.sql') && !n.endsWith('.down.sql')),
    ...walk(join(SERVICE_ROOT, 'src'), (n) => n === 'migrate.rs'),
  ];
  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w]*))/gi;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const body = file.endsWith('.rs') ? stripRustCommentsKeepStrings(text) : stripSqlComments(text);
    for (const m of body.matchAll(re)) {
      const table = m[1] ?? m[2];
      if (table) names.add(table);
    }
  }
  return names;
}

test('scanner refuses a planted Java wallet table (fail-closed)', () => {
  const hits = scanDualBookText('CREATE TABLE IF NOT EXISTS member_wallet (id bigint, balance numeric);', 'sql');
  assert.ok(hits.some((h) => h.id === 'member_wallet' || h.id === 'table:member_wallet'));
});

test('scanner refuses a planted extra ledger table', () => {
  const hits = scanDualBookText('CREATE TABLE "ledger"."user_wallets" (balance numeric);', 'sql');
  assert.ok(hits.some((h) => h.id === 'table:user_wallets'));
});

test('scanner sees a second balance table written unlogged, temp, or temporary', () => {
  const hits = scanDualBookText(
    [
      'CREATE UNLOGGED TABLE "ledger"."shadow_balances" (balance numeric);',
      'CREATE TEMP TABLE session_wallet (balance numeric);',
      'CREATE TEMPORARY TABLE IF NOT EXISTS pay.held_balances (owner text, amount numeric);',
      'CREATE TEMP TABLE import_batch (row_no int, payload text);',
    ].join('\n'),
    'sql',
  );
  assert.ok(hits.some((h) => h.id === 'table:shadow_balances'));
  assert.ok(hits.some((h) => h.id === 'table:session_wallet'));
  assert.ok(hits.some((h) => h.id === 'table:held_balances'));
  assert.equal(
    hits.some((h) => h.id === 'table:import_batch'),
    false,
  );
});

test('scanner sees temp balance forms that still create a second relation', () => {
  const mustHit = [
    'CREATE LOCAL TEMP TABLE user_wallets (balance numeric);',
    'CREATE GLOBAL TEMPORARY TABLE IF NOT EXISTS pay.held_balances (owner text, amount numeric);',
    'CREATE TEMP TABLE accounts (id int, balance numeric);',
    'CREATE TEMP TABLE balance_snapshots (account_id int, balance numeric);',
    'CREATE TEMPORARY TABLE ledger_entries (id int, balance_after numeric);',
    'CREATE TEMP TABLE pay.accounts (id int, amount numeric);',
    'CREATE TEMP TABLE pots (cash_balance numeric);',
    'CREATE TEMP TABLE pots2 (balances numeric);',
    'CREATE TEMP TABLE cash (LIKE user_wallets);',
    'CREATE TEMP TABLE cash2 AS SELECT * FROM user_wallets;',
    "CREATE TEMP TABLE session_cash (note text DEFAULT 'x;y', balance numeric);",
  ];
  const missed = mustHit.filter((sql) => {
    const hits = scanDualBookText(sql, 'sql');
    return !hits.some((h) => h.id.startsWith('table:') || h.id.startsWith('schema:'));
  });
  assert.deepEqual(missed, []);
  for (const sql of [
    'CREATE TEMP TABLE import_batch (row_no int, payload text);',
    'CREATE TEMP TABLE notes (imbalance int, payload text);',
  ]) {
    assert.deepEqual(scanDualBookText(sql, 'sql'), [], sql);
  }
});

test('scanner refuses a planted public-schema book and wallet mutator', () => {
  const sqlHits = scanDualBookText('CREATE TABLE pay.balances (owner text, amount numeric);', 'sql');
  assert.ok(sqlHits.some((h) => h.id.startsWith('schema:pay')));
  const tsHits = scanDualBookText(
    `import { pgSchema, pgTable } from 'drizzle-orm/pg-core';
     const wallet = pgSchema('wallet');
     export const wallets = pgTable('wallets', {});
     function credit() { increaseBalance(1); }`,
    'ts',
  );
  assert.ok(tsHits.some((h) => h.id === 'pgSchema:wallet'));
  assert.ok(tsHits.some((h) => h.id.startsWith('pgTable:')));
  assert.ok(tsHits.some((h) => h.id === 'increaseBalance'));
});

test('scanner refuses a second book a Rust string holds, and a Rust wallet mutator', () => {
  const hits = scanDualBookText(
    `fn open<'a>(c: &'a mut Client) -> Result<(), Error> {
       let quote = '"';
       c.batch_execute("CREATE TABLE ledger.user_wallets (balance numeric)")?;
       c.batch_execute(r#"CREATE UNLOGGED TABLE "ledger"."shadow_balances" (balance numeric)"#)?;
       increaseBalance(1);
       Ok(())
     }`,
    'rs',
  );
  assert.ok(
    hits.some((h) => h.id === 'table:user_wallets'),
    JSON.stringify(hits),
  );
  assert.ok(
    hits.some((h) => h.id === 'table:shadow_balances'),
    JSON.stringify(hits),
  );
  assert.ok(
    hits.some((h) => h.id === 'increaseBalance'),
    JSON.stringify(hits),
  );
});

test('scanner stays quiet on a commented member_wallet (prose is not a book)', () => {
  assert.deepEqual(scanDualBookText('-- leftover member_wallet from vendor, do not recreate\n', 'sql'), []);
  assert.deepEqual(scanDualBookText('// MemberWalletDao is banned; we post through ledger-client\n', 'ts'), []);
  assert.deepEqual(
    scanDualBookText(
      "/// MemberWalletDao is banned.\n/* outer /* CREATE TABLE ledger.wallets (balance numeric) */ */\nfn f<'a>(_: &'a str) {}\n",
      'rs',
    ),
    [],
  );
});

test('walks migrations + production src (empty walk is a failed scan)', () => {
  const { files, hits } = scanProductionTree();
  assert.ok(files > 10, `only ${files} files walked`);
  assert.deepEqual(hits, [], hits.map((h) => `${h.file}: ${h.id} (${h.why})`).join('\n'));
});

test('one-book tables exist on disk — a missing accounts table is not a clean tree', () => {
  const created = createdOneBookTables();
  assert.ok(created.has('accounts'));
  assert.ok(created.has('ledger_entries'));
  assert.ok(created.has('ledger_tx'));
  assert.ok(created.has('__migrations'), 'the runner creates its apply log');
  assert.deepEqual(
    [...created].filter((n) => !ONE_BOOK_TABLES.has(n)),
    [],
  );
});

// ── 2. assets.decimals (assets-decimals.test.ts) ─────────────────────────────────────────────────────────────────────

/** Production source that could read the column: the ledger's Rust and ledger-client's TypeScript, tests left out. */
function decimalsSources() {
  return [
    ...walk(join(SERVICE_ROOT, 'src'), (n) => n.endsWith('.rs')),
    ...walk(join(REPO, 'packages', 'ledger-client', 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
  ];
}

/** Reads the column: `decimals` in code, comments stripped (the column is discussed, and discussing it is honest). */
export function readsDecimals(text, kind) {
  const code = kind === 'rs' ? stripRustCommentsKeepStrings(text) : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The drizzle declaration itself is not a read.
  const withoutDeclaration = code.replace(/decimals:\s*integer\('decimals'\)[^,]*,/g, '');
  return /\bdecimals\b/.test(withoutDeclaration);
}

test('assets.decimals is read by no production code in the ledger or ledger-client', () => {
  const files = decimalsSources();
  assert.ok(files.length > 10, `only ${files.length} files walked`);
  const readers = files.filter((path) => readsDecimals(readFileSync(path, 'utf8'), path.endsWith('.rs') ? 'rs' : 'ts'));
  assert.deepEqual(
    readers.map((p) => relative(REPO, p)),
    [],
  );
});

test('the decimals tripwire fires on a planted read, and not on prose', () => {
  assert.equal(readsDecimals('let d: i32 = row.get("decimals");', 'rs'), true);
  assert.equal(readsDecimals('c.query("SELECT decimals FROM ledger.assets", &[])?;', 'rs'), true);
  assert.equal(readsDecimals('// decimals is not read\n/// nor here: decimals\nfn f() {}', 'rs'), false);
  assert.equal(readsDecimals('const d = asset.decimals;', 'ts'), true);
});

test('every seeded scale is one the ledger could not currently honour', () => {
  const migrations = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'));
  const seeded = migrations
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), 'utf8').split('\n'))
    .map((line) => /^\s*\('([A-Z0-9]+)',\s*'[a-z]+',\s*(\d+)\)/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ asset: m[1], decimals: Number(m[2]) }));
  assert.ok(seeded.length > 5, `only ${seeded.length} seeded assets found`);
  // At least one asset is seeded below the storage scale: what makes the unenforced column a real gap.
  assert.ok(seeded.some((s) => s.decimals < 18));
  // Every scale fits numeric(38,18): the gap is dust, not overflow.
  for (const { asset, decimals } of seeded) {
    assert.ok(decimals <= 18, `${asset} declares more precision than the ledger stores`);
  }
});
