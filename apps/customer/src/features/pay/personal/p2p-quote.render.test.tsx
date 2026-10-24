// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuoteCountdown } from './TakeOffer';
import { takeFailureKind, takeRefusalIsDefinite } from './p2p-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

describe('locked take quote (P-trade-orders-06)', () => {
  it('counts down to the quote’s end, then turns placing off and offers a new quote', async () => {
    const start = Date.parse('2026-10-23T15:00:00Z');
    vi.setSystemTime(start);
    const renewed: number[] = [];
    root = createRoot(host);
    const mounted = root;
    await act(async () =>
      mounted.render(
        <QuoteCountdown endsAt={new Date(start + 120_000).toISOString()} renewing={false} onRenew={() => renewed.push(1)}>
          {(ended) => <button data-testid="place" disabled={ended} />}
        </QuoteCountdown>,
      ),
    );
    const timer = () => host.querySelector<HTMLElement>('[data-testid="take-quote-countdown"]')!;
    const place = () => host.querySelector<HTMLButtonElement>('[data-testid="place"]')!;
    expect(timer().textContent).toContain('held for 2:00');
    expect(place().disabled).toBe(false);
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(timer().textContent).toContain('held for 0:59');
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(timer().getAttribute('data-ended')).toBe('true');
    expect(timer().textContent).toContain('This quote ended at');
    expect(place().disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="take-quote-renew"]')!.click());
    expect(renewed).toEqual([1]);
  });

  it('an ended or moved quote is a definite refusal with its own words', () => {
    for (const code of ['p2p.quote_expired', 'p2p.quote_not_found'])
      expect([
        takeFailureKind({ reason: 'conflict', code, status: 409 }),
        takeRefusalIsDefinite({ reason: 'conflict', code, status: 409 }),
      ]).toEqual(['quoteExpired', true]);
    for (const code of ['p2p.quote_changed', 'p2p.quote_mismatch'])
      expect([
        takeFailureKind({ reason: 'conflict', code, status: 409 }),
        takeRefusalIsDefinite({ reason: 'conflict', code, status: 409 }),
      ]).toEqual(['quoteChanged', true]);
  });
});
