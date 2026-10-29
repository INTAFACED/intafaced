import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const dir = process.env.MARKET_REVIEW_EVIDENCE || '/tmp/intafaced-market-review';
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
  refundWindowSeconds: null,
  hold: null,
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
for (const mode of Object.keys(modes))
  for (const outcome of ['success', 'refused', 'unknown'])
    test('native ' + mode + ' review and ' + outcome + ' follow two-tab View with original intent', async ({ page, context }) => {
      const calls = await network(context, mode, outcome);
      await login(page, modes[mode].path);
      const view = await context.newPage();
      await login(view, '/view');
      const origin = await page.evaluate(() => performance.timeOrigin);
      await stage(page, mode);
      const dialog = page.getByRole('dialog'),
        originalDialog = await dialog.elementHandle();
      const inputs = await page.locator('input,textarea,select').elementHandles();
      const originalPrice = ['purchase', 'listing', 'strategy'].includes(mode)
        ? await dialog.getByRole('group', { name: text('en', 'price'), exact: true }).elementHandle()
        : null;
      const values = await page.locator('input,textarea,select').evaluateAll((xs) => xs.map((x) => x.value));
      for (const locale of ['en', 'es', 'fr']) {
        if (locale !== 'en') await language(view, page, locale);
        await page.screenshot({ path: dir + '/' + mode + '-' + outcome + '-review-' + locale + '.png', fullPage: true });
        await expect(dialog).toHaveAccessibleName(text(locale, modes[mode].review));
        await expect(dialog.getByRole('button', { name: text(locale, modes[mode].confirm), exact: true })).toBeVisible();
        await expect(dialog).toContainText(modes[mode].raw);
        if (['purchase', 'listing', 'strategy'].includes(mode)) {
          await expect(dialog).toContainText(exactPrice);
          await expect(dialog).toContainText(asset);
        }
        const raw = dialog.getByText(modes[mode].raw, { exact: true });
        expect(await raw.evaluate((x) => x.closest('[lang]').lang)).toBe(mode === 'release' || mode === 'cancel' ? 'zxx' : 'und');
        for (const input of inputs) expect(await input.evaluate((x) => x.isConnected)).toBe(true);
        expect(await page.locator('input,textarea,select').evaluateAll((xs) => xs.map((x) => x.value))).toEqual(values);
        expect(await originalDialog.evaluate((x) => x.isConnected && x.open)).toBe(true);
        if (originalPrice) expect(await originalPrice.evaluate((x) => x.isConnected)).toBe(true);
        if (mode === 'purchase') await expect(dialog.getByText(vendorId, { exact: true })).toHaveAttribute('lang', 'zxx');
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
        expect(calls.writes).toEqual([]);
        expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
      }
      await dialog.getByRole('button', { name: text('fr', modes[mode].confirm), exact: true }).click();
      await expect.poll(() => calls.writes.length).toBe(1);
      expect(calls.writes[0]).toEqual({ procedure: modes[mode].procedure, input: expected(mode, calls.writes[0].input) });
      await expect.poll(() => calls.journals.length).toBe(1);
      const originalMarker = JSON.parse(calls.journals[0]);
      expect(originalMarker.title).toBe(text('en', modes[mode].review));
      if (mode === 'purchase') expect(originalMarker.reference).toBe(calls.writes[0].input.purchaseId);
      else expect(originalMarker.reference).toBeUndefined();
      await expect(dialog).toHaveCount(0);
      for (const locale of ['fr', 'es', 'en']) {
        if (locale !== 'fr') await language(view, page, locale);
        if (outcome === 'success') {
          await expect(page.locator('.more-success')).toHaveText(text(locale, modes[mode].success));
          await expect(page.locator('.more-success')).toHaveAttribute('lang', locale);
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
        } else if (outcome === 'refused') {
          const message = page.locator('.failure p').filter({ hasText: provider });
          await expect(message).toHaveText(provider);
          expect(await message.evaluate((x) => x.closest('[lang]').lang)).toBe('und');
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
        } else {
          expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), markerKey))).toEqual(originalMarker);
          if (mode === 'purchase') {
            const explanation = page.locator('.failure p').filter({ hasText: provider });
            await expect(explanation).toHaveText(provider);
            expect(await explanation.evaluate((x) => x.closest('[lang]').lang)).toBe('und');
          }
          await expect(page.locator('.failure').getByText(originalMarker.title, { exact: true })).toHaveAttribute('lang', 'und');
          await expect(page.locator('.more-success')).toHaveCount(0);
          await expect(page.getByRole('button', { name: catalogs[locale]['common.check.original.outcome'], exact: true })).toHaveCount(
            mode === 'purchase' ? 1 : 0,
          );
        }
        expect(calls.writes).toHaveLength(1);
        await page.screenshot({ path: dir + '/' + mode + '-' + outcome + '-outcome-' + locale + '.png', fullPage: true });
      }
      expect(calls.errors).toEqual([]);
      results.push({ mode, outcome, calls });
      writeFileSync(dir + '/requests.json', JSON.stringify(results, null, 2));
    });

