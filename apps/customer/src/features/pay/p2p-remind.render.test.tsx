// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemindSeller, SellerReminder } from './p2p-remind';
import type { PersonalPayApi } from './pay-api';
import type { Trade, TradeReminders } from './schemas';

/** J-p2p-02 #2 (P-trade-orders-15): the buyer reminds the seller after the wait; the seller sees the reminder. */

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

const trade = (reminders: TradeReminders): Trade => ({
  id: '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c',
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: '11111111-1111-4111-8111-111111111111',
  buyerId: '22222222-2222-4222-8222-222222222222',
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'EUR',
  fiatAmount: '9.2',
  price: '0.92',
  method: 'test-bank-transfer',
  status: 'fiat_sent',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-24T12:00:00.000Z',
  escrowedAt: '2026-10-24T12:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
  reminders,
});

async function render(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
  return host;
}
const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Remind the seller')!;

describe('Remind the seller (J-p2p-02 #2)', () => {
  it('stays off before the wait and says when it opens', async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    await render(
      <RemindSeller trade={trade({ count: 0, lastAt: null, nextAt: later, max: 3 })} pay={{} as PersonalPayApi} onSent={() => {}} />,
    );
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('You can remind the seller from');
  });

  it('sends one reminder once the wait has passed', async () => {
    const remindSeller = vi.fn(async () => ({
      ok: true as const,
      data: { count: 1, lastAt: new Date().toISOString(), nextAt: null, max: 3 },
    }));
    const onSent = vi.fn();
    const past = new Date(Date.now() - 1_000).toISOString();
    await render(
      <RemindSeller
        trade={trade({ count: 0, lastAt: null, nextAt: past, max: 3 })}
        pay={{ remindSeller } as unknown as PersonalPayApi}
        onSent={onSent}
      />,
    );
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(remindSeller).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('says a refused reminder in its own words with the time it may go, and keeps the button off while it sends', async () => {
    const until = '2026-10-24T13:00:00.000Z';
    let answer!: (value: unknown) => void;
    const remindSeller = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const past = new Date(Date.now() - 1_000).toISOString();
    await render(
      <RemindSeller
        trade={trade({ count: 0, lastAt: null, nextAt: past, max: 3 })}
        pay={{ remindSeller } as unknown as PersonalPayApi}
        onSent={() => {}}
      />,
    );
    await act(async () => button().click());
    expect(button().disabled).toBe(true);
    await act(async () =>
      answer({ ok: false, reason: 'error', message: 'service text', code: 'p2p.remind_too_early', status: 409, p2pLimit: { until } }),
    );
    expect(host.textContent).toContain('You can remind the seller from');
    expect(host.textContent).not.toContain('service text');
  });

  it('names the blocker when the order carries no reminders', async () => {
    await render(
      <RemindSeller
        trade={{ ...trade({ count: 0, lastAt: null, nextAt: null, max: 3 }), reminders: undefined }}
        pay={{} as PersonalPayApi}
        onSent={() => {}}
      />,
    );
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('This page could not read this order’s reminders.');
  });

  it('says the count is spent and points to a dispute, and says when reminders are switched off', async () => {
    await render(
      <RemindSeller
        trade={trade({ count: 3, lastAt: '2026-10-24T12:10:00.000Z', nextAt: null, max: 3 })}
        pay={{} as PersonalPayApi}
        onSent={() => {}}
      />,
    );
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('You have sent this order’s 3 reminders');
    expect(host.textContent).toContain('You reminded the seller at');
    act(() => root?.unmount());
    await render(
      <RemindSeller trade={trade({ count: 0, lastAt: null, nextAt: null, max: null })} pay={{} as PersonalPayApi} onSent={() => {}} />,
    );
    expect(host.textContent).toContain('Reminders are switched off on this service');
  });

  it('shows the seller the buyer’s reminder, and nothing before one', async () => {
    await render(<SellerReminder reminders={{ count: 1, lastAt: '2026-10-24T12:10:00.000Z', nextAt: null, max: 3 }} />);
    expect(host.querySelector('[data-testid="order-reminder"]')!.textContent).toContain('The buyer reminded you to release at');
    act(() => root?.unmount());
    await render(<SellerReminder reminders={{ count: 0, lastAt: null, nextAt: null, max: 3 }} />);
    expect(host.querySelector('[data-testid="order-reminder"]')).toBeNull();
  });
});
