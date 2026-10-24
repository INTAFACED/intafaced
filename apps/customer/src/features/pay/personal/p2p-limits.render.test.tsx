// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../../shared/api';
import { TakeFailureNote } from './TakeOffer';
import { takeFailureKind, takeRefusalIsDefinite } from './p2p-model';

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

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
const refused = (code: string, p2pLimit?: Failure['p2pLimit']): Failure => ({
  ok: false,
  reason: 'error',
  message: 'service text',
  code,
  status: 409,
  ...(p2pLimit ? { p2pLimit } : {}),
});

async function note(failure: Failure) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<TakeFailureNote failure={failure} context="quote" />));
  return host.querySelector<HTMLElement>('[data-testid="take-failure"]')!;
}

const TRADE = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';

describe('take limits in plain words (P-trade-orders-03, P-disputes-security-15)', () => {
  it('names the order cap, the soonest deadline and links each ongoing order', async () => {
    const shown = await note(refused('p2p.active_order_cap', { until: '2026-10-23T18:04:05.000Z', cap: '2', openTradeIds: [TRADE] }));
    expect(shown.dataset.kind).toBe('orderCap');
    expect(shown.textContent).toContain('You already have 2 ongoing orders');
    expect(shown.textContent).toContain('The soonest of them reaches its deadline at');
    const link = shown.querySelector<HTMLAnchorElement>('[data-testid="take-open-order"]')!;
    expect(link.getAttribute('href')).toBe(`/p2p/orders/${TRADE}`);
    expect(link.textContent).toBe('Order 0b6f1c1e');
    expect(shown.textContent).not.toContain('service text');
  });

  it('gives the pair bounds and says the limit has no end time', async () => {
    const shown = await note(refused('p2p.pair_limit_exceeded', { until: null, min: '10', max: '500', currency: 'EUR' }));
    expect(shown.textContent).toContain('between 10 and 500 EUR');
    expect(shown.textContent).toContain('no end time');
  });

  it('gives what is left today and when the daily allowance starts again, with the way to raise it', async () => {
    const shown = await note(
      refused('p2p.verification_daily_limit', { until: '2026-10-24T00:00:00.000Z', remaining: '11.6', currency: 'EUR' }),
    );
    expect(shown.dataset.kind).toBe('verificationLimit');
    expect(shown.textContent).toContain('11.6 EUR is left today');
    expect(shown.textContent).toContain('starts again at');
    expect(shown.querySelector('a[href="/verification"]')?.textContent).toBe('Raise your verification level');
  });

  it('names a retired payment method with the operator’s reason and no end time', async () => {
    const shown = await note(refused('p2p.method_delisted', { until: null, reason: 'provider_withdrawn' }));
    expect(shown.dataset.kind).toBe('methodRetired');
    expect(shown.textContent).toContain('retired because the payment provider withdrew it');
    expect(shown.textContent).toContain('no end time');
    expect(shown.textContent).not.toContain('service text');
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.method_delisted', status: 400 })).toBe(true);
    root?.unmount();
    expect((await note(refused('p2p.method_delisted'))).textContent).toContain('has been retired and no longer takes orders');
  });

  it('says buying is paused after cancelled orders, until when, and that selling is not', async () => {
    const shown = await note(refused('p2p.buying_restricted', { until: '2026-10-24T09:00:00.000Z', cap: '3', windowHours: '24' }));
    expect(shown.dataset.kind).toBe('buyingPaused');
    expect(shown.textContent).toContain(
      'You cancelled 3 orders, or let their payment time run out, within 24 hours, so buying is paused until',
    );
    expect(shown.textContent).toContain('Selling is not paused.');
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.buying_restricted', status: 409 })).toBe(true);
  });

  it('asks for the take’s fresh confirmation in words, links Security, and counts it as nothing placed', async () => {
    const shown = await note(refused('auth.step_up_required'));
    expect(shown.dataset.kind).toBe('stepUp');
    expect(shown.textContent).toContain('Confirm this order with your authenticator app or a passkey before it is placed.');
    expect(shown.querySelector<HTMLAnchorElement>('a[href="/uc/safe"]')!.textContent).toBe(
      'Set up an authenticator app or a passkey in Security',
    );
    root?.unmount();
    expect((await note(refused('auth.step_up_expired'))).textContent).toContain('Your last confirmation has ended.');
    root?.unmount();
    const failed = await note(refused('auth.step_up_failed'));
    expect(failed.dataset.kind).toBe('stepUpFailed');
    expect(failed.textContent).not.toContain('service text');
    for (const code of ['auth.step_up_required', 'auth.step_up_expired', 'auth.step_up_failed']) {
      expect(takeRefusalIsDefinite({ reason: 'forbidden', code, status: 403 })).toBe(true);
    }
    root?.unmount();
    // A confirmation that could not be checked does not ask for a new passkey: one would fail the same way.
    const unchecked = await note(refused('p2p.step_up_unverifiable'));
    expect(unchecked.dataset.kind).toBe('stepUpUnchecked');
    expect(unchecked.textContent).toContain('Your confirmation could not be checked just now, so nothing was placed.');
    expect(unchecked.querySelector('a[href="/uc/safe"]')).toBeNull();
    expect(takeRefusalIsDefinite({ reason: 'error', code: 'p2p.step_up_unverifiable', status: 412 })).toBe(true);
  });

  it('falls back to the plain sentence when the figures are missing', async () => {
    const shown = await note(refused('p2p.active_order_cap'));
    expect(shown.textContent).toContain('You already have the most ongoing orders');
    expect(shown.querySelector('[data-testid="take-open-order"]')).toBeNull();
  });

  it('counts every limit as a refusal before anything was reserved', () => {
    for (const code of ['p2p.active_order_cap', 'p2p.pair_limit_exceeded', 'p2p.config_unset', 'p2p.verification_daily_limit']) {
      expect(takeRefusalIsDefinite({ reason: 'error', code, status: 409 })).toBe(true);
    }
    expect(takeFailureKind({ reason: 'error', code: 'p2p.config_unset' })).toBe('limitsUnset');
  });
});