test('native changed purchase terms refuses locally and follows View without dispatch', async ({ page, context }) => {
  let reads = 0;
  const calls = await network(context, 'purchase', 'success', {
    listings: (_route, _input, reply) => reply([listing({ price: ++reads === 1 ? exactPrice : '1' })]),
  });
  await login(page, '/market');
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect(page.locator('.failure')).toContainText(text('en', 'the.listing.terms.changed.reload.the.catalogue'));
  const view = await context.newPage();
  await login(view, '/view');
  for (const locale of ['es', 'fr']) {
    await language(view, page, locale);
    await expect(page.locator('.failure')).toContainText(text(locale, 'the.listing.terms.changed.reload.the.catalogue'));
    expect(await page.locator('.failure p').evaluate((x) => x.closest('[lang]').lang)).toBe(locale);
  }
  expect(calls.writes).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
});

for (const width of [320, 390])
  for (const amount of [exactPrice, '99999999999999999999.999999999999999999'])
    test(
      'native phone ' + width + ' purchase exact price ' + amount + ' keeps its unit and confirmation focus visible',
      async ({ page, context }) => {
        await page.setViewportSize({ width, height: 780 });
        const calls = await network(context, 'purchase', 'success', {
          listings: (_route, _input, reply) => reply([listing({ price: amount })]),
        });
        const [whole, fraction] = amount.split('.');
        const displayed = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
        const label = width + '-' + (amount === exactPrice ? 'nano' : 'long');
        await login(page, '/market');
        const catalogue = page.locator('.more-room-link');
        const cataloguePrice = catalogue.getByRole('group', { name: text('en', 'price'), exact: true });
        await expect(cataloguePrice).toHaveText(displayed);
        await cataloguePrice.focus();
        await expect(cataloguePrice).toBeFocused();
        for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
        await expect
          .poll(() => cataloguePrice.evaluate((x) => x.scrollLeft))
          .toBe(await cataloguePrice.evaluate((x) => x.scrollWidth - x.clientWidth));
        await expect(catalogue.getByText(asset, { exact: true })).toBeVisible();
        const catalogueGeometry = await catalogue.evaluate((x) => ({
          card: x.getBoundingClientRect().toJSON(),
          price: x.querySelector('[role=group]').getBoundingClientRect().toJSON(),
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        }));
        writeFileSync(dir + '/phone-' + label + '-catalogue-geometry.json', JSON.stringify(catalogueGeometry));
        expect(catalogueGeometry.card.right).toBeLessThanOrEqual(width);
        expect(catalogueGeometry.price.right).toBeLessThanOrEqual(catalogueGeometry.card.right);
        expect(catalogueGeometry.documentWidth).toBeLessThanOrEqual(width);
        const buy = catalogue.getByRole('button', { name: text('en', 'buy.2').replace('{value1}', rawTitle), exact: true });
        await buy.focus();
        await expect(buy).toBeFocused();
        expect(
          await buy.evaluate((x) => {
            const r = x.getBoundingClientRect();
            return (
              r.top >= 0 && r.bottom <= innerHeight && x.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
            );
          }),
        ).toBe(true);
        await page.screenshot({ path: dir + '/phone-' + label + '-catalogue-native.png' });
        await stage(page, 'purchase');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(displayed);
        await page.screenshot({ path: dir + '/phone-' + label + '-review-before-inspection.png' });
        const price = dialog.getByRole('group', { name: text('en', 'price'), exact: true });
        await expect(price).toHaveText(displayed);
        await price.focus();
        await expect(price).toBeFocused();
        for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
        const end = await price.evaluate((x) => x.scrollWidth - x.clientWidth);
        await expect.poll(() => price.evaluate((x) => x.scrollLeft)).toBe(end);
        const originalPrice = await price.elementHandle();
        const geometry = await price.evaluate((x) => ({
          dd: x.closest('dd').getBoundingClientRect().toJSON(),
          dialog: x.closest('dialog').getBoundingClientRect().toJSON(),
          left: x.getBoundingClientRect().left,
          right: x.getBoundingClientRect().right,
          client: x.clientWidth,
          scroll: x.scrollWidth,
          offset: x.scrollLeft,
        }));
        writeFileSync(dir + '/phone-' + label + '-geometry.json', JSON.stringify(geometry));
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.dd.left).toBeGreaterThanOrEqual(geometry.dialog.left);
        expect(geometry.dd.right).toBeLessThanOrEqual(geometry.dialog.right);
        const view = await context.newPage();
        await login(view, '/view');
        for (const locale of ['es', 'fr']) {
          await language(view, page, locale);
          expect(await originalPrice.evaluate((x) => x.isConnected && x === document.activeElement)).toBe(true);
          await expect(dialog.getByRole('group', { name: text(locale, 'price'), exact: true })).toHaveText(displayed);
          expect(await originalPrice.evaluate((x) => x.scrollLeft)).toBe(geometry.offset);
        }
        await language(view, page, 'en');
        if (geometry.scroll > geometry.client) expect(geometry.offset).toBeGreaterThan(0);
        await expect(dialog.getByText(asset, { exact: true })).toBeVisible();
        const confirm = dialog.getByRole('button', { name: text('en', 'confirm.purchase'), exact: true });
        await confirm.focus();
        await expect(confirm).toBeFocused();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        writeFileSync(
          dir + '/phone-' + label + '-confirmation-geometry.json',
          JSON.stringify(
            await confirm.evaluate((x) => {
              const r = x.getBoundingClientRect();
              return {
                rect: r.toJSON(),
                innerHeight,
                innerWidth,
                hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.outerHTML,
              };
            }),
          ),
        );
        expect(
          await confirm.evaluate((x) => {
            const r = x.getBoundingClientRect();
            return (
              r.top >= 0 && r.bottom <= innerHeight && x.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
            );
          }),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const axe = await new AxeBuilder({ page }).analyze();
        expect(axe.violations.filter((x) => ['serious', 'critical'].includes(x.impact))).toEqual([]);
        expect(calls.writes).toEqual([]);
        expect(calls.errors).toEqual([]);
        await page.screenshot({ path: dir + '/phone-' + label + '-native-exact-review.png' });
        writeFileSync(dir + '/phone-' + label + '-geometry.json', JSON.stringify(geometry));
      },
    );

