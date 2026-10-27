import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const dir = process.env.MORE_ORIGINAL_EVIDENCE || '/tmp/intafaced-more-original';
mkdirSync(dir, { recursive: true });
const catalogs = JSON.parse(readFileSync(process.env.MARKET_REVIEW_CATALOGS, 'utf8'));
const text = (locale, key) => catalogs[locale]['market.' + key];
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222',
  listingId = '33333333-3333-4333-8333-333333333333',
  originalId = '44444444-4444-4444-8444-444444444444',
  ledgerId = '55555555-5555-4555-8555-555555555555',
  vendorId = '66666666-6666-4666-8666-666666666666',
  sellerId = '77777777-7777-4777-8777-777777777777',
  returnedId = '88888888-8888-4888-8888-888888888888';
const at = '2026-10-09T10:00:00.000Z';
const rawTitle = 'Original title <owner> / no translation',
  rawDescription = 'Original user description <owner> / no translation';
const provider = 'Original provider prose <owner> / no translation. ' + text('en', 'the.listing.terms.changed.reload.the.catalogue');
const exactPrice = '0.000000000000000001',
  asset = 'LONG_NATIVE_ASSET_IDENTIFIER_123';
const listing = (extra = {}) => ({
  id: listingId,
  vendorId,
  title: rawTitle,
  description: rawDescription,
  offerType: 'subscription',
  assetId: asset,
  price: exactPrice,
  periodSeconds: 3600,
  status: 'active',
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const purchase = (extra = {}) => ({
  id: originalId,
  listingId,
  buyerId: owner,
  vendorId,
  vendorUserId: sellerId,
  assetId: asset,
  price: exactPrice,
  commissionBps: 500,
  status: 'settled',
  ledgerTxId: ledgerId,
  rejectionCode: null,
  createdAt: at,
  settledAt: at,
  accessUntil: '2026-10-10T10:00:00.000Z',
  ...extra,
});
const vendor = (extra = {}) => ({
  id: vendorId,
  userId: owner,
  displayName: rawTitle,
  description: rawDescription,
  status: 'approved',
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const modes = {
  purchase: {
    path: '/market',
    review: 'review.purchase',
    confirm: 'confirm.purchase',
    success: 'purchase.outcome.received.read.its.settlement.status',
    procedure: 'purchase',
    raw: rawTitle,
  },
  application: {
    path: '/market/mine',
    review: 'review.seller.application',
    confirm: 'submit.application',
    success: 'application.received',
    procedure: 'applyAsVendor',
    raw: rawTitle,
  },
  release: {
    path: '/market/mine',
    review: 'release.listing.slot',
    confirm: 'release.slot',
    success: 'slot.release.confirmed',
    procedure: 'releaseSlot',
    raw: listingId,
  },
  listing: {
    path: '/market/mine',
    review: 'review.listing',
    confirm: 'publish.listing',
    success: 'listing.published',
    procedure: 'createListing',
    raw: rawTitle,
  },
  strategy: {
    path: '/market/strategy',
    review: 'review.listing',
    confirm: 'publish.listing',
    success: 'listing.published',
    procedure: 'createStrategyListing',
    raw: rawTitle,
  },
  archive: {
    path: '/market/mine',
    review: 'archive.listing',
    confirm: 'archive.listing',
    success: 'listing.archived',
    procedure: 'archiveListing',
    raw: rawTitle,
  },
  cancel: {
    path: '/market',
    review: 'cancel.subscription.access',
    confirm: 'cancel.access',
    success: 'access.cancellation.recorded',
    procedure: 'cancelSubscription',
    raw: listingId,
  },
};
const markerKey = 'intafaced:more:pending:' + owner + ':market';
const results = [];
async function network(context, mode = 'purchase', outcome = 'success', overrides = {}) {
  const calls = { reads: [], writes: [], journals: [], errors: [] };
  const observeErrors = (page) => page.on('pageerror', (e) => calls.errors.push(e.message));
  for (const page of context.pages()) observeErrors(page);
  context.on('page', observeErrors);
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: overrides.identity?.() || owner,
        accessToken: 'isolated-market-token',
        refreshToken: 'isolated-market-refresh',
        expiresAt: '2027-10-09T10:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    const call = { procedure, input };
    (request.method() === 'GET' ? calls.reads : calls.writes).push(call);
    if (request.method() !== 'GET')
      calls.journals.push(
        await request
          .frame()
          .page()
          .evaluate((key) => localStorage.getItem(key), markerKey),
      );
    if (overrides[procedure]) return overrides[procedure](route, input, reply);
    if (request.method() === 'GET') {
      if (procedure === 'commerceProgramme') return reply({ commissionBps: 500, commissionConfigured: true });
      if (procedure === 'listings') return reply([listing()]);
      if (procedure === 'myListings') return reply(mode === 'application' ? [] : [listing()]);
      if (procedure === 'mine') return reply(mode === 'application' ? null : vendor());
      if (procedure === 'myPurchases') return reply(mode === 'cancel' ? [purchase()] : []);
      if (procedure === 'slots')
        return reply({
          vendorId,
          status: 'approved',
          tier: 'tier-original',
          capacity: 1,
          held: 1,
          usable: 1,
          slots: [{ id: returnedId, vendorId, ref: listingId, claimedAt: at, releasedAt: null }],
        });
      if (procedure === 'webauthn.list') return reply([]);
      return route.fulfill({ status: 503, json: { message: 'Isolated read unavailable' } });
    }
    expect(procedure).toBe(modes[mode].procedure);
    if (outcome === 'unknown')
      return mode === 'purchase'
        ? route.fulfill({ status: 412, json: { error: { message: provider, data: { cause: { code: 'market.fixture_unknown' } } } } })
        : route.abort('failed');
    if (outcome === 'refused')
      return route.fulfill({
        status: mode === 'purchase' ? 403 : 412,
        json: { error: { message: provider, data: { code: 'PRECONDITION_FAILED', cause: { code: 'market.fixture_refusal' } } } },
      });
    if (mode === 'purchase') return reply(purchase({ id: input.purchaseId }));
    if (mode === 'application') return reply(vendor({ displayName: input.displayName, description: input.description, status: 'applied' }));
    if (mode === 'release') return reply({ released: true });
    if (mode === 'archive') return reply(listing({ status: 'archived' }));
    if (mode === 'cancel') return reply({ listingId: input.listingId, buyerId: owner, cancelledAt: at });
    return reply(
      listing({
        ...input,
        id: returnedId,
        offerType: mode === 'strategy' ? 'subscription' : input.offerType,
        periodSeconds: input.periodSeconds ?? null,
      }),
    );
  });
  return calls;
}
async function login(page, path) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-market');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function language(view, page, locale) {
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}
async function stage(page, mode) {
  if (mode === 'application') {
    await page.getByLabel(text('en', 'seller.display.name'), { exact: true }).fill(rawTitle);
    await page.getByLabel(text('en', 'seller.description'), { exact: true }).fill(rawDescription);
    await page.getByRole('button', { name: text('en', 'review.application'), exact: true }).click();
  } else if (mode === 'listing' || mode === 'strategy') {
    await page.getByLabel(text('en', 'listing.title'), { exact: true }).fill(rawTitle);
    await page.getByLabel(text('en', 'listing.description'), { exact: true }).fill(rawDescription);
    await page.getByLabel(text('en', 'price.asset.id'), { exact: true }).fill(asset);
    await page.getByRole('textbox', { name: text('en', 'price'), exact: true }).fill(exactPrice);
    if (mode === 'listing') await page.getByRole('combobox', { name: /^Offer type/ }).selectOption('subscription');
    await page.getByLabel(text('en', 'paid.period.in.seconds'), { exact: true }).fill('3600');
    await page.getByRole('button', { name: text('en', 'review.listing'), exact: true }).click();
  } else if (mode === 'purchase')
    await page.getByRole('button', { name: text('en', 'buy.2').replace('{value1}', rawTitle), exact: true }).click();
  else if (mode === 'cancel') {
    await page.getByRole('button', { name: 'Inspect purchase', exact: true }).click();
    await page.getByRole('button', { name: text('en', 'cancel.access'), exact: true }).click();
  } else await page.getByRole('button', { name: text('en', mode === 'release' ? 'release.2' : 'archive'), exact: true }).click();
}
function expected(mode, input) {
  if (mode === 'purchase') return { listingId, purchaseId: input.purchaseId };
  if (mode === 'application') return { displayName: rawTitle, description: rawDescription };
  if (mode === 'release') return { ref: listingId };
  if (mode === 'archive' || mode === 'cancel') return { listingId };
  return {
    title: rawTitle,
    description: rawDescription,
    assetId: asset,
    price: exactPrice,
    periodSeconds: 3600,
    ...(mode === 'listing' ? { offerType: 'subscription' } : {}),
  };
}

const observations = [];
test.beforeEach(async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  observations.push({ name: info.title, pageErrors: errors });
});
test.afterEach(async ({}, info) => {
  observations.at(-1).status = info.status;
  writeFileSync(dir + '/native-summary.json', JSON.stringify(observations, null, 2) + '\n');
});
const buyButton = (page, locale = 'en') =>
  page.getByRole('button', { name: text(locale, 'buy.2').replace('{value1}', rawTitle), exact: true });
