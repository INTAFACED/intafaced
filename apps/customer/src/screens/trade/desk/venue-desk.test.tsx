import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrdersTable } from '../../../features/trade/venue/VenueKit';
import type { AsOf, OrderIntent, VenueMarket, VenueOrder, VenuePreview, VenueUp } from '../../../features/trade/venue-api';
import { VenueReviewRows, VenueVerifyDesk, WithdrawalLine } from './VenueSpotDesk';
import {
  HeldDraft,
  amountForValue,
  depositTransfer,
  offeredTif,
  tagProblem,
  valueOf,
  venueSelfTrade,
  intentOf,
  refusedAtHeldWorst,
  shortAddress,
  slippageLimit,
  ticketProblem,
  withdrawStep,
  type TicketFields,
} from './venue-desk';

// J-cex-spot-01 on the venue spot desk: the preview asked as the order is typed, the review's lines, the client id held
// for retry, no builder-fee approval on a known zero, the deposit's own transfer, and the step-up before the wallet.

const OWNER = '0x1234567890abcdef1234567890abcdef1234abcd';
const MARKET: VenueMarket = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: '0.1',
  lotSize: '0.00001',
  makerFeeBps: { known: true, value: '1' },
  takerFeeBps: { known: true, value: '3.5' },
  listedBy: { known: false },
  oracleRule: { known: false },
  markRule: { known: false },
  tradingHours: { known: false },
  feed: { known: false },
  session: { known: false },
  contractSize: { known: false },
  mark: { known: false },
  funding: { known: false },
};
const limitBuy: TicketFields = { side: 'buy', type: 'limit', price: '60000.1', amount: '0.1' };

describe('the ticket asks the venue as the order is typed', () => {
  it('a typed limit is the preview body the door takes: place_order, GTC, its price, amount and the held key', () => {
    const key = new HeldDraft(OWNER, MARKET.symbol, () => 1).keyFor(limitBuy);
    expect(intentOf(limitBuy, MARKET, null, key, true)).toEqual({
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: '0.1',
      price: '60000.1',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: key,
      builderFee: null,
    });
  });

  it('asks nothing until the order is whole and on the market’s steps', () => {
    expect(ticketProblem({ ...limitBuy, amount: '' }, MARKET, null)).toBe('amount');
    expect(ticketProblem({ ...limitBuy, price: '' }, MARKET, null)).toBe('price');
    expect(ticketProblem({ ...limitBuy, amount: '0.000001' }, MARKET, null)).toBe('amount_step');
    expect(ticketProblem({ ...limitBuy, price: '60000.15' }, MARKET, null)).toBe('price_step');
    expect(intentOf({ ...limitBuy, amount: '' }, MARKET, null, 'order:x:y:z', true)).toBeNull();
    expect(ticketProblem(limitBuy, MARKET, null)).toBeNull();
  });

  it('a market order is IOC at its worst price, and with no book on its side there is no order', () => {
    const market: TicketFields = { side: 'buy', type: 'market', price: '', amount: '0.001' };
    expect(ticketProblem(market, MARKET, null)).toBe('no_book');
    // With the owner's price protection blank, a market order is refused, never bounded by a figure the desk made up.
    expect(ticketProblem(market, MARKET, '60600.2', false)).toBe('no_cap');
    expect(ticketProblem({ ...market, type: 'limit', price: '60000' }, MARKET, null, false)).toBeNull();
    expect(intentOf(market, MARKET, '60600.2', 'order:x:y:z', true)).toMatchObject({
      type: 'market',
      timeInForce: 'IOC',
      price: '60600.2',
    });
  });

  it('a market intent is never built with the owner’s price protection blank; a limit is', () => {
    const market: TicketFields = { side: 'buy', type: 'market', price: '', amount: '0.001' };
    expect(intentOf(market, MARKET, '60600.2', 'order:x:y:z', false)).toBeNull();
    expect(intentOf(limitBuy, MARKET, null, 'order:x:y:z', false)).toMatchObject({ type: 'limit', price: '60000.1' });
  });
});

