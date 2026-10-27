import { describe, expect, it } from 'vitest';
import type { Offer, Trade } from '../schemas';
import {
  checkOfferForm,
  checkTake,
  exceedsAvailable,
  feePercent,
  isOwnOffer,
  makerSummary,
  quoteIsConsistent,
  sameQuoteFigures,
  sameTakeTerms,
  splitDuration,
  takeFailureKind,
  takeRefusalIsDefinite,
  takeRequest,
  takerRole,
  tradeMovedFromQuote,
  tradeMatchesTake,
  disputeStages,
  emptyOffer,
  escrowView,
  filterOrders,
  offerChanges,
  offerMethodIds,
  placedNotice,
  offerToForm,
  orderBucket,
  orderCounts,
  roleIn,
  timeLeft,
  type OfferFormValues,
} from './p2p-model';

const BUYER = 'b0000000-0000-4000-8000-000000000001';
const SELLER = 's0000000-0000-4000-8000-000000000002';
const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 't1',
  offerId: 'o1',
  sellerId: SELLER,
  buyerId: BUYER,
  asset: 'USDT',
  amount: '100',
  fiatCurrency: 'EUR',
  fiatAmount: '92',
  price: '0.92',
  method: 'sepa',
  status: 'escrowed',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-17T00:00:00Z',
  escrowedAt: '2026-10-17T00:01:00Z',
  resolvedAt: null,
  settledAt: null,
  ...over,
});
const offer = (over: Partial<Offer> = {}): Offer => ({
  id: 'o1',
  makerId: SELLER,
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'EUR',
  priceType: 'fixed',
  price: '0.92',
  minAmount: '10',
  maxAmount: '500',
  remainingAmount: '300',
  methods: ['sepa', { id: 'wise' }, { nope: 1 }, null],
  terms: 'Pay within 15 minutes',
  status: 'active',
  createdAt: '2026-10-17T00:00:00Z',
  ...over,
});

describe('orders', () => {
  it('puts each status in one bucket', () => {
    expect(orderBucket({ status: 'created' })).toBe('active');
    expect(orderBucket({ status: 'escrowed' })).toBe('active');
    expect(orderBucket({ status: 'fiat_sent' })).toBe('active');
    expect(orderBucket({ status: 'disputed' })).toBe('disputed');
    expect(orderBucket({ status: 'released' })).toBe('completed');
    expect(orderBucket({ status: 'cancelled' })).toBe('cancelled');
  });
  it('filters and counts', () => {
    const rows = [
      { status: 'created' },
      { status: 'released' },
      { status: 'released' },
      { status: 'cancelled' },
      { status: 'disputed' },
    ] as const;
    expect(filterOrders(rows, 'completed')).toHaveLength(2);
    expect(filterOrders(rows, 'all')).toHaveLength(5);
    expect(orderCounts(rows)).toEqual({ all: 5, active: 1, disputed: 1, completed: 2, cancelled: 1 });
    expect(orderCounts([])).toEqual({ all: 0, active: 0, disputed: 0, completed: 0, cancelled: 0 });
  });
  it('names the role', () => {
    expect(roleIn(trade(), BUYER)).toBe('buyer');
    expect(roleIn(trade(), SELLER)).toBe('seller');
    expect(roleIn(trade(), 'someone')).toBe('observer');
    expect(roleIn(trade(), null)).toBe('observer');
  });
});

