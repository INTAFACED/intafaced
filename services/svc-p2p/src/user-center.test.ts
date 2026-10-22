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
 * P-ads-merchant-20: user center stats and the counterparty card, recomputed from trades.
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

describe('svc-p2p user center (P-ads-merchant-20)', () => {
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

  const SECRET = 'p2p-user-center-edge-secret-long-ok';
  function sign(scopes: string[], userId: string) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-user-center');
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
      id: 'req-user-center',
    });
  }

  /** TAKER takes from MAKER's sell offer and drives it to the given outcome. */
  async function trade(outcome: 'released' | 'cancelled' | 'paid', amount: string) {
    const offer = await sell();
    const t = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount(amount),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    if (outcome === 'cancelled') {
      await p2p.cancelTrade(t.id, TAKER);
      return t.id;
    }
    await p2p.markFiatSent(t.id, TAKER);
    if (outcome === 'released') await p2p.confirmFiatReceived(t.id, MAKER);
    return t.id;
  }

  it('every own metric equals a recomputation from the trades', async () => {
    await fund(MAKER, '1000');
    await trade('released', '20');
    await trade('released', '30.5');
    await trade('cancelled', '10');
    await trade('paid', '15');

    const router = createP2pRouter(p2p, instruments);
    const stats = await router.createCaller(sign(['p2p:read'], MAKER)).merchants.stats();

    const trades = await p2p.listTrades(MAKER, 50);
    const escrowed = trades.filter((t) => t.escrowedAt !== null);
    const released = escrowed.filter((t) => t.status === 'released');
    expect(stats.ordersTotal).toBe(escrowed.length);
    expect(stats.completed).toBe(released.length);
    expect(stats.cancelled).toBe(escrowed.filter((t) => t.status === 'cancelled').length);
    expect(stats.completionRate).toBe(Math.round((released.length / escrowed.length) * 10_000) / 10_000);
    expect(stats.cancelRate).toBe(Math.round((stats.cancelled / escrowed.length) * 10_000) / 10_000);
    const secs = (from: Date | null, to: Date | null) => ((to as Date).getTime() - (from as Date).getTime()) / 1000;
    const avg = (xs: number[]) => Math.round(xs.reduce((x, y) => x + y, 0) / xs.length);
    // Seller side: escrow lock to release over MAKER's released sells.
    expect(stats.avgReleaseSecs).toBe(avg(released.map((t) => secs(t.escrowedAt, t.resolvedAt))));
    // MAKER never bought: no pay sample is null, not "0 seconds".
    expect(stats.avgPaySecs).toBeNull();
    const sum = released.reduce((acc, t) => acc + t.amount, 0n);
    expect(stats.volume).toEqual([
      {
        asset: ASSET,
        fiatCurrency: 'USD',
        amount: formatAmount(sum),
        fiatAmount: formatAmount(released.reduce((a, t) => a + t.fiatAmount, 0n)),
      },
    ]);
    expect(stats.volume[0]?.amount).toBe('50.5');
    expect(typeof stats.volume[0]?.amount).toBe('string');

    const buyer = await router.createCaller(sign(['p2p:read'], TAKER)).merchants.stats();
    // Buyer side: escrow lock to "marked paid" over every paid trade (3 samples).
    const paid = escrowed.filter((t) => t.fiatSentAt !== null);
    expect(paid).toHaveLength(3);
    expect(buyer.avgPaySecs).toBe(avg(paid.map((t) => secs(t.escrowedAt, t.fiatSentAt))));
    expect(buyer.avgReleaseSecs).toBeNull();
    expect(buyer.ordersTotal).toBe(stats.ordersTotal);
  });

  it('zero history is honest zeros and null averages', async () => {
    const stats = await createP2pRouter(p2p, instruments)
      .createCaller(sign(['p2p:read'], OTHER))
      .merchants.stats();
    expect(stats).toEqual({
      ordersTotal: 0,
      completed: 0,
      cancelled: 0,
      disputed: 0,
      completionRate: 0,
      cancelRate: 0,
      avgReleaseSecs: null,
      avgPaySecs: null,
      volume: [],
    });
  });

  it('stats needs the read scope', async () => {
    await expect(createP2pRouter(p2p, instruments).createCaller(sign([], MAKER)).merchants.stats()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('counterparty card shows identity handle, member-since and verification level when wired', async () => {
    await fund(MAKER, '1000');
    await trade('released', '20');
    const router = createP2pRouter(p2p, instruments, undefined, {
      publicProfile: {
        async lookup(userId) {
          return userId === MAKER ? { handle: 'maker_one', memberSince: '2025-03-01T00:00:00.000Z', verificationLevel: 'L2' } : null;
        },
      },
    });
    const card = await router.createCaller(sign(['p2p:read'], OTHER)).reputation.get({ userId: MAKER });
    expect(card.handle).toBe('maker_one');
    expect(card.handle).not.toBe('Member');
    expect(card.memberSince).toBe('2025-03-01T00:00:00.000Z');
    expect(card.verification).toEqual({ level: 'L2' });
    expect(card.rating).toBeNull();
    // MAKER sold only: no pay sample.
    expect(card.avgPaySecs).toBeNull();
    const buyerCard = await router.createCaller(sign(['p2p:read'], OTHER)).reputation.get({ userId: TAKER });
    const [only] = await p2p.listTrades(TAKER, 5);
    expect(buyerCard.avgPaySecs).toBe(Math.round((only!.fiatSentAt!.getTime() - only!.escrowedAt!.getTime()) / 1000));
    expect(buyerCard.avgPaySecs).not.toBeNull();
    expect(buyerCard.handle).toBeNull();
    expect(buyerCard.verification).toBeNull();
    expect(buyerCard.profile).toEqual({ status: 'absent', code: 'p2p.public_profile_absent' });
  });

  it('a profile without a verification level shows none rather than a guessed one', async () => {
    const router = createP2pRouter(p2p, instruments, undefined, {
      publicProfile: {
        async lookup() {
          return { handle: 'fresh', memberSince: '2026-10-01T00:00:00.000Z' };
        },
      },
    });
    const card = await router.createCaller(sign(['p2p:read'], OTHER)).reputation.get({ userId: MAKER });
    expect(card.verification).toBeNull();
    expect(card.tradesTotal).toBe(0);
    expect(card.completionRate).toBe(0);
    expect(card.avgPaySecs).toBeNull();
    expect(card.handle).toBe('fresh');
  });

  it('unwired identity gives null handle, never a "Member" placeholder', async () => {
    const card = await createP2pRouter(p2p, instruments)
      .createCaller(sign(['p2p:read'], OTHER))
      .reputation.get({ userId: MAKER });
    expect(card.handle).toBeNull();
    expect(card.memberSince).toBeNull();
    expect(card.verification).toBeNull();
    expect(card.profile).toEqual({ status: 'unwired', code: 'p2p.public_profile_unwired' });
  });

  it('refuses p2p.user_not_found when identity knows nobody and there is no history', async () => {
    const router = createP2pRouter(p2p, instruments, undefined, {
      publicProfile: {
        async lookup() {
          return null;
        },
      },
    });
    await expect(router.createCaller(sign(['p2p:read'], OTHER)).reputation.get({ userId: MAKER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: expect.objectContaining({ code: 'p2p.user_not_found' }),
    });
  });

  it('refuses p2p.blocked to a viewer in a blocked pair, either direction', async () => {
    const router = createP2pRouter(p2p, instruments);
    await p2p.setContact({ ownerId: MAKER, peerId: OTHER, kind: 'block', present: true, idempotencyKey: 'block-other-1' });
    await expect(router.createCaller(sign(['p2p:read'], OTHER)).reputation.get({ userId: MAKER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'p2p.blocked' }),
    });
    await expect(router.createCaller(sign(['p2p:read'], MAKER)).reputation.get({ userId: OTHER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'p2p.blocked' }),
    });
    // Own card is never blocked; an unrelated viewer still sees it.
    await expect(router.createCaller(sign(['p2p:read'], MAKER)).reputation.get({ userId: MAKER })).resolves.toMatchObject({
      tradesTotal: 0,
    });
    await expect(router.createCaller(sign(['p2p:read'], TAKER)).reputation.get({ userId: MAKER })).resolves.toMatchObject({
      tradesTotal: 0,
    });
    await p2p.setContact({ ownerId: MAKER, peerId: OTHER, kind: 'block', present: false, idempotencyKey: 'unblock-other-1' });
    await expect(router.createCaller(sign(['p2p:read'], OTHER)).reputation.get({ userId: MAKER })).resolves.toMatchObject({
      tradesTotal: 0,
    });
  });
});
