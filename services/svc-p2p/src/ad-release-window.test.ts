import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';
import { parsePairLimits, type BuyerCancelLimit } from './take-limits.js';

/**
 * J-p2p-06 #5 (P-trade-orders-15): an ad's own release window. It may only shorten the published release clock, it is
 * copied onto the order at take and never changes after, and when it passes on a paid order the sweep opens one
 * dispute and moves no escrow. J-p2p-06 #1 (P-trade-orders-05): the buyer reads how many cancels count today.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const PAIRS = parsePairLimits('{"USDT/EUR":{"min":"9.5","max":"40"}}');
const RELEASE_SECONDS = 1800;

async function refusal(p: Promise<unknown>): Promise<P2pError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(P2pError);
  return err as P2pError;
}

describe('svc-p2p ad release window and cancel count (J-p2p-06 #1 #5)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;

  const service = (buyerCancels: BuyerCancelLimit = { limit: 100, windowHours: 24 }) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: RELEASE_SECONDS,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
      takeLimits: { activeOrderCap: 20, pairLimits: PAIRS, buyerCancels },
    });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
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
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const sellOffer = (p2p: P2pService, releaseWindowSeconds?: number) =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('20'),
      totalAmt: parseAmount('200'),
      methods: ['sepa'],
      terms: 'TEST terms',
      ...(releaseWindowSeconds === undefined ? {} : { releaseWindowSeconds }),
    });

  const take = (p2p: P2pService, offerId: string) =>
    p2p.takeOffer({ tradeId: crypto.randomUUID(), offerId, takerId: TAKER, amount: parseAmount('20'), method: 'sepa', tier: 'basic' });

  const escrowOf = async (userId: string) => {
    const all = await ledger.balances('user', userId);
    return formatAmount(
      all.filter((b) => b.account.kind === 'escrow' && b.account.assetId === ASSET).reduce((acc, b) => acc + b.amount, 0n),
    );
  };

  it('an ad window outside 60 s and the published release clock refuses and posts no ad', async () => {
    const p2p = service();
    for (const seconds of [59, RELEASE_SECONDS + 1, 90.5]) {
      const refused = await refusal(sellOffer(p2p, seconds));
      expect(refused.code).toBe('p2p.release_window_out_of_bounds');
    }
    expect(await sql`SELECT id FROM p2p.offers`).toHaveLength(0);
    expect((await sellOffer(p2p, 60)).releaseWindowSeconds).toBe(60);
    expect((await sellOffer(p2p)).releaseWindowSeconds).toBeNull();
  });

  it('the window is copied onto the order at take, written once, and sets the paid order’s release clock', async () => {
    const p2p = service();
    const short = await sellOffer(p2p, 60);
    const plain = await sellOffer(p2p);
    const fast = await take(p2p, short.id);
    const slow = await take(p2p, plain.id);
    expect(fast.releaseWindowSeconds).toBe(60);
    expect(slow.releaseWindowSeconds).toBeNull();

    const paidFast = await p2p.markFiatSent(fast.id, TAKER);
    const paidSlow = await p2p.markFiatSent(slow.id, TAKER);
    expect(paidFast.deadlineAt!.getTime() - paidFast.fiatSentAt!.getTime()).toBe(60_000);
    expect(paidSlow.deadlineAt!.getTime() - paidSlow.fiatSentAt!.getTime()).toBe(RELEASE_SECONDS * 1000);

    // Written once: a later write to the order's window is refused by the database.
    await expect(sql`UPDATE p2p.p2p_trades SET release_window_seconds = 600 WHERE id = ${fast.id}`).rejects.toThrow(/written once/);
  });

  it('when the ad’s window passes on a paid order the sweep opens one dispute and the escrow does not move', async () => {
    const p2p = service();
    const offer = await sellOffer(p2p, 60);
    const trade = await take(p2p, offer.id);
    const paid = await p2p.markFiatSent(trade.id, TAKER);
    expect(await escrowOf(MAKER)).toBe('20');
    const journal = ledger.journal().length;

    // Not due a second before the window ends.
    await p2p.sweepDeadlines(new Date(paid.deadlineAt!.getTime() - 1_000), 100);
    expect((await p2p.getTrade(trade.id)).status).toBe('fiat_sent');

    const after = new Date(paid.deadlineAt!.getTime() + 1_000);
    const first = await p2p.sweepDeadlines(after, 100);
    expect(first.failed).toBe(0);
    const disputed = await p2p.getTrade(trade.id);
    expect(disputed.status).toBe('disputed');
    expect(disputed.resolution).toBeNull();
    // A second sweep opens no second dispute and posts nothing.
    await p2p.sweepDeadlines(after, 100);
    const disputes = await sql<Array<{ opened_via: string }>>`SELECT opened_via FROM p2p.p2p_disputes WHERE trade_id = ${trade.id}`;
    expect(disputes).toEqual([{ opened_via: 'timeout' }]);
    expect(ledger.journal()).toHaveLength(journal);
    expect(await escrowOf(MAKER)).toBe('20');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('the buyer reads how many cancels count today, out of how many, and when the count starts again', async () => {
    await expect(service({ limit: null, windowHours: null }).buyerCancelCount(TAKER)).rejects.toMatchObject({ code: 'p2p.config_unset' });
    const p2p = service({ limit: 2, windowHours: 24 });
    const [{ midnight }] = (await sql<Array<{ midnight: Date }>>`
      SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' AS midnight
    `) as [{ midnight: Date }];
    const offer = await sellOffer(p2p);
    expect(await p2p.buyerCancelCount(TAKER)).toEqual({ used: 0, cap: 2, windowHours: 24, resetsAt: midnight, restrictedUntil: null });

    // The seller's cancel is not the buyer's.
    await p2p.cancelTrade((await take(p2p, offer.id)).id, MAKER, 'TEST seller changed their mind');
    expect((await p2p.buyerCancelCount(TAKER)).used).toBe(0);
    await p2p.cancelTrade((await take(p2p, offer.id)).id, TAKER, 'TEST');
    expect(await p2p.buyerCancelCount(TAKER)).toMatchObject({ used: 1, restrictedUntil: null });
    await p2p.cancelTrade((await take(p2p, offer.id)).id, TAKER, 'TEST');
    expect(await p2p.buyerCancelCount(TAKER)).toMatchObject({ used: 2, restrictedUntil: midnight });
    const refused = await refusal(take(p2p, offer.id));
    expect(refused.code).toBe('p2p.buying_restricted');
    expect(refused.limit).toEqual({ until: midnight.toISOString(), cap: '2', windowHours: '24' });
  });
});