const mismatches = [
  ['purchase', 'id', returnedId],
  ['purchase', 'listingId', returnedId],
  ['purchase', 'buyerId', other],
  ['purchase', 'vendorId', returnedId],
  ['purchase', 'assetId', 'OTHER'],
  ['purchase', 'price', '2'],
  ['application', 'userId', other],
  ['application', 'displayName', 'Another name'],
  ['listing', 'vendorId', returnedId],
  ['listing', 'title', 'Another title'],
  ['listing', 'price', '2'],
  ['strategy', 'periodSeconds', 7200],
  ['archive', 'id', returnedId],
  ['archive', 'vendorId', returnedId],
  ['cancel', 'buyerId', other],
  ['cancel', 'listingId', returnedId],
];
for (const [mode, field, value] of mismatches)
  test('native ' + mode + ' returned ' + field + ' mismatch keeps its original unknown journal', async ({ page, context }) => {
    const calls = await network(context, mode, 'success', {
      [modes[mode].procedure]: (_route, input, reply) => {
        const row =
          mode === 'purchase'
            ? purchase({ id: input.purchaseId })
            : mode === 'application'
              ? vendor({ displayName: input.displayName, description: input.description, status: 'applied' })
              : mode === 'cancel'
                ? { listingId, buyerId: owner, cancelledAt: at }
                : mode === 'archive'
                  ? listing({ status: 'archived' })
                  : listing({ ...input, id: returnedId, offerType: mode === 'strategy' ? 'subscription' : input.offerType });
        return reply({ ...row, [field]: value });
      },
    });
    await login(page, modes[mode].path);
    await stage(page, mode);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: text('en', modes[mode].confirm), exact: true })
      .click();
    await expect.poll(() => calls.writes.length).toBe(1);
    await page.screenshot({ path: dir + '/binding-' + mode + '-' + field + '.png', fullPage: true });
    await expect(page.locator('.more-success')).toHaveCount(0);
    await expect(page.locator('.failure[role="alert"]').first()).toBeVisible();
    const marker = JSON.parse(calls.journals[0]);
    expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), markerKey))).toEqual(marker);
    expect(marker.title).toBe(text('en', modes[mode].review));
    if (mode === 'purchase') expect(marker.reference).toBe(calls.writes[0].input.purchaseId);
    else expect(marker.reference).toBeUndefined();
    expect(calls.writes).toHaveLength(1);
    expect(calls.errors).toEqual([]);
  });

