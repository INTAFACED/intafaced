// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { P2POrder } from './P2POrder';
import type { PersonalPayApi } from './pay-api';
import type { Trade } from './schemas';

/** J-p2p-01 #5: the order page shows the ad's terms as they were when the order was placed. */

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
const BUYER = '22222222-2222-4222-8222-222222222222';
const trade = (terms: Trade['terms']): Trade => ({
  id: TRADE,
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: '11111111-1111-4111-8111-111111111111',
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
  ...(terms === undefined ? {} : { terms }),
});

/** Only what the order page reads: the trade, an empty action journal, and a contacts list that is not answered. */
function payWith(order: Trade): PersonalPayApi {
  return {
    viewer: BUYER,
    trade: async () => ({ ok: true, data: order }),
    contacts: () => new Promise(() => undefined),
    guard: { status: () => null, restore: async () => undefined, knownProof: () => null },
  } as unknown as PersonalPayApi;
}

async function terms(order: Trade) {
  root = createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <P2POrder pay={payWith(order)} tradeId={TRADE} userId={BUYER} renderActions={() => null} renderSecondary={() => null} />,
    ),
  );
  await act(async () => undefined);
  return host.querySelector('.p2p-order-facts')!;
}

describe('P2P order page terms (J-p2p-01 #5)', () => {
  it('shows the terms copied when the order was placed, line breaks kept', async () => {
    const facts = await terms(trade('TEST terms: pay from an account in your own name.\nNo third-party payments.'));
    expect(facts.textContent).toContain('Terms when placed');
    // The maker's own words: no interface language is claimed for them.
    expect(facts.querySelector('[data-testid="order-terms"]')!.getAttribute('lang')).toBe('und');
    expect(facts.querySelector('[data-testid="order-terms"]')!.textContent).toBe(
      'TEST terms: pay from an account in your own name.\nNo third-party payments.',
    );
  });

  it('says so when the ad had no terms, and when an older order never had them copied', async () => {
    for (const blank of ['', '  \n ']) {
      const facts = await terms(trade(blank));
      expect(facts.textContent).toContain('No terms supplied');
      expect(facts.querySelector('[data-testid="order-terms"]')).toBeNull();
      act(() => root?.unmount());
      root = null;
    }
    for (const value of [null, undefined]) {
      root = null;
      const facts = await terms(trade(value));
      expect(facts.textContent).toContain('The ad’s terms were not copied onto this order when it was placed.');
      expect(facts.querySelector('[data-testid="order-terms"]')).toBeNull();
      act(() => root?.unmount());
    }
    root = null;
  });
});
