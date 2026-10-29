// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomApi, RfqQuote } from '../rooms/api';
import type { RoomWriter } from '../rooms/write';
import { TEST_NOW, TEST_QUOTES } from './fixtures';
import { QuoteCard } from './QuoteCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

// Nothing is sent from these renders: an idle writer with no note, and no API.
const writer = {
  busy: false,
  outcome: { kind: 'idle' },
  note: { state: 'none' },
  run: async () => ({ kind: 'idle' }),
  resolve: () => undefined,
  dismiss: () => undefined,
  signedIn: true,
} as unknown as RoomWriter;

async function show(quote: RfqQuote) {
  await act(async () =>
    root.render(
      <QuoteCard
        api={{} as RoomApi}
        writer={writer}
        quote={quote}
        readAt={TEST_NOW}
        now={TEST_NOW}
        onCheck={async () => undefined}
        onQuote={() => undefined}
      />,
    ),
  );
}
const settleBy = () => host.querySelector('[data-testid="settle-by"]')?.textContent ?? null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the settlement window of an accepted quote (CB-otc-07)', () => {
  it('reads "Not set" when the desk publishes no window, and names the quote expiry it must settle by', async () => {
    await show({ ...TEST_QUOTES.bound, settleBy: TEST_QUOTES.bound.expiresAt, settleWindowMs: null });
    expect(settleBy()).toMatch(/^Not set: no deferral, settle by the quote expiry \d{2} [A-Z][a-z]{2}, \d{2}:\d{2}/);
  });

  it('names the settle-by time when the desk publishes one', async () => {
    await show({ ...TEST_QUOTES.bound, settleBy: '2026-10-17T10:00:50.000Z', settleWindowMs: 60_000 });
    expect(settleBy()).toMatch(/^Settle by \d{2} [A-Z][a-z]{2}, \d{2}:\d{2}/);
  });

  it('never invents a time when the settle-by time is missing', async () => {
    await show({ ...TEST_QUOTES.bound, settleBy: null, settleWindowMs: null });
    expect(settleBy()).toBe('Settle-by time unreadable: check status');
  });

  it('shows no settlement window before a quote is accepted or after it settles', async () => {
    await show({ ...TEST_QUOTES.open, settleBy: null });
    expect(settleBy()).toBeNull();
    await show({ ...TEST_QUOTES.settled, settleBy: null });
    expect(settleBy()).toBeNull();
  });
});
