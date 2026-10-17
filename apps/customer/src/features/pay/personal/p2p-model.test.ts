import { describe, expect, it } from 'vitest';
import type { Offer, Trade } from '../schemas';
import {
  checkOfferForm,
  checkTake,
  disputeStages,
  emptyOffer,
  escrowView,
  filterOffers,
  filterOrders,
  offerChanges,
  offerMethodIds,
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
    expect(seller.actions).toEqual(['release', 'cancel', 'dispute']);
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
  it('filters by method and by maker', () => {
    const rows = [offer({ id: 'a' }), offer({ id: 'b', methods: ['paypal'] }), offer({ id: 'c', makerId: BUYER })];
    expect(filterOffers(rows, { method: 'paypal' }).map((r) => r.id)).toEqual(['b']);
    expect(filterOffers(rows, { makerId: BUYER.toUpperCase() }).map((r) => r.id)).toEqual(['c']);
    expect(filterOffers(rows, {})).toHaveLength(3);
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
  };
  it('accepts a complete form', () => expect(checkOfferForm(good)).toEqual({}));
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