describe('the slippage limit, from the venue’s own best prices', () => {
  const best = { symbol: 'BTC-USDC', bid: '59999.9', ask: '60000.1' };
  it('a buy pays at most the ask plus the bound, rounded up to the tick; a sell at least the bid less it, rounded down', () => {
    expect(slippageLimit('buy', best, '100', '0.1')).toBe('60600.2'); // 60600.101 → up to the tick
    expect(slippageLimit('sell', best, '100', '0.1')).toBe('59399.9'); // 59399.901 → down to the tick
    expect(slippageLimit('buy', best, '50', '0.1')).toBe('60300.2');
  });
  it('no price on the side the order meets is no limit', () => {
    expect(slippageLimit('buy', { ...best, ask: null }, '100', '0.1')).toBeNull();
    expect(slippageLimit('sell', null, '100', '0.1')).toBeNull();
  });
});

describe('the client id held for retry', () => {
  it('the same order reviewed again keeps its key; a changed order or a definite answer gets a new one', () => {
    let now = 1_000;
    const draft = new HeldDraft(OWNER, MARKET.symbol, () => now++);
    const first = draft.keyFor(limitBuy);
    expect(first).toMatch(/^order:0x1234567890abcdef1234567890abcdef1234abcd:btc-usdc:\S+$/);
    expect(draft.keyFor({ ...limitBuy })).toBe(first);
    // "0.10" is the same order as "0.1".
    expect(draft.keyFor({ ...limitBuy, amount: '0.10' })).toBe(first);
    const changed = draft.keyFor({ ...limitBuy, price: '60000.2' });
    expect(changed).not.toBe(first);
    draft.settle(changed);
    expect(draft.keyFor({ ...limitBuy, price: '60000.2' })).not.toBe(changed);
  });

  it('a market order’s worst price is held with its key: polled best prices never change the intent sent for a key', () => {
    let now = 2_000;
    const draft = new HeldDraft(OWNER, MARKET.symbol, () => now++);
    const market: TicketFields = { side: 'buy', type: 'market', price: '', amount: '0.001' };
    const first = draft.hold(market, '60600.2');
    const intentAt = (worst: string) => {
      const held = draft.hold(market, worst);
      return intentOf(market, MARKET, held.worst, held.key, true);
    };
    // The book moved twice; the key, and so the whole intent, is the one first sent.
    expect(intentAt('60700.3')).toEqual(intentOf(market, MARKET, '60600.2', first.key, true));
    expect(intentAt('60500.1')).toMatchObject({ clientOrderKey: first.key, price: '60600.2' });
  });

  it('a changed amount, side or type mints a new key, held at the worst price of that moment', () => {
    let now = 3_000;
    const draft = new HeldDraft(OWNER, MARKET.symbol, () => now++);
    const market: TicketFields = { side: 'buy', type: 'market', price: '', amount: '0.001' };
    const first = draft.hold(market, '60600.2');
    const bigger = draft.hold({ ...market, amount: '0.002' }, '60700.3');
    expect(bigger.key).not.toBe(first.key);
    expect(bigger.worst).toBe('60700.3');
    const sell = draft.hold({ ...market, amount: '0.002', side: 'sell' }, '59399.9');
    expect(sell.key).not.toBe(bigger.key);
    expect(sell.worst).toBe('59399.9');
    const limit = draft.hold({ ...market, amount: '0.002', side: 'sell', type: 'limit', price: '60000' }, null);
    expect(limit.key).not.toBe(sell.key);
  });

  it('a door refusal at the held worst price frees the key; every other refusal keeps it for retry', () => {
    expect(refusedAtHeldWorst({ kind: 'refused', code: 'trade.venue.price_outside_protection' })).toBe(true);
    expect(refusedAtHeldWorst({ kind: 'refused', code: 'trade.venue.insufficient_balance' })).toBe(false);
    expect(refusedAtHeldWorst({ kind: 'unknown' })).toBe(false);
  });
});

