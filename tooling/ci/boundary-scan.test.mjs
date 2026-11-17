import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_EXPR_CAP,
  applyAllow,
  checkMigration,
  checkSchemaTs,
  checkSource,
  findCycles,
  keyExpression,
  vueDeps,
} from './boundary-scan.mjs';

const eq = (a, b, m) => assert.deepEqual(a, b, m);
const schemas = ['trade', 'pay', 'mining_pool'];
const t = (text, ctx) =>
  checkSource(text, { rel: 'services/svc-pay/src/x.ts', group: 'services', service: 'svc-pay', ...ctx }, schemas).map((f) => f.rule);

test('checkSource and checkMigration: the boundary and money rules', () => {
  eq(t("import x from '../../svc-trade/src/a.js';"), ['B-hops'], 'sibling hop');
  eq(t("import x from '../helpers.js';"), [], 'plain import');
  eq(t("// import x from '../../svc-trade/a.js'"), [], 'comment ignored');
  eq(t('await sql`SELECT * FROM trade.orders`'), ['B-sql'], 'other schema');
  eq(t('await sql`SELECT * FROM pay.orders`'), [], 'own schema');
  eq(t("const r = { entries: [{ account: a, direction: 'debit', amount: 1n }] };"), ['M-entries'], 'inline entries');
  eq(t('const a = { entries: [] };'), [], 'audit entries are not postings');
  eq(
    t("const r = { entries: [{ account: a, direction: 'debit' }] };", {
      rel: 'packages/ledger-client/src/r.ts',
      group: 'packages',
      service: null,
    }),
    [],
    'ledger-client owns entries',
  );
  eq(t('export class MyLedger implements LedgerClient {}'), ['M-client'], 'own ledger client');
  eq(t("await fetch(`${base}/trpc/post`, { method: 'POST' });"), ['M-client'], 'direct ledger post');
  eq(t('const c = createHttpLedgerClient({ baseUrl });'), [], 'shared client');
  eq(
    t('class L implements LedgerClient {}', { rel: 'services/svc-ledger/src/s.ts', service: 'svc-ledger' }),
    [],
    'ledger service owns the interface',
  );
  eq(t('post({ idempotencyKey: `x:${randomUUID()}` })'), ['M-key'], 'random key');
  eq(t('post({ idempotencyKey: `x:${order.id}` })'), [], 'business key');
  eq(
    checkMigration('  hold_amount numeric(38,18) NOT NULL,', { rel: 'm.sql' }).map((f) => f.rule),
    ['M-balance'],
    'balance column',
  );
  eq(checkMigration('  filled_at timestamptz,', { rel: 'm.sql' }), [], 'plain column');
});

test('evasions: generic SQL tags, balance columns, keys, pushed entries and ledger clients', () => {
  // Evasion forms fed to the first version of this gate.
  eq(t('await sql<{ a: string }[]>`SELECT * FROM trade.orders`'), ['B-sql'], 'evasion 1: generic sql tag');
  eq(t('await tx`SELECT * FROM trade.orders`'), ['B-sql'], 'evasion 1: tx tag');
  eq(t('await tx<Row[]>`SELECT * FROM "trade"."orders"`'), ['B-sql'], 'evasion 1: tx generic quoted');
  eq(t('await sql.unsafe("SELECT * FROM trade.orders")'), ['B-sql'], 'evasion 1: unsafe string');
  eq(t('const msg = "amounts come from ledger.balance(houseFees)"'), [], 'a function call is not a table');
  eq(
    checkMigration('  ADD COLUMN IF NOT EXISTS "available" numeric(38, 18) NOT NULL DEFAULT 0;', { rel: 'm.sql' }).map((x) => x.rule),
    ['M-balance'],
    'evasion 2: ADD COLUMN available',
  );
  eq(checkMigration('ALTER TABLE x ADD COLUMN margin_current numeric;', { rel: 'm.sql' }).length, 1, 'ADD COLUMN margin mirror');
  eq(checkMigration('  "refunded_count" integer NOT NULL DEFAULT 0,', { rel: 'm.sql' }), [], 'a count is not a balance');
  eq(
    checkSchemaTs("export const t = pgTable('t', { held: numeric('held', { precision: 38 }) });", { rel: 's.ts' }).length,
    1,
    'drizzle schema column',
  );
  eq(t('const k = randomUUID();\nawait post({ idempotencyKey: k });'), ['M-key'], 'evasion 3: key from a variable');
  eq(t('const k = `x:${Date.now()}`;\nawait post({ idempotencyKey: `pay:${k}` });'), ['M-key'], 'evasion 3: key from a clock variable');
  eq(t('await post({\n  idempotencyKey:\n    `x:${randomUUID()}`,\n});'), ['M-key'], 'evasion 3: key on the next line');
  eq(t('const id = randomUUID();\nfoo(id);\nawait post({ idempotencyKey: `x:${row.id}` });'), [], 'property named like a random local');
  eq(t('const idempotencyKey = randomUUID();\nawait post({ idempotencyKey });'), ['M-key'], 'evasion 3: shorthand key');
  eq(
    t("const e = [];\ne.push({ account: a, direction: 'debit', amount: 1n });\nawait post({ entries: e });"),
    ['M-entries'],
    'evasion 4: entries pushed',
  );
  eq(t("type Row = { direction: 'debit' | 'credit' };"), [], 'a direction type union is not an entry');
  eq(t('const c: LedgerClient = { post, balance };'), ['M-client'], 'evasion 5: object-literal client');
  eq(t('const c = makeThing() as LedgerClient;'), ['M-client'], 'cast client');
  eq(t('export function build(): LedgerClient { return { post, balance }; }'), ['M-client'], 'factory without the shared client');
  eq(t('export function build(): LedgerClient { return createHttpLedgerClient({}); }'), [], 'factory over the shared client');
  eq(t('const p = "/trpc/post"; await fetch(base + p);'), ['M-client'], 'ledger path in a variable');
});

