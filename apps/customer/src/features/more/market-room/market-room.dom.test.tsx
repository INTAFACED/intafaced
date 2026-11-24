// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// /market on the kit (J-more-catalogue-02): the catalogue, its filters and doors, the listing detail, the purchase review
// and the buyer's purchases, with svc-market answered here. Every name a journey finds the room by is checked.

const ME = 'a0000000-0000-4000-8000-000000000001';
const VENDOR = 'b0000000-0000-4000-8000-000000000002';
const LISTING = 'c0000000-0000-4000-8000-000000000003';
const PURCHASE = 'd0000000-0000-4000-8000-000000000004';
const listing = {
  id: LISTING,
  vendorId: VENDOR,
  title: 'TEST strategy',
  description: 'TEST strategy listing.',
  offerType: 'subscription',
  assetId: 'USDT',
  price: '12.5',
  periodSeconds: 2_592_000,
  status: 'active',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  reviewState: 'approved',
};
const purchase = {
  id: PURCHASE,
  listingId: LISTING,
  buyerId: ME,
  vendorId: VENDOR,
  vendorUserId: VENDOR,
  assetId: 'USDT',
  price: '12.5',
  commissionBps: 100,
  status: 'held',
  ledgerTxId: 'e0000000-0000-4000-8000-000000000005',
  rejectionCode: null,
  createdAt: '2026-11-21T00:00:00.000Z',
  settledAt: null,
  accessUntil: null,
  periodSeconds: 2_592_000,
  flow: 'hold',
  refundWindowSeconds: 86_400,
  holdPostedAt: '2026-11-21T00:00:00.000Z',
  refundWindowEndsAt: '2099-11-22T00:00:00.000Z',
  refundRequestedAt: null,
  outcome: null,
  outcomeTxId: null,
  outcomeAt: null,
};
const answers: Record<string, unknown> = {
  listings: { ok: true, data: [listing] },
  commerceProgramme: {
    ok: true,
    data: { commissionBps: 100, commissionConfigured: true, purchaseHold: true, refundWindowSeconds: 86_400, refundPolicy: null },
  },
  myPurchases: { ok: true, data: [purchase] },
  listingCategories: { ok: true, data: { categories: ['data'] } },
  listed: {
    ok: true,
    data: [{ id: VENDOR, displayName: 'TEST seller', description: 'TEST seller.', createdAt: '2026-11-01T00:00:00.000Z' }],
  },
  profile: {
    ok: true,
    data: { id: VENDOR, displayName: 'TEST seller', description: 'TEST seller.', createdAt: '2026-11-01T00:00:00.000Z' },
  },
};
const sent: string[] = [];
const api = {
  query: async (_service: string, procedure: string) => {
    sent.push(procedure);
    return answers[procedure] ?? new Promise(() => undefined);
  },
  mutate: async (_service: string, procedure: string) => {
    sent.push(procedure);
    return new Promise(() => undefined);
  },
  canWrite: () => true,
  call(
    this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
    record: { kind: string; module: string; path: string; output: unknown },
    input?: unknown,
    opts?: unknown,
  ) {
    // tooling/codemod/call-records: a call by its record reaches this double's own query or mutate, as the client sends it.
    return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
      record.module,
      record.path,
      input,
      record.output,
      opts,
    ]);
  },
};
vi.mock('../../session', async (original) => {
  const real = await original<typeof import('../../session')>();
  const session = { api, userId: ME, session: null };
  return { ...real, useSession: () => session as never, useApi: () => api as never };
});
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const { MarketRoom } = await import('./MarketRoom');

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  sent.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const mount = async () => {
  await act(async () => {
    root.render(<MarketRoom />);
  });
  // Each read answers at once here: a few settled microtask turns let every one land.
  for (let turn = 0; turn < 5; turn++)
    await act(async () => {
      await Promise.resolve();
    });
};
const card = () => [...host.querySelectorAll('article')].find((node) => node.querySelector('h3')?.textContent === 'TEST strategy')!;
const buttonIn = (scope: ParentNode, name: RegExp) =>
  [...scope.querySelectorAll('button')].find((node) => name.test(node.getAttribute('aria-label') ?? node.textContent ?? ''))!;

it('opens /market on the catalogue template under the Market title, with its section links', async () => {
  await mount();
  expect(host.querySelector('h1')?.textContent).toBe('Market');
  expect(host.querySelector('[data-template="catalogue"]')).not.toBeNull();
  const links = [...host.querySelectorAll('nav.lt-tabs a')].map((a) => a.getAttribute('href'));
  expect(links).toEqual(['/market', '/market/mine', '/market/strategy']);
  expect(host.querySelector('nav.lt-tabs a[aria-current="page"]')?.getAttribute('href')).toBe('/market');
});

it('draws each listing as a card with its terms, its review state, View and Buy, and the filters a journey uses', async () => {
  await mount();
  const row = card();
  expect(row.textContent).toContain('12.5');
  expect(row.textContent).toContain('USDT');
  expect(row.querySelector('[data-review-state]')?.getAttribute('data-review-state')).toBe('approved');
  expect(row.querySelector('[role="group"][aria-label="Price"]')).not.toBeNull();
  expect(buttonIn(row, /^View /)).toBeTruthy();
  expect(buttonIn(row, /^Buy/).disabled).toBe(true); // already held by this buyer
  expect(host.querySelector('fieldset[role="radiogroup"] legend')?.textContent).toBe('Listing type');
  expect(host.querySelectorAll('fieldset[role="radiogroup"] input[type="radio"]')).toHaveLength(3);
  expect(host.querySelector('[data-testid="more-toolbar"]')).not.toBeNull();
  expect(host.querySelector('nav[aria-label="More in the Market"]')?.querySelectorAll('a')).toHaveLength(4);
  const labels = [...host.querySelectorAll('select')].map(
    (s) => s.getAttribute('aria-labelledby') && host.querySelector(`[id="${s.getAttribute('aria-labelledby')}"]`)?.textContent,
  );
  expect(labels).toEqual(expect.arrayContaining(['Category', 'Sort by']));
});

it('keeps the buyer’s purchases with the refund control and the named refund-policy blocker', async () => {
  await mount();
  const region = host.querySelector('[role="region"][aria-label="Your purchases"]')!;
  expect(region.querySelector('table')).not.toBeNull();
  const rowOf = [...region.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('TEST strategy'))!;
  expect(rowOf.querySelector('[role="note"][data-code="owner.decision"]')).not.toBeNull();
  expect(buttonIn(rowOf, /Ask for a refund/)).toBeTruthy();
  expect(rowOf.querySelector('time')?.getAttribute('datetime')).toBe(purchase.refundWindowEndsAt);
});

it('opens a listing in its sheet with the exact price, and Buy there stages the purchase review without sending it', async () => {
  answers.myPurchases = { ok: true, data: [] };
  await mount();
  await act(async () => buttonIn(card(), /^View /).click());
  const sheet = host.querySelector('dialog')!;
  expect(sheet.getAttribute('aria-label')).toBe('TEST strategy');
  expect(sheet.querySelector('[role="group"][aria-label="Price"]')?.textContent).toContain('USDT');
  await act(async () => buttonIn(sheet, /^Buy/).click());
  const review = [...host.querySelectorAll('dialog')].find((d) => d.textContent?.includes('Confirm purchase'));
  expect(review).toBeTruthy();
  expect(sent).not.toContain('purchase');
});