const preview = (over: Partial<VenuePreview> = {}): AsOf<VenuePreview> => ({
  venueId: 'test-venue',
  asOf: '2026-11-09T10:00:00.000Z',
  value: {
    symbol: 'BTC-USDC',
    kind: 'spot',
    lock: { asset: 'USDC', amount: '6000.01' },
    role: 'maker',
    venueFee: { known: true, value: { asset: 'BTC', amount: '0.00001' } },
    builderFee: { known: true, value: { asset: 'USDC', amount: '0' } },
    perpetual: null,
    ...over,
  },
});
const intent: OrderIntent = intentOf(limitBuy, MARKET, null, 'order:0xowner:btc-usdc:abc1', true)!;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the review’s lines are the venue’s', () => {
  it('lock, venue’s fee, our builder fee reading none, maker, good till cancelled, the client id, the as-of time', () => {
    const html = renderToStaticMarkup(
      <VenueReviewRows intent={intent} preview={preview()} status={{ builder: null, test: true }} approved={null} />,
    );
    const shown = text(html);
    expect(shown).toContain('The venue locks 6,000.01 USDC');
    expect(shown).toContain('Venue’s fee 0.00001 BTC');
    expect(shown).toMatch(/Our builder fee None: the venue charges no builder fee on a spot buy/);
    expect(shown).toContain('Fee role Maker');
    expect(shown).toContain('Time in force Good till cancelled');
    expect(html).toContain('data-testid="client-order-id">order:0xowner:btc-usdc:abc1<');
    expect(shown).toMatch(/As of \S+ \S+ 2026, \d{1,2}:\d{2}/);
    expect(shown).toContain('TEST');
  });

  it('asks no builder-fee approval on a known zero, even with the fee published and nothing approved', () => {
    const html = renderToStaticMarkup(
      <VenueReviewRows
        intent={intent}
        preview={preview()}
        status={{ builder: { address: '0x00000000000000000000000000000000000000bb', feeBps: '2' }, test: true }}
        approved={false}
      />,
    );
    expect(text(html)).not.toMatch(/approv/i);
  });

  it('a sell that carries our fee shows it, and says the approval is not signed', () => {
    const html = renderToStaticMarkup(
      <VenueReviewRows
        intent={{ ...intent, side: 'sell' }}
        preview={preview({ builderFee: { known: true, value: { asset: 'USDC', amount: '1.2' } } })}
        status={{ builder: { address: '0x00000000000000000000000000000000000000bb', feeBps: '2' }, test: true }}
        approved={false}
      />,
    );
    expect(text(html)).toMatch(/Our builder fee 1\.2 USDC · Not signed/);
  });
});

