import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * checkout_sessions.link_id, merchant_id, and payment_id are separate foreign
 * keys. The session merchant has to be the link's merchant, and the payment's
 * merchant when a payment is set. A mismatched row would freeze the amount
 * against a different merchant than the link or the payment.
 *
 * Every forward file under drizzle/ is applied in order onto a schema in the
 * database TEST_DATABASE_URL names. Pay SQL is schema-qualified, so each file
 * is rewritten onto that schema before apply. This file does not start
 * Postgres and does not create a database.
 *
 * Amounts are decimal strings inside the SQL. A JavaScript number is never
 * passed for an amount.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const AMOUNT = '10.500000000000000000';
const CURRENCY = 'USD';
const RAIL = 'card-sandbox';

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for checkout session merchants');
  }
  return url;
}

function rewritePaySchema(sql: string, schema: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`refusing to rewrite pay SQL onto ${schema}`);
  }
  return sql.replaceAll('"pay"', `"${schema}"`).replace(/\bpay\./g, `${schema}.`);
}

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected ${what}`);
  return row;
}

interface Fixture {
  merchantA: string;
  merchantB: string;
  linkA: string;
  linkA2: string;
  linkB: string;
  paymentA: string;
  paymentA2: string;
  paymentB: string;
}

describe('checkout session merchant matches the link and the payment', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';
  let fx: Fixture;

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(
      await admin<Array<{ db: string }>>`SELECT current_database() AS db`,
      'current database',
    );
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate checkout sessions on database ${current.db}`);
    }

    schema = `test_pay_l865_${process.pid}`;
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);

    sql = postgres(url, {
      max: 4,
      connection: { search_path: `${schema},public` },
      onnotice: () => undefined,
    });
    for (const migration of migrations) {
      await sql.unsafe(rewritePaySchema(migration, schema));
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (admin && schema) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  beforeEach(async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');
    const tables = await db<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = ${schema}
    `;
    if (tables.length > 0) {
      const list = tables.map((t) => `"${schema}"."${t.tablename}"`).join(', ');
      await db.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }

    const merchantA = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id) VALUES ('l865-merchant-a') RETURNING id
      `,
      'merchant A',
    );
    const merchantB = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id) VALUES ('l865-merchant-b') RETURNING id
      `,
      'merchant B',
    );

    async function link(merchantId: string, tokenHash: string): Promise<string> {
      const row = one(
        await db<Array<{ id: string }>>`
          INSERT INTO payment_links (merchant_id, token_hash, token_prefix, label)
          VALUES (${merchantId}, ${tokenHash}, 'pl_l865', 'l865 link')
          RETURNING id
        `,
        tokenHash,
      );
      return row.id;
    }

    async function payment(merchantId: string): Promise<string> {
      const row = one(
        await db<Array<{ id: string }>>`
          INSERT INTO payments (merchant_id, amount, currency, method, rail_adapter)
          VALUES (${merchantId}, ${AMOUNT}::numeric(38, 18), ${CURRENCY}, 'card', ${RAIL})
          RETURNING id
        `,
        'payment',
      );
      return row.id;
    }

    fx = {
      merchantA: merchantA.id,
      merchantB: merchantB.id,
      linkA: await link(merchantA.id, 'l865-link-a'),
      linkA2: await link(merchantA.id, 'l865-link-a2'),
      linkB: await link(merchantB.id, 'l865-link-b'),
      paymentA: await payment(merchantA.id),
      paymentA2: await payment(merchantA.id),
      paymentB: await payment(merchantB.id),
    };
  });

  function sqlOrThrow(): postgres.Sql {
    if (!sql) throw new Error('test database was not opened');
    return sql;
  }

  async function insertSession(args: {
    linkId: string;
    merchantId: string;
    paymentId: string | null;
    tokenHash: string;
  }): Promise<{ id: string; amount: string; currency: string; rail_adapter: string }> {
    const db = sqlOrThrow();
    return one(
      await db<Array<{ id: string; amount: string; currency: string; rail_adapter: string }>>`
        INSERT INTO checkout_sessions (
          link_id, merchant_id, payment_id, token_hash, token_prefix,
          amount, currency, rail_adapter, expires_at
        ) VALUES (
          ${args.linkId},
          ${args.merchantId},
          ${args.paymentId},
          ${args.tokenHash},
          'cs_l865',
          ${AMOUNT}::numeric(38, 18),
          ${CURRENCY},
          ${RAIL},
          now() + interval '15 minutes'
        )
        RETURNING id, amount::text AS amount, currency, rail_adapter
      `,
      'checkout session',
    );
  }

  async function stored(tokenHash: string): Promise<
    | {
        amount: string;
        currency: string;
        rail_adapter: string;
        merchant_id: string;
        link_id: string;
        payment_id: string | null;
        status: string;
      }
    | undefined
  > {
    const db = sqlOrThrow();
    const rows = await db<
      Array<{
        amount: string;
        currency: string;
        rail_adapter: string;
        merchant_id: string;
        link_id: string;
        payment_id: string | null;
        status: string;
      }>
    >`
      SELECT amount::text AS amount, currency, rail_adapter, merchant_id, link_id, payment_id, status
        FROM checkout_sessions
       WHERE token_hash = ${tokenHash}
    `;
    return rows[0];
  }

  it('refuses an insert whose link merchant differs from the session merchant', async () => {
    const tokenHash = 'l865-link-mismatch';
    await expect(
      insertSession({
        linkId: fx.linkB,
        merchantId: fx.merchantA,
        paymentId: fx.paymentA,
        tokenHash,
      }),
    ).rejects.toThrow(/payment link merchant/);
    expect(await stored(tokenHash)).toBeUndefined();
  });

  it('refuses an insert whose payment merchant differs from the session merchant', async () => {
    const tokenHash = 'l865-payment-mismatch';
    await expect(
      insertSession({
        linkId: fx.linkA,
        merchantId: fx.merchantA,
        paymentId: fx.paymentB,
        tokenHash,
      }),
    ).rejects.toThrow(/payment merchant/);
    expect(await stored(tokenHash)).toBeUndefined();
  });

  it('stores an insert with no payment when the link merchant equals the session merchant', async () => {
    const tokenHash = 'l865-null-payment';
    const session = await insertSession({
      linkId: fx.linkA,
      merchantId: fx.merchantA,
      paymentId: null,
      tokenHash,
    });
    expect(typeof session.amount).toBe('string');
    expect(session.amount).toBe(AMOUNT);
    expect(session.currency).toBe(CURRENCY);
    expect(session.rail_adapter).toBe(RAIL);

    const row = await stored(tokenHash);
    expect(row).toEqual({
      amount: AMOUNT,
      currency: CURRENCY,
      rail_adapter: RAIL,
      merchant_id: fx.merchantA,
      link_id: fx.linkA,
      payment_id: null,
      status: 'open',
    });
  });

  it('stores an insert when the link, the session, and the payment name the same merchant', async () => {
    const tokenHash = 'l865-same-merchant';
    const session = await insertSession({
      linkId: fx.linkA,
      merchantId: fx.merchantA,
      paymentId: fx.paymentA,
      tokenHash,
    });
    expect(typeof session.amount).toBe('string');
    expect(session.amount).toBe(AMOUNT);
    expect(session.currency).toBe(CURRENCY);
    expect(session.rail_adapter).toBe(RAIL);

    const row = await stored(tokenHash);
    expect(row).toEqual({
      amount: AMOUNT,
      currency: CURRENCY,
      rail_adapter: RAIL,
      merchant_id: fx.merchantA,
      link_id: fx.linkA,
      payment_id: fx.paymentA,
      status: 'open',
    });
  });

  it('refuses an update that would leave the merchants disagreeing and keeps the stored amount, currency, and rail', async () => {
    const db = sqlOrThrow();
    const tokenHash = 'l865-update';
    const session = await insertSession({
      linkId: fx.linkA,
      merchantId: fx.merchantA,
      paymentId: fx.paymentA,
      tokenHash,
    });

    const movedLink = one(
      await db<Array<{ amount: string; currency: string; rail_adapter: string; link_id: string }>>`
        UPDATE checkout_sessions
           SET link_id = ${fx.linkA2}
         WHERE id = ${session.id}
        RETURNING amount::text AS amount, currency, rail_adapter, link_id
      `,
      'same-merchant link update',
    );
    expect(movedLink.amount).toBe(AMOUNT);
    expect(movedLink.currency).toBe(CURRENCY);
    expect(movedLink.rail_adapter).toBe(RAIL);
    expect(movedLink.link_id).toBe(fx.linkA2);

    await expect(
      db`
        UPDATE checkout_sessions
           SET merchant_id = ${fx.merchantB}
         WHERE id = ${session.id}
      `,
    ).rejects.toThrow(/payment link merchant/);

    await expect(
      db`
        UPDATE checkout_sessions
           SET link_id = ${fx.linkB}
         WHERE id = ${session.id}
      `,
    ).rejects.toThrow(/payment link merchant/);

    await expect(
      db`
        UPDATE checkout_sessions
           SET payment_id = ${fx.paymentB}
         WHERE id = ${session.id}
      `,
    ).rejects.toThrow(/payment merchant/);

    await expect(
      db`
        UPDATE checkout_sessions
           SET merchant_id = ${fx.merchantB},
               link_id = ${fx.linkB}
         WHERE id = ${session.id}
      `,
    ).rejects.toThrow(/payment merchant/);

    const expired = one(
      await db<Array<{ amount: string; currency: string; rail_adapter: string; status: string }>>`
        UPDATE checkout_sessions
           SET status = 'expired'
         WHERE id = ${session.id}
        RETURNING amount::text AS amount, currency, rail_adapter, status
      `,
      'status update',
    );
    expect(expired.amount).toBe(AMOUNT);
    expect(expired.currency).toBe(CURRENCY);
    expect(expired.rail_adapter).toBe(RAIL);
    expect(expired.status).toBe('expired');

    const nullToken = 'l865-update-null';
    const open = await insertSession({
      linkId: fx.linkA,
      merchantId: fx.merchantA,
      paymentId: null,
      tokenHash: nullToken,
    });
    await expect(
      db`
        UPDATE checkout_sessions
           SET payment_id = ${fx.paymentB}
         WHERE id = ${open.id}
      `,
    ).rejects.toThrow(/payment merchant/);

    const attached = one(
      await db<Array<{ amount: string; currency: string; rail_adapter: string; payment_id: string }>>`
        UPDATE checkout_sessions
           SET payment_id = ${fx.paymentA2}
         WHERE id = ${open.id}
        RETURNING amount::text AS amount, currency, rail_adapter, payment_id
      `,
      'matching payment attach',
    );
    expect(attached.amount).toBe(AMOUNT);
    expect(attached.currency).toBe(CURRENCY);
    expect(attached.rail_adapter).toBe(RAIL);
    expect(attached.payment_id).toBe(fx.paymentA2);

    const realigned = one(
      await db<
        Array<{
          amount: string;
          currency: string;
          rail_adapter: string;
          merchant_id: string;
          link_id: string;
          payment_id: string;
        }>
      >`
        UPDATE checkout_sessions
           SET merchant_id = ${fx.merchantB},
               link_id = ${fx.linkB},
               payment_id = ${fx.paymentB}
         WHERE id = ${session.id}
        RETURNING amount::text AS amount, currency, rail_adapter, merchant_id, link_id, payment_id
      `,
      'realigned merchants',
    );
    expect(realigned.amount).toBe(AMOUNT);
    expect(realigned.currency).toBe(CURRENCY);
    expect(realigned.rail_adapter).toBe(RAIL);
    expect(realigned.merchant_id).toBe(fx.merchantB);
    expect(realigned.link_id).toBe(fx.linkB);
    expect(realigned.payment_id).toBe(fx.paymentB);

    expect(await stored(tokenHash)).toEqual({
      amount: AMOUNT,
      currency: CURRENCY,
      rail_adapter: RAIL,
      merchant_id: fx.merchantB,
      link_id: fx.linkB,
      payment_id: fx.paymentB,
      status: 'expired',
    });
    expect(await stored(nullToken)).toEqual({
      amount: AMOUNT,
      currency: CURRENCY,
      rail_adapter: RAIL,
      merchant_id: fx.merchantA,
      link_id: fx.linkA,
      payment_id: fx.paymentA2,
      status: 'open',
    });

    const down = readFileSync(join(drizzleDir, '0022_pay_checkout_session_merchant_match.down.sql'), 'utf8');
    await db.unsafe(rewritePaySchema(down, schema));

    const triggers = await db<Array<{ tgname: string }>>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema}
         AND c.relname = 'checkout_sessions'
         AND t.tgname = 'checkout_sessions_merchant_match_trg'
         AND NOT t.tgisinternal
    `;
    expect(triggers).toEqual([]);

    const afterDown = await stored(tokenHash);
    expect(afterDown?.amount).toBe(AMOUNT);
    expect(afterDown?.currency).toBe(CURRENCY);
    expect(afterDown?.rail_adapter).toBe(RAIL);
  });
});
