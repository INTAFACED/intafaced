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
 * P-trade-orders-13: order list paging, filters, tab counts and displayStatus.
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

describe('svc-p2p order list (P-trade-orders-13)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let p2p!: P2pService;
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let bus!: MemoryEventBus;

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

  const SECRET = 'p2p-order-list-edge-secret-long-ok';
  function sign(scopes: string[], userId: string) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-order-list');
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
    return edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-order-list',
    });
  }

  async function take(offerId: string) {
    return p2p.takeOffer({ offerId, takerId: TAKER, amount: parseAmount('10'), method: 'sepa', tradeId: crypto.randomUUID() });
  }

  it('given 300 trades, tab counts are exact and paging reaches the oldest', async () => {
    await fund(MAKER, '10000');
    const offer = await sell({ totalAmt: parseAmount('5000') });
    for (let i = 0; i < 300; i++) {
      const t = await take(offer.id);
      if (i % 3 === 0) await p2p.cancelTrade(t.id, TAKER);
      else if (i % 5 === 0) {
        await p2p.markFiatSent(t.id, TAKER);
        await p2p.confirmFiatReceived(t.id, MAKER);
      } else if (i % 7 === 0) {
        await p2p.markFiatSent(t.id, TAKER);
        await p2p.openDispute({ tradeId: t.id, openedBy: TAKER, reason: 'not released' });
      }
    }
    const truth = await sql<Array<{ status: string; n: number }>>`
      SELECT status::text AS status, count(*)::int AS n FROM p2p.p2p_trades GROUP BY status
    `;
    const n = (s: string) => truth.find((r) => r.status === s)?.n ?? 0;
    const caller = createP2pRouter(p2p, instruments).createCaller(sign(['p2p:read'], TAKER));

    const first = await caller.trades.page({ limit: 50 });
    expect(first.counts).toEqual({
      in_progress: n('created') + n('escrowed') + n('fiat_sent'),
      in_dispute: n('disputed'),
      completed: n('released'),
      cancelled: n('cancelled'),
    });
    expect(Object.values(first.counts).reduce((a, b) => a + b, 0)).toBe(300);
    expect(first.counts.in_dispute).toBeGreaterThan(0);

    const seen: string[] = [];
    let page = first;
    for (;;) {
      seen.push(...page.trades.map((t) => t.id));
      if (!page.nextCursor) break;
      page = await caller.trades.page({ limit: 50, cursor: page.nextCursor });
    }
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    const oldest = await sql<Array<{ id: string }>>`SELECT id FROM p2p.p2p_trades ORDER BY created_at ASC, id ASC LIMIT 1`;
    expect(seen[seen.length - 1]).toBe(oldest[0]?.id);

    const disputes = await caller.trades.page({ limit: 200, tab: 'in_dispute' });
    expect(disputes.trades).toHaveLength(n('disputed'));
    expect(disputes.trades.every((t) => t.status === 'disputed' && t.tab === 'in_dispute' && t.displayStatus === 'appealing')).toBe(true);
    // Counts are per tab over the filter, not the loaded window or the selected tab.
    expect(disputes.counts).toEqual(first.counts);
    const cancelled = await caller.trades.page({ limit: 200, tab: 'cancelled' });
    expect(cancelled.trades.every((t) => t.displayStatus === 'cancelled')).toBe(true);
  }, 240_000);

  it('a trade cancelled by timeout says so', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const t = await take(offer.id);
    await p2p.sweepDeadlines(new Date(Date.now() + 365 * 24 * 3600 * 1000), 100);
    const stored = await p2p.getTrade(t.id);
    expect(stored.status).toBe('cancelled');
    const out = await createP2pRouter(p2p, instruments)
      .createCaller(sign(['p2p:read'], TAKER))
      .trades.page({ limit: 10 });
    expect(out.trades[0]).toMatchObject({ id: t.id, tab: 'cancelled', displayStatus: 'cancelled_by_timeout' });
  });

  it('filters by side, asset, date range and order id prefix', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const a = await take(offer.id);
    const b = await take(offer.id);
    const caller = createP2pRouter(p2p, instruments).createCaller(sign(['p2p:read'], TAKER));
    expect((await caller.trades.page({ limit: 10, side: 'buy' })).trades).toHaveLength(2);
    expect((await caller.trades.page({ limit: 10, side: 'sell' })).trades).toHaveLength(0);
    expect((await caller.trades.page({ limit: 10, asset: 'BTC' })).counts.in_progress).toBe(0);
    expect((await caller.trades.page({ limit: 10, asset: ASSET })).counts.in_progress).toBe(2);
    const byId = await caller.trades.page({ limit: 10, orderId: a.id.slice(0, 13).toUpperCase() });
    expect(byId.trades.map((t) => t.id)).toEqual([a.id]);
    expect(byId.trades[0]?.displayStatus).toBe('waiting_for_buyer_to_pay');
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await caller.trades.page({ limit: 10, from: future })).trades).toHaveLength(0);
    expect((await caller.trades.page({ limit: 10, to: future })).trades.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    // A stranger sees none of TAKER's orders.
    const stranger = await createP2pRouter(p2p, instruments)
      .createCaller(sign(['p2p:read'], OTHER))
      .trades.page({ limit: 10 });
    expect(stranger.trades).toHaveLength(0);
    expect(stranger.counts).toEqual({ in_progress: 0, in_dispute: 0, completed: 0, cancelled: 0 });
  });

  it('refuses malformed filters with p2p.filter_invalid', async () => {
    const caller = createP2pRouter(p2p, instruments).createCaller(sign(['p2p:read'], TAKER));
    const bad = [
      { tab: 'open' },
      { asset: 'usdt' },
      { side: 'both' },
      { from: 'yesterday' },
      { to: '2026-13-99T00:00:00Z' },
      { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      { orderId: "x' OR 1=1" },
    ];
    for (const f of bad) {
      await expect(caller.trades.page({ limit: 10, ...f })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: expect.objectContaining({ code: 'p2p.filter_invalid' }),
      });
    }
  });

  it('refuses a bad cursor with p2p.cursor_invalid and a blank page size by name', async () => {
    const caller = createP2pRouter(p2p, instruments).createCaller(sign(['p2p:read'], TAKER));
    for (const cursor of [
      'not-a-cursor',
      Buffer.from('123\nnot-uuid').toString('base64url'),
      Buffer.from(`1\n${MAKER}\nx`).toString('base64url'),
    ]) {
      await expect(caller.trades.page({ limit: 10, cursor })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: expect.objectContaining({ code: 'p2p.cursor_invalid' }),
      });
    }
    await expect(caller.trades.page({})).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.trade_list_limit_unset' }),
    });
    await expect(createP2pRouter(p2p, instruments).createCaller(sign([], TAKER)).trades.page({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