for (const outcome of ['pending', 'incomplete', 'missing', 'rejected', 'settled'])
  test('native original purchase ' + outcome + ' recovery follows View without replay or a new reference', async ({ page, context }) => {
    let reference;
    const calls = await network(context, 'purchase', 'unknown', {
      purchase: (route, input) => {
        reference = input.purchaseId;
        return route.abort('failed');
      },
      myPurchases: (_route, _input, reply) =>
        reply(
          !reference || outcome === 'missing'
            ? []
            : [
                purchase({
                  id: reference,
                  ...(outcome === 'pending' ? { status: 'pending', ledgerTxId: null, settledAt: null } : {}),
                  ...(outcome === 'incomplete' ? { ledgerTxId: null } : {}),
                  ...(outcome === 'rejected'
                    ? { status: 'rejected', ledgerTxId: null, settledAt: null, rejectionCode: 'market.fixture_rejected' }
                    : {}),
                }),
              ],
        ),
    });
    await login(page, '/market');
    await stage(page, 'purchase');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
      .click();
    await expect.poll(() => calls.journals.length).toBe(1);
    const marker = JSON.parse(calls.journals[0]);
    await expect(page.getByRole('button', { name: catalogs.en['common.check.original.outcome'], exact: true })).toBeVisible();
    await page.getByRole('button', { name: catalogs.en['common.check.original.outcome'], exact: true }).click();
    const resolved = outcome === 'rejected' || outcome === 'settled';
    const key =
      outcome === 'pending'
        ? 'original.purchase.is.still.pending.settlement.is'
        : outcome === 'incomplete'
          ? 'the.original.settlement.evidence.is.incomplete.keep'
          : 'the.original.purchase.is.not.present.in';
    const view = await context.newPage();
    await login(view, '/view');
    for (const locale of ['en', 'es', 'fr']) {
      if (locale !== 'en') await language(view, page, locale);
      if (resolved) {
        await expect(page.locator('.more-success')).toHaveText(catalogs[locale]['common.original.outcome.verified']);
        expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
      } else {
        await expect(page.locator('.failure').first()).toContainText(text(locale, key));
        expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), markerKey))).toEqual(marker);
        await expect(page.getByText(marker.title, { exact: true })).toHaveAttribute('lang', 'und');
        await expect(page.locator('.more-success')).toHaveCount(0);
      }
    }
    expect(calls.writes).toEqual([{ procedure: 'purchase', input: { listingId, purchaseId: reference } }]);
    expect(calls.reads.filter((x) => x.procedure === 'myPurchases').every((x) => x.input.limit === 50)).toBe(true);
    expect(calls.reads.filter((x) => x.procedure === 'subscriptionAccess')).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

test('native changed seller before purchase dispatch refuses original listing terms', async ({ page, context }) => {
  let reads = 0;
  const calls = await network(context, 'purchase', 'success', {
    listings: (_route, _input, reply) => reply([listing({ vendorId: ++reads === 1 ? vendorId : returnedId })]),
  });
  await login(page, '/market');
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect(page.locator('.failure')).toContainText(text('en', 'the.listing.terms.changed.reload.the.catalogue'));
  expect(calls.writes).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
});

test('native cross-tab Web Lock refuses dispatch and retains localized authored refusal', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await stage(page, 'purchase');
  const view = await context.newPage();
  await login(view, '/view');
  await view.evaluate((key) => {
    window.lockAcquired = false;
    navigator.locks.request('more-action:' + key, async () => {
      window.lockAcquired = true;
      await new Promise((resolve) => {
        window.releaseMarketLock = resolve;
      });
    });
  }, markerKey);
  await expect.poll(() => view.evaluate(() => window.lockAcquired)).toBe(true);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  for (const locale of ['en', 'es', 'fr']) {
    if (locale !== 'en') await language(view, page, locale);
    await expect(page.locator('.failure')).toContainText(catalogs[locale]['common.this.account.has.an.action.running.in']);
    expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
  }
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
  await view.evaluate(() => window.releaseMarketLock());
});

test('native sign out during original purchase preflight prevents POST', async ({ page, context }) => {
  let reads = 0,
    release;
  const calls = await network(context, 'purchase', 'success', {
    listings: async (_route, _input, reply) => {
      if (++reads > 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return reply([listing()]);
    },
  });
  await login(page, '/market');
  await stage(page, 'purchase');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'confirm.purchase'), exact: true })
    .click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.locator('.person-trigger').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/login?redirect=%2Fmarket',
  );
  release();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
  await expect.poll(() => calls.reads.filter((x) => x.procedure === 'listings').length).toBe(2);
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
});
