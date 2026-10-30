import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { createApiClient } from '../../../shared/api';
import type { Offer, TakeQuote, Trade } from '../schemas';
import { createPayMutationGuard, createPersonalPayApi, type PersonalPayApi } from '../pay-api';
import { OfferForm } from './OfferForm';
import { DisputeProgress, EscrowPath, OfferTabs, OrderFilterTabs, TakeOfferPanel } from './P2PDepth';
import { TakeAvailable, TakeFailureNote, TakeQuoteDetails, TakeReviewDetails } from './TakeOffer';
import { CounterpartyMetrics, CounterpartyName } from '../P2PCounterparty';
import { TraderName, TraderSummary } from './Trader';

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
const offer: Offer = {
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
  methods: ['sepa', { id: 'wise' }],
  terms: '',
  status: 'active',
  createdAt: '2026-10-17T00:00:00Z',
};

it('shows the buyer whose turn it is and what they can do', () => {
  const out = renderToString(<EscrowPath trade={trade()} userId={BUYER} />);
  expect(out).toContain('Your turn');
  expect(out).toContain('Mark payment sent');
  expect(out).toContain('Open a dispute');
  expect(out).toContain('Asset held in escrow');
});

it('says a disputed order waits for a moderator and does not guess the payment step', () => {
  const out = renderToString(<EscrowPath trade={trade({ status: 'disputed' })} userId={SELLER} />);
  expect(out).toContain('Waiting for a moderator');
  expect(out).toContain('Waiting for a moderator’s ruling');
  expect(out).toContain('Not recorded');
});

it('names how a cancelled order ended', () => {
  const out = renderToString(<EscrowPath trade={trade({ status: 'cancelled', resolution: 'refunded' })} userId={SELLER} />);
  expect(out).toContain('Asset returned to the seller');
  expect(out).toContain('Nothing left to do');
  expect(out).not.toContain('Deadline');
});

it('lists the four dispute stages', () => {
  const out = renderToString(
    <DisputeProgress dispute={{ status: 'open', evidence: [], moderatorId: null, lastSeenByModeratorAt: null, overdue: true }} />,
  );
  for (const label of ['Opened', 'Evidence', 'Moderator review', 'Ruling']) expect(out).toContain(label);
  expect(out).toContain('past its deadline');
});

const idle = createApiClient({ fetch: () => new Promise<Response>(() => {}) });
const payFor = (userId: string | null) => createPersonalPayApi(idle, userId, createPayMutationGuard());
const quote: TakeQuote = {
  amount: '100',
  price: '0.92',
  fiatAmount: '92',
  feeBps: 30,
  fee: '0.3',
  netAmount: '99.7',
  reservationExpiresAt: '2026-10-18T10:15:00.000Z',
};

it('offers a stranger the order form with limits, methods and a quote area, and no “not yet” copy', () => {
  const out = renderToString(<TakeOfferPanel offer={offer} pay={payFor(BUYER)} userId={BUYER} />);
  expect(out).toContain('Quantity in USDT');
  expect(out).toContain('This offer takes 10 to 500 USDT per order.');
  expect(out).toContain('Enter a quantity and choose a payment method to see your quote.');
  expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="take-review"|<button[^>]*data-testid="take-review"[^>]*disabled/);
  expect(out).toContain('sepa');
  expect(out).toContain('wise');
  expect(out).not.toContain('Orders can’t be placed yet');
  expect(out).not.toContain('doesn’t give a fee');
  expect(out).not.toContain('data-testid="take-unresolved"');
});

it('gives the maker no order form on their own offer', () => {
  const out = renderToString(<TakeOfferPanel offer={offer} pay={payFor(SELLER)} userId={SELLER} />);
  expect(out).toContain('This is your offer');
  expect(out).toContain('data-testid="take-own"');
  expect(out).not.toContain('<input');
  expect(out).not.toContain('data-testid="take-review"');
});

it('shows the quote exactly as the service returned it, from the buyer’s side', () => {
  const out = renderToString(<TakeQuoteDetails offer={offer} quote={quote} />);
  for (const text of [
    'You buy',
    '100 USDT',
    'You pay (external payment)',
    '92 EUR',
    '0.92 EUR / USDT',
    'Service fee',
    '0.3 USDT (0.3%)',
    'You receive',
    '99.7 USDT',
  ])
    expect(out).toContain(text);
  expect(out).not.toContain('Reservation');
});