describe('escrowView', () => {
  const states = (view: ReturnType<typeof escrowView>) => view.steps.map((s) => s.state).join(',');
  it('created: waiting on the service to lock the asset', () => {
    const view = escrowView(trade({ status: 'created', escrowedAt: null }), BUYER);
    expect(states(view)).toBe('current,pending,pending,pending');
    expect(view.waitingOn).toBe('service');
    expect(view.actions).toEqual(['cancel']);
  });
  it('escrowed: the buyer pays, the seller waits', () => {
    const buyer = escrowView(trade(), BUYER);
    expect(states(buyer)).toBe('done,done,current,pending');
    expect(buyer.waitingOn).toBe('you');
    expect(buyer.actions).toEqual(['markPaid', 'cancel', 'dispute']);
    const seller = escrowView(trade(), SELLER);
    expect(seller.waitingOn).toBe('counterparty');
    expect(seller.actions).toEqual(['cancel', 'dispute']);
  });
  it('payment sent: the seller verifies and releases', () => {
    const seller = escrowView(trade({ status: 'fiat_sent' }), SELLER);
    expect(states(seller)).toBe('done,done,done,current');
    expect(seller.waitingOn).toBe('you');
    // Once the buyer has marked paid the seller cannot cancel (svc-p2p refuses it); release or dispute only.
    expect(seller.actions).toEqual(['release', 'dispute']);
    const buyer = escrowView(trade({ status: 'fiat_sent' }), BUYER);
    expect(buyer.waitingOn).toBe('counterparty');
    expect(buyer.actions).toEqual(['dispute']);
  });
  it('released: everything done, nothing to do', () => {
    const view = escrowView(trade({ status: 'released', settledAt: '2026-10-17T01:00:00Z' }), BUYER);
    expect(states(view)).toBe('done,done,done,done');
    expect(view).toMatchObject({ outcome: 'released', waitingOn: 'nobody', actions: [] });
  });
  it('cancelled: refunded, voided, or plain, and an unlocked order says it never held the asset', () => {
    expect(escrowView(trade({ status: 'cancelled', resolution: 'refunded' }), SELLER).outcome).toBe('returned');
    expect(escrowView(trade({ status: 'cancelled', resolution: 'voided' }), SELLER).outcome).toBe('voided');
    const plain = escrowView(trade({ status: 'cancelled', escrowedAt: null }), SELLER);
    expect(plain.outcome).toBe('cancelled');
    expect(states(plain)).toBe('done,unknown,unknown,stopped');
    expect(plain.actions).toEqual([]);
  });
  it('disputed: waiting on a moderator, no payment step guessed', () => {
    const view = escrowView(trade({ status: 'disputed' }), BUYER);
    expect(states(view)).toBe('done,done,unknown,stopped');
    expect(view).toMatchObject({ outcome: 'disputed', waitingOn: 'moderator', actions: [] });
  });
  it('an outsider gets no actions', () => {
    expect(escrowView(trade(), 'stranger').actions).toEqual([]);
  });
});

describe('timeLeft', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');
  it('counts down and past', () => {
    expect(timeLeft('2026-10-17T12:30:00Z', now)).toEqual({ kind: 'left', hours: 2, minutes: 30 });
    expect(timeLeft('2026-10-17T09:45:00Z', now)).toEqual({ kind: 'past', hours: 0, minutes: 15 });
    expect(timeLeft(null, now)).toEqual({ kind: 'none' });
    expect(timeLeft('not a date', now)).toEqual({ kind: 'none' });
  });
});

