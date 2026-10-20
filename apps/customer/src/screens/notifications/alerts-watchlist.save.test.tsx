// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../data/favorites', async (original) => {
  const real = await original<typeof import('../../data/favorites')>();
  return {
    ...real,
    useFavorites: () => ({ favorites: ['BTC/USDT', 'ETH/USDT'], isFavorite: () => false, toggle: () => undefined }),
  };
});

import { WatchlistAlert } from './WatchlistAlert';

const markets = [
  { id: 'm1', label: 'BTC/USDT', quote: 'USDT' },
  { id: 'm2', label: 'ETH/USDT', quote: 'USDT' },
];
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!;

async function toReview(onSave: (intent: unknown) => Promise<'saved' | 'unknown' | 'refused'>) {
  await act(async () =>
    root.render(<WatchlistAlert markets={markets} userId="u1" room={5} blockedReason={null} busy={false} onSave={onSave as never} />),
  );
  await act(async () => button('Choose all').click());
  const price = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(price, '100');
    price.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
const reviewPanel = () => host.querySelector('[data-testid="alerts-watchlist-review"]');
const saveButton = () =>
  Array.from(host.querySelectorAll('button')).find(
    (b) => b.closest('[data-testid="alerts-watchlist-review"]') && b.textContent?.includes('Save'),
  )!;

describe('watchlist alert save', () => {
  it('names the markets that were chosen when the review opened', async () => {
    await toReview(async () => 'refused');
    expect(reviewPanel()?.textContent).toContain('BTC/USDT, ETH/USDT');
  });
  it.each(['saved', 'unknown'] as const)('ends the attempt on %s so the same batch cannot be sent twice', async (result) => {
    const onSave = vi.fn(async () => result);
    await toReview(onSave);
    await act(async () => saveButton().click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(reviewPanel()).toBeNull();
  });
  it('keeps the review open after a refusal so the person can change it', async () => {
    const onSave = vi.fn(async () => 'refused' as const);
    await toReview(onSave);
    await act(async () => saveButton().click());
    expect(reviewPanel()).not.toBeNull();
  });
});
