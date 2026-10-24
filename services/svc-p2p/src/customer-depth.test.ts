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
 * Acceptance for the P2P screens that were built with these controls off.
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

describe('svc-p2p customer depth', () => {
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
      // P-trade-orders-14: trades.export now refuses without owner caps; generous caps keep this test about export content.
      exportPolicy: { maxRangeDays: 36_500, maxRows: 10_000 },
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

  it('create with the same idempotency key publishes one offer', async () => {
    const first = await sell({ idempotencyKey: 'create-once-key' });
    const second = await sell({ idempotencyKey: 'create-once-key' });
    expect(second.id).toBe(first.id);
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.offers`;
    expect(rows[0]?.n).toBe(1);
    expect(bus.emitted('p2pOfferCreated')).toHaveLength(1);
    await expect(sell({ idempotencyKey: 'create-once-key', price: parseAmount('2') })).rejects.toMatchObject({
      code: 'p2p.idempotency_conflict',
    });
  });

  it('a client-chosen offer id is not published twice', async () => {
    const offerId = crypto.randomUUID();
    const first = await sell({ offerId });
    const second = await sell({ offerId });
    expect(second.id).toBe(first.id);
    expect(bus.emitted('p2pOfferCreated')).toHaveLength(1);
  });

  it('editing an offer leaves the open order on the terms it was taken on', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    const edited = await p2p.updateOffer({
      offerId: offer.id,
      makerId: MAKER,
      idempotencyKey: 'edit-terms-1',
      price: parseAmount('3'),
      terms: 'new terms',
    });
    expect(formatAmount(edited.price)).toBe('3');
    expect(edited.terms).toBe('new terms');
    const again = await p2p.updateOffer({
      offerId: offer.id,
      makerId: MAKER,
      idempotencyKey: 'edit-terms-1',
      price: parseAmount('3'),
      terms: 'new terms',
    });
    expect(again.id).toBe(offer.id);
    expect(formatAmount(again.price)).toBe('3');
    const stored = await p2p.getTrade(trade.id);
    expect(formatAmount(stored.price)).toBe('1');
    expect(formatAmount(stored.amount)).toBe('20');
    expect(stored.method).toBe('sepa');
    const snap = await sql<Array<{ terms_snapshot: string }>>`
      SELECT terms_snapshot FROM p2p.p2p_trades WHERE id = ${trade.id}
    `;
    expect(snap[0]?.terms_snapshot).toBe('pay within 15 minutes');
    await expect(p2p.updateOffer({ offerId: offer.id, makerId: TAKER, idempotencyKey: 'not-maker', terms: 'no' })).rejects.toMatchObject({
      code: 'p2p.not_a_party',
    });
  });

  it('refuses an offer edit that lifts maxAmt past the standard ceiling', async () => {
    const capped = new P2pService(sql, ledger, bus, {
      instruments,
      offerLimits: {
        standardMaxAmount: parseAmount('100'),
        merchantMaxAmount: null,
        standardMode: 'capped',
        merchantMode: 'unset',
      },
    });
    const offer = await capped.createOffer({
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
      idempotencyKey: 'ceiling-create',
    });
    await expect(
      capped.updateOffer({
        offerId: offer.id,
        makerId: MAKER,
        idempotencyKey: 'ceiling-up',
        maxAmt: parseAmount('101'),
        totalAmt: parseAmount('101'),
      }),
    ).rejects.toMatchObject({ code: 'p2p.offer_limit_exceeded' });
    const stored = await sql<Array<{ max_amt: string }>>`
      SELECT max_amt::text AS max_amt FROM p2p.offers WHERE id = ${offer.id}
    `;
    expect(formatAmount(parseAmount(stored[0]!.max_amt))).toBe('100');
    const lowered = await capped.updateOffer({
      offerId: offer.id,
      makerId: MAKER,
      idempotencyKey: 'ceiling-down',
      maxAmt: parseAmount('90'),
    });
    expect(formatAmount(lowered.maxAmt)).toBe('90');
  });

  it('quotes fee, net and reservation expiry without writing a trade', async () => {
    const offer = await sell();
    const before = new Date();
    const quoted = await p2p.quoteTake({ offerId: offer.id, takerId: TAKER, amount: parseAmount('100'), method: 'sepa' });
    expect(formatAmount(quoted.fee)).toBe('1');
    expect(formatAmount(quoted.netAmount)).toBe('99');
    expect(formatAmount(quoted.fiatAmount)).toBe('100');
    expect(quoted.feeBps).toBe(100);
    expect(quoted.reservationExpiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 120_000 - 2_000);
    expect(quoted.reservationExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120_000 + 2_000);
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.p2p_trades`;
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses a quote when the fee policy is unset', async () => {
    const bare = new P2pService(sql, ledger, bus, { instruments });
    const offer = await sell();
    await expect(bare.quoteTake({ offerId: offer.id, takerId: TAKER, amount: parseAmount('100'), method: 'sepa' })).rejects.toMatchObject({
      code: 'p2p.fee_bps_unset',
    });
  });

  it('filters the board by method, maker and min fiat, and pages with a cursor', async () => {
    await sell({ price: parseAmount('1'), idempotencyKey: 'board-a' });
    await sell({ price: parseAmount('2'), methods: ['wire'], idempotencyKey: 'board-b' });
    await p2p.createOffer({
      makerId: OTHER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('4'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      idempotencyKey: 'board-c',
    });
    await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'float',
      price: parseAmount('1.01'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      idempotencyKey: 'board-float',
    });

    const wire = await p2p.listOfferBoard({ limit: 10, methodId: 'wire', viewerId: TAKER });
    expect(wire.offers).toHaveLength(1);
    expect(wire.offers[0]?.methods).toEqual(['wire']);

    const makers = await p2p.listOfferBoard({ limit: 10, makerId: OTHER, viewerId: TAKER });
    expect(makers.offers.map((o) => o.makerId)).toEqual([OTHER]);

    const fiat = await p2p.listOfferBoard({ limit: 10, minFiat: '150', viewerId: TAKER });
    expect(fiat.offers.every((o) => o.priceType === 'fixed')).toBe(true);
    expect(fiat.offers.map((o) => formatAmount(o.price)).sort()).toEqual(['2', '4']);

    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-depth');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const secret = 'p2p-depth-edge-secret-long-enough-ok';
    const edge = createEdgeContext({ secret, serviceName: 'svc-p2p' });
    const viewer = {
      sub: TAKER,
      userId: TAKER,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['p2p:read'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(viewer);
    const board = createP2pRouter(p2p, instruments).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-board-page',
      }),
    );
    const seen: string[] = [];
    const references: Array<[string, unknown]> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const page = await board.offers.page({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.offers.map((o) => o.id));
      references.push(...page.offers.map((o): [string, unknown] => [o.priceType, o.referencePrice]));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(4);
    // No market feed is wired here: the floating ad says so with a null reference; fixed ads carry none.
    expect(references).toEqual([
      ['fixed', undefined],
      ['fixed', undefined],
      ['fixed', undefined],
      ['float', null],
    ]);
  });

  it('sorts fixed-price ads cheapest or dearest first, floating ads last, and pages each sort without a gap or a repeat', async () => {
    const at = async (price: string, key: string, priceType: 'fixed' | 'float' = 'fixed') =>
      (await sell({ price: parseAmount(price), priceType, idempotencyKey: key })).id;
    const one = await at('1', 'sort-1');
    const three = await at('3', 'sort-3');
    const twoA = await at('2', 'sort-2a');
    const twoB = await at('2', 'sort-2b');
    const float = await at('1.01', 'sort-float', 'float');

    const walk = async (sort: 'price_asc' | 'price_desc') => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await p2p.listOfferBoard({ limit: 2, sort, viewerId: TAKER, ...(cursor ? { cursor } : {}) });
        seen.push(...page.offers.map((o) => o.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return seen;
    };
    expect(await walk('price_asc')).toEqual([one, twoA, twoB, three, float]);
    expect(await walk('price_desc')).toEqual([three, twoA, twoB, one, float]);
    expect((await p2p.listOfferBoard({ limit: 10, viewerId: TAKER })).offers.map((o) => o.id)).toEqual([one, twoA, twoB, three, float]);

    // A cursor carries its sort: reading it under the other sort refuses rather than skipping rows.
    const first = await p2p.listOfferBoard({ limit: 2, sort: 'price_asc', viewerId: TAKER });
    await expect(p2p.listOfferBoard({ limit: 2, sort: 'price_desc', viewerId: TAKER, cursor: first.nextCursor! })).rejects.toMatchObject({
      code: 'p2p.offer_cursor_invalid',
    });
    // The three-part cursor of the old board order is refused, never read as a position in the new one.
    const legacy = Buffer.from(`1\n${'0'.repeat(20)}\n${one}`, 'utf8').toString('base64url');
    await expect(p2p.listOfferBoard({ limit: 2, viewerId: TAKER, cursor: legacy })).rejects.toMatchObject({
      code: 'p2p.offer_cursor_invalid',
    });
  });

  it('filters by a fiat amount the ad can take whole, and leaves floating ads out', async () => {
    // Fiat ranges: the price-2 ad takes 20 to 200, the price-1 ad 10 to 100.
    const two = (await sell({ price: parseAmount('2'), idempotencyKey: 'fiat-2' })).id;
    const one = (await sell({ price: parseAmount('1'), idempotencyKey: 'fiat-1' })).id;
    await sell({ price: parseAmount('1.01'), priceType: 'float', idempotencyKey: 'fiat-float' });
    const ids = async (fiatAmount: string) =>
      (await p2p.listOfferBoard({ limit: 10, fiatAmount, viewerId: TAKER })).offers.map((o) => o.id).sort();
    expect(await ids('15')).toEqual([one]);
    expect(await ids('50')).toEqual([one, two].sort());
    expect(await ids('150')).toEqual([two]);
    expect(await ids('201')).toEqual([]);
    await expect(p2p.listOfferBoard({ limit: 10, fiatAmount: '-1', viewerId: TAKER })).rejects.toMatchObject({
      code: 'p2p.offer_cursor_invalid',
    });
  });

  it('a floating ad on the board names its market reference, or null when no feed prices the pair', async () => {
    await sell({ price: parseAmount('1.01'), priceType: 'float', idempotencyKey: 'ref-float' });
    await sell({ price: parseAmount('1'), idempotencyKey: 'ref-fixed' });
    expect(await p2p.referencePrice(ASSET, 'USD')).toBeNull();
    const fed = new P2pService(sql, ledger, bus, {
      instruments,
      feeBps: 100,
      referencePrices: { price: async (asset, fiat) => (asset === ASSET && fiat === 'USD' ? parseAmount('0.99') : null) },
    });
    expect(await fed.referencePrice(ASSET, 'USD')).toBe(parseAmount('0.99'));
    expect(await fed.referencePrice(ASSET, 'EUR')).toBeNull();
  });

  it('reports total, filled and completed counts from the offer and its released trades', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('40'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    const counts = await p2p.releasedTradeCounts([offer.id]);
    expect(counts.get(offer.id) ?? 0).toBe(0);
    const taken = await p2p.getOffer(offer.id);
    expect(formatAmount(taken.totalAmt)).toBe('500');
    expect(formatAmount(taken.remainingAmt)).toBe('460');
    await p2p.markFiatSent(trade.id, TAKER);
    await p2p.confirmFiatReceived(trade.id, MAKER);
    expect((await p2p.releasedTradeCounts([offer.id])).get(offer.id)).toBe(1);
    expect(await p2p.tradesInWindow(MAKER)).toBe(1);
    expect(await p2p.tradesInWindow(TAKER)).toBe(1);
  });

  it('hides a blocked maker and refuses the take; a follow does not', async () => {
    const offer = await sell();
    await p2p.setContact({ ownerId: TAKER, peerId: MAKER, kind: 'follow', present: true, idempotencyKey: 'follow-1' });
    expect((await p2p.listContacts(TAKER)).following).toEqual([MAKER]);
    expect((await p2p.listOfferBoard({ limit: 10, viewerId: TAKER })).offers.map((o) => o.id)).toContain(offer.id);

    await p2p.setContact({ ownerId: TAKER, peerId: MAKER, kind: 'block', present: true, idempotencyKey: 'block-1' });
    expect((await p2p.listOfferBoard({ limit: 10, viewerId: TAKER })).offers).toEqual([]);
    await expect(p2p.quoteTake({ offerId: offer.id, takerId: TAKER, amount: parseAmount('10'), method: 'sepa' })).rejects.toBeInstanceOf(
      P2pError,
    );
    await expect(
      p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: parseAmount('10'), method: 'sepa', tradeId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'p2p.blocked' });
    await expect(
      p2p.setContact({ ownerId: TAKER, peerId: TAKER, kind: 'block', present: true, idempotencyKey: 'self-block' }),
    ).rejects.toMatchObject({ code: 'p2p.contact_self' });
  });

  it('serves order chat to the parties and to a moderator only while a dispute is open', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('15'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await expect(
      p2p.sendChatMessage({ tradeId: trade.id, senderId: OTHER, clientId: 'x', text: 'no', asModerator: false }),
    ).rejects.toMatchObject({ code: 'p2p.trade_not_found' });
    await expect(
      p2p.sendChatMessage({ tradeId: trade.id, senderId: MODERATOR, clientId: 'm', text: 'no', asModerator: true }),
    ).rejects.toMatchObject({ code: 'p2p.trade_not_found' });
    await expect(
      p2p.sendChatMessage({
        tradeId: trade.id,
        senderId: TAKER,
        clientId: 'a',
        text: 'paid',
        asModerator: false,
        attachment: { name: 'shot.png' },
      }),
    ).rejects.toMatchObject({ code: 'p2p.chat_attachment_unwired' });

    const sent = await p2p.sendChatMessage({
      tradeId: trade.id,
      senderId: TAKER,
      clientId: 'client-1',
      text: 'I paid',
      asModerator: false,
    });
    const replay = await p2p.sendChatMessage({
      tradeId: trade.id,
      senderId: TAKER,
      clientId: 'client-1',
      text: 'I paid',
      asModerator: false,
    });
    expect(replay.message.id).toBe(sent.message.id);
    expect(replay.created).toBe(false);
    expect(await p2p.unreadChat({ tradeId: trade.id, viewerId: MAKER, asModerator: false })).toBe(1);
    const page = await p2p.listChatMessages({ tradeId: trade.id, viewerId: MAKER, asModerator: false, limit: 50 });
    expect(page.messages.map((m) => m.text)).toEqual(['I paid']);
    expect(page.unread).toBe(1);
    expect(await p2p.unreadChat({ tradeId: trade.id, viewerId: MAKER, asModerator: false })).toBe(0);

    await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'not released' });
    const mod = await p2p.sendChatMessage({
      tradeId: trade.id,
      senderId: MODERATOR,
      clientId: 'mod-1',
      text: 'send the receipt',
      asModerator: true,
    });
    expect(mod.message.senderId).toBe(MODERATOR);
  });

  it('lists the caller’s disputes and exports only that caller’s trades', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('12'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'waiting' });
    const mine = await p2p.listMyDisputes({ userId: TAKER, status: 'open', limit: 20 });
    expect(mine.disputes.map((d) => d.tradeId)).toEqual([trade.id]);
    expect(await p2p.listMyDisputes({ userId: OTHER, limit: 20 })).toMatchObject({ disputes: [], nextCursor: null });

    const csv = await p2p.exportTrades({
      userId: TAKER,
      from: '2020-01-01T00:00:00.000Z',
      to: '2035-01-01T00:00:00.000Z',
    });
    expect(csv.rows).toBe(1);
    expect(csv.csv.split('\n')[0]).toBe(
      'tradeId,offerId,role,asset,amount,fiatCurrency,fiatAmount,price,method,status,resolution,createdAt',
    );
    expect(csv.csv).toContain(trade.id);
    expect(csv.csv).toContain('buyer');
    expect(csv.csv).toContain('12');
    const other = await p2p.exportTrades({
      userId: OTHER,
      from: '2020-01-01T00:00:00.000Z',
      to: '2035-01-01T00:00:00.000Z',
    });
    expect(other.rows).toBe(0);
    expect(other.csv).not.toContain(trade.id);
  });

  it('refuses a session that does not hold the procedure scope', async () => {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-depth');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const secret = 'p2p-depth-edge-secret-long-enough-ok';
    const edge = createEdgeContext({ secret, serviceName: 'svc-p2p' });
    const sign = (scopes: string[], userId: string = TAKER) => {
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
          'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-depth',
      });
    };
    const router = createP2pRouter(p2p, instruments);
    const offer = await sell();
    await expect(router.createCaller(sign([])).trades.quote({ offerId: offer.id, amount: '10', method: 'sepa' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      router.createCaller(sign(['p2p:read'])).offers.update({
        offerId: offer.id,
        idempotencyKey: 'needs-write',
        terms: 'no',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const notified: string[] = [];
    const wired = createP2pRouter(p2p, instruments, undefined, {
      moderatorUserIds: [MODERATOR],
      chatNotify: {
        async messageSent(input) {
          notified.push(input.messageId);
        },
      },
      publicProfile: {
        async lookup() {
          return null;
        },
      },
    });
    await fund(MAKER, '1000');
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await expect(
      wired.createCaller(sign(['p2p:read'])).chat.messages.send({
        tradeId: trade.id,
        text: 'hello',
        clientId: 'router-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unreadParty = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.chat_messages`;
    expect(unreadParty[0]?.n).toBe(0);
    const sent = await wired.createCaller(sign(['p2p:read', 'p2p:write'])).chat.messages.send({
      tradeId: trade.id,
      text: 'hello',
      clientId: 'router-1',
    });
    expect(sent.notify).toEqual({ delivered: true, code: 'p2p.chat_notify_delivered' });
    expect(notified).toEqual([sent.id]);
    await expect(
      wired.createCaller(sign(['p2p:read'], MODERATOR)).chat.messages.send({
        tradeId: trade.id,
        text: 'too early',
        clientId: 'mod-early',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const beforeDispute = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.chat_messages`;
    expect(beforeDispute[0]?.n).toBe(1);
    await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'not released' });
    const modSent = await wired.createCaller(sign(['p2p:read'], MODERATOR)).chat.messages.send({
      tradeId: trade.id,
      text: 'send the receipt',
      clientId: 'mod-router-1',
    });
    expect(modSent.senderId).toBe(MODERATOR);
    const profile = await wired.createCaller(sign(['p2p:read'])).reputation.get({ userId: MAKER });
    expect(profile.handle).toBeNull();
    expect(profile.profile).toEqual({ status: 'absent', code: 'p2p.public_profile_absent' });
    const unwired = await router.createCaller(sign(['p2p:read'])).reputation.get({ userId: MAKER });
    expect(unwired.profile).toEqual({ status: 'unwired', code: 'p2p.public_profile_unwired' });
    expect(unwired.trades30d).toBe(0);
  });
});
