// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vendor = '11111111-1111-4111-8111-111111111111';
const listing = {
  id: '22222222-2222-4222-8222-222222222222',
  vendorId: vendor,
  title: 'TEST strategy',
  description: 'TEST strategy listing',
  offerType: 'subscription',
  assetId: 'USDT',
  price: '12.50',
  periodSeconds: 3600,
  status: 'active',
  reviewState: 'approved',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const answers: Record<string, unknown> = {
  mine: { id: vendor, userId: 'u-test', displayName: 'TEST seller', description: 'TEST', status: 'approved' },
  myListings: [listing],
  commerceProgramme: {
    commissionBps: null,
    commissionConfigured: false,
    purchaseHold: true,
    refundWindowSeconds: null,
    refundPolicy: null,
  },
  myPurchases: [],
  refundRequests: [],
  slots: null,
};

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../session/session', () => {
  const api = {
    canWrite: () => true,
    call: async (record: { path: string }) => ({ ok: true, data: answers[record.path] }),
  };
  const session = { userId: 'u-test', api, session: {} };
  return { useApi: () => api, useSession: () => session };
});

const { MarketStrategyRoom } = await import('./MarketStrategyRoom');

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MarketStrategyRoom />));
  await vi.waitFor(() => expect(host.textContent).toContain('TEST strategy listing'));
  return host;
}

describe('/market/strategy, ready', () => {
  it('keeps the Market tabs, the own listings and the strategy form with every field', async () => {
    const host = await mount();
    expect(host.querySelector('h1')?.textContent).toBe('Strategy subscriptions');
    const tabs = [...host.querySelectorAll('nav a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]);
    expect(tabs).toEqual([
      ['Catalogue', '/market', null],
      ['My listings', '/market/mine', null],
      ['Publish a strategy subscription', '/market/strategy', 'page'],
    ]);
    expect(host.querySelector('[data-review-state="approved"]')).not.toBeNull();
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent);
    for (const label of ['Listing title', 'Listing description', 'Price asset ID', 'Price', 'Paid period in seconds'])
      expect(labels).toContain(label);
    expect(labels.some((l) => l?.startsWith('Offer type'))).toBe(false);
    const review = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Review listing');
    expect(review?.disabled).toBe(true);
    expect(host.querySelector('[data-code="owner.decision"]')).not.toBeNull();
  });
});
