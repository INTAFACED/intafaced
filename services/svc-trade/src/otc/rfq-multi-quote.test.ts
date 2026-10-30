/**
 * J-copy-bots-otc-24 #5 — one request collects one quote per provider asked, each at that provider's spread, and is
 * ranked best first with ties going to the provider asked earlier. Provider ids, spreads, the mid and the sizes below
 * are TEST fixtures, not an owner directory or desk law.
 */
import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { OtcDeskLaw } from './desk-law.js';
import { OtcError } from './errors.js';
import { createObservedOtcMidSource } from './mid-source.js';
import {
  loadOtcMakerDirectory,
  OTC_PROVIDER_SPREAD_UNSET_RESIDUAL,
  parseOtcMakerDirectoryJson,
  selectOtcMakers,
} from './maker-directory.js';
import { OTC_MAKER_ROUTING_RESIDUAL } from './maker-routing.js';
import { MemoryOtcQuoteStore } from './quote-store.js';
import { acceptOtcQuote, rankRfqQuotes } from './rfq.js';
import { buildRfqBoard, type RfqBoardRow } from './rfq-board.js';

const now = () => new Date('2026-10-29T22:00:00.000Z');
const principal = { userId: '00000000-0000-4000-8000-000000000001', tier: 'full' } as Principal;

const directory = (makers: Record<string, unknown>[], localTest = true) =>
  parseOtcMakerDirectoryJson(JSON.stringify({ selectCap: 4, makers }), { localTest });

const HOUSE = { id: 'house', name: 'TEST house desk', route: 'platform' };
const LP1 = { id: 'test-lp-1', name: 'TEST provider 1', route: 'outside', spreadBps: 10 };
const LP2 = { id: 'test-lp-2', name: 'TEST provider 2', route: 'outside', spreadBps: 30 };
const LP3 = { id: 'test-lp-3', name: 'TEST provider 3', route: 'outside', spreadBps: 10 };
const LP_BLANK = { id: 'test-lp-blank', name: 'TEST provider with no spread', route: 'outside' };

