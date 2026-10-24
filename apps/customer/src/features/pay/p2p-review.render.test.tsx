// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderReview } from './personal/OrderReview';
import type { PersonalPayApi } from './pay-api';
import type { OrderReview as Review, Trade, TradeReviews } from './schemas';

/** J-p2p-01 #9: one good or bad review per party of a completed order. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const TRADE = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const trade = (status: Trade['status']): Trade => ({
  id: TRADE,
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: SELLER,
  buyerId: BUYER,
  asset: 'USDT',
  amount: '50',
  fiatCurrency: 'EUR',
  fiatAmount: '46',
  price: '0.92',
  method: 'test-bank-transfer',
  status,
  resolution: status === 'released' ? 'released' : null,
  deadlineAt: null,
  createdAt: '2026-10-24T05:00:00.000Z',
  escrowedAt: '2026-10-24T05:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
});
const review = (patch: Partial<Review>): Review => ({
  id: '44444444-4444-4444-8444-444444444444',
  tradeId: TRADE,
  authorId: BUYER,
  subjectId: SELLER,
  rating: 'good',
  comment: '',
  explanation: null,
  reply: null,
  repliedAt: null,
  createdAt: '2026-10-24T05:20:00.000Z',
  updatedAt: '2026-10-24T05:20:00.000Z',
  hidden: false,
  hiddenReason: null,
  ...patch,
});

function payWith(reads: TradeReviews[], leaveReview = vi.fn(async (..._args: unknown[]) => ({ ok: true, data: review({}) }))) {
  const orderReviews = vi.fn(async () => ({ ok: true, data: reads.length > 1 ? reads.shift()! : reads[0]! }));
  return { pay: { viewer: BUYER, orderReviews, leaveReview } as unknown as PersonalPayApi, orderReviews, leaveReview };
}

async function open(pay: PersonalPayApi, status: Trade['status']) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<OrderReview pay={pay} trade={trade(status)} />));
  await act(async () => undefined);
  return host;
}

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('P2P order review (J-p2p-01 #9)', () => {
  it('says an open order cannot be reviewed yet and asks the service nothing', async () => {
    const { pay, orderReviews } = payWith([{ mine: null, theirs: null }]);
    const page = await open(pay, 'fiat_sent');
    expect(page.textContent).toContain('You can review this order once it is completed.');
    expect(orderReviews).not.toHaveBeenCalled();
  });

  it('needs an explanation for a bad review, leaves it once, then shows it instead of the form', async () => {
    const left = review({ rating: 'bad', explanation: 'TEST paid late' });
    const { pay, leaveReview } = payWith([
      { mine: null, theirs: null },
      { mine: left, theirs: null },
    ]);
    await open(pay, 'released');
    await act(async () => button('Bad').click());
    expect(button('Leave review').disabled).toBe(true);
    const area = host.querySelectorAll('textarea')[1]!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, 'TEST paid late');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Leave review').disabled).toBe(false);
    await act(async () => button('Leave review').click());
    await act(async () => undefined);
    expect(leaveReview).toHaveBeenCalledWith({ tradeId: TRADE, rating: 'bad', explanation: 'TEST paid late' });
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('Your review');
    expect(host.textContent).toContain('TEST paid late');
  });

  it('shows a reply, and keeps a replied-to review as it was', async () => {
    const { pay } = payWith([
      {
        mine: review({ reply: 'TEST thanks', repliedAt: '2026-10-24T05:30:00.000Z' }),
        theirs: review({ authorId: SELLER, subjectId: BUYER, reply: 'TEST noted', repliedAt: '2026-10-24T05:31:00.000Z' }),
      },
    ]);
    await open(pay, 'released');
    expect(host.textContent).toContain('Reply: TEST thanks');
    expect(host.textContent).toContain('This review has a reply, so it stays as it was replied to.');
    expect(host.querySelector('form')).toBeNull();
  });

  it('shows the other side’s visible review of you, or says there is none', async () => {
    const { pay } = payWith([{ mine: review({}), theirs: review({ authorId: SELLER, subjectId: BUYER, comment: 'TEST quick payer' }) }]);
    await open(pay, 'released');
    expect(host.textContent).toContain('Their review of you');
    expect(host.textContent).toContain('TEST quick payer');
    expect(host.querySelector('form[aria-label="Reply to their review"]')).not.toBeNull();
    expect(button('Edit review')).toBeTruthy();
    act(() => root?.unmount());
    root = null;
    const none = payWith([{ mine: review({}), theirs: null }]);
    await open(none.pay, 'released');
    expect(host.textContent).toContain('The other side has not reviewed you on this order.');
  });
});