describe('J-cex-spot-03: market by spend, every time in force, self-trade, tag and unit', () => {
  it('a spend sizes the most whole lots whose cost at the worst price stays within it', () => {
    // 100 / 60300.2 = 0.0016583… → 0.00165 at a 0.00001 lot; 0.00166 × 60300.2 would pass 100.
    expect(amountForValue('100', '60300.2', '0.00001')).toBe('0.00165');
    expect(amountForValue('100', '60300.2', '0.0001')).toBe('0.0016');
    expect(amountForValue('1', '60300.2', '0.0001')).toBeNull();
    expect(amountForValue('', '60300.2', '0.0001')).toBeNull();
    expect(amountForValue('100', null, '0.0001')).toBeNull();
    expect(valueOf('0.001', '30000')).toBe('30');
  });

  it('a limit carries the picked time in force; a market order stays IOC', () => {
    const key = new HeldDraft(OWNER, MARKET.symbol, () => 1).keyFor(limitBuy);
    expect(intentOf({ ...limitBuy, tif: 'IOC' }, MARKET, null, key, true)?.timeInForce).toBe('IOC');
    expect(intentOf({ ...limitBuy, tif: 'ALO' }, MARKET, null, key, true)?.timeInForce).toBe('ALO');
    expect(intentOf({ ...limitBuy, type: 'market', tif: 'ALO' }, MARKET, '60300.2', key, true)?.timeInForce).toBe('IOC');
  });

  it('a changed time in force is a new order with a new key', () => {
    const draft = new HeldDraft(OWNER, MARKET.symbol, () => 1);
    const gtc = draft.keyFor(limitBuy);
    expect(draft.keyFor({ ...limitBuy, tif: 'IOC' })).not.toBe(gtc);
  });

  it('only what the venue offers can be picked: FOK and GTD are not offered by the TEST venue', () => {
    expect(offeredTif(MARKET, 'GTC')).toBe('GTC');
    expect(offeredTif(MARKET, 'ALO')).toBe('ALO');
    expect(offeredTif(MARKET, 'FOK')).toBeNull();
    expect(offeredTif(MARKET, 'GTD')).toBeNull();
  });

  it('the self-trade rule is the venue’s own, or none where it publishes none', () => {
    expect(venueSelfTrade({ selfTrade: { known: true, value: 'cancel_resting' } })).toBe('cancel_resting');
    expect(venueSelfTrade({ selfTrade: { known: false } })).toBeNull();
    expect(venueSelfTrade({})).toBeNull();
  });

  it('a tag is optional, up to 32 plain characters', () => {
    expect(tagProblem('')).toBe(false);
    expect(tagProblem('desk-run_1.a')).toBe(false);
    expect(tagProblem('x'.repeat(33))).toBe(true);
    expect(tagProblem('<b>')).toBe(true);
  });

  it('the review shows a market order’s price protection in words, the venue’s self-trade rule and the tag', () => {
    const market = intentOf({ ...limitBuy, type: 'market' }, MARKET, '60300.2', 'order:0xowner:btc-usdc:abc2', true)!;
    const html = renderToStaticMarkup(
      <VenueReviewRows
        intent={market}
        preview={preview()}
        status={{ builder: null, test: true }}
        approved={null}
        protectionBps="50"
        selfTrade="cancel_resting"
        tag="desk-1"
      />,
    );
    const shown = text(html);
    expect(shown).toContain('Price protection You won’t pay more than 60,300.2 USDC per BTC (50 bps above the best ask)');
    expect(shown).toContain('If it meets my own order Cancel my resting order');
    expect(shown).toContain('Tag desk-1');
    const sell = renderToStaticMarkup(
      <VenueReviewRows
        intent={{ ...market, side: 'sell' }}
        preview={preview()}
        status={{ builder: null, test: true }}
        approved={null}
        protectionBps="50"
      />,
    );
    expect(text(sell)).toContain('You won’t sell for less than 60,300.2 USDC per BTC (50 bps below the best bid)');
    expect(text(sell)).toContain('If it meets my own order not published by this venue');
  });
});

describe('the deposit is the person’s own transfer', () => {
  const route = {
    chainId: 84532,
    token: '0x00000000000000000000000000000000000000c0',
    tokenDecimals: 6,
    address: '0x00000000000000000000000000000000000000d0',
    asset: 'USDC',
  };
  it('an ERC-20 transfer of the amount in token units, to the venue’s deposit address, on the route’s token', () => {
    const sent = depositTransfer(route, '1000');
    expect(sent?.to).toBe(route.token);
    expect(sent?.units).toBe(1_000_000_000n);
    expect(sent?.data).toBe(`0xa9059cbb${'0'.repeat(24)}${route.address.slice(2)}${(1_000_000_000).toString(16).padStart(64, '0')}`);
  });
  it('refuses an amount past the token’s decimals, or none', () => {
    expect(depositTransfer(route, '1.0000001')).toBeNull();
    expect(depositTransfer(route, '0')).toBeNull();
    expect(depositTransfer(route, 'ten')).toBeNull();
  });
});