const LAW: Extract<OtcDeskLaw, { published: true }> = {
  published: true,
  spreadBps: 20,
  minStake: parseAmount('1'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
  minNotional: { USDT: 0n },
  assets: ['BTC'],
  minTier: 'full',
};

class CountingStore extends MemoryOtcQuoteStore {
  saved = 0;
  override async saveOpen(...args: Parameters<MemoryOtcQuoteStore['saveOpen']>) {
    this.saved += 1;
    return super.saveOpen(...args);
  }
}

function desk(makers: Record<string, unknown>[], law: Partial<typeof LAW> = {}) {
  const store = new CountingStore();
  const svc = new OtcDeskService(
    new MemoryLedger(),
    { stakeOf: async () => parseAmount('9999') },
    {
      law: { ...LAW, ...law },
      midSource: createObservedOtcMidSource('BTC/USDT:65000', now),
      makerDirectory: directory(makers),
      store,
      now,
    },
  );
  return { svc, store };
}
const ask = (makerIds: string[], side: 'buy' | 'sell' = 'buy') => ({ side, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds });

describe('a provider spread in the directory (#5)', () => {
  it('a platform provider may carry an owner spread anywhere; left out, it has none', () => {
    const dir = parseOtcMakerDirectoryJson(
      JSON.stringify({
        selectCap: 2,
        makers: [
          { ...HOUSE, spreadBps: 15 },
          { ...HOUSE, id: 'h2' },
        ],
      }),
    );
    expect(dir.published && dir.makers.map((m) => m.spreadBps)).toEqual([15, undefined]);
    expect(dir.published && dir.localTest).toBeUndefined();
  });

  it('a spread on an outside provider is a LOCAL TEST value: refused at boot outside APP_ENV dev or test', () => {
    expect(() => parseOtcMakerDirectoryJson(JSON.stringify({ selectCap: 1, makers: [LP1] }))).toThrow(OtcError);
    const logged: string[] = [];
    expect(loadOtcMakerDirectory(JSON.stringify({ selectCap: 1, makers: [LP1] }), (m) => logged.push(m), false)).toEqual({
      published: false,
    });
    expect(logged).toEqual([
      'Provider test-lp-1 is outside the platform; its spread is a LOCAL TEST value, refused outside APP_ENV dev or test',
    ]);
    const local = loadOtcMakerDirectory(JSON.stringify({ selectCap: 1, makers: [LP1] }), () => undefined, true);
    expect(local.published && local.localTest).toBe(true);
    expect(local.published && local.makers[0]!.spreadBps).toBe(10);
  });

  it('a malformed spread refuses the directory with trade.otc_makers_unset', () => {
    for (const bad of [-1, 5001, 2.5, '10', true]) {
      expect(() => directory([{ ...LP1, spreadBps: bad }])).toThrow(
        expect.objectContaining({
          code: 'trade.otc_makers_unset',
          message: 'Provider test-lp-1 spreadBps must be an integer from 0 to 5000',
        }),
      );
    }
  });

  it('under LOCAL TEST a blank spread refuses that provider by name; in production an outside provider stays feed.market', () => {
    expect(() => selectOtcMakers(directory([LP1, LP_BLANK]), ['test-lp-1', 'test-lp-blank'])).toThrow(
      expect.objectContaining({
        code: 'trade.otc_provider_spread_unset',
        message: 'The spread for provider test-lp-blank is not set — the request refuses',
        residual: OTC_PROVIDER_SPREAD_UNSET_RESIDUAL,
      }),
    );
    expect(() => selectOtcMakers(directory([LP_BLANK], false), ['test-lp-blank'])).toThrow(
      expect.objectContaining({ code: 'feed.market', residual: OTC_MAKER_ROUTING_RESIDUAL }),
    );
  });
});

describe('one request, one quote per provider asked (#5)', () => {
  it('collects a quote from each provider in the order asked, at its own spread, all against house inventory', async () => {
    const { svc, store } = desk([HOUSE, LP1, LP2, LP3]);
    const best = await svc.quote(principal, ask(['test-lp-2', 'house', 'test-lp-1']));
    const quotes = (await store.listRfq(best.rfqId)).map((s) => s.quote);
    expect(store.saved).toBe(3);
    expect(quotes.map((q) => [q.makerId, q.rfqSeq, q.spreadBps, q.test, q.counterparty, q.counterpartyId])).toEqual([
      ['test-lp-2', 1, 30, true, 'platform', 'platform:otc-desk'],
      // The house has no spread of its own: the desk law spread.
      ['house', 2, 20, false, 'platform', 'platform:otc-desk'],
      ['test-lp-1', 3, 10, true, 'platform', 'platform:otc-desk'],
    ]);
    expect(new Set(quotes.map((q) => q.quoteId)).size).toBe(3);
    // 1 BTC at 65000: each provider's price is the mid plus its own spread.
    expect(quotes.map((q) => q.quotedPrice)).toEqual([parseAmount('65195'), parseAmount('65130'), parseAmount('65065')]);
    // The answer is the best quote: the lowest price for a buy.
    expect(best).toMatchObject({ makerId: 'test-lp-1', quotedPrice: '65065', test: true });
  });

  it('rfq.quote answers every quote best first, and an equal price goes to the provider asked earlier', async () => {
    const { svc } = desk([HOUSE, LP1, LP2, LP3]);
    const rfq = await svc.rfqQuote(principal, ask(['test-lp-2', 'test-lp-3', 'test-lp-1']));
    expect(rfq.quotes.map((q) => [q.makerId, q.rank, q.quotedPrice])).toEqual([
      ['test-lp-3', 1, '65065'],
      ['test-lp-1', 2, '65065'],
      ['test-lp-2', 3, '65195'],
    ]);
    expect(rfq.quoteId).toBe(rfq.quotes[0]!.quoteId);
    expect(rfq.quotes.every((q) => q.rfqId === rfq.rfqId)).toBe(true);
  });

  it('for a sell the highest price is best', async () => {
    const { svc } = desk([HOUSE, LP1, LP2]);
    const rfq = await svc.rfqQuote(principal, ask(['test-lp-2', 'house', 'test-lp-1'], 'sell'));
    expect(rfq.quotes.map((q) => [q.makerId, q.quotedPrice])).toEqual([
      ['test-lp-1', '64935'],
      ['house', '64870'],
      ['test-lp-2', '64805'],
    ]);
  });

  it('one provider with a blank spread refuses the whole request by its code, and nothing is kept', async () => {
    const { svc, store } = desk([HOUSE, LP1, LP_BLANK]);
    await expect(svc.quote(principal, ask(['house', 'test-lp-1', 'test-lp-blank']))).rejects.toMatchObject({
      code: 'trade.otc_provider_spread_unset',
    });
    expect(store.saved).toBe(0);
  });

  it('one quote under the desk minimum refuses the whole request before any quote is kept', async () => {
    // A sell at 30 bps lands under a 64900 minimum while the 10 bps quote is above it.
    const { svc, store } = desk([LP1, LP2], { minNotional: { USDT: parseAmount('64900') } });
    await expect(svc.quote(principal, ask(['test-lp-1', 'test-lp-2'], 'sell'))).rejects.toMatchObject({
      code: 'trade.rfq_below_minimum',
    });
    expect(store.saved).toBe(0);
  });

  it('a maker desk never prices an outside provider at its LOCAL TEST spread: it still refuses feed.market', async () => {
    const { svc, store } = desk([HOUSE, LP1], { counterparty: 'maker' });
    await expect(svc.quote(principal, { ...ask(['test-lp-1']), makerId: 'test-lp-1' })).rejects.toMatchObject({
      code: 'feed.market',
      residual: OTC_MAKER_ROUTING_RESIDUAL,
    });
    await expect(
      svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerId: 'test-lp-1' }, { desk: false }),
    ).rejects.toMatchObject({
      code: 'feed.market',
    });
    expect(store.saved).toBe(0);
  });

  it('a convert asks no provider: one quote at the desk law spread, not TEST', async () => {
    const { svc, store } = desk([HOUSE, LP1]);
    const q = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' }, { desk: false });
    expect(store.saved).toBe(1);
    expect(q).toMatchObject({ rfqId: q.quoteId, rfqSeq: 1, makerId: null, spreadBps: 20, test: false });
  });
});