const originalRaw = JSON.stringify({ id: originalId, title: text('en', 'review.purchase'), reference: originalId });
async function seed(page, raw = originalRaw) {
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: markerKey, raw });
}
async function retain(locator, name) {
  await expect(locator).toBeVisible();
  await locator.evaluate((node, name) => {
    const props = Object.keys(node).find((key) => key.startsWith('__reactProps$'));
    if (!props || typeof node[props].onClick !== 'function') throw new Error('Mounted handler unavailable');
    window[name] = node[props].onClick;
  }, name);
}
async function faultRead(page) {
  await page.evaluate((key) => {
    window.__moreGetter = Storage.prototype.getItem;
    window.__moreSetter = Storage.prototype.setItem;
    window.__moreRemover = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (name) {
      if (this === localStorage && name === key) throw new DOMException('Isolated getItem-only failure', 'SecurityError');
      return window.__moreGetter.call(this, name);
    };
  }, markerKey);
}
async function rawSaved(page) {
  return page.evaluate((key) => (window.__moreGetter ?? Storage.prototype.getItem).call(localStorage, key), markerKey);
}
test('preserved getItem-only fault keeps original bytes and refuses ordinary Buy admission', async ({ page, context }) => {
  const calls = await network(context, 'purchase', 'success', { myPurchases: (_route, _input, reply) => reply([purchase()]) });
  await seed(page);
  await login(page, '/market');
  await expect(buyButton(page)).toBeDisabled();
  await faultRead(page);
  await page.getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect(page.getByText('Recovery storage cannot be read', { exact: true })).toBeVisible();
  await expect(buyButton(page)).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await rawSaved(page)).toBe(originalRaw);
  expect(calls.writes).toEqual([]);
  expect(
    await page.evaluate(() => Storage.prototype.setItem === window.__moreSetter && Storage.prototype.removeItem === window.__moreRemover),
  ).toBe(true);
  await page.evaluate(() => {
    Storage.prototype.getItem = window.__moreGetter;
  });
  await page.getByRole('button', { name: 'Retry recovery storage', exact: true }).click();
  await expect(page.getByTestId('failure').filter({ hasText: originalId })).toBeVisible();
  await page.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect.poll(() => rawSaved(page)).toBeNull();
  await expect(buyButton(page)).toBeEnabled();
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect.poll(() => calls.writes.length).toBe(1);
  writeFileSync(
    dir + '/PRESERVED-RED-ACCEPTANCE.json',
    JSON.stringify(
      {
        before: originalRaw,
        duringReadFault: originalRaw,
        originalBytesSurvive: true,
        otherStorageMethodsUnchanged: true,
        writesBeforeRecovery: 0,
        currentPurchasePositive: 1,
        qualification: 'Same preserved key-specific fault/raw assertion; fixed disabled Buy is ordinary pointer UI, no forced Confirm.',
      },
      null,
      2,
    ) + '\n',
  );
});
test('current service response survives cleanup throw; local retry sends zero API', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await page.evaluate((key) => {
    window.__moreRemover = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (this === localStorage && name === key) throw new Error('Isolated cleanup refusal');
      return window.__moreRemover.call(this, name);
    };
  }, markerKey);
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect(page.getByText(text('en', 'purchase.outcome.received.read.its.settlement.status'), { exact: true })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry local cleanup', exact: true });
  await expect(retry).toBeVisible();
  const raw = await rawSaved(page);
  expect(JSON.parse(raw).reference).toBe(calls.writes[0].input.purchaseId);
  await retry.click();
  expect(await rawSaved(page)).toBe(raw);
  await expect(buyButton(page)).toBeDisabled();
  await page.waitForTimeout(50);
  const count = calls.reads.length + calls.writes.length;
  await page.evaluate(() => {
    Storage.prototype.removeItem = window.__moreRemover;
  });
  await retry.click();
  await expect.poll(() => rawSaved(page)).toBeNull();
  expect(calls.reads.length + calls.writes.length).toBe(count);
  await expect(buyButton(page)).toBeEnabled();
  expect(calls.errors).toEqual([]);
  expect(calls.writes).toHaveLength(1);
});
test('retained review A Confirm and Back cannot dispatch or dismiss current B', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await stage(page, 'purchase');
  const dialog = page.getByRole('dialog');
  await retain(dialog.getByRole('button', { name: text('en', 'confirm.purchase'), exact: true }), '__moreAConfirm');
  await retain(dialog.getByRole('button', { name: 'Back', exact: true }), '__moreABack');
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await stage(page, 'purchase');
  await page.evaluate(() => {
    window.__moreAConfirm();
    window.__moreABack();
  });
  await expect(dialog).toBeVisible();
  expect(calls.writes).toEqual([]);
  await dialog.getByRole('button', { name: text('en', 'confirm.purchase'), exact: true }).click();
  await expect.poll(() => calls.writes.length).toBe(1);
});
test('retained Check A cannot retarget later B with the same purchase reference', async ({ page, context }) => {
  const calls = await network(context, 'purchase', 'success', { myPurchases: (_route, _input, reply) => reply([purchase()]) });
  await seed(page);
  await login(page, '/market');
  await retain(page.getByRole('button', { name: 'Check original outcome', exact: true }), '__moreACheck');
  const later = JSON.stringify({ id: returnedId, title: 'Later public marker', reference: originalId });
  await page.evaluate(
    ({ key, raw }) => {
      localStorage.setItem(key, raw);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: raw }));
    },
    { key: markerKey, raw: later },
  );
  await expect(page.getByText('Later public marker', { exact: true })).toBeVisible();
  const reads = calls.reads.length;
  await page.evaluate(() => window.__moreACheck());
  await page.waitForTimeout(30);
  expect(calls.reads.length).toBe(reads);
  expect(await rawSaved(page)).toBe(later);
  await page.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect.poll(() => rawSaved(page)).toBeNull();
  await expect(buyButton(page)).toBeEnabled();
  expect(calls.writes).toEqual([]);
});
test('same-task observed full URL ABA retires old review; new current review succeeds', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await stage(page, 'purchase');
  await retain(page.getByRole('dialog').getByRole('button', { name: text('en', 'confirm.purchase'), exact: true }), '__moreAConfirm');
  await page.evaluate(() => {
    const before = location.href;
    history.pushState({}, '', '/market?depart=1#away');
    window.dispatchEvent(new PopStateEvent('popstate'));
    history.pushState({}, '', before);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.__moreAConfirm();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls.writes).toEqual([]);
  expect(await rawSaved(page)).toBeNull();
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect.poll(() => calls.writes.length).toBe(1);
});
test('held original read cannot clear later same-id changed bytes; current read succeeds', async ({ page, context }) => {
  let held,
    first = true;
  const calls = await network(context, 'purchase', 'success', {
    myPurchases: (route, _input, reply) => {
      if (!first) return reply([purchase()]);
      first = false;
      return reply([]);
    },
  });
  await seed(page);
  await login(page, '/market');
  await expect.poll(() => calls.reads.filter((call) => call.procedure === 'myPurchases').length).toBe(1);
  await context.route('**/api/market/trpc/myPurchases?**', (route) => {
    held = route;
  });
  await page.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  const later = JSON.stringify({ id: originalId, title: 'Changed later bytes', reference: originalId });
  await page.evaluate(
    ({ key, raw }) => {
      localStorage.setItem(key, raw);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: raw }));
    },
    { key: markerKey, raw: later },
  );
  await held.fulfill({ status: 200, json: { result: { data: [purchase()] } } });
  await expect(page.getByRole('button', { name: 'Check original outcome', exact: true })).toBeVisible();
  expect(await rawSaved(page)).toBe(later);
  await context.unroute('**/api/market/trpc/myPurchases?**');
  await page.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect.poll(() => rawSaved(page)).toBeNull();
  expect(calls.writes).toEqual([]);
});
test('held purchase preflight after observed URL departure cannot dispatch or clear its original', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await stage(page, 'purchase');
  let held;
  await context.route('**/api/market/trpc/listings?**', (route) => {
    held = route;
  });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect.poll(() => Boolean(held)).toBe(true);
  const raw = await rawSaved(page);
  await page.evaluate(() => {
    const before = location.href;
    history.pushState({}, '', '/market?depart=held');
    window.dispatchEvent(new PopStateEvent('popstate'));
    history.pushState({}, '', before);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await held.fulfill({ status: 200, json: { result: { data: [listing()] } } });
  await expect(page.getByRole('button', { name: 'Check original outcome', exact: true })).toBeVisible();
  expect(await rawSaved(page)).toBe(raw);
  expect(calls.writes).toEqual([]);
  await context.unroute('**/api/market/trpc/listings?**');
  await page.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check original outcome', exact: true })).toBeVisible();
  expect(await rawSaved(page)).toBe(raw);
  expect(calls.errors).toEqual([]);
});
test('actual same-task Sign out invalidates retained Confirm before rerender', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await retain(page.getByRole('button', { name: 'Sign out', exact: true }), '__moreSignout');
  await page.getByRole('dialog', { name: 'Your account', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await stage(page, 'purchase');
  await retain(page.getByRole('dialog').getByRole('button', { name: text('en', 'confirm.purchase'), exact: true }), '__moreAConfirm');
  // Mounted real SessionProvider logout clears its immediate identity lease.
  await page.evaluate(() => {
    window.__moreSignout();
    window.__moreAConfirm();
  });
  await expect(page.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible();
  expect(calls.writes).toEqual([]);
  expect(await rawSaved(page)).toBeNull();
});
test('actual same-task Sign out invalidates retained private Check before rerender', async ({ page, context }) => {
  const calls = await network(context);
  await seed(page);
  await login(page, '/market');
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await retain(page.getByRole('button', { name: 'Sign out', exact: true }), '__moreSignout');
  await page.getByRole('dialog', { name: 'Your account', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await retain(page.getByRole('button', { name: 'Check original outcome', exact: true }), '__moreACheck');
  const reads = calls.reads.length;
  await page.evaluate(() => {
    window.__moreSignout();
    window.__moreACheck();
  });
  await expect(page.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible();
  expect(calls.reads.length).toBe(reads);
  expect(calls.writes).toEqual([]);
  expect(await rawSaved(page)).toBe(originalRaw);
});
test('native existing-key lock refuses a current Confirm without writing; later review succeeds', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await stage(page, 'purchase');
  const peer = await context.newPage();
  await login(peer, '/market');
  await peer.evaluate((key) => {
    window.__moreLockHeld = false;
    navigator.locks.request('more-action:' + key, async () => {
      window.__moreLockHeld = true;
      await new Promise((resolve) => {
        window.__moreRelease = resolve;
      });
    });
  }, markerKey);
  await expect.poll(() => peer.evaluate(() => window.__moreLockHeld)).toBe(true);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect(page.getByText(/This account has an action running in another tab/)).toBeVisible();
  expect(calls.writes).toEqual([]);
  expect(await rawSaved(page)).toBeNull();
  await peer.evaluate(() => window.__moreRelease());
  await peer.close();
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect.poll(() => calls.writes.length).toBe(1);
});
test('tab closure preserves dispatched unknown; current tab uses existing feature proof without POST replay', async ({ page, context }) => {
  let recorded;
  const calls = await network(context, 'purchase', 'unknown', {
    purchase: (route, input) => {
      recorded = purchase({ id: input.purchaseId });
      return route.abort('failed');
    },
    myPurchases: (_route, _input, reply) => reply(recorded ? [recorded] : []),
  });
  await login(page, '/market');
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Check original outcome', exact: true })).toBeVisible();
  const raw = await rawSaved(page);
  await page.close();
  const fresh = await context.newPage();
  await login(fresh, '/market');
  expect(await rawSaved(fresh)).toBe(raw);
  await fresh.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect.poll(() => rawSaved(fresh)).toBeNull();
  expect(calls.writes).toHaveLength(1);
  expect(calls.errors).toEqual([]);
});
for (const locale of ['en', 'es', 'fr'])
  for (const width of [320, 390])
    test(`${locale} ${width}px recovery read failure and long reference fit with keyboard retry`, async ({ page, context }) => {
      const calls = await network(context),
        view = await context.newPage();
      await login(view, '/view');
      if (locale !== 'en') await language(view, view, locale);
      const long = JSON.stringify({ id: originalId, title: rawTitle, reference: 'original-reference-'.repeat(10) });
      await seed(page, long);
      await page.setViewportSize({ width, height: 780 });
      await login(page, '/market');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(buyButton(page, locale)).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: dir + `/original-${locale}-${width}.png`, fullPage: true });
      await faultRead(page);
      await page.getByRole('button', { name: /Refresh purchases|Actualizar compras|Actualiser les achats/ }).click();
      const retry = page.getByRole('button', { name: /Retry recovery storage|Reintentar el almacenamiento|Réessayer le stockage/ });
      await expect(retry).toBeVisible();
      await retry.focus();
      await page.keyboard.press('Enter');
      expect(await rawSaved(page)).toBe(long);
      expect(calls.writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
