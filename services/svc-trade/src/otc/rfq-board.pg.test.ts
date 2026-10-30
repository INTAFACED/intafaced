/**
 * One request, several quotes, one accept (real PostgreSQL, J-copy-bots-otc-24 #5): the quotes of a request are read
 * back together, the database refuses a second accepted quote of the same request, and the board groups requests by
 * status with counts and ranks each request's quotes best first, ties to the quote asked earlier. Rows are TEST quotes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { SqlOtcQuoteStore } from './quote-store.js';
import { listRfqBoard } from './rfq-board.js';
import { acceptOtcQuote, buildOtcQuote, type OtcQuote, type OtcSide } from './rfq.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const principal = (userId: string) => ({ userId, sub: userId, scopes: ['trade:read'], tier: 'full', mfa: false }) as unknown as Principal;
const T0 = new Date('2026-10-30T10:00:00.000Z');
const window = { from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T23:00:00.000Z', limit: 50 };

/** One quote of request `rfqId`, priced off a TEST mid of 65000 at `spreadBps`. */
function quote(
  rfqId: string,
  seq: number,
  makerId: string,
  spreadBps: number,
  over: { side?: OtcSide; userId?: string; at?: Date } = {},
): OtcQuote {
  return buildOtcQuote({
    quoteId: seq === 1 ? rfqId : `${rfqId}-${seq}`,
    userId: over.userId ?? ALICE,
    side: over.side ?? 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: parseAmount('1'),
    midPrice: parseAmount('65000'),
    spreadBps,
    counterparty: 'platform',
    counterpartyId: 'platform',
    now: over.at ?? T0,
    quoteTtlMs: 60_000,
    rfqId,
    rfqSeq: seq,
    makerId,
    test: makerId !== 'house',
  });
}

describe('RFQ with several quotes, in PostgreSQL', () => {
  let db: TestDatabase;
  let store: SqlOtcQuoteStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
    store = new SqlOtcQuoteStore(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE otc_desk_quotes`;
  });

  it('reads every quote of a request back, in the order the providers were asked, with its provider and TEST flag', async () => {
    await store.saveOpen(quote('rfq-a', 1, 'test-lp-2', 30));
    await store.saveOpen(quote('rfq-a', 2, 'house', 20));
    await store.saveOpen(quote('rfq-a', 3, 'test-lp-1', 10));
    await store.saveOpen(quote('rfq-other', 1, 'house', 20));
    const read = await store.listRfq('rfq-a');
    expect(read.map((s) => [s.quote.quoteId, s.quote.rfqSeq, s.quote.makerId, s.quote.test])).toEqual([
      ['rfq-a', 1, 'test-lp-2', true],
      ['rfq-a-2', 2, 'house', false],
      ['rfq-a-3', 3, 'test-lp-1', true],
    ]);
  });

  it('saves a request all or none: a quote the database refuses leaves no other quote of that request open', async () => {
    const good = quote('rfq-torn', 1, 'house', 20);
    // A side the table's check refuses, standing in for any failure part-way through the request.
    const refused = { ...quote('rfq-torn', 2, 'test-lp-1', 10), side: 'neither' as OtcSide };
    await expect(store.saveOpenRequest([good, refused])).rejects.toMatchObject({ code: '23514' });
    expect(await store.listRfq('rfq-torn')).toEqual([]);
    expect(await store.load('rfq-torn')).toBeNull();
  });

  it('refuses a second accepted quote of one request, and the first stays the only one bound', async () => {
    const first = quote('rfq-b', 1, 'house', 20);
    const second = quote('rfq-b', 2, 'test-lp-1', 10);
    await store.saveOpen(first);
    await store.saveOpen(second);
    await store.saveBound(first, acceptOtcQuote({ quote: first, now: T0 }));
    await expect(store.saveBound(second, acceptOtcQuote({ quote: second, now: T0 }))).rejects.toMatchObject({
      code: 'trade.rfq_other_quote_accepted',
    });
    const read = await store.listRfq('rfq-b');
    expect(read.map((s) => [s.quote.quoteId, s.lifecycle])).toEqual([
      ['rfq-b', 'bound'],
      ['rfq-b-2', 'open'],
    ]);
  });

  it('groups the caller’s requests by status with counts and ranks each request’s quotes, ties to the earlier', async () => {
    // Open: three quotes; providers 1 and 3 both at 10 bps, so provider 1 (asked second) beats provider 3 (asked third).
    await store.saveOpen(quote('rfq-open', 1, 'test-lp-2', 30));
    await store.saveOpen(quote('rfq-open', 2, 'test-lp-1', 10));
    await store.saveOpen(quote('rfq-open', 3, 'test-lp-3', 10));
    // Accepted: one quote bound.
    const bound = quote('rfq-accepted', 1, 'house', 20, { at: new Date(T0.getTime() + 1_000) });
    await store.saveOpen(bound);
    await store.saveBound(bound, acceptOtcQuote({ quote: bound, now: T0 }));
    // Settled.
    const settled = quote('rfq-settled', 1, 'house', 20, { at: new Date(T0.getTime() + 2_000) });
    await store.saveOpen(settled);
    const fill = acceptOtcQuote({ quote: settled, now: T0 });
    await store.saveBound(settled, fill);
    await store.saveSettled(settled, fill, T0);
    // Expired: priced an hour earlier and never accepted.
    await store.saveOpen(quote('rfq-expired', 1, 'house', 20, { at: new Date(T0.getTime() - 3_600_000) }));
    // Another account's request never shows.
    await store.saveOpen(quote('rfq-bob', 1, 'house', 20, { userId: BOB }));

    const board = await listRfqBoard(db.sql, principal(ALICE), window, new Date(T0.getTime() + 10_000));
    expect(board.groups.map((g) => [g.status, g.count, g.requests.map((r) => r.rfqId)])).toEqual([
      ['open', 1, ['rfq-open']],
      ['accepted', 1, ['rfq-accepted']],
      ['settled', 1, ['rfq-settled']],
      ['expired', 1, ['rfq-expired']],
    ]);
    expect(board.more).toBe(false);
    const open = board.groups[0]!.requests[0]!;
    expect(open.quotes.map((q) => [q.makerId, q.quotedPrice, q.rank, q.best, q.test])).toEqual([
      ['test-lp-1', '65065', 1, true, true],
      ['test-lp-3', '65065', 2, false, true],
      ['test-lp-2', '65195', 3, false, true],
    ]);
  });

  it('pages by request, not by quote, and says when there are more', async () => {
    for (let i = 0; i < 3; i++) {
      const at = new Date(T0.getTime() + i * 1_000);
      await store.saveOpen(quote(`rfq-${i}`, 1, 'house', 20, { at }));
      await store.saveOpen(quote(`rfq-${i}`, 2, 'test-lp-1', 10, { at }));
    }
    const board = await listRfqBoard(db.sql, principal(ALICE), { ...window, limit: 2 }, T0);
    const shown = board.groups.flatMap((g) => g.requests);
    expect(shown.map((r) => [r.rfqId, r.quotes.length])).toEqual([
      ['rfq-2', 2],
      ['rfq-1', 2],
    ]);
    expect(board.more).toBe(true);
  });

  it('refuses a blank window or limit rather than invent one', async () => {
    await expect(listRfqBoard(db.sql, principal(ALICE), { from: window.from, to: window.to }, T0)).rejects.toMatchObject({
      code: 'trade.rfq_list_limit_unset',
    });
    await expect(listRfqBoard(db.sql, principal(ALICE), { limit: 10 }, T0)).rejects.toMatchObject({ code: 'trade.rfq_list_window_unset' });
  });
});