test('checkSource: reading another service from disk', () => {
  eq(
    t("const root = join(ROOT, 'services', 'svc-x', 'src', 'a.ts'); readFileSync(root);"),
    [],
    'a variable path is not seen (known limit, documented in the header)',
  );
  eq(
    t("readFileSync(join(ROOT, 'services', 'svc-execution', 'src', 'a.ts'), 'utf8')", {
      rel: 'packages/p/src/a.ts',
      group: 'packages',
      service: null,
    }),
    ['B-reads'],
    'package reads a service from disk',
  );
  eq(t("readFileSync(join(__dirname, '..', 'svc-trade', 'a.ts'))"), ['B-reads'], 'service reads a sibling service from disk');
  eq(t("readFileSync(join(__dirname, 'svc-pay.txt'))"), [], 'own name is fine');
});

test('findCycles', () => {
  eq(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ]),
    ).length,
    1,
    'cycle found',
  );
  eq(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', []],
      ]),
    ).length,
    0,
    'no cycle',
  );
  eq(
    findCycles(
      new Map([
        ['a', ['b', 'c']],
        ['b', ['c']],
        ['c', []],
      ]),
    ).length,
    0,
    'diamond is not a cycle',
  );
});

test('checkSource and checkMigration: INSERT, TRUNCATE, entries with a variable direction, balance column spellings', () => {
  eq(t('await sql`INSERT INTO trade.orders(id, amount) VALUES (1, 2)`'), ['B-sql'], 'INSERT INTO with no space before the column list');
  eq(t('await sql`TRUNCATE trade.orders`'), ['B-sql'], 'TRUNCATE other schema');
  eq(t('post({ entries:[{ account: a, direction: row.dir, amount }] });'), ['M-entries'], 'entries with a variable direction');
  eq(
    t("const DEBIT = 'debit';\npost({ entries: [{ account: a, direction: DEBIT }] });"),
    ['M-entries'],
    'entries with a constant direction',
  );
  eq(checkMigration('  balances numeric(38,18),', { rel: 'm.sql' }).length, 1, 'plural balance column');
  eq(checkMigration('  availablebalance numeric,', { rel: 'm.sql' }).length, 1, 'run-together balance column');
  eq(checkMigration('  available int8 NOT NULL,', { rel: 'm.sql' }).length, 1, 'int8 available column');
});

test('keyExpression: an unterminated key reads at most its cap', () => {
  // An unterminated key, bare or inside an unclosed string, reads at most its cap, never the rest of the file: the slice
  // is everything it read after the `:`. Checked by length, not by the clock.
  for (const [open, name] of [
    ['', 'bare'],
    ["'", 'single-quoted'],
    ['"', 'double-quoted'],
    ['`', 'template'],
  ]) {
    const flood = `idempotencyKey: ${open}${'idempotencyKey: '.repeat(20000)}`;
    const read = keyExpression(flood, 'idempotencyKey'.length).length;
    assert.ok(read <= KEY_EXPR_CAP + 1, `an unterminated ${name} key expression read ${read} characters`);
  }
  eq(t('idempotencyKey: '.repeat(20000)), [], 'a flood of unterminated keys scans and finds nothing');
});

test('vueDeps', () => {
  const vue = (json) => vueDeps('apps/x/package.json', json).map((x) => x.detail);
  eq(vue({ dependencies: { vue: '3.5.0' } }), ['dependencies vue'], 'a vue dependency');
  eq(
    vue({ devDependencies: { '@vue/compiler-sfc': '3', 'vue-router': '4', nuxt: '3' }, peerDependencies: { vuex: '4' } }),
    ['devDependencies @vue/compiler-sfc', 'devDependencies vue-router', 'devDependencies nuxt', 'peerDependencies vuex'],
    'the Vue family in every dependency kind',
  );
  eq(
    vue({ dependencies: { react: '19', 'react-dom': '19', vitest: '4', vite: '7', 'eslint-plugin-vuejs-accessibility': '1' } }),
    [],
    'React, Vite and lookalikes pass',
  );
});

test('applyAllow', () => {
  const f = { rule: 'B-deps', file: 'a/package.json', detail: 'devDependencies @intafaced/svc-x' };
  eq(applyAllow([f], [{ rule: 'B-deps', file: 'a/package.json', reason: 'r' }]).open, [], 'allowed');
  eq(applyAllow([], [{ rule: 'B-deps', file: 'a/package.json', reason: 'r' }]).stale.length, 1, 'stale allow entry');
});
