import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { Offer, Trade } from '../schemas';
import type { PersonalPayApi } from '../pay-api';
import { OfferForm } from './OfferForm';
import { DisputeProgress, EscrowPath, OfferTabs, OrderChat, OrderFilterTabs, TakeOfferPanel } from './P2PDepth';

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

it('shows the whole chat and cannot send, with the reason', () => {
  const out = renderToString(<OrderChat />);
  expect(out).toContain('Order chat isn’t connected yet');
  expect(out).toContain('No messages yet.');
  expect(out).toMatch(/<textarea[^>]*>/);
  expect(out).toMatch(/<button[^>]*disabled[^>]*>Send message/);
});

it('shows the exact external payment but does not place an order', () => {
  const out = renderToString(<TakeOfferPanel offer={offer} />);
  expect(out).toContain('Quantity in USDT');
  expect(out).toContain('Orders can’t be placed yet');
  expect(out).toMatch(/data-testid="take-review"/);
  expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="take-review"|<button[^>]*data-testid="take-review"[^>]*disabled/);
  expect(out).toContain('sepa');
  expect(out).toContain('wise');
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
const stubPay = { fiat: pending, methods: pending, offer: pending } as unknown as PersonalPayApi;

it('shows the whole create form with saving off and the reason on screen', () => {
  const out = renderToString(<OfferForm pay={stubPay} userId={SELLER} mode="create" offerId={null} />);
  expect(out).toContain('Publishing offers is off');
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
  const out = renderToString(<OfferForm pay={stubPay} userId={SELLER} mode="edit" offerId="a0000000-0000-4000-8000-000000000009" />);
  expect(out).toContain('Editing a published offer is off');
  expect(out).not.toContain('data-testid="offer-submit"');
});
