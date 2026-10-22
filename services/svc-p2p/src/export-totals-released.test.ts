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
import { csvCell } from './customer-depth.js';

/**
 * P-trade-orders-14: export totals count released trades only; totalsByRole splits by side.
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

describe('svc-p2p export totals over released trades (P-trade-orders-14)', () => {
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

  async function cancelled(amount: string) {
    const offer = await sell();
    const t = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount(amount),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.cancelTrade(t.id, TAKER);
  }

  async function soldByTaker(amount: string) {
    const buyOffer = await sell({ side: 'buy' });
    const t = await p2p.takeOffer({
      offerId: buyOffer.id,
      takerId: TAKER,
      amount: parseAmount(amount),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.markFiatSent(t.id, MAKER);
    await p2p.confirmFiatReceived(t.id, TAKER);
  }

  it('totals count released trades only; a cancelled trade is excluded', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    await fund(TAKER, '1000');
    await released('20');
    await cancelled('30');
    const out = await caller(TAKER).trades.export({ from: FROM, to: TO, format: 'csv' });
    expect(out.rows).toBe(2);
    expect(out.totals).toEqual([{ asset: ASSET, fiatCurrency: 'USD', amount: '20', fiatAmount: '20' }]);
  });

  it('a range with only cancelled trades has no totals', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    await cancelled('25');
    const out = await caller(TAKER).trades.export({ from: FROM, to: TO, format: 'csv' });
    expect(out.rows).toBe(1);
    expect(out.totals).toEqual([]);
    expect(out.totalsByRole).toEqual([]);
  });

  it('totalsByRole splits released totals by the caller side; totals keep their shape', async () => {
    rebuild(FULL);
    await fund(MAKER, '1000');
    await fund(TAKER, '1000');
    await released('20');
    await cancelled('30');
    await soldByTaker('15');
    const out = await caller(TAKER).trades.export({ from: FROM, to: TO, format: 'csv' });
    expect(out.rows).toBe(3);
    expect(out.totals).toEqual([{ asset: ASSET, fiatCurrency: 'USD', amount: '35', fiatAmount: '35' }]);
    expect(out.totalsByRole).toEqual([
      { role: 'buyer', asset: ASSET, fiatCurrency: 'USD', amount: '20', fiatAmount: '20' },
      { role: 'seller', asset: ASSET, fiatCurrency: 'USD', amount: '15', fiatAmount: '15' },
    ]);
    const maker = await caller(MAKER).trades.export({ from: FROM, to: TO, format: 'csv' });
    expect(maker.totalsByRole).toEqual([
      { role: 'buyer', asset: ASSET, fiatCurrency: 'USD', amount: '15', fiatAmount: '15' },
      { role: 'seller', asset: ASSET, fiatCurrency: 'USD', amount: '20', fiatAmount: '20' },
    ]);
  });
});
