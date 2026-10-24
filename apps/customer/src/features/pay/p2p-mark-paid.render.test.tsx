// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderActions } from './P2P';
import type { PersonalPayApi } from './pay-api';
import type { Trade } from './schemas';

/** J-p2p-01 #7 (P-trade-orders-16): the buyer ticks what they did outside before the order says it was paid. */

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
  status: 'escrowed',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-23T20:00:00.000Z',
  escrowedAt: '2026-10-23T20:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
};

const byText = (text: string) => [...document.querySelectorAll('button')].filter((button) => button.textContent === text);

async function openMarkPaid(manageTrade: PersonalPayApi['manageTrade']) {
  const pay = { manageTrade } as unknown as PersonalPayApi;
  root = createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(<OrderActions trade={trade} pay={pay} userId={BUYER} reload={() => {}} locked={false} onOutcome={() => {}} />),
  );
  await act(async () => byText('Mark payment sent')[0]!.click());
  return document.querySelector('[data-testid="order-paid-checklist"]')!;
}

describe('Mark payment sent checklist (J-p2p-01 #7)', () => {
  it('keeps the confirm off until all three lines are ticked, then marks the order paid once', async () => {
    const manageTrade = vi.fn(async () => ({ ok: true as const, data: { ...trade, status: 'fiat_sent' as const } }));
    const checklist = await openMarkPaid(manageTrade as unknown as PersonalPayApi['manageTrade']);
    expect(checklist.textContent).toContain('I paid 9.2 EUR, the exact amount of this order');
    expect(checklist.textContent).toContain('I paid from an account in my own name');
    expect(checklist.textContent).toContain('I paid to the payment details shown on this order');
    expect(document.body.textContent).toContain('Tick each line to mark the payment sent.');

    const confirm = () => byText('Mark payment sent').at(-1)!;
    const boxes = [...checklist.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(3);
    expect(confirm().disabled).toBe(true);
    await act(async () => confirm().click());
    expect(manageTrade).not.toHaveBeenCalled();

    await act(async () => boxes[0]!.click());
    await act(async () => boxes[1]!.click());
    expect(confirm().disabled).toBe(true);
    await act(async () => boxes[2]!.click());
    expect(confirm().disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Tick each line to mark the payment sent.');

    await act(async () => confirm().click());
    expect(manageTrade).toHaveBeenCalledTimes(1);
    expect(manageTrade.mock.calls[0]![1]).toBe('markFiatSent');
  });

  it('is not offered to the seller', async () => {
    const pay = {} as unknown as PersonalPayApi;
    root = createRoot(host);
    const mounted = root;
    await act(async () =>
      mounted.render(<OrderActions trade={trade} pay={pay} userId={SELLER} reload={() => {}} locked={false} onOutcome={() => {}} />),
    );
    expect(byText('Mark payment sent')).toHaveLength(0);
  });
});
