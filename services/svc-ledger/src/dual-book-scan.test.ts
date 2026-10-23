import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * H8 / Q-ledger dual-book scan. This service is the TypeScript book.
 * A second book here is Java wallet tables, extra CREATE TABLE, or a
 * service-held balance store. Statement PnL is a view — not recut.
 *
 * Vendor Java already has `scan:vendor-java-money` + door gates. Those
 * never open drizzle/ or src/ in this package.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = join(HERE, '..');

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
]);

const JAVA_WALLET_IDS: readonly { readonly id: string; readonly re: RegExp; readonly why: string }[] = [
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

export type DualBookHit = {
  readonly id: string;
  readonly why: string;
  readonly excerpt: string;
};

function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function stripTsCommentsKeepStrings(source: string): string {
  const literals: string[] = [];
  const masked = source.replace(/(['"`])(?:\\.|[^\\])*?\1/g, (s) => {
    literals.push(s);
    return `"\u0000${literals.length - 1}\u0000"`;
  });
  const decommented = masked.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return decommented.replace(/"\u0000(\d+)\u0000"/g, (_, i) => literals[Number(i)] ?? '');
}

/** A semicolon inside quotes does not end the statement. */
function statementUntilSemicolon(afterName: string): string {
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < afterName.length) {
    const c = afterName[i]!;
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

function stripSingleQuoted(source: string): string {
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

function isBalanceColumnName(name: string): boolean {
  return BALANCE_COLUMN_NAME.test(name);
}

function namesBalanceWalletOrOneBook(name: string | undefined): boolean {
  return name != null && (ONE_BOOK_TABLES.has(name) || BALANCE_BOOK_NAME.test(name));
}

function relationKeywordHitsBook(stmt: string, keyword: 'LIKE' | 'FROM' | 'JOIN'): boolean {
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
function isLedgerScratchTemp(table: string, afterName: string): boolean {
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

function excerptAt(text: string, index: number): string {
  return text
    .slice(Math.max(0, index - 24), Math.min(text.length, index + 48))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scan one source blob. Kind picks the comment stripper. */
export function scanDualBookText(text: string, kind: 'sql' | 'ts'): DualBookHit[] {
  const body = kind === 'sql' ? stripSqlComments(text) : stripTsCommentsKeepStrings(text);
  const hits: DualBookHit[] = [];

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

  if (kind === 'ts') {
    DRIZZLE_TABLE.lastIndex = 0;
    for (const m of body.matchAll(DRIZZLE_TABLE)) {
      const table = m[1]!;
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

function walk(dir: string, pred: (name: string, full: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
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

function scanProductionTree(): { readonly files: number; readonly hits: readonly (DualBookHit & { file: string })[] } {
  const files = [
    ...walk(join(SERVICE_ROOT, 'drizzle'), (n) => n.endsWith('.sql')),
    ...walk(join(SERVICE_ROOT, 'scripts'), (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
    ...walk(join(SERVICE_ROOT, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
  ];
  const java = walk(SERVICE_ROOT, (n) => n.endsWith('.java'));
  const hits: (DualBookHit & { file: string })[] = [];
  for (const file of java) {
    hits.push({
      file: relative(SERVICE_ROOT, file).replace(/\\/g, '/'),
      id: 'java-file',
      why: 'Java source in svc-ledger',
      excerpt: file,
    });
  }
  for (const file of files) {
    const rel = relative(SERVICE_ROOT, file).replace(/\\/g, '/');
    const kind = file.endsWith('.sql') ? 'sql' : 'ts';
    for (const hit of scanDualBookText(readFileSync(file, 'utf8'), kind)) {
      hits.push({ file: rel, ...hit });
    }
  }
  return { files: files.length, hits };
}

function createdOneBookTables(): Set<string> {
  const names = new Set<string>();
  const files = [
    ...walk(join(SERVICE_ROOT, 'drizzle'), (n) => n.endsWith('.sql') && !n.endsWith('.down.sql')),
    ...walk(join(SERVICE_ROOT, 'scripts'), (n) => n === 'migrate.ts'),
  ];
  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w]*))/gi;
  for (const file of files) {
    const body = stripSqlComments(readFileSync(file, 'utf8'));
    for (const m of body.matchAll(re)) {
      const table = m[1] ?? m[2];
      if (table) names.add(table);
    }
  }
  return names;
}

describe('H8 dual-book scan — one book in svc-ledger', () => {
  it('scanner refuses a planted Java wallet table (fail-closed)', () => {
    const hits = scanDualBookText('CREATE TABLE IF NOT EXISTS member_wallet (id bigint, balance numeric);', 'sql');
    expect(hits.some((h) => h.id === 'member_wallet' || h.id === 'table:member_wallet')).toBe(true);
  });

  it('scanner refuses a planted extra ledger table', () => {
    const hits = scanDualBookText('CREATE TABLE "ledger"."user_wallets" (balance numeric);', 'sql');
    expect(hits.some((h) => h.id === 'table:user_wallets')).toBe(true);
  });

  it('scanner sees a second balance table written unlogged, temp, or temporary', () => {
    const hits = scanDualBookText(
      [
        'CREATE UNLOGGED TABLE "ledger"."shadow_balances" (balance numeric);',
        'CREATE TEMP TABLE session_wallet (balance numeric);',
        'CREATE TEMPORARY TABLE IF NOT EXISTS pay.held_balances (owner text, amount numeric);',
        'CREATE TEMP TABLE import_batch (row_no int, payload text);',
      ].join('\n'),
      'sql',
    );
    expect(hits.some((h) => h.id === 'table:shadow_balances')).toBe(true);
    expect(hits.some((h) => h.id === 'table:session_wallet')).toBe(true);
    expect(hits.some((h) => h.id === 'table:held_balances')).toBe(true);
    expect(hits.some((h) => h.id === 'table:import_batch')).toBe(false);
  });

  it('scanner sees temp balance forms that still create a second relation', () => {
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
    expect(missed).toEqual([]);
    for (const sql of [
      'CREATE TEMP TABLE import_batch (row_no int, payload text);',
      'CREATE TEMP TABLE notes (imbalance int, payload text);',
    ]) {
      expect(scanDualBookText(sql, 'sql'), sql).toEqual([]);
    }
  });

  it('scanner refuses a planted public-schema book and wallet mutator', () => {
    const sqlHits = scanDualBookText('CREATE TABLE pay.balances (owner text, amount numeric);', 'sql');
    expect(sqlHits.some((h) => h.id.startsWith('schema:pay'))).toBe(true);
    const tsHits = scanDualBookText(
      `import { pgSchema, pgTable } from 'drizzle-orm/pg-core';
       const wallet = pgSchema('wallet');
       export const wallets = pgTable('wallets', {});
       function credit() { increaseBalance(1); }`,
      'ts',
    );
    expect(tsHits.some((h) => h.id === 'pgSchema:wallet')).toBe(true);
    expect(tsHits.some((h) => h.id.startsWith('pgTable:'))).toBe(true);
    expect(tsHits.some((h) => h.id === 'increaseBalance')).toBe(true);
  });

  it('scanner stays quiet on a commented member_wallet (prose is not a book)', () => {
    expect(scanDualBookText('-- leftover member_wallet from vendor, do not recreate\n', 'sql')).toEqual([]);
    expect(scanDualBookText('// MemberWalletDao is banned; we post through ledger-client\n', 'ts')).toEqual([]);
  });

  it('walks drizzle + production src (empty walk is a failed scan)', () => {
    const { files, hits } = scanProductionTree();
    expect(files).toBeGreaterThan(10);
    expect(hits, hits.map((h) => `${h.file}: ${h.id} (${h.why})`).join('\n')).toEqual([]);
  });

  it('one-book tables exist on disk — a missing accounts table is not a clean tree', () => {
    const created = createdOneBookTables();
    expect(created.has('accounts')).toBe(true);
    expect(created.has('ledger_entries')).toBe(true);
    expect(created.has('ledger_tx')).toBe(true);
    const extras = [...created].filter((n) => !ONE_BOOK_TABLES.has(n));
    expect(extras).toEqual([]);
  });
});