it('shows the quote from the seller’s side when the maker is buying', () => {
  const out = renderToString(<TakeQuoteDetails offer={{ ...offer, side: 'buy' }} quote={quote} />);
  expect(out).toContain('You sell');
  expect(out).toContain('You receive (external payment from the buyer)');
  expect(out).toContain('Service fee (taken from what the buyer receives)');
  expect(out).toContain('The buyer receives');
  expect(out).toContain('99.7 USDT');
  expect(out).not.toContain('Reservation');
});

it('calls an unconfirmed order unconfirmed and shows no service text or code', () => {
  const failure = {
    ok: false as const,
    reason: 'uncertain' as const,
    message: 'p2p.escrow_lock_uncertain',
    code: 'p2p.escrow_lock_uncertain',
  };
  const out = renderToString(<TakeFailureNote failure={failure} context="take" />);
  expect(out).toContain('We couldn’t confirm your order');
  expect(out).toContain('Check before trying again');
  expect(out).not.toContain('p2p.');
  const verify = renderToString(
    <TakeFailureNote failure={{ ok: false, reason: 'forbidden', message: 'x', code: 'denied.kyc_required' }} context="quote" />,
  );
  expect(verify).toContain('Verify your identity to place P2P orders.');
  expect(verify).toContain('href="/verification"');
  expect(verify).not.toContain('denied.');
  const region = renderToString(
    <TakeFailureNote failure={{ ok: false, reason: 'forbidden', message: 'x', code: 'denied.region_blocked' }} context="quote" />,
  );
  expect(region).toContain('aren’t available in your region');
  expect(region).not.toContain('/verification');
  const refused = { ok: false as const, reason: 'forbidden' as const, message: 'p2p.blocked', code: 'p2p.blocked' };
  const blocked = renderToString(<TakeFailureNote failure={refused} context="take" />);
  expect(blocked).toContain('You can’t place an order with this member.');
  expect(blocked).not.toContain('p2p.blocked');
});

it('names a trader by handle, never by account id, and says what the record returned', () => {
  const record = {
    ok: true as const,
    data: {
      tradesTotal: 120,
      completed: 118,
      cancelled: 2,
      disputed: 0,
      disputesLost: 0,
      completionRate: 0.985,
      avgReleaseSecs: 190,
      badges: [],
      merchant: null,
      handle: 'test_friend',
      memberSince: null,
    },
  };
  const name = renderToString(<TraderName record={record} />);
  expect(name).toContain('@test_friend');
  const summary = renderToString(<TraderSummary record={record} />);
  expect(summary).toContain('120 orders');
  expect(summary).toContain('98.5%');
  expect(summary).toContain('releases in about 3 min');
  // Identity not connected (no profile status): nothing is known about the member, so it stays "Member".
  const unnamed = renderToString(<TraderName record={{ ok: true, data: { ...record.data, handle: null } }} />);
  expect(unnamed).toContain('Member');
  const absent = renderToString(
    <TraderName record={{ ok: true, data: { ...record.data, handle: null, profile: { status: 'absent' } } }} />,
  );
  expect(absent).toContain('—');
  expect(absent).toContain('No public handle');
  expect(absent).not.toContain('Member');
  // A maker beyond the board's cap has no record asked for: Member, no spinner, no summary.
  expect(renderToString(<TraderName record={null} />)).toContain('Member');
  expect(renderToString(<TraderName record={null} />)).not.toContain('aria-busy');
  expect(renderToString(<TraderSummary record={null} />)).toBe('');
  expect(renderToString(<TraderSummary record={{ ok: true, data: { ...record.data, tradesTotal: 0, completed: 0 } }} />)).toContain(
    'New trader',
  );
  expect(renderToString(<TraderSummary record={{ ok: false, reason: 'error', message: 'x' }} />)).toContain('Trader record unavailable');
});