describe('a request takes one provider’s price (#5)', () => {
  it('once one quote is bound the others refuse trade.rfq_other_quote_accepted and stay open', async () => {
    const { svc, store } = desk([HOUSE, LP1, LP2]);
    const rfq = await svc.rfqQuote(principal, ask(['house', 'test-lp-1', 'test-lp-2']));
    const [best, second, third] = rfq.quotes;
    const bound = await svc.accept(principal, { quoteId: best!.quoteId, assertedPrice: best!.quotedPrice });
    // Bound at the provider's price, against the platform: house inventory settles it.
    expect(bound).toMatchObject({ fillPrice: best!.quotedPrice, counterparty: 'platform', counterpartyId: 'platform:otc-desk' });
    for (const other of [second!, third!]) {
      await expect(svc.accept(principal, { quoteId: other.quoteId })).rejects.toMatchObject({
        code: 'trade.rfq_other_quote_accepted',
      });
      expect((await store.load(other.quoteId))?.lifecycle).toBe('open');
    }
    // Accepting the bound quote again still answers it.
    expect(await svc.accept(principal, { quoteId: best!.quoteId })).toMatchObject({ quoteId: best!.quoteId });
  });

  it('letting the shown quote go lets the request go: every other open quote of it expires too', async () => {
    const { svc, store } = desk([HOUSE, LP1, LP2]);
    const rfq = await svc.rfqQuote(principal, ask(['house', 'test-lp-1', 'test-lp-2']));
    await svc.rfqExpire(principal, { quoteId: rfq.quoteId });
    expect((await store.listRfq(rfq.rfqId)).map((s) => s.lifecycle)).toEqual(['expired', 'expired', 'expired']);
    for (const other of rfq.quotes.slice(1)) {
      await expect(svc.accept(principal, { quoteId: other.quoteId })).rejects.toMatchObject({ code: 'trade.otc_quote_expired' });
    }
  });

  it('expiring an open quote of an accepted request leaves the bound quote bound', async () => {
    const { svc, store } = desk([HOUSE, LP1, LP2]);
    const rfq = await svc.rfqQuote(principal, ask(['house', 'test-lp-1', 'test-lp-2']));
    await svc.accept(principal, { quoteId: rfq.quotes[0]!.quoteId });
    await svc.rfqExpire(principal, { quoteId: rfq.quotes[1]!.quoteId });
    const byId = new Map((await store.listRfq(rfq.rfqId)).map((s) => [s.quote.quoteId, s.lifecycle]));
    expect(rfq.quotes.map((q) => byId.get(q.quoteId))).toEqual(['bound', 'expired', 'expired']);
  });

  it('the store itself refuses a second bound quote of one request', async () => {
    const { svc, store } = desk([HOUSE, LP1]);
    const rfq = await svc.rfqQuote(principal, ask(['house', 'test-lp-1']));
    await svc.accept(principal, { quoteId: rfq.quotes[0]!.quoteId });
    const other = await store.load(rfq.quotes[1]!.quoteId);
    const secondBound = acceptOtcQuote({ quote: other!.quote, now: now() });
    await expect(store.saveBound(other!.quote, secondBound)).rejects.toMatchObject({ code: 'trade.rfq_other_quote_accepted' });
  });
});

