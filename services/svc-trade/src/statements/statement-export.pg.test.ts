/**
 * Statement export (J-cex-spot-07 #5) against Postgres.
 *
 * Promise: one request key is one job and one file, built once; the file lists exactly the caller's orders, trades and
 * ledger lines of the range [from, to), and nothing of anyone else's; a job is the caller's alone.
 * Break: a resend builds a second file; the same key quietly answers a different range; a row from just outside the
 * range, or another customer's row, rides along; a range too large to list is cut short; another person's job reads.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { LedgerLine, LedgerPages } from './ledger-history.js';
import { STATEMENT_CODES, STATEMENT_COLUMNS, StatementError, StatementExports } from './statement-export.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')).endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-10-02T00:00:00.000Z';

function principal(userId: string, scopes = ['trade:read']): Principal {
  return {
    sub: userId,
    userId,
    sid: randomUUID(),
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(NOW.getTime() + 60_000),
  } as Principal;
}

function line(id: number, at: string, over: Partial<LedgerLine> = {}): LedgerLine {
  return {
    entryId: String(id),
    txId: `tx-${id}`,
    module: 'trade',
    reason: 'trade.fill',
    direction: 'debit',
    amount: '1',
    postedAt: new Date(at),
    assetId: 'USDT',
    orderId: null,
    ...over,
  };
}

/** The ledger as svc-ledger pages it for one person: newest first, all of it on one page here. */
function ledgerOf(byUser: Record<string, LedgerLine[]>, calls: { n: number }): LedgerPages {
  return {
    async page(request) {
      calls.n += 1;
      const mine = [...(byUser[request.userId] ?? [])].sort((a, b) => Number(b.entryId) - Number(a.entryId));
      return { entries: mine, nextCursor: null };
    },
  };
}