it('marks the pressed offer and order tabs', () => {
  const tabs = renderToString(<OfferTabs side="sell" onSide={() => {}} />);
  expect(tabs).toMatch(/aria-pressed="true"[^>]*>I want to buy/);
  const filters = renderToString(
    <OrderFilterTabs value="active" counts={{ all: 5, active: 2, disputed: 1, completed: 1, cancelled: 1 }} onChange={() => {}} />,
  );
  expect(filters).toContain('Active');
  expect(filters).toContain('(2)');
  expect(filters).toMatch(/aria-pressed="true"[^>]*>Active/);
});

const pending = () => new Promise<never>(() => {});
const stubPay = {
  fiat: pending,
  methods: pending,
  offer: pending,
  advertiserTerms: pending,
  levelLimits: pending,
  postingEligibility: pending,
} as unknown as PersonalPayApi;

it('shows the whole create form, with review off until it is complete', () => {
  const out = renderToString(<OfferForm pay={stubPay} userId={SELLER} mode="create" offerId={null} />);
  expect(out).toContain('data-testid="offer-form"');
  expect(out).not.toContain('Publishing from this form is off');
  for (const label of [
    'Offer type',
    'Fiat currency',
    'Price type',
    'Minimum per order',
    'Maximum per order',
    'Payment methods',
    'Terms (optional)',
  ])
    expect(out).toContain(label);
  expect(out).toContain('Finish the form to review');
  expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="offer-submit"|<button[^>]*data-testid="offer-submit"[^>]*disabled/);
});

it('asks which offer to edit when none is chosen, and shows no form', () => {
  const out = renderToString(<OfferForm pay={stubPay} userId={SELLER} mode="edit" offerId={null} />);
  expect(out).toContain('Pick an offer to edit');
  expect(out).toContain('href="/uc/ad"');
  expect(out).not.toContain('data-testid="offer-submit"');
  expect(out).not.toContain('Editing a published offer is off');
  expect(out).not.toContain('<input');
});

it('loads the live offer before showing the edit form', () => {
  // P-ads-merchant-06: editing a published ad saves now, so no "editing is off" notice; the form waits for the live ad.
  const out = renderToString(<OfferForm pay={stubPay} userId={SELLER} mode="edit" offerId="a0000000-0000-4000-8000-000000000009" />);
  expect(out).toContain('data-kind="loading"');
  expect(out).not.toContain('Editing a published offer is off');
  expect(out).not.toContain('data-testid="offer-submit"');
});

const reputation = (over: Partial<import('../schemas').Reputation> = {}): import('../schemas').Reputation => ({
  tradesTotal: 0,
  completed: 0,
  cancelled: 0,
  disputed: 0,
  disputesLost: 0,
  completionRate: 0,
  avgReleaseSecs: 0,
  badges: [],
  merchant: null,
  handle: null,
  memberSince: null,
  ...over,
});

it('shows a dash and “No trades yet” for a trader with no history, never 0% or 0s', () => {
  const out = renderToString(<CounterpartyMetrics data={reputation()} />);
  expect(out).toContain('—');
  expect(out).toContain('No trades yet');
  expect(out).not.toContain('0%');
  expect(out).not.toMatch(/>0<|0\s*s</);
  expect(out).not.toContain('shows zero');
});

it('shows the real rate and release time once there are completed trades, and a dash for release when none completed', () => {
  const record = renderToString(
    <CounterpartyMetrics data={reputation({ tradesTotal: 10, completed: 8, cancelled: 2, completionRate: 0.8, avgReleaseSecs: 190 })} />,
  );
  expect(record).toContain('80%');
  expect(record).toContain('190');
  expect(record).toContain('8 of 10');
  const cancelledOnly = renderToString(
    <CounterpartyMetrics data={reputation({ tradesTotal: 2, completed: 0, cancelled: 2, completionRate: 0 })} />,
  );
  expect(cancelledOnly).toContain('0%');
  expect(cancelledOnly).toContain('No completed trades yet');
});