describe('a withdrawal confirms it’s you before the wallet is asked', () => {
  it('the press asks for the step-up first; only an approval reaches the signing step', () => {
    expect(withdrawStep('10', null)).toEqual({ step: 'step_up' });
    expect(withdrawStep('10', { id: 'approval-1' })).toEqual({ step: 'sign', stepUpApprovalId: 'approval-1' });
    expect(withdrawStep('', null)).toEqual({ step: 'refuse', why: 'amount' });
  });
  it('names the destination by its short address, and tracks the venue’s withdrawal by its nonce with its fee or not known', () => {
    expect(shortAddress(OWNER)).toBe('0x1234…abcd');
    const pending = renderToStaticMarkup(
      <WithdrawalLine
        withdrawal={{
          nonce: '1731',
          asset: 'USDC',
          amount: '10',
          destination: OWNER,
          status: 'pending',
          fee: { known: false },
          networkFee: { known: false },
        }}
        asOf="2026-11-09T10:00:00.000Z"
      />,
    );
    expect(pending).toContain('data-nonce="1731"');
    expect(text(pending)).toContain('Pending on the venue');
    expect(text(pending)).toContain('Venue withdrawal fee not known');
  });
});

describe('a person not verified for trading', () => {
  it('sees the venue desk’s forms with Price and Amount, each order button off with the way to Verify, and no venue figure', () => {
    const status = {
      available: true,
      venue: { id: 'test-venue', displayName: 'TEST venue' },
      test: true,
      builder: null,
    } as unknown as VenueUp;
    const html = renderToStaticMarkup(<VenueVerifyDesk status={status} symbol="BTC-USDC" />);
    const shown = text(html);
    expect(html).toContain('data-access="verify"');
    expect(html.match(/aria-label="Price"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Amount"/g)).toHaveLength(2);
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*aria-describedby="dk-reason-buy"[^>]*>|<button[^>]*aria-describedby="dk-reason-buy"[^>]*disabled/,
    );
    expect(shown).toContain('Buy BTC');
    expect(shown).toContain('Sell BTC');
    expect(html.match(/id="dk-reason-(buy|sell)"/g)).toHaveLength(2);
    expect(shown).toContain('Verify your identity first');
    expect(shown).toContain('Verify now');
    // The venue's fees were not read: they read Not known, never a figure.
    expect(shown).toContain('maker not known, taker not known');
    expect(shown).not.toMatch(/\d+(\.\d+)? bps/);
    // The venue account panel is there, so a closed Buy is the refusal and never a missing wallet: the wallet row, no
    // venue figure, and Deposit and Withdraw off.
    expect(html).toMatch(/<section[^>]*aria-label="Your venue account"[^>]*data-access="verify"/);
    expect(shown).toContain('Verify for trading to see the venue’s figures');
    expect(html).not.toContain('data-cell="free"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Deposit<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Withdraw<\/button>/);
  });
});

describe('an order the desk placed that filled (J-cex-spot-01 #8)', () => {
  const order = (id: string, status: string, filled: string, locked: string): VenueOrder => ({
    venueOrderId: `v-${id}`,
    venueClientOrderId: id,
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    timeInForce: 'GTC',
    price: '60000',
    amount: '0.001',
    filled,
    remaining: status === 'filled' ? '0' : '0.001',
    averagePrice: null,
    status,
    locked,
    lockedAsset: 'USDC',
    reduceOnly: false,
  });

  it('stays listed as the venue reads it, Filled, with nothing to cancel; an open one keeps Cancel', () => {
    const html = renderToStaticMarkup(
      <OrdersTable
        orders={{ value: [order('0xopen', 'open', '0', '60')], asOf: '2026-11-12T00:00:00.000Z' } as AsOf<VenueOrder[]>}
        test
        onCancel={() => undefined}
        cancelled={[]}
        filled={[order('0xdone', 'filled', '0.001', '0'), order('0xopen', 'filled', '0.001', '0'), order('0xpart', 'open', '0', '60')]}
      />,
    );
    const row = (id: string) => /<tr[^>]*data-client-order-id="(0x\w+)"[^>]*>(.*?)<\/tr>/g;
    const rows = [...html.matchAll(row(''))].map((m) => ({ id: m[1], body: m[2] }));
    // The open order once (its open record wins), the filled one once; a non-filled read-back is never listed here.
    expect(rows.map((r) => r.id)).toEqual(['0xopen', '0xdone']);
    expect(rows[1]!.body).toMatch(/data-cell="status"[^>]*>Filled</);
    expect(rows[1]!.body).not.toContain('<button');
    expect(rows[0]!.body).toContain('Cancel');
  });
});