describe('disputeStages', () => {
  const base = { status: 'open' as const, evidence: [], moderatorId: null, lastSeenByModeratorAt: null };
  it('starts at evidence, moves to review, ends at ruled', () => {
    expect(disputeStages(base).map((s) => s.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(disputeStages({ ...base, evidence: [{}] }).map((s) => s.state)).toEqual(['done', 'done', 'current', 'pending']);
    expect(disputeStages({ ...base, lastSeenByModeratorAt: '2026-10-17T00:00:00Z' }).map((s) => s.state)).toEqual([
      'done',
      'done',
      'current',
      'pending',
    ]);
    expect(disputeStages({ ...base, status: 'resolved', moderatorId: 'm' }).map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
  });
});

describe('offers', () => {
  it('reads method ids from strings and { id } objects only', () => {
    expect(offerMethodIds(offer())).toEqual(['sepa', 'wise']);
  });
});

describe('checkTake', () => {
  const o = offer();
  it('computes the exact external payment for a fixed price', () => {
    expect(checkTake(o, '100')).toEqual({ kind: 'ok', amount: '100', fiatTotal: '92' });
    expect(checkTake(o, '33.333333')).toEqual({ kind: 'ok', amount: '33.333333', fiatTotal: '30.66666636' });
  });
  it('gives no total for a floating price', () => {
    expect(checkTake(offer({ priceType: 'float', price: '1.01' }), '100')).toEqual({ kind: 'ok', amount: '100', fiatTotal: null });
  });
  it('checks the limits in order', () => {
    expect(checkTake(o, '')).toEqual({ kind: 'empty' });
    expect(checkTake(o, 'abc')).toEqual({ kind: 'invalid' });
    expect(checkTake(o, '0')).toEqual({ kind: 'invalid' });
    expect(checkTake(o, '9.99')).toEqual({ kind: 'belowMin' });
    expect(checkTake(o, '500.01')).toEqual({ kind: 'aboveMax' });
    expect(checkTake(offer({ maxAmount: '500', remainingAmount: '50' }), '60')).toEqual({ kind: 'aboveRemaining' });
    expect(checkTake(o, '1e3')).toEqual({ kind: 'invalid' });
  });
});

describe('offer form', () => {
  const good: OfferFormValues = {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: '0.92',
    minAmount: '10',
    maxAmount: '500',
    totalAmount: '1000',
    methods: ['sepa'],
    terms: '',
    acceptsNonInstant: false,
  };
  it('accepts a complete form', () => expect(checkOfferForm(good)).toEqual({}));
  it('needs the seller to accept a method that is not instant, and only on a sell ad (P-disputes-security-09)', () => {
    const slow = new Set(['slow']);
    expect(checkOfferForm({ ...good, methods: ['sepa', 'Slow'] }, slow).methods).toBe('nonInstantConsent');
    expect(checkOfferForm({ ...good, methods: ['sepa', 'slow'], acceptsNonInstant: true }, slow)).toEqual({});
    expect(checkOfferForm({ ...good, side: 'buy', methods: ['slow'] }, slow)).toEqual({});
    expect(checkOfferForm({ ...good, methods: ['sepa'] }, slow)).toEqual({});
  });
  it('reports every missing field on an empty form', () => {
    expect(checkOfferForm(emptyOffer())).toEqual({
      asset: 'required',
      fiatCurrency: 'required',
      price: 'required',
      minAmount: 'required',
      maxAmount: 'required',
      methods: 'required',
    });
  });
  it('catches bad numbers, a min above the max, a total below the max and long terms', () => {
    expect(checkOfferForm({ ...good, price: '0' }).price).toBe('invalid');
    expect(checkOfferForm({ ...good, price: '1,5' }).price).toBe('invalid');
    expect(checkOfferForm({ ...good, minAmount: '600' }).minAmount).toBe('minTooHigh');
    expect(checkOfferForm({ ...good, totalAmount: '400' }).totalAmount).toBe('totalTooLow');
    expect(checkOfferForm({ ...good, totalAmount: '-1' }).totalAmount).toBe('invalid');
    expect(checkOfferForm({ ...good, terms: 'x'.repeat(4001) }).terms).toBe('tooLong');
    expect(checkOfferForm({ ...good, fiatCurrency: 'eu' }).fiatCurrency).toBe('invalid');
    expect(checkOfferForm({ ...good, asset: 'bad asset!' }).asset).toBe('invalid');
  });
  it('turns an offer into form values and lists what changed', () => {
    const before = offerToForm(offer());
    expect(before).toMatchObject({ asset: 'USDT', price: '0.92', methods: ['sepa', 'wise'], totalAmount: '' });
    expect(offerChanges(before, before)).toEqual([]);
    expect(offerChanges(before, { ...before, price: '0.920', maxAmount: '400', methods: ['wise', 'sepa', 'x'], terms: 'new' })).toEqual([
      'maxAmount',
      'methods',
      'terms',
    ]);
  });
});

describe('taking an offer', () => {
  const quote = {
    amount: '100',
    price: '0.92',
    fiatAmount: '92',
    feeBps: 30,
    fee: '0.3',
    netAmount: '99.7',
    reservationExpiresAt: '2026-10-18T10:15:00.000Z',
  };
  const me = 'm0000000-0000-4000-8000-000000000003';

  it('knows an offer is the signed-in person’s own, whatever the letter case', () => {
    expect(isOwnOffer(offer({ makerId: SELLER }), SELLER)).toBe(true);
    expect(isOwnOffer(offer({ makerId: SELLER.toUpperCase() }), SELLER)).toBe(true);
    expect(isOwnOffer(offer({ makerId: SELLER }), BUYER)).toBe(false);
    expect(isOwnOffer(offer({ makerId: SELLER }), null)).toBe(false);
  });
  it('puts the taker on the other side of the maker', () => {
    expect(takerRole(offer({ side: 'sell' }))).toBe('buyer');
    expect(takerRole(offer({ side: 'buy' }))).toBe('seller');
  });
  it('writes basis points as an exact percentage', () => {
    expect(feePercent(0)).toBe('0');
    expect(feePercent(30)).toBe('0.3');
    expect(feePercent(125)).toBe('1.25');
    expect(feePercent(5)).toBe('0.05');
    expect(feePercent(100)).toBe('1');
  });
  it('builds one request only from an amount inside the offer’s limits and a method the offer lists', () => {
    expect(takeRequest(offer(), '100', 'sepa')).toEqual({ ok: true, request: { offerId: 'o1', amount: '100', method: 'sepa' } });
    expect(takeRequest(offer(), ' 100.50 ', 'wise')).toMatchObject({ ok: true, request: { amount: '100.5' } });
    expect(takeRequest(offer(), '9.99', 'sepa')).toEqual({ ok: false, kind: 'belowMin' });
    expect(takeRequest(offer(), '10', 'sepa')).toMatchObject({ ok: true });
    expect(takeRequest(offer({ remainingAmount: '500' }), '500', 'sepa')).toMatchObject({ ok: true });
    expect(takeRequest(offer({ remainingAmount: '900' }), '500.01', 'sepa')).toEqual({ ok: false, kind: 'aboveMax' });
    expect(takeRequest(offer({ maxAmount: '500', remainingAmount: '50' }), '60', 'sepa')).toEqual({ ok: false, kind: 'aboveRemaining' });
    expect(takeRequest(offer(), '', 'sepa')).toEqual({ ok: false, kind: 'empty' });
    expect(takeRequest(offer(), '1e3', 'sepa')).toEqual({ ok: false, kind: 'invalid' });
    expect(takeRequest(offer(), '100', '')).toEqual({ ok: false, kind: 'noMethod' });
    expect(takeRequest(offer(), '100', 'paypal')).toEqual({ ok: false, kind: 'noMethod' });
    expect(takeRequest(offer({ status: 'paused' }), '100', 'sepa')).toEqual({ ok: false, kind: 'inactive' });
  });
  it('accepts a quote only when it is for this request and adds up exactly', () => {
    const request = { offerId: 'o1', amount: '100', method: 'sepa' };
    expect(quoteIsConsistent(offer(), request, quote)).toBe(true);
    expect(quoteIsConsistent(offer(), request, { ...quote, netAmount: '99.71' })).toBe(false);
    expect(quoteIsConsistent(offer(), request, { ...quote, fee: '100.1', netAmount: '-0.1' })).toBe(false);
    expect(quoteIsConsistent(offer(), request, { ...quote, amount: '100.000000000000000001' })).toBe(false);
    expect(quoteIsConsistent(offer(), request, { ...quote, price: '0.93' })).toBe(false);
    // A floating price is priced by the service, so its price is not compared with the offer's multiplier.
    expect(quoteIsConsistent(offer({ priceType: 'float', price: '1.01' }), request, quote)).toBe(true);
    expect(quoteIsConsistent(offer(), request, { ...quote, amount: '100.0', fee: '0.30', netAmount: '99.700' })).toBe(true);
  });
  it('compares quotes by value, not by when the reservation would end', () => {
    expect(sameQuoteFigures(quote, { ...quote, reservationExpiresAt: '2026-10-18T10:16:00.000Z', fee: '0.30' })).toBe(true);
    expect(sameQuoteFigures(quote, { ...quote, feeBps: 31 })).toBe(false);
    expect(sameQuoteFigures(quote, { ...quote, fiatAmount: '92.01' })).toBe(false);
  });
  it('lets the remaining quantity move between review and confirm but nothing else', () => {
    expect(sameTakeTerms(offer(), offer({ remainingAmount: '10' }))).toBe(true);
    expect(sameTakeTerms(offer(), offer({ price: '0.93' }))).toBe(false);
    expect(sameTakeTerms(offer(), offer({ minAmount: '11' }))).toBe(false);
    expect(sameTakeTerms(offer(), offer({ status: 'paused' }))).toBe(false);
    expect(sameTakeTerms(offer(), offer({ terms: 'changed' }))).toBe(false);
    expect(sameTakeTerms(offer(), offer({ methods: ['sepa'] }))).toBe(false);
  });
  it('accepts a returned order only for this person, this offer and these terms', () => {
    const o = offer({ makerId: SELLER, side: 'sell' });
    const mine = trade({ id: 't9', buyerId: me, sellerId: SELLER });
    expect(tradeMatchesTake(mine, o, me, { amount: '100', method: 'sepa' }, 'T9')).toBe(true);
    expect(tradeMatchesTake(mine, o, me, null, 't9')).toBe(true);
    expect(tradeMatchesTake(mine, o, BUYER, null, 't9')).toBe(false);
    expect(tradeMatchesTake(mine, o, me, null, 't8')).toBe(false);
    expect(tradeMatchesTake(mine, o, me, { amount: '101', method: 'sepa' }, 't9')).toBe(false);
    expect(tradeMatchesTake(mine, o, me, { amount: '100', method: 'wise' }, 't9')).toBe(false);
    expect(tradeMatchesTake({ ...mine, offerId: 'o2' }, o, me, null, 't9')).toBe(false);
    // A maker who buys: the taker is the seller.
    const buying = offer({ makerId: SELLER, side: 'buy' });
    expect(tradeMatchesTake(trade({ id: 't9', sellerId: me, buyerId: SELLER }), buying, me, null, 't9')).toBe(true);
    expect(tradeMatchesTake(trade({ id: 't9', sellerId: SELLER, buyerId: me }), buying, me, null, 't9')).toBe(false);
  });
  it('treats only named pre-lock refusals and plain request rejections as proof nothing was placed', () => {
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.amount_below_min', status: 400 })).toBe(true);
    expect(takeRefusalIsDefinite({ reason: 'forbidden', code: 'p2p.blocked', status: 403 })).toBe(true);
    expect(takeRefusalIsDefinite({ reason: 'error', status: 400 })).toBe(true);
    expect(takeRefusalIsDefinite({ reason: 'unauthorized', status: 401 })).toBe(true);
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.trade_exists', status: 409 })).toBe(false);
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.escrow_lock_uncertain', status: 412 })).toBe(false);
    expect(takeRefusalIsDefinite({ reason: 'error', status: 409 })).toBe(false);
    expect(takeRefusalIsDefinite({ reason: 'error', status: 412 })).toBe(false);
    expect(takeRefusalIsDefinite({ reason: 'uncertain', status: 503 })).toBe(false);
    expect(takeRefusalIsDefinite({ reason: 'aborted' })).toBe(false);
    expect(takeRefusalIsDefinite({ reason: 'error' })).toBe(false);
  });
  it('names each failure as one plain kind', () => {
    expect(takeFailureKind({ reason: 'uncertain' })).toBe('unconfirmed');
    expect(takeFailureKind({ reason: 'error', code: 'pay.operation_unresolved' })).toBe('unconfirmed');
    expect(takeFailureKind({ reason: 'uncertain', code: 'pay.take_not_found' })).toBe('notFound');
    expect(takeFailureKind({ reason: 'forbidden', code: 'p2p.self_trade' })).toBe('ownOffer');
    expect(takeFailureKind({ reason: 'forbidden', code: 'p2p.blocked' })).toBe('blocked');
    expect(takeFailureKind({ reason: 'error', code: 'p2p.take_refused' })).toBe('methodRefused');
    expect(takeFailureKind({ reason: 'error', code: 'p2p.amount_above_max' })).toBe('outOfBounds');
    expect(takeFailureKind({ reason: 'error', code: 'p2p.release_unpostable' })).toBe('tooSmall');
    // P-ads-merchant-19: a floating ad on a method made cash in person; the take rolled back, so nothing is pending.
    expect(takeFailureKind({ reason: 'error', code: 'p2p.floating_not_allowed_for_method' })).toBe('floatingCashRefused');
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.floating_not_allowed_for_method' })).toBe(true);
    expect(takeFailureKind({ reason: 'invalid_response', code: 'pay.take_quote_changed' })).toBe('quoteChanged');
    expect(takeFailureKind({ reason: 'not_supported', code: 'pay.recovery_journal_unavailable' })).toBe('noRecord');
    expect(takeFailureKind({ reason: 'forbidden', code: 'denied.kyc_required', status: 403 })).toBe('verify');
    expect(takeFailureKind({ reason: 'forbidden', code: 'denied.region_blocked', status: 403 })).toBe('region');
    expect(takeFailureKind({ reason: 'forbidden', code: 'denied.region_unknown', status: 403 })).toBe('region');
    expect(takeRefusalIsDefinite({ reason: 'forbidden', code: 'denied.kyc_required', status: 403 })).toBe(true);
    expect(takeFailureKind({ reason: 'unauthorized' })).toBe('signIn');
    expect(takeFailureKind({ reason: 'unreachable' })).toBe('noService');
    expect(takeFailureKind({ reason: 'error', code: 'something.new' })).toBe('generic');
  });
});

describe('an order priced differently from the review', () => {
  it('notices a changed price or fiat total, and ignores formatting', () => {
    expect(tradeMovedFromQuote({ price: '0.92', fiatAmount: '92' }, { price: '0.920', fiatAmount: '92.0' })).toBe(false);
    expect(tradeMovedFromQuote({ price: '0.93', fiatAmount: '93' }, { price: '0.92', fiatAmount: '92' })).toBe(true);
    expect(tradeMovedFromQuote({ price: '0.92', fiatAmount: '92.01' }, { price: '0.92', fiatAmount: '92' })).toBe(true);
  });
});

describe('who is on the other side', () => {
  it('summarises a maker only from the returned record', () => {
    expect(makerSummary({ tradesTotal: 0, completed: 0, cancelled: 0, completionRate: 0, avgReleaseSecs: 0 })).toEqual({ kind: 'new' });
    expect(makerSummary({ tradesTotal: 10, completed: 9, cancelled: 1, completionRate: 0.9, avgReleaseSecs: 120 })).toEqual({
      kind: 'record',
      orders: 10,
      completionRate: 0.9,
      releaseSecs: 120,
    });
    // Orders but none completed: there is no release time to average, so none is shown.
    expect(makerSummary({ tradesTotal: 3, completed: 0, cancelled: 3, completionRate: 0, avgReleaseSecs: 0 })).toMatchObject({
      releaseSecs: null,
    });
  });
  it('splits a duration into its two largest units', () => {
    expect(splitDuration(45)).toEqual({ unit: 'seconds', major: 45, minor: null });
    expect(splitDuration(190)).toEqual({ unit: 'minutes', major: 3, minor: 10 });
    expect(splitDuration(7500)).toEqual({ unit: 'hours', major: 2, minor: 5 });
  });
});

describe('exceedsAvailable', () => {
  it('compares exact decimals and only judges a complete quantity', () => {
    expect(exceedsAvailable('530.152143', '530.152142')).toBe(true);
    expect(exceedsAvailable('530.152142', '530.152142')).toBe(false);
    expect(exceedsAvailable('12.5', '530.152142')).toBe(false);
    expect(exceedsAvailable('1000000000000000000', '999999999999999999.999999999999999999')).toBe(true);
    expect(exceedsAvailable('', '5')).toBe(false);
    expect(exceedsAvailable('abc', '5')).toBe(false);
    expect(exceedsAvailable('0', '0')).toBe(false);
    expect(exceedsAvailable('1', '0')).toBe(true);
  });
});

describe('placedNotice', () => {
  const trade = { id: 'AAAA', price: '0.92', fiatAmount: '92' };
  const quote = { price: '0.92', fiatAmount: '92' };
  it('opens a new order straight away', () => {
    expect(placedNotice({ heldReference: null, trade, quote, placedNow: false })).toBe(null);
  });
  it('says an order the service already had is the earlier one', () => {
    expect(placedNotice({ heldReference: 'aaaa', trade, quote, placedNow: false })).toBe('earlier');
  });
  it('says a resend placed it under the earlier reference', () => {
    expect(placedNotice({ heldReference: 'aaaa', trade, quote, placedNow: true })).toBe('resent');
  });
  it('puts a moved price first when a resend placed it at another price', () => {
    expect(placedNotice({ heldReference: 'aaaa', trade: { ...trade, price: '0.93' }, quote, placedNow: true })).toBe('moved');
  });
});

describe('makerSummary with unfinished trades', () => {
  const base = { tradesTotal: 0, completed: 0, cancelled: 0, completionRate: 0, avgReleaseSecs: 0 };
  it('has three states: new, only open trades, and a finished record', () => {
    expect(makerSummary(base)).toEqual({ kind: 'new' });
    expect(makerSummary({ ...base, tradesTotal: 1 })).toEqual({ kind: 'unfinished', orders: 1 });
    expect(makerSummary({ ...base, tradesTotal: 2, cancelled: 2 })).toMatchObject({ kind: 'record', completionRate: 0, releaseSecs: null });
  });
});