it('names the counterparty by handle, or says there is none, and never by account id', () => {
  const named = renderToString(<CounterpartyName resource={{ status: 'ready', data: reputation({ handle: 'test_friend' }) }} />);
  expect(named).toContain('@test_friend');
  const unnamed = renderToString(<CounterpartyName resource={{ status: 'ready', data: reputation() }} />);
  expect(unnamed).toContain('Member');
  const absent = renderToString(<CounterpartyName resource={{ status: 'ready', data: reputation({ profile: { status: 'absent' } }) }} />);
  expect(absent).toContain('—');
  expect(absent).toContain('No public handle');
  const failed = renderToString(
    <CounterpartyName resource={{ status: 'failed', failure: { ok: false, reason: 'error', message: 'x' } }} />,
  );
  expect(failed).toContain('Member');
  expect(renderToString(<CounterpartyName resource={{ status: 'loading' }} />)).toBe('');
});

it('puts the payment method and the counterparty in the order review, on both sides', () => {
  const buying = renderToString(
    <TakeReviewDetails offer={offer} quote={quote} methodLabel="SEPA bank transfer" counterparty={<TraderName record={null} />} />,
  );
  expect(buying).toContain('Seller');
  expect(buying).toContain('Member');
  expect(buying).toContain('Payment method');
  expect(buying).toContain('SEPA bank transfer');
  expect(buying).toContain('99.7 USDT');
  const selling = renderToString(
    <TakeReviewDetails
      offer={{ ...offer, side: 'buy' }}
      quote={quote}
      methodLabel="Wise"
      counterparty={<TraderName record={{ ok: true, data: reputation({ handle: 'test_friend' }) }} />}
    />,
  );
  expect(selling).toContain('Buyer');
  expect(selling).toContain('@test_friend');
  expect(selling).toContain('Wise');
});

it('shows the seller’s available balance, or says it could not be read', () => {
  expect(renderToString(<TakeAvailable state={{ ok: true, data: '530.152142' }} asset="USDT" />)).toContain('Available 530.152142 USDT');
  expect(renderToString(<TakeAvailable state={{ ok: false, reason: 'error', message: 'x' }} asset="USDT" />)).toContain(
    'couldn’t read your available balance',
  );
  expect(renderToString(<TakeAvailable state="loading" asset="USDT" />)).toBe('');
  expect(renderToString(<TakeAvailable state={null} asset="USDT" />)).toBe('');
});

it('shows the available line only on the selling side of the order form', () => {
  const selling = renderToString(<TakeOfferPanel offer={{ ...offer, side: 'buy' }} pay={payFor(BUYER)} userId={BUYER} />);
  expect(selling).toContain('Quantity in USDT');
  const buying = renderToString(<TakeOfferPanel offer={offer} pay={payFor(BUYER)} userId={BUYER} />);
  expect(buying).not.toContain('take-available');
});

it('shows a dash, not 0%, while a trader’s only trades are still open', () => {
  const open = renderToString(<CounterpartyMetrics data={reputation({ tradesTotal: 1, completed: 0, cancelled: 0 })} />);
  expect(open).toContain('—');
  expect(open).toContain('No finished trades yet');
  expect(open).not.toContain('0%');
  expect(open).not.toContain('0 of 1');
  const cancelled = renderToString(<CounterpartyMetrics data={reputation({ tradesTotal: 2, completed: 0, cancelled: 2 })} />);
  expect(cancelled).toContain('0%');
  expect(cancelled).toContain('No completed trades yet');
});

it('says a maker has no finished orders yet instead of a 0% record on the board', () => {
  const out = renderToString(
    <TraderSummary record={{ ok: true, data: reputation({ tradesTotal: 3, completed: 0, cancelled: 0, completionRate: 0 }) }} />,
  );
  expect(out).toContain('3 orders · none finished yet');
  expect(out).not.toContain('0%');
  const cancelledOnly = renderToString(
    <TraderSummary record={{ ok: true, data: reputation({ tradesTotal: 2, completed: 0, cancelled: 2, completionRate: 0 }) }} />,
  );
  expect(cancelledOnly).toContain('0%');
});

it('says "1 order", not "1 orders", for a maker with one trade', () => {
  const one = renderToString(
    <TraderSummary record={{ ok: true, data: reputation({ tradesTotal: 1, completed: 1, cancelled: 0, completionRate: 1 }) }} />,
  );
  expect(one).toContain('1 order · 100% completed');
  expect(one).not.toContain('1 orders');
});