describe('ranking and the board (#5)', () => {
  it('rankRfqQuotes: lowest first for a buy, highest for a sell, equal prices by the order asked', () => {
    const q = (side: 'buy' | 'sell', price: string, rfqSeq: number) => ({ side, quotedPrice: parseAmount(price), rfqSeq });
    expect(rankRfqQuotes([q('buy', '2', 1), q('buy', '1', 3), q('buy', '1', 2)]).map((x) => x.rfqSeq)).toEqual([2, 3, 1]);
    expect(rankRfqQuotes([q('sell', '1', 1), q('sell', '2', 3), q('sell', '2', 2)]).map((x) => x.rfqSeq)).toEqual([2, 3, 1]);
  });

  const row = (over: Partial<RfqBoardRow>): RfqBoardRow => ({
    rfq_id: 'r1',
    quote_id: 'q1',
    maker_id: 'test-lp-1',
    rfq_seq: 1,
    side: 'buy',
    base_asset: 'BTC',
    quote_asset: 'USDT',
    qty: '1.000000000000000000',
    quoted_price: '65065.000000000000000000',
    user_notional: '65065.000000000000000000',
    spread_bps: 10,
    lifecycle: 'open',
    test: true,
    created_at: '2026-10-29T21:59:30.000Z',
    expires_at: '2026-10-29T22:00:30.000Z',
    ...over,
  });

  it('groups every request by status, always all four groups with counts, quotes best first with ties to the earlier', () => {
    const board = buildRfqBoard(
      [
        row({ rfq_id: 'live', quote_id: 'l1', rfq_seq: 1, quoted_price: '65195', maker_id: 'test-lp-2' }),
        row({ rfq_id: 'live', quote_id: 'l2', rfq_seq: 2, quoted_price: '65065', maker_id: 'test-lp-3' }),
        row({ rfq_id: 'live', quote_id: 'l3', rfq_seq: 3, quoted_price: '65065', maker_id: 'test-lp-1' }),
        row({ rfq_id: 'took', quote_id: 't1', lifecycle: 'bound' }),
        row({ rfq_id: 'took', quote_id: 't2', rfq_seq: 2 }),
        row({ rfq_id: 'done', quote_id: 'd1', lifecycle: 'settled' }),
        row({ rfq_id: 'lapsed', quote_id: 'x1', expires_at: '2026-10-29T21:59:59.000Z' }),
        row({ rfq_id: 'withdrawn', quote_id: 'w1', lifecycle: 'expired' }),
      ],
      now(),
    );
    expect(board.groups.map((g) => [g.status, g.count, g.requests.map((r) => r.rfqId)])).toEqual([
      ['open', 1, ['live']],
      ['accepted', 1, ['took']],
      ['settled', 1, ['done']],
      ['expired', 2, ['lapsed', 'withdrawn']],
    ]);
    const live = board.groups[0]!.requests[0]!;
    expect(live.quotes.map((q) => [q.quoteId, q.rank, q.best, q.quotedPrice])).toEqual([
      ['l2', 1, true, '65065'],
      ['l3', 2, false, '65065'],
      ['l1', 3, false, '65195'],
    ]);
    expect(live).toMatchObject({ side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', createdAt: '2026-10-29T21:59:30.000Z' });
  });

  it('an empty window is four empty groups, never a sample request', () => {
    expect(buildRfqBoard([], now()).groups.map((g) => [g.status, g.count])).toEqual([
      ['open', 0],
      ['accepted', 0],
      ['settled', 0],
      ['expired', 0],
    ]);
  });
});
