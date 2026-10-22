import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount, recipes } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { P2pService, P2pError } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { createP2pRouter } from './router.js';

/**
 * P-trade-orders-14: capped CSV export with audit, and receipts under owner quotas.
 * Postgres is the shared test server (TEST_DATABASE_URL). No balances are invented.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MODERATOR = '44444444-4444-4444-8444-444444444444';
const ASSET = 'USDT';

describe('svc-p2p export caps and receipts (P-trade-orders-14)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let p2p!: P2pService;
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let bus!: MemoryEventBus;
  let policy: import('./export-receipt.js').ExportPolicy = {};

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
    instruments = new InstrumentService(sql);
    p2p = new P2pService(sql, ledger, bus, {
      instruments,
      feeBps: 100,
      exportPolicy: policy,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    for (const methodId of ['sepa', 'wire']) {
      await instruments.registerMethodSchema({
        methodId,
        country: ANY_COUNTRY,
        label: 'Test rail',
        fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
      });
    }
    for (const ownerId of [MAKER, TAKER, OTHER]) {
      for (const methodId of ['sepa', 'wire']) {
        await instruments.createInstrument({
          ownerId,
          methodId,
          country: 'DE',
          fiatCurrency: 'USD',
          label: methodId,
          details: { account_reference: `ref-${ownerId}-${methodId}` },
          instrumentId: crypto.randomUUID(),
        });
      }
    }
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: ASSET,
        amount: parseAmount(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${crypto.randomUUID()}`,
      }),
    );
  }

  async function sell(overrides: Partial<Parameters<P2pService['createOffer']>[0]> = {}) {
    return p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'pay within 15 minutes',
      ...overrides,
    });
  }

  const SECRET = 'p2p-export-receipt-edge-secret-long';
  function caller(userId: string, scopes: string[] = ['p2p:read']) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-export');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: userId,
      userId,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes,
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-export',
      }),
    );
  }

  const FULL = { maxRangeDays: 3650, maxRows: 100, receiptDailyQuota: 2, receiptPerTradeQuota: 1 };
  const FROM = '2020-01-01T00:00:00.000Z';
  const TO = '2029-01-01T00:00:00.000Z';

  async function released(amount: string) {
    const offer = await sell();
    const t = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount(amount),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.markFiatSent(t.id, TAKER);
    await p2p.confirmFiatReceived(t.id, MAKER);
    return t;
  }

  function cause(code: string) {
    return { cause: expect.objectContaining({ code }) };
  }

  // `policy` is read in beforeEach; tests that need caps rebuild the service.
  function rebuild(next: typeof policy) {
    policy = next;
    p2p = new P2pService(sql, ledger, bus, {
      instruments,
      feeBps: 100,
      exportPolicy: policy,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
  }

  it('valid range: row count equals trade count, totals equal a recomputation, one audit row', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    await released('20');
    await released('12.5');
    const out = await caller(TAKER).trades.exportFile({ from: FROM, to: TO, format: 'csv' });
    const trades = await p2p.listTrades(TAKER, 50);
    expect(out.rows).toBe(trades.length);
    expect(out.csv.trim().split('\n')).toHaveLength(trades.length + 1);
    const sum = trades.reduce((a, t) => a + t.amount, 0n);
    const fiat = trades.reduce((a, t) => a + t.fiatAmount, 0n);
    expect(out.totals).toEqual([{ asset: ASSET, fiatCurrency: 'USD', amount: formatAmount(sum), fiatAmount: formatAmount(fiat) }]);
    expect(out.totals[0]?.amount).toBe('32.5');
    const audit = await sql<
      Array<{ kind: string; row_count: number; format: string }>
    >`SELECT kind, row_count, format FROM p2p.export_audit`;
    expect(audit).toEqual([{ kind: 'export', row_count: 2, format: 'csv' }]);
  });

  it('a range over the cap is refused with the cap', async () => {
    rebuild({ ...FULL, maxRangeDays: 30 });
    await expect(
      caller(TAKER).trades.exportFile({ from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z', format: 'csv' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('at most 30 days'),
      ...cause('p2p.export_range_too_large'),
    });
    const audit = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.export_audit`;
    expect(audit[0]?.n).toBe(0);
  });

  it('more rows than the cap is refused', async () => {
    rebuild({ ...FULL, maxRows: 1 });
    await fund(MAKER, '1000');
    await released('20');
    await released('20');
    await expect(caller(TAKER).trades.exportFile({ from: FROM, to: TO, format: 'csv' })).rejects.toMatchObject(
      cause('p2p.export_too_many_rows'),
    );
  });

  it('blank caps refuse p2p.config_unset; xlsx and pdf refuse as unbuilt; a bad range refuses', async () => {
    rebuild({});
    await expect(caller(TAKER).trades.exportFile({ from: FROM, to: TO, format: 'csv' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      ...cause('p2p.config_unset'),
    });
    rebuild({ maxRangeDays: 10 });
    await expect(caller(TAKER).trades.exportFile({ from: FROM, to: TO, format: 'csv' })).rejects.toMatchObject(cause('p2p.config_unset'));
    rebuild(FULL);
    for (const format of ['xlsx', 'pdf'] as const) {
      await expect(caller(TAKER).trades.exportFile({ from: FROM, to: TO, format })).rejects.toMatchObject(
        cause('p2p.export_format_unbuilt'),
      );
    }
    await expect(caller(TAKER).trades.exportFile({ from: TO, to: FROM, format: 'csv' })).rejects.toMatchObject(
      cause('p2p.export_range_invalid'),
    );
  });

  it('receipt for a released trade, for both parties, without counterparty identity', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    const t = await released('20');
    const r = await caller(TAKER).trades.receipt({ tradeId: t.id });
    expect(r.receipt).toMatchObject({ tradeId: t.id, role: 'buyer', amount: '20', asset: ASSET, method: 'sepa', feeBps: 100 });
    expect(JSON.stringify(r)).not.toContain(MAKER);
    expect(r.tradeRemaining).toBe(0);
    expect(r.dailyRemaining).toBe(1);
    const s = await caller(MAKER).trades.receipt({ tradeId: t.id });
    expect(s.receipt.role).toBe('seller');
    expect(JSON.stringify(s)).not.toContain(TAKER);
  });

  it('per-trade quota and daily quota refuse with the reset time; each download is audited', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    const a = await released('20');
    const b = await released('20');
    const c = await released('20');
    await caller(TAKER).trades.receipt({ tradeId: a.id });
    await expect(caller(TAKER).trades.receipt({ tradeId: a.id })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('does not reset'),
      ...cause('p2p.receipt_quota_reached'),
    });
    await caller(TAKER).trades.receipt({ tradeId: b.id });
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    await expect(caller(TAKER).trades.receipt({ tradeId: c.id })).rejects.toMatchObject({
      message: expect.stringContaining(`resets at ${tomorrow.toISOString()}`),
      ...cause('p2p.receipt_quota_reached'),
    });
    const audit = await sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM p2p.export_audit WHERE kind = 'receipt' AND user_id = ${TAKER}`;
    expect(audit[0]?.n).toBe(2);
    // The quota is per user: the seller still has its own.
    await expect(caller(MAKER).trades.receipt({ tradeId: c.id })).resolves.toMatchObject({ receipt: { role: 'seller' } });
  });

  it('receipt refuses a non-completed trade, a stranger, and blank quotas', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    const offer = await sell();
    const open = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await expect(caller(TAKER).trades.receipt({ tradeId: open.id })).rejects.toMatchObject(cause('p2p.receipt_not_available'));
    const done = await released('20');
    await expect(caller(OTHER).trades.receipt({ tradeId: done.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    rebuild({ maxRangeDays: 1, maxRows: 1, receiptDailyQuota: 5 });
    await expect(caller(TAKER).trades.receipt({ tradeId: done.id })).rejects.toMatchObject(cause('p2p.config_unset'));
    const audit = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.export_audit`;
    expect(audit[0]?.n).toBe(0);
  });

  it('the existing uncapped export is unchanged with no policy', async () => {
    rebuild({});
    await fund(MAKER, '1000');
    await released('20');
    const out = await p2p.exportTrades({ userId: TAKER, from: FROM, to: TO });
    expect(out.rows).toBe(1);
  });
});
