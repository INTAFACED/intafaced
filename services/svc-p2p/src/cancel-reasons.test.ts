import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUYER_CANCEL_REASONS, SELLER_CANCEL_REASONS, cancelReasonAllowed, cancelReasonOf } from './cancel-reasons.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';
import { parsePairLimits } from './take-limits.js';

/**
 * P-trade-orders-19: cancel with a reason from the caller's side's list, the seller's cancellation request parked until
 * the founders decide (always `p2p.owner_decision_pending`, nothing written), the seller's existing cancel at `fiat_sent`
 * unchanged, and no path that posts a second refund.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';

async function refusal(p: Promise<unknown>): Promise<P2pError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(P2pError);
  return err as P2pError;
}

describe('svc-p2p cancel reasons (P-trade-orders-19)', () => {
  it('each side has its own list, and a stored reason reads back as who cancelled and the code', () => {
    expect(cancelReasonAllowed('buyer', 'changed_mind')).toBe(true);
    expect(cancelReasonAllowed('seller', 'changed_mind')).toBe(true);
    expect(cancelReasonAllowed('buyer', 'buyer_unresponsive')).toBe(false);
    expect(cancelReasonAllowed('seller', 'seller_unresponsive')).toBe(false);
    for (const code of BUYER_CANCEL_REASONS) expect(cancelReasonAllowed('buyer', code)).toBe(true);
    for (const code of SELLER_CANCEL_REASONS) expect(cancelReasonAllowed('seller', code)).toBe(true);
    expect(cancelReasonOf({ status: 'cancelled', resolutionReason: 'buyer.changed_mind' })).toEqual({ by: 'buyer', code: 'changed_mind' });
    expect(cancelReasonOf({ status: 'cancelled', resolutionReason: 'seller.price_mistake' })).toEqual({
      by: 'seller',
      code: 'price_mistake',
    });
    // Free text through the API, or a code from the other list, is not a code.
    expect(cancelReasonOf({ status: 'cancelled', resolutionReason: 'buyer.TEST free text' })).toEqual({ by: 'buyer', code: null });
    expect(cancelReasonOf({ status: 'cancelled', resolutionReason: 'seller.seller_unresponsive' })).toEqual({ by: 'seller', code: null });
    expect(cancelReasonOf({ status: 'cancelled', resolutionReason: 'timeout.payment_window_elapsed' })).toEqual({
      by: 'timeout',
      code: null,
    });
    expect(cancelReasonOf({ status: 'cancelled', resolutionReason: 'moderator:abc' })).toEqual({ by: 'moderator', code: null });
    expect(cancelReasonOf({ status: 'released', resolutionReason: 'buyer.changed_mind' })).toBeNull();
  });
});

describe('svc-p2p cancel with a reason and the parked cancellation request (P-trade-orders-19)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let p2p!: P2pService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    const instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await instruments.createInstrument({
      ownerId: MAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-maker' },
      instrumentId: crypto.randomUUID(),
    });
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('500'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
    p2p = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
      // One buyer cancel in the window pauses buying, so the cancel is shown to count.
      takeLimits: {
        activeOrderCap: 10,
        pairLimits: parsePairLimits('{"USDT/EUR":{"min":"1","max":"100"}}'),
        buyerCancels: { limit: 1, windowHours: 24 },
      },
    });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const take = async () => {
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });
    const trade = await p2p.takeOffer({
      tradeId: crypto.randomUUID(),
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tier: 'basic',
    });
    return { offer, trade };
  };
  const refunds = (tradeId: string) => ledger.journal().filter((tx) => tx.idempotencyKey === `p2p.escrow.refund:${tradeId}`);
  const free = async () => (await ledger.balance({ ownerType: 'user', ownerId: MAKER, assetId: ASSET, kind: 'available' })).amount;

  it('in escrow the buyer cancels with a reason: one refund to the seller, the code is stored, and the cancel counts', async () => {
    const before = await free();
    const { offer, trade } = await take();
    expect(trade.status).toBe('escrowed');
    const cancelled = await p2p.cancelTrade(trade.id, TAKER, 'cancelled', 'changed_mind');
    expect(cancelled).toMatchObject({ status: 'cancelled', resolution: 'refunded', resolutionReason: 'buyer.changed_mind' });
    expect(cancelReasonOf(cancelled)).toEqual({ by: 'buyer', code: 'changed_mind' });
    expect(refunds(trade.id)).toHaveLength(1);
    expect(await free()).toBe(before);
    // A coded cancel is a buyer cancel like any other: with a limit of one, buying pauses.
    const paused = await refusal(
      p2p.takeOffer({
        tradeId: crypto.randomUUID(),
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('20'),
        method: 'sepa',
        tier: 'basic',
      }),
    );
    expect(paused.code).toBe('p2p.buying_restricted');
  });

  it('the seller cancels with a seller reason; a reason from the other list refuses and nothing moves', async () => {
    const { trade } = await take();
    const journal = ledger.journal().length;
    const wrong = await refusal(p2p.cancelTrade(trade.id, MAKER, 'cancelled', 'seller_unresponsive'));
    expect(wrong.code).toBe('p2p.cancel_reason_invalid');
    const buyerWrong = await refusal(p2p.cancelTrade(trade.id, TAKER, 'cancelled', 'price_mistake'));
    expect(buyerWrong.code).toBe('p2p.cancel_reason_invalid');
    expect(ledger.journal()).toHaveLength(journal);
    expect((await p2p.getTrade(trade.id)).status).toBe('escrowed');
    const cancelled = await p2p.cancelTrade(trade.id, MAKER, 'cancelled', 'price_mistake');
    expect(cancelled).toMatchObject({ status: 'cancelled', resolution: 'refunded', resolutionReason: 'seller.price_mistake' });
    expect(refunds(trade.id)).toHaveLength(1);
  });

  it('a stranger cannot cancel or request, and learns nothing about the order', async () => {
    const { trade } = await take();
    expect((await refusal(p2p.cancelTrade(trade.id, STRANGER, 'cancelled', 'changed_mind'))).code).toBe('p2p.trade_not_found');
    expect((await refusal(p2p.requestCancel(trade.id, STRANGER))).code).toBe('p2p.trade_not_found');
    expect((await p2p.getTrade(trade.id)).status).toBe('escrowed');
  });

  it('after payment: the buyer is refused, the seller’s cancel is today’s refusal, and the request refuses owner_decision_pending writing nothing', async () => {
    const { trade } = await take();
    await p2p.markFiatSent(trade.id, TAKER);
    const row = await sql`SELECT * FROM p2p.p2p_trades WHERE id = ${trade.id}`;
    const journal = ledger.journal().length;

    expect((await refusal(p2p.cancelTrade(trade.id, TAKER, 'cancelled', 'changed_mind'))).code).toBe('p2p.not_the_seller');
    // Pinned until the founders decide (ENGINE-SPEC section 5): the seller's straight cancel at fiat_sent, with or
    // without a reason, is the same refusal and message as before this slice.
    for (const attempt of [
      p2p.cancelTrade(trade.id, MAKER, 'payment_never_arrived'),
      p2p.cancelTrade(trade.id, MAKER, 'cancelled', 'buyer_unresponsive'),
    ]) {
      const err = await refusal(attempt);
      expect(err.code).toBe('p2p.cancel_after_paid');
      expect(err.message).toBe('The buyer has declared the fiat sent — confirm receipt, or open a dispute if you were not paid');
    }

    for (const who of [MAKER, TAKER]) {
      const parked = await refusal(p2p.requestCancel(trade.id, who));
      expect(parked.code).toBe('p2p.owner_decision_pending');
      expect(parked.message).toBe('Cancelling after the buyer has paid needs a founder decision. It is switched off in this build.');
    }
    // Nothing written and nothing moved: the order row is byte-for-byte the same, the journal unchanged.
    expect(await sql`SELECT * FROM p2p.p2p_trades WHERE id = ${trade.id}`).toEqual(row);
    expect(ledger.journal()).toHaveLength(journal);
    expect(refunds(trade.id)).toHaveLength(0);
  });

  it('no path posts a second refund: cancels from both sides at once, then again, refund the escrow once', async () => {
    const before = await free();
    const { trade } = await take();
    const attempts = await Promise.allSettled([
      p2p.cancelTrade(trade.id, TAKER, 'cancelled', 'changed_mind'),
      p2p.cancelTrade(trade.id, MAKER, 'cancelled', 'changed_mind'),
      p2p.cancelTrade(trade.id, TAKER, 'cancelled', 'seller_unresponsive'),
      p2p.cancelTrade(trade.id, MAKER, 'TEST free text'),
    ]);
    expect(attempts.some((a) => a.status === 'fulfilled')).toBe(true);
    await Promise.allSettled([p2p.cancelTrade(trade.id, TAKER, 'cancelled', 'changed_mind'), p2p.requestCancel(trade.id, MAKER)]);
    expect(refunds(trade.id)).toHaveLength(1);
    expect(await free()).toBe(before);
    const after = await p2p.getTrade(trade.id);
    expect(after).toMatchObject({ status: 'cancelled', resolution: 'refunded' });
    expect(['buyer.changed_mind', 'seller.changed_mind', 'buyer.seller_unresponsive', 'seller.TEST free text']).toContain(
      after.resolutionReason,
    );
  });
});
