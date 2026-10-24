// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepUpBegin } from '../account/security-step-up';
import { OrderActions } from './P2P';
import type { PersonalPayApi } from './pay-api';
import type { Trade } from './schemas';

/**
 * J-p2p-02 #5 (P-trade-orders-16, -07): the seller ticks five facts about the payment and confirms it's them before the
 * release goes out once; the review names the buyer by handle, never by account id, with what they get and the fee.
 */

const asked: StepUpBegin[] = [];
// Identity's passkey check stands in as one button: pressing it gives this release its single-use approval.
vi.mock('../money/StepUpConfirm', () => ({
  StepUpConfirm: ({ request, onApproved }: { request: () => StepUpBegin; onApproved: (id: string | null) => void }) => (
    <button
      type="button"
      onClick={() => {
        asked.push(request());
        onApproved('approval-1');
      }}
    >
      Use a passkey
    </button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  asked.length = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

const BUYER = '22222222-2222-4222-8222-222222222222';
const SELLER = '11111111-1111-4111-8111-111111111111';
const trade: Trade = {
  id: '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c',
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: SELLER,
  buyerId: BUYER,
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'EUR',
  fiatAmount: '9.2',
  price: '0.92',
  method: 'test-bank-transfer',
  status: 'fiat_sent',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-23T20:00:00.000Z',
  escrowedAt: '2026-10-23T20:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
  feeBps: 100,
  releasePreview: { fee: '0.1', netAmount: '9.9' },
};

const byText = (text: string) => [...document.querySelectorAll('button')].filter((button) => button.textContent === text);

async function openRelease(manageTrade: PersonalPayApi['manageTrade'], confirmedUntil: string | null = null) {
  const reputation = vi.fn(async () => ({
    ok: true as const,
    data: { userId: BUYER, handle: 'TESTbuyer', profile: { status: 'present' } },
  }));
  const releaseStepUpWindow = vi.fn(async () => ({ ok: true as const, data: { confirmedUntil } }));
  const pay = { manageTrade, reputation, releaseStepUpWindow } as unknown as PersonalPayApi;
  root = createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(<OrderActions trade={trade} pay={pay} userId={SELLER} reload={() => {}} locked={false} onOutcome={() => {}} />),
  );
  await act(async () => byText('Release to the buyer')[0]!.click());
  return document.querySelector('[data-testid="order-release-review"]')!;
}

describe('Release with the pre-release checklist and a fresh check (J-p2p-02 #5)', () => {
  it('names the buyer by handle with what they get and the fee, and releases once only after five ticks and the check', async () => {
    const manageTrade = vi.fn(async (..._args: unknown[]) => ({
      ok: true as const,
      data: { ...trade, status: 'released' as const, resolution: 'released' as const },
    }));
    const review = await openRelease(manageTrade as unknown as PersonalPayApi['manageTrade']);
    expect(review.textContent).toContain('@TESTbuyer');
    expect(review.textContent).not.toContain(BUYER);
    expect(review.textContent).toContain('The buyer gets');
    expect(review.textContent).toContain('9.9');
    expect(review.textContent).toContain('0.1');

    const checklist = review.querySelector('[data-testid="order-release-checklist"]')!;
    expect(checklist.textContent).toContain('I received 9.2 EUR, the exact amount of this order');
    const boxes = [...checklist.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(5);
    const confirm = () => byText('Release to the buyer').at(-1)!;
    expect(confirm().disabled).toBe(true);
    expect(document.body.textContent).toContain('Tick each line to release.');

    for (const box of boxes) await act(async () => box.click());
    // Ticked but not yet confirmed: still off, and it says why.
    expect(confirm().disabled).toBe(true);
    expect(document.body.textContent).toContain('Confirm it’s you to release.');
    await act(async () => byText('Use a passkey')[0]!.click());
    expect(asked).toEqual([
      { scope: 'p2p.step_up.trades.confirmReceived', purpose: 'trades.confirmReceived', target: trade.id, fields: { tradeId: trade.id } },
    ]);
    expect(confirm().disabled).toBe(false);

    await act(async () => confirm().click());
    expect(manageTrade).toHaveBeenCalledTimes(1);
    expect(manageTrade.mock.calls[0]![1]).toBe('confirmReceived');
    expect(manageTrade.mock.calls[0]![4]).toBe('approval-1');
  });

  it('needs no new check while this session’s last release confirmation still covers it', async () => {
    const manageTrade = vi.fn(async (..._args: unknown[]) => ({
      ok: true as const,
      data: { ...trade, status: 'released' as const, resolution: 'released' as const },
    }));
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    const review = await openRelease(manageTrade as unknown as PersonalPayApi['manageTrade'], until);
    expect(review.querySelector('[data-testid="order-release-covered"]')?.textContent).toContain(
      'You confirmed it’s you here, so this release needs no new check until',
    );
    expect(byText('Use a passkey')).toHaveLength(0);
    for (const box of review.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => box.click());
    await act(async () => byText('Release to the buyer').at(-1)!.click());
    expect(manageTrade).toHaveBeenCalledTimes(1);
    expect(manageTrade.mock.calls[0]![4]).toBeUndefined();
  });

  it('asks for a new check after a refused release', async () => {
    const manageTrade = vi.fn(async (..._args: unknown[]) => ({
      ok: false as const,
      reason: 'forbidden' as const,
      message: 'auth.step_up_failed: confirm this release again',
      code: 'auth.step_up_failed',
    }));
    const review = await openRelease(manageTrade as unknown as PersonalPayApi['manageTrade']);
    for (const box of review.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => box.click());
    await act(async () => byText('Use a passkey')[0]!.click());
    await act(async () => byText('Release to the buyer').at(-1)!.click());
    expect(manageTrade).toHaveBeenCalledTimes(1);
    expect(byText('Use a passkey')).toHaveLength(1);
    expect(byText('Release to the buyer').at(-1)!.disabled).toBe(true);
  });

  it('is not offered to the buyer', async () => {
    const pay = {} as unknown as PersonalPayApi;
    root = createRoot(host);
    const mounted = root;
    await act(async () =>
      mounted.render(<OrderActions trade={trade} pay={pay} userId={BUYER} reload={() => {}} locked={false} onOutcome={() => {}} />),
    );
    expect(byText('Release to the buyer')).toHaveLength(0);
  });
});