describe('statement export', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.statement_exports, trade.fills, trade.order_stop_trigger, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${MARKET}, 'BTC/USDT', 'BTC', 'USDT', 'spot', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC spot', now())`;
  });

  async function order(userId: string, at: string, over: { price?: string; status?: string; filled?: string } = {}): Promise<string> {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset,
        hold_amount, created_at)
      VALUES (${id}, ${userId}, ${MARKET}, ${`c-${id}`}, 'buy', 'limit', ${over.price ?? '49000'}, '0.5', ${over.filled ?? '0'},
        ${over.status ?? 'open'}, 'GTC', 'USDT', 24500, ${new Date(at)})`;
    return id;
  }

  let sequence = 0;
  async function fill(userId: string, orderId: string, at: string): Promise<string> {
    const id = randomUUID();
    sequence += 1;
    await db.sql`
      INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount,
        fee_asset, fee_amount, fee_bps, sequence, ts)
      VALUES (${id}, ${orderId}, ${randomUUID()}, ${MARKET}, ${userId}, 'buy', 'taker', 49000, '0.25', 12250, 'BTC', '0.00005', 20,
        ${sequence}, ${new Date(at)})`;
    return id;
  }

  function rows(csv: string): Array<Record<string, string>> {
    const [head, ...body] = csv.trimEnd().split('\n');
    expect(head).toBe(STATEMENT_COLUMNS.join(','));
    return body.map((r) => Object.fromEntries(r.split(',').map((v, i) => [STATEMENT_COLUMNS[i], v])));
  }

  it('builds one file listing exactly the range’s orders, trades and ledger lines, and a resend answers the same job', async () => {
    const before = await order(ALICE, '2026-09-30T23:59:59.999Z');
    const first = await order(ALICE, FROM, { status: 'filled', filled: '0.5' });
    const second = await order(ALICE, '2026-10-01T18:30:00.000Z');
    await order(ALICE, TO); // `to` is exclusive
    const bobs = await order(BOB, '2026-10-01T12:00:00.000Z');
    const filled = await fill(ALICE, first, '2026-10-01T00:00:01.000Z');
    await fill(ALICE, before, '2026-09-30T23:00:00.000Z');
    await fill(BOB, bobs, '2026-10-01T12:00:01.000Z');
    const calls = { n: 0 };
    const ledger = ledgerOf(
      {
        [ALICE]: [
          line(10, '2026-09-30T23:59:59.000Z', { reason: 'deposit.crypto' }),
          line(11, FROM, { direction: 'credit', reason: 'order.hold', amount: '24500', orderId: first }),
          line(12, '2026-10-01T00:00:01.000Z', { assetId: 'BTC', amount: '0.24995', orderId: first }),
          line(13, TO, { reason: 'order.hold.released' }),
        ],
        [BOB]: [line(20, '2026-10-01T12:00:00.000Z')],
      },
      calls,
    );
    const exports = new StatementExports(db.sql, ledger, () => NOW);

    const job = await exports.request(principal(ALICE), { from: FROM, to: TO, requestKey: 'stmt-2026-10-01' });
    expect(job).toMatchObject({ status: 'finished', from: FROM, to: TO, rows: { orders: 2, trades: 1, ledger: 2 }, error: null });
    const file = await exports.file(principal(ALICE), job.id);
    expect(file.sha256).toBe(job.sha256);
    expect(createHash('sha256').update(file.csv, 'utf8').digest('hex')).toBe(file.sha256);
    expect(file.filename).toBe('statement-2026-10-01-2026-10-02.csv');

    const listed = rows(file.csv);
    expect(listed.map((r) => [r.record, r.id])).toEqual([
      ['order', first],
      ['order', second],
      ['trade', filled],
      ['ledger', '11'],
      ['ledger', '12'],
    ]);
    expect(listed[0]).toMatchObject({
      market: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      status: 'filled',
      price: '49000',
      amount: '0.5',
      filled: '0.5',
    });
    expect(listed[2]).toMatchObject({
      market: 'BTC/USDT',
      price: '49000',
      amount: '0.25',
      fee: '0.00005',
      fee_asset: 'BTC',
      order_id: first,
    });
    expect(listed[3]).toMatchObject({
      direction: 'out',
      amount: '24500',
      asset: 'USDT',
      ledger_ref: 'tx-11',
      reason: 'order.hold',
      order_id: first,
    });
    expect(listed[4]).toMatchObject({ direction: 'in', amount: '0.24995', asset: 'BTC', ledger_ref: 'tx-12' });

    // The same request again: the same job and file, not rebuilt.
    const again = await exports.request(principal(ALICE), { from: FROM, to: TO, requestKey: 'stmt-2026-10-01' });
    expect(again).toEqual(job);
    expect(calls.n).toBe(1);
    const [{ n }] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.statement_exports`;
    expect(n).toBe(1);
  });

  it('refuses the same key for another range, a range not over yet, a backwards or overlong range, and a malformed key', async () => {
    const exports = new StatementExports(db.sql, ledgerOf({}, { n: 0 }), () => NOW);
    await exports.request(principal(ALICE), { from: FROM, to: TO, requestKey: 'stmt-key-one' });
    const refusal = (input: object) =>
      exports.request(principal(ALICE), input).then(
        () => null,
        (err: unknown) => (err instanceof StatementError ? err.code : err),
      );
    expect(await refusal({ from: FROM, to: '2026-10-03T00:00:00.000Z', requestKey: 'stmt-key-one' })).toBe(STATEMENT_CODES.keyReused);
    expect(await refusal({ from: FROM, to: '2026-10-21T00:00:00.000Z', requestKey: 'stmt-key-two' })).toBe(STATEMENT_CODES.rangeNotOver);
    expect(await refusal({ from: TO, to: FROM, requestKey: 'stmt-key-two' })).toBe(STATEMENT_CODES.rangeInvalid);
    expect(await refusal({ from: '2025-01-01T00:00:00.000Z', to: TO, requestKey: 'stmt-key-two' })).toBe(STATEMENT_CODES.rangeTooWide);
    expect(await refusal({ from: FROM, to: TO, requestKey: 'short' })).toBe(STATEMENT_CODES.keyInvalid);
    expect(await refusal({ from: '1 Oct', to: TO, requestKey: 'stmt-key-two' })).toBe(STATEMENT_CODES.rangeInvalid);
    // Bob may use the same key for his own statement.
    await expect(
      exports.request(principal(BOB), { from: FROM, to: '2026-10-03T00:00:00.000Z', requestKey: 'stmt-key-one' }),
    ).resolves.toMatchObject({
      status: 'finished',
    });
  });

  it('keeps a job to its owner: another person reads not found, and a read needs trade:read', async () => {
    const exports = new StatementExports(db.sql, ledgerOf({}, { n: 0 }), () => NOW);
    const job = await exports.request(principal(ALICE), { from: FROM, to: TO, requestKey: 'stmt-own-key' });
    await expect(exports.get(principal(BOB), job.id)).rejects.toMatchObject({ code: STATEMENT_CODES.notFound });
    await expect(exports.file(principal(BOB), job.id)).rejects.toMatchObject({ code: STATEMENT_CODES.notFound });
    await expect(exports.get(principal(ALICE), 'not-a-uuid')).rejects.toMatchObject({ code: STATEMENT_CODES.notFound });
    await expect(exports.get(principal(ALICE, []), job.id)).rejects.toThrow();
    await expect(exports.get(principal(ALICE), job.id)).resolves.toMatchObject({ id: job.id, status: 'finished' });
  });

  it('leaves a job pending when the ledger cannot be read, and the same request builds it once the ledger answers', async () => {
    let up = false;
    const ledger: LedgerPages = {
      async page() {
        if (!up) throw new Error('svc-ledger unreachable');
        return { entries: [line(1, '2026-10-01T05:00:00.000Z')], nextCursor: null };
      },
    };
    const exports = new StatementExports(db.sql, ledger, () => NOW);
    const input = { from: FROM, to: TO, requestKey: 'stmt-retry-key' };
    await expect(exports.request(principal(ALICE), input)).rejects.toThrow('svc-ledger unreachable');
    const [pending] = await db.sql<Array<{ id: string; status: string }>>`SELECT id, status FROM trade.statement_exports`;
    expect(pending?.status).toBe('pending');
    await expect(exports.file(principal(ALICE), pending!.id)).rejects.toMatchObject({ code: STATEMENT_CODES.notFinished });
    up = true;
    const job = await exports.request(principal(ALICE), input);
    expect(job).toMatchObject({ id: pending!.id, status: 'finished', rows: { orders: 0, trades: 0, ledger: 1 } });
  });

  it('fails a range with more ledger lines than a statement carries, instead of a short file', async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => line(i + 1, '2026-10-01T05:00:00.000Z'));
    const exports = new StatementExports(db.sql, ledgerOf({ [ALICE]: many }, { n: 0 }), () => NOW);
    const job = await exports.request(principal(ALICE), { from: FROM, to: TO, requestKey: 'stmt-too-large' });
    expect(job).toMatchObject({ status: 'failed', error: STATEMENT_CODES.tooLarge, rows: null, sha256: null });
    await expect(exports.file(principal(ALICE), job.id)).rejects.toMatchObject({ code: STATEMENT_CODES.notFinished });
  });
});
