/**
 * The TEST age door's OTC quote, in real PostgreSQL: a quote made `ms` earlier keeps its own order and gaps, the desk then
 * reads it as expired or past its settle window, and a settled quote is never aged. Rows are TEST quotes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { SqlOtcQuoteStore } from './otc/quote-store.js';
import { acceptOtcQuote, buildOtcQuote, type OtcQuote } from './otc/rfq.js';
import { ageLeadApplication, ageOtcQuote } from './test-age-door.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
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
const T0 = new Date('2026-11-17T10:00:00.000Z');
const TTL = 60_000;

function quote(quoteId: string): OtcQuote {
  return buildOtcQuote({
    quoteId,
    userId: ALICE,
    side: 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: parseAmount('0.02'),
    midPrice: parseAmount('65000'),
    spreadBps: 20,
    counterparty: 'platform',
    counterpartyId: 'platform',
    now: T0,
    quoteTtlMs: TTL,
    rfqId: quoteId,
    rfqSeq: 1,
    makerId: 'test-lp-1',
    test: true,
  });
}

describe('the TEST age door ages one OTC quote, in PostgreSQL', () => {
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

  it('an open quote: created and expiring that much earlier, the gap between them kept, and no other quote moved', async () => {
    await store.saveOpen(quote('q-open'));
    await store.saveOpen(quote('q-other'));
    const aged = await ageOtcQuote(db.sql)('q-open', TTL + 1_000);
    expect(aged).toEqual({ createdAt: '2026-11-17T09:58:59.000Z', expiresAt: '2026-11-17T09:59:59.000Z', acceptedAt: null });
    const read = await store.load('q-open');
    expect(read?.lifecycle).toBe('open');
    expect([read?.quote.createdAt, read?.quote.expiresAt]).toEqual([aged?.createdAt, aged?.expiresAt]);
    expect((await store.load('q-other'))?.quote.expiresAt).toBe('2026-11-17T10:01:00.000Z');
  });

  it('a bound quote: its acceptance moves back with it, so the settle window measured from it has passed too', async () => {
    const q = quote('q-bound');
    await store.saveOpen(q);
    const fill = acceptOtcQuote({ quote: q, now: new Date(T0.getTime() + 5_000) });
    await store.saveBound(q, fill);
    const aged = await ageOtcQuote(db.sql)('q-bound', 90_000);
    expect(aged).toEqual({
      createdAt: '2026-11-17T09:58:30.000Z',
      expiresAt: '2026-11-17T09:59:30.000Z',
      acceptedAt: '2026-11-17T09:58:35.000Z',
    });
    const read = await store.load('q-bound');
    expect(read?.lifecycle).toBe('bound');
    expect(read && 'bound' in read ? read.bound.acceptedAt : null).toBe('2026-11-17T09:58:35.000Z');
  });

  it('a settled quote is history: not aged, and its times are as they were', async () => {
    const q = quote('q-settled');
    await store.saveOpen(q);
    const fill = acceptOtcQuote({ quote: q, now: new Date(T0.getTime() + 5_000) });
    await store.saveBound(q, fill);
    await store.saveSettled(q, fill, new Date(T0.getTime() + 10_000));
    expect(await ageOtcQuote(db.sql)('q-settled', 60_000)).toBeNull();
    expect((await store.load('q-settled'))?.quote.createdAt).toBe(T0.toISOString());
  });

  it('a quote that does not exist is not found', async () => {
    expect(await ageOtcQuote(db.sql)('q-none', 60_000)).toBeNull();
  });
});

describe('the TEST age door ages one rejected lead application, in PostgreSQL', () => {
  let db: TestDatabase;
  const REJECTED = '22222222-2222-4222-8222-222222222222';
  const OPEN = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE trade.copy_lead_applications`;
    await db.sql`
      INSERT INTO trade.copy_lead_applications (id, user_id, display_name, status, reason, created_at, updated_at, decided_at)
      VALUES (${REJECTED}, ${ALICE}, 'TEST lead', 'rejected', 'TEST reason', ${T0}, ${T0}, ${new Date(T0.getTime() + 5_000)}),
             (${OPEN}, 'bob', 'TEST other', 'pending', NULL, ${T0}, ${T0}, NULL)`;
  });

  it('a rejected application: created and decided that much earlier, so the wait measured from the decision has passed', async () => {
    expect(await ageLeadApplication(db.sql)(REJECTED, 60_000)).toEqual({
      createdAt: '2026-11-17T09:59:00.000Z',
      decidedAt: '2026-11-17T09:59:05.000Z',
    });
    const [other] = await db.sql<{ created_at: Date }[]>`SELECT created_at FROM trade.copy_lead_applications WHERE id = ${OPEN}`;
    expect(other?.created_at.toISOString()).toBe(T0.toISOString());
  });

  it('an open application, or one that does not exist, is never aged', async () => {
    expect(await ageLeadApplication(db.sql)(OPEN, 60_000)).toBeNull();
    expect(await ageLeadApplication(db.sql)('44444444-4444-4444-8444-444444444444', 60_000)).toBeNull();
  });
});
