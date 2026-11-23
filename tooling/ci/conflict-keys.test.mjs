import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankJsComments,
  findingId,
  findings,
  freshNames,
  insertsWithTarget,
  judge,
  resolveTable,
  schemaFromSql,
  targetText,
  unabsorbedKeys,
} from './conflict-keys.mjs';

/** What the check says about one source file against one service's migrations: the open keys per insert. */
function check(migrations, source) {
  const schema = schemaFromSql(migrations);
  const strings = new Set([...source.matchAll(/'([^'\n\\]*)'|"([^"\n\\]*)"/g)].map((s) => (s[1] ?? s[2]).toLowerCase()));
  return insertsWithTarget(source).map((ins) => ({
    table: ins.table,
    target: targetText(ins.target),
    open: unabsorbedKeys(ins, schema.tables.get(ins.table), strings, freshNames(source)).open.map((k) => k.name),
  }));
}

// ── the two past mistakes, as they were on main ──────────────────────────────

// services/svc-academy/drizzle/20261112092541_course_purchases.sql (the keys only)
const ACADEMY = [
  `CREATE TABLE IF NOT EXISTS "academy"."course_purchases" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "course_id" uuid NOT NULL, "user_id" text NOT NULL, "n" integer NOT NULL, "purchase_key" text NOT NULL,
     "chain_id" integer, "tx_hash" text, "refund_key" text, "refund_tx_hash" text,
     CONSTRAINT "course_purchases_key_uq" UNIQUE ("purchase_key"),
     CONSTRAINT "course_purchases_n_uq" UNIQUE ("course_id", "user_id", "n"),
     CONSTRAINT "course_purchases_tx_uq" UNIQUE ("chain_id", "tx_hash"),
     CONSTRAINT "course_purchases_refund_key_uq" UNIQUE ("refund_key"),
     CONSTRAINT "course_purchases_refund_tx_uq" UNIQUE ("chain_id", "refund_tx_hash")
   );`,
];

// services/svc-academy/src/purchases/course-purchases.ts before #8417 (#8378)
const ACADEMY_BEFORE = `
      return tx<PurchaseRow[]>\`
        INSERT INTO academy.course_purchases (course_id, course_slug, user_id, n, purchase_key, price, price_asset, chain_id, token,
          decimals, receiver, buyer_wallet, from_block, status, created_at, updated_at)
        VALUES (\${course.id}, \${course.slug}, \${input.userId}, \${n}, \${purchaseKeyOf(course.slug, input.userId, n)}, \${course.price},
                \${course.price_asset!}, \${settings.chainId}, \${settings.token}, \${settings.decimals}, \${settings.receiver}, \${wallet},
                \${fromBlock.toString()}, 'awaiting_signature', \${now}, \${now})
        ON CONFLICT (course_id, user_id, n) DO NOTHING
        RETURNING *
      \`;`;
const ACADEMY_AFTER = ACADEMY_BEFORE.replace('ON CONFLICT (course_id, user_id, n) DO NOTHING', 'ON CONFLICT DO NOTHING');

// services/svc-pay/drizzle/0117_pay_custody_deposit_addresses.sql and the address_index migration after it
const PAY = [
  `CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_addresses" (
     "user_id" text NOT NULL, "asset_id" text NOT NULL, "network_id" text NOT NULL, "address" text NOT NULL,
     "memo" text, "issued_at" timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY ("user_id", "asset_id", "network_id"),
     CONSTRAINT "custody_deposit_addresses_address_ck" CHECK (length("address") BETWEEN 1 AND 256 AND "address" !~ '\\s')
   );
   CREATE UNIQUE INDEX IF NOT EXISTS "custody_deposit_addresses_network_address_uq"
     ON "pay"."custody_deposit_addresses" ("network_id", lower("address"));`,
  `ALTER TABLE "pay"."custody_deposit_addresses" ADD COLUMN IF NOT EXISTS "address_index" integer NOT NULL DEFAULT 0;
   ALTER TABLE "pay"."custody_deposit_addresses" DROP CONSTRAINT IF EXISTS "custody_deposit_addresses_pkey";
   ALTER TABLE "pay"."custody_deposit_addresses" ADD PRIMARY KEY ("user_id", "asset_id", "network_id", "address_index");`,
];

// services/svc-pay/src/custody/deposits/service.ts before #8792 (#8526)
const PAY_BEFORE = `
    await this.deps.sql\`
      INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at)
      VALUES (\${input.userId}, \${input.assetId}, \${input.networkId}, \${index}, \${derived}, \${expiresAt})
      ON CONFLICT (user_id, asset_id, network_id, address_index) DO NOTHING\`;
    // A unique violation on (network, address) is not caught here: it means two people derived one address, which must be
    // seen and must issue nothing. A lost insert race returns the row that won, with its own expiry.`;
// …and after: the 23505 on the address index is caught by name and the row that won is returned.
const PAY_AFTER = `
const ADDRESS_UNIQUE_INDEX = 'custody_deposit_addresses_network_address_uq';
function isAddressClash(error) { return error?.code === '23505' && error.constraint_name === ADDRESS_UNIQUE_INDEX; }
${PAY_BEFORE.replace(/\/\/ A unique violation[\s\S]*$/, '')}`;

test('fails the svc-academy purchase insert before #8417 and passes it after', () => {
  assert.deepEqual(check(ACADEMY, ACADEMY_BEFORE), [
    {
      table: 'course_purchases',
      target: '(course_id, user_id, n)',
      open: ['course_purchases_key_uq', 'course_purchases_tx_uq', 'course_purchases_refund_key_uq', 'course_purchases_refund_tx_uq'],
    },
  ]);
  assert.deepEqual(check(ACADEMY, ACADEMY_AFTER), [], 'ON CONFLICT DO NOTHING has no target: it absorbs every key');
});

test('fails the svc-pay deposit-address insert before #8792 and passes it after', () => {
  assert.deepEqual(check(PAY, PAY_BEFORE), [
    {
      table: 'custody_deposit_addresses',
      target: '(user_id, asset_id, network_id, address_index)',
      open: ['custody_deposit_addresses_network_address_uq'],
    },
  ]);
  assert.deepEqual(check(PAY, PAY_AFTER)[0].open, [], 'the file catches the other key by its name');
});

test('the prose in a comment that quotes the old statement is not read as an insert', () => {
  const src = `// The insert is \`ON CONFLICT (id) DO NOTHING\`, so the second deposit runs against the first\n/* INSERT INTO x ON CONFLICT (id) DO NOTHING */`;
  assert.deepEqual(insertsWithTarget(src), []);
  assert.equal(blankJsComments('a // b\nc').length, 'a // b\nc'.length);
});

// ── what absorbs a key ───────────────────────────────────────────────────────

const T = [
  `CREATE TABLE app.t (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     seq bigserial,
     k text NOT NULL UNIQUE,
     ref text,
     slot text
   );
   CREATE UNIQUE INDEX t_ref_uq ON app.t (ref) WHERE ref IS NOT NULL;`,
];

test('a key the database or the code fills with a fresh value cannot clash', () => {
  const insert = (cols, vals, pre = '') => `${pre}\nawait sql\`INSERT INTO app.t (${cols}) VALUES (${vals}) ON CONFLICT (k) DO NOTHING\`;`;
  assert.deepEqual(check(T, insert('k', '${k}'))[0].open, ['t_ref_uq'], 'the defaulted id and seq are not written: skipped');
  assert.deepEqual(check(T, insert('id, k', '${id}, ${k}'))[0].open, ['t_pkey', 't_ref_uq'], 'an id the caller passes may repeat');
  assert.deepEqual(check(T, insert('id, k', '${id}, ${k}', 'const id = randomUUID();'))[0].open, ['t_ref_uq']);
  assert.deepEqual(check(T, insert('id, k', '${randomUUID()}, ${k}'))[0].open, ['t_ref_uq']);
});

test('a partial unique index needs the same WHERE in the target to be the arbiter', () => {
  const src = 'await sql`INSERT INTO app.t (k, ref) VALUES (${k}, ${r}) ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING`;';
  assert.deepEqual(check(T, src)[0].open, ['t_k_key']);
});

test('ON CONFLICT ON CONSTRAINT names its arbiter', () => {
  const src = 'await sql`INSERT INTO app.t (k) VALUES (${k}) ON CONFLICT ON CONSTRAINT t_k_key DO NOTHING`;';
  assert.deepEqual(check(T, src)[0].open, ['t_ref_uq']);
});

test('a statement may say why a key cannot clash, on itself or the line above', () => {
  const src = [
    '// conflict-keys-ok: t_ref_uq — ref is set only by the settle step, never on this insert',
    'await sql`INSERT INTO app.t (k) VALUES (${k}) ON CONFLICT (k) DO NOTHING`;',
  ].join('\n');
  assert.deepEqual(check(T, src)[0].open, []);
});

// ── reading migrations ───────────────────────────────────────────────────────

test('keys follow drops, renames, dropped columns and conditional DDL', () => {
  const s = schemaFromSql([
    `CREATE TABLE a.x (id text PRIMARY KEY, u text, v text, w text, CONSTRAINT x_u_uq UNIQUE (u));
     CREATE UNIQUE INDEX IF NOT EXISTS x_v_uq ON a.x (v);
     CREATE UNIQUE INDEX x_w_uq ON a.x USING btree (lower(w));`,
    `ALTER TABLE a.x DROP CONSTRAINT IF EXISTS x_u_uq;
     ALTER INDEX a.x_v_uq RENAME TO x_v_unique;
     ALTER TABLE a.x DROP COLUMN w;
     DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x_uv_uq') THEN
         ALTER TABLE a.x ADD CONSTRAINT x_uv_uq UNIQUE (u, v);
       END IF;
     END $$;`,
  ]);
  const keys = Object.fromEntries([...s.tables.get('x').keys.values()].map((k) => [k.name, k.elements.join(',')]));
  assert.deepEqual(keys, { x_pkey: 'id', x_v_unique: 'v', x_uv_uq: 'u,v' });
});

test('an interpolated table is followed when the file names it', () => {
  const src = "const listings = relation(schema, 'library_listings');";
  assert.equal(resolveTable('${listings}', src), 'library_listings');
  assert.equal(resolveTable("${t('owner_criteria')}", ''), 'owner_criteria');
  assert.equal(resolveTable('${dynamic}', ''), '${dynamic}');
});

// ── the baseline ─────────────────────────────────────────────────────────────

test('a finding the baseline does not list fails, and an entry nothing matches is stale', () => {
  const rows = [
    {
      status: 'open',
      file: 'f.ts',
      line: 3,
      table: 't',
      target: { elements: ['k'], predicate: '' },
      open: [
        { name: 'a', elements: ['a'], predicate: '' },
        { name: 'b', elements: ['b'], predicate: '' },
      ],
    },
    { status: 'ok', file: 'g.ts', line: 1, table: 't', target: { elements: ['k'], predicate: '' }, open: [] },
  ];
  const found = findings(rows);
  assert.deepEqual(found.map(findingId), ['f.ts | t | (k) | a', 'f.ts | t | (k) | b']);
  const { fresh, stale, known } = judge(found, [
    { file: 'f.ts', table: 't', target: '(k)', constraint: 'a', verdict: 'safe', why: 'x' },
    { file: 'gone.ts', table: 't', target: '(k)', constraint: 'a', verdict: 'safe', why: 'x' },
  ]);
  assert.deepEqual(
    fresh.map((f) => f.constraint),
    ['b'],
  );
  assert.deepEqual(
    stale.map((e) => e.file),
    ['gone.ts'],
  );
  assert.equal(known.length, 1);
});
