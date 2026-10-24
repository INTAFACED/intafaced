// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonalPayApi } from './pay-api';
import type { Offer, OfferPage } from './schemas';
import { BoardPages, OfferPrice } from './P2POffers';
import { p2pReturn } from './p2p-return';

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

const offer = (n: number, extra: Partial<Offer> = {}): Offer => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  makerId: 'maker',
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'EUR',
  priceType: 'fixed',
  price: '0.92',
  minAmount: '10',
  maxAmount: '50',
  remainingAmount: '200',
  methods: ['test-bank-transfer'],
  terms: '',
  status: 'active',
  createdAt: '2026-10-23T00:00:00.000Z',
  ...extra,
});

async function show(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}

describe('P2P board (P-trade-orders-01)', () => {
  it('continues the same query with the cursor, shows each offer once, and says when every offer is shown', async () => {
    const asked: unknown[] = [];
    const pay = {
      offerPage: async (input: unknown) => {
        asked.push(input);
        // The next page repeats the last row (an offer that moved), plus one new one.
        return { ok: true, data: { offers: [offer(2), offer(3)], nextCursor: null } } as const;
      },
    } as unknown as PersonalPayApi;
    const first: OfferPage = { offers: [offer(1), offer(2)], nextCursor: 'cursor-1' };
    const query = { fiatCurrency: 'EUR', fiatAmount: '20', sort: 'price_desc' as const, makerId: 'maker' };
    await show(
      <BoardPages pay={pay} first={first} query={query}>
        {(rows) => (
          <ul>
            {rows.map((row) => (
              <li key={row.id}>{row.id}</li>
            ))}
          </ul>
        )}
      </BoardPages>,
    );
    expect(host.querySelectorAll('li')).toHaveLength(2);
    const more = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Show more offers')!;
    await act(async () => more.click());
    expect(asked).toEqual([{ ...query, limit: 50, cursor: 'cursor-1' }]);
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual([offer(1).id, offer(2).id, offer(3).id]);
    expect(host.textContent).toContain('That is every open offer for these filters.');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Show more offers')).toBe(false);
  });

  it('a floating ad with no market reference says it needs a market feed', async () => {
    await show(<OfferPrice offer={offer(1, { priceType: 'float', price: '1.01', referencePrice: null })} />);
    expect(host.querySelector('[data-testid="p2p-offer-needs-feed"]')?.textContent).toBe(
      'Needs a market feed: no EUR / USDT reference price is published, so this ad cannot be priced or taken.',
    );
  });

  it('a floating ad with a reference shows it', async () => {
    await show(<OfferPrice offer={offer(1, { priceType: 'float', price: '1.01', referencePrice: '0.93' })} />);
    expect(host.querySelector('[data-testid="p2p-offer-needs-feed"]')).toBeNull();
    expect(host.textContent).toContain('Reference price');
  });

  it('the board keeps its maker, method, amount and sort in the address, and drops anything malformed', () => {
    const maker = '00000000-0000-4000-8000-000000000009';
    expect(p2pReturn(`/p2p?makerId=${maker}&methodId=test-bank-transfer&fiatAmount=20.5&sort=price_desc`).href).toBe(
      `/p2p?makerId=${maker}&methodId=test-bank-transfer&fiatAmount=20.5&sort=price_desc`,
    );
    expect(p2pReturn('/p2p?makerId=nope&methodId=a%20b&fiatAmount=-1&sort=newest').href).toBe('/p2p');
  });
});
