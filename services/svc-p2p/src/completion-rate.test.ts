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
 * P-trade-orders-21: 30-day vs total completion rate and the one-time appeal.
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

describe('svc-p2p completion rates and appeal (P-trade-orders-21)', () => {
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
      appealReviewHours: 48,
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

  const SECRET = 'p2p-completion-edge-secret-long-ok';
  function caller(userId: string, scopes: string[] = ['p2p:read', 'p2p:write']) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-completion');
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
        id: 'req-completion',
      }),
    );
  }

  async function trade(outcome: 'released' | 'cancelled' | 'open') {
    const offer = await sell();
    const t = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    if (outcome === 'cancelled') await p2p.cancelTrade(t.id, TAKER);
    if (outcome === 'released') {
      await p2p.markFiatSent(t.id, TAKER);
      await p2p.confirmFiatReceived(t.id, MAKER);
    }
    return t;
  }

  const pct = (part: number, whole: number) => (whole === 0 ? '0.00' : ((part * 100) / whole).toFixed(2));

  it('both rates equal a recomputation from trades; definition is data', async () => {
    await fund(MAKER, '1000');
    await trade('released');
    await trade('released');
    await trade('cancelled');
    await trade('open');
    const old = await trade('released');
    // Age one completed trade out of the 30-day window (created_at is not frozen).
    await sql`UPDATE p2p.p2p_trades SET created_at = now() - interval '40 days' WHERE id = ${old.id}`;
    const all = await p2p.listTrades(TAKER, 50);
    const counted = all.filter((t) => t.escrowedAt !== null);
    const done = counted.filter((t) => t.status === 'released');
    const recent = counted.filter((t) => t.createdAt.getTime() >= Date.now() - 30 * 86_400_000);
    const card = await caller(OTHER, ['p2p:read']).reputation.get({ userId: TAKER });
    expect(card.completionRateTotal).toBe(pct(done.length, counted.length));
    expect(card.completionRate30d).toBe(pct(recent.filter((t) => t.status === 'released').length, recent.length));
    expect(card.completionRateTotal).toBe('60.00');
    expect(card.completionRate30d).toBe('50.00');
    expect(card.completionDefinition.denominator).toContain('reached escrow');
  });

  it('no history is 0.00, never 100.00', async () => {
    const card = await caller(OTHER, ['p2p:read']).reputation.get({ userId: TAKER });
    expect(card.completionRate30d).toBe('0.00');
    expect(card.completionRateTotal).toBe('0.00');
  });

  it('one appeal per user: submit, replay returns it, a second is refused p2p.appeal_used', async () => {
    await fund(MAKER, '1000');
    const a = await trade('cancelled');
    const b = await trade('cancelled');
    expect(await caller(TAKER).reputation.myAppeal()).toBeNull();
    const first = await caller(TAKER).reputation.appeal({ tradeId: a.id, reason: 'seller asked me to cancel' });
    expect(first).toMatchObject({ tradeId: a.id, status: 'submitted', decidedBy: null });
    expect(new Date(first.reviewDueAt).getTime() - new Date(first.submittedAt).getTime()).toBe(48 * 3600_000);
    const again = await caller(TAKER).reputation.appeal({ tradeId: a.id, reason: 'seller asked me to cancel' });
    expect(again.id).toBe(first.id);
    await expect(caller(TAKER).reputation.appeal({ tradeId: b.id, reason: 'another' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'p2p.appeal_used' }),
    });
    expect((await caller(TAKER).reputation.myAppeal())?.id).toBe(first.id);
  });

  it('an accepted appeal changes the rate once (decision step is left for later; set here in SQL)', async () => {
    await fund(MAKER, '1000');
    await trade('released');
    const c = await trade('cancelled');
    expect((await caller(OTHER, ['p2p:read']).reputation.get({ userId: TAKER })).completionRateTotal).toBe('50.00');
    const ap = await caller(TAKER).reputation.appeal({ tradeId: c.id, reason: 'payment rail outage' });
    // Submitted alone changes nothing.
    expect((await caller(OTHER, ['p2p:read']).reputation.get({ userId: TAKER })).completionRateTotal).toBe('50.00');
    await sql`UPDATE p2p.completion_appeals SET status = 'accepted', decided_by = ${OTHER}, decided_at = now(), decision_reason = 'verified outage' WHERE id = ${ap.id}`;
    expect((await caller(OTHER, ['p2p:read']).reputation.get({ userId: TAKER })).completionRateTotal).toBe('100.00');
    // The maker's own rate is untouched by the taker's appeal.
    expect((await caller(OTHER, ['p2p:read']).reputation.get({ userId: MAKER })).completionRateTotal).toBe('50.00');
  });

  it('refuses blank reason, ineligible trades, strangers, missing scope and blank review window', async () => {
    await fund(MAKER, '1000');
    const done = await trade('released');
    const c = await trade('cancelled');
    await expect(caller(TAKER).reputation.appeal({ tradeId: c.id, reason: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: 'p2p.reason_required' }),
    });
    await expect(caller(TAKER).reputation.appeal({ tradeId: done.id, reason: 'x' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.appeal_not_eligible' }),
    });
    await expect(caller(OTHER).reputation.appeal({ tradeId: c.id, reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller(TAKER, ['p2p:read']).reputation.appeal({ tradeId: c.id, reason: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller(TAKER, []).reputation.myAppeal()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    p2p = new P2pService(sql, ledger, bus, { instruments, feeBps: 100 });
    await expect(caller(TAKER).reputation.appeal({ tradeId: c.id, reason: 'x' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.config_unset' }),
    });
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.completion_appeals`;
    expect(rows[0]?.n).toBe(0);
  });
});
