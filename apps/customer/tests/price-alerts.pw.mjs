import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
const dir = process.env.ALERT_EVIDENCE || '/tmp/intafaced-price-alerts-browser';
mkdirSync(dir, { recursive: true });
const userId = '11111111-1111-4111-8111-111111111111',
  id = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-10-09T01:00:00Z';
const live = { markSource: 'live', canFire: true, code: null };
const original = {
  id,
  userId,
  marketId: 'market-BTC',
  kind: 'price',
  direction: 'above',
  targetPrice: '84000.000000000000000000001',
  status: 'active',
  firedAt: null,
  createdAt: stamp,
};
const session = { userId, accessToken: 'isolated-alert-test', refreshToken: 'isolated-refresh-test', expiresAt: '2027-10-09T00:00:00Z' };
const reply = (r, data) => r.fulfill({ json: { result: { data } } });
const fail = (r) => r.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Current read unavailable.' } });
function market(base, paper = false) {
  return {
    id: 'market-' + base,
    symbol: base + '/USDT',
    base,
    quote: 'USDT',
    settle: null,
    baseId: base,
    quoteId: 'USDT',
    type: 'spot',
    spot: true,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: null,
    inverse: null,
    active: true,
    orderable: true,
    paper,
    schedule: 'crypto-24x7',
    sessionOpen: true,
    nextSessionChange: null,
    hours: { kind: 'continuous' },
    taker: '0.001',
    maker: '0.001',
    contractSize: null,
    expiry: null,
    expiryDatetime: null,
    strike: null,
    optionType: null,
    precisionMode: 'TICK_SIZE',
    precision: { amount: '0.00001', price: '0.01' },
    limits: {
      amount: { min: '0.00001', max: null },
      price: { min: null, max: null },
      cost: { min: '5', max: null },
      leverage: { min: null, max: null },
    },
  };
}
async function setup(page, options = {}) {
  const state = {
    items: [structuredClone(original)],
    evaluation: { ...live },
    writes: [],
    reads: 0,
    readFail: false,
    unauthorized: false,
    unknown: false,
    malformed: false,
    evalKind: 'hold',
    fireStatus: 'fired',
    evalMark: null,
    evalAbsent: false,
    createMissing: false,
    listGate: null,
    pageErrors: [],
  };
  page.on('pageerror', (e) => state.pageErrors.push(e.message));
  await page.route('**/api/**', fail);
  await page.route('**/api/identity/trpc/auth.login', (r) => reply(r, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (r) => reply(r, []));
  await page.route('**/api/v1/markets*', (r) =>
    r.fulfill({ json: [market('BTC', Boolean(options.paper)), market('ETH', Boolean(options.paper))] }),
  );
  await page.route('**/api/v1/ohlcv/**', (r) => r.fulfill({ json: [[Date.now() - 60000, '80000', '80020', '79990', '80001', '1']] }));
  await page.route('**/api/v1/orderbook/**', (r) =>
    r.fulfill({
      json: {
        symbol: decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()),
        bids: [['80000', '1']],
        asks: [['80001', '1']],
        timestamp: Date.now(),
        datetime: new Date().toISOString(),
        nonce: 1,
      },
    }),
  );
  await page.route('**/api/notify/trpc/notify.alerts?*', async (r) => {
    state.reads++;
    if (state.listGate) await state.listGate;
    if (state.unauthorized) return r.fulfill({ status: 401, json: { error: 'unauthorized' } });
    if (state.readFail) return fail(r);
    const count = JSON.parse(new URL(r.request().url()).searchParams.get('input')).limit;
    return reply(r, { items: state.items.slice(0, count), evaluation: state.evaluation });
  });
  await page.route('**/api/notify/trpc/*', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const proc = new URL(r.request().url()).pathname.split('/').pop(),
      body = r.request().postDataJSON();
    state.writes.push({ proc, body });
    if (state.unknown) return fail(r);
    if (proc === 'notify.createAlert') {
      if (state.createMissing)
        return r.fulfill({ status: 412, json: { error: { message: 'alert.price_unavailable', data: { code: 'PRECONDITION_FAILED' } } } });
      const row = { ...original, ...body, id: '44444444-4444-4444-8444-444444444444' };
      state.items.unshift(row);
      return reply(r, {
        alert: state.malformed ? { ...row, userId: '22222222-2222-4222-8222-222222222222' } : row,
        evaluation: state.evaluation,
      });
    }
    if (proc === 'notify.cancelAlert') {
      state.items = state.items.map((row) => (row.id === body.id ? { ...row, status: 'cancelled' } : row));
      return reply(r, { cancelled: true, alert: state.items.find((row) => row.id === body.id) });
    }
    if (state.evalAbsent)
      return reply(r, {
        alert: null,
        evaluation: { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' },
        outcome: { kind: 'refuse', code: 'alert.price_unavailable', detail: 'Alert service is unavailable.' },
      });
    const watched = state.items.find((item) => item.id === body.id) || original;
    const row = {
      ...watched,
      status: state.evalKind === 'fire' ? state.fireStatus : 'active',
      firedAt: state.evalKind === 'fire' && state.fireStatus === 'fired' ? stamp : null,
    };
    state.items = [row];
    return reply(r, {
      alert: row,
      evaluation: state.evaluation,
      outcome:
        state.evalKind === 'refuse'
          ? { kind: 'refuse', code: 'alert.price_unavailable', detail: 'No fresh sourced mark.' }
          : {
              kind: state.evalKind,
              markPrice: state.evalMark || (state.evalKind === 'hold' ? '83000.000000000000000000001' : '85000.000000000000000000001'),
            },
    });
  });
  if (!options.signedOut) {
    await page.goto('/login?redirect=' + encodeURIComponent(options.paper ? '/exchange?simulated=true' : '/exchange'));
    await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('isolated-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/exchange/);
  } else await page.goto('/exchange');
  return state;
}
async function open(page) {
  await page.getByRole('button', { name: 'Price alerts', exact: true }).click();
  return page.getByRole('dialog');
}
async function createReview(page, price = original.targetPrice) {
  const dialog = await open(page);
  await dialog.getByLabel('Trigger price (USDT per BTC)', { exact: true }).fill(price);
  await dialog.getByRole('button', { name: 'Review price alert', exact: true }).click();
  return dialog;
}
async function pending(page) {
  return JSON.parse((await page.evaluate((u) => localStorage.getItem('intafaced.customer.alert-unconfirmed.v1:' + u), userId)) || 'null');
}
test('native price watch exact review and explicit dispatch work at four widths', async ({ page }) => {
  const state = await setup(page),
    dialog = await createReview(page);
  await expect(dialog).toContainText('BTC/USDT');
  await expect(dialog).toContainText(original.targetPrice);
  await expect(dialog).toContainText('At or above');
  expect(state.writes).toEqual([]);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const button = dialog.getByRole('button', { name: 'Save price alert', exact: true });
    await dialog.getByRole('button', { name: 'Back', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    const fit = await button.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { height: b.height, hit: el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) };
    });
    expect(fit.height).toBeGreaterThanOrEqual(44);
    expect(fit.hit).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const a = await new AxeBuilder({ page }).include('[data-testid="price-alerts"]').analyze();
    expect(a.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
    await page.screenshot({ path: dir + '/review-' + width + '.png', fullPage: true });
  }
  await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
  await expect(dialog).toContainText('The service saved your one-shot alert.');
  expect(state.writes).toEqual([
    { proc: 'notify.createAlert', body: { kind: 'price', marketId: 'market-BTC', direction: 'above', targetPrice: original.targetPrice } },
  ]);
  expect(await pending(page)).toBeNull();
  expect(state.pageErrors).toEqual([]);
});
test('invalid decimal threshold never enters review or dispatch', async ({ page }) => {
  const state = await setup(page),
    dialog = await open(page),
    field = dialog.getByLabel('Trigger price (USDT per BTC)', { exact: true });
  for (const value of ['0', '-1', '1e3', '84,000', '0.000000000000000000000']) {
    await field.fill(value);
    await dialog.getByRole('button', { name: 'Review price alert', exact: true }).click();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
  }
  expect(state.writes).toEqual([]);
  expect(await pending(page)).toBeNull();
});
test('dark evaluation requires explicit storage acknowledgement', async ({ page }) => {
  const state = await setup(page);
  state.evaluation = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' };
  const dialog = await createReview(page);
  await expect(dialog).toContainText('This alert cannot currently fire');
  const save = dialog.getByRole('button', { name: 'Save price alert', exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await save.click();
  await expect(dialog).toContainText('The service saved your one-shot alert.');
  await expect(dialog).toContainText('This alert cannot currently fire');
  expect(state.writes).toHaveLength(1);
});
for (const mode of ['failed', 'changed', 'signed out'])
  test('creation preflight ' + mode + ' dispatches no request or marker', async ({ page }) => {
    const state = await setup(page),
      dialog = await createReview(page);
    if (mode === 'failed') state.readFail = true;
    if (mode === 'changed') state.evaluation = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' };
    if (mode === 'signed out') state.unauthorized = true;
    await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
    await expect.poll(() => state.reads).toBeGreaterThan(1);
    if (mode !== 'signed out') await expect(dialog).toContainText('No request was sent.');
    else {
      await expect(dialog).toHaveCount(0);
      await open(page);
      await expect(dialog).toContainText('Sign in to manage your alerts');
    }
    expect(state.writes).toEqual([]);
    expect(await pending(page)).toBeNull();
  });
test('owned market and predicate filtering preserves selected ID through failed and empty reads', async ({ page }) => {
  const state = await setup(page);
  state.items.push(
    { ...original, id: '55555555-5555-4555-8555-555555555555', marketId: 'market-ETH' },
    { ...original, id: '66666666-6666-4666-8666-666666666666', kind: 'funding' },
  );
  const dialog = await open(page);
  await expect(dialog.getByTestId('price-alerts-row')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
  state.readFail = true;
  await dialog.getByRole('button', { name: 'Refresh alerts', exact: true }).click();
  await expect(dialog.getByTestId('price-alerts-selection')).toContainText(id);
  await expect(dialog.getByTestId('price-alerts-selection')).toContainText('Your original selection remains here.');
  state.readFail = false;
  state.items = [];
  await dialog.getByRole('button', { name: 'Refresh alerts', exact: true }).click();
  await expect(dialog).toContainText('No price alerts returned for this market');
  await expect(dialog.getByTestId('price-alerts-selection')).toContainText(id);
  state.items = [original];
  await dialog.getByRole('button', { name: 'Refresh alerts', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Review cancellation', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});
test('cancellation reviews original watch and follows authoritative returned status', async ({ page }) => {
  const state = await setup(page),
    dialog = await open(page);
  await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review cancellation', exact: true }).click();
  await expect(dialog.getByTestId('price-alerts-review')).toContainText(id);
  expect(state.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel this alert', exact: true }).click();
  await expect(dialog).toContainText('The service returned this alert as cancelled.');
  expect(state.writes).toEqual([{ proc: 'notify.cancelAlert', body: { id } }]);
  expect(await pending(page)).toBeNull();
});
for (const [kind, status, text] of [
  ['hold', 'active', 'The condition was not met at this check.'],
  ['fire', 'fired', 'The service returned this alert as fired. Device arrival is not confirmed.'],
  ['fire', 'active', 'Notification completion is not established.'],
  ['refuse', 'active', 'The service refused this evaluation.'],
])
  test('manual evaluation ' + kind + '/' + status + ' does not overstate notification outcome', async ({ page }) => {
    const state = await setup(page);
    state.evalKind = kind;
    state.fireStatus = status;
    const dialog = await open(page);
    await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review check now', exact: true }).click();
    await expect(dialog).toContainText('this can fire the alert and create a notification.');
    expect(state.writes).toEqual([]);
    await dialog.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog).toContainText(text);
    expect(state.writes).toEqual([{ proc: 'notify.evaluateAlert', body: { id } }]);
    expect(await pending(page)).toBeNull();
  });
for (const mode of ['unknown', 'malformed'])
  test(mode + ' create survives close, matching list and empty list without replay', async ({ page }) => {
    const state = await setup(page),
      dialog = await createReview(page);
    state.unknown = mode === 'unknown';
    state.malformed = mode === 'malformed';
    await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
    await expect(dialog).toContainText('Original alert action unconfirmed');
    const marker = await pending(page);
    expect(marker.action).toBe('create');
    expect(marker.marketId).toBe('market-BTC');
    expect(marker).not.toHaveProperty('targetPrice');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await open(page);
    await expect(dialog).toContainText(marker.requestId);
    await expect(dialog.getByRole('button', { name: 'Review price alert', exact: true })).toHaveCount(0);
    state.items = [];
    await dialog.getByRole('button', { name: 'Refresh alerts', exact: true }).click();
    await expect(dialog).toContainText('No price alerts returned for this market');
    expect(await pending(page)).toEqual(marker);
    expect(state.writes).toHaveLength(1);
  });
test('changed original watch refuses cancellation before dispatch', async ({ page }) => {
  const state = await setup(page),
    dialog = await open(page);
  await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review cancellation', exact: true }).click();
  state.items = [];
  await dialog.getByRole('button', { name: 'Cancel this alert', exact: true }).click();
  await expect(dialog).toContainText('No request was sent.');
  expect(state.writes).toEqual([]);
  expect(await pending(page)).toBeNull();
});
for (const [direction, kind, mark] of [
  ['above', 'hold', original.targetPrice],
  ['above', 'fire', '84000.000000000000000000000'],
  ['below', 'hold', original.targetPrice],
  ['below', 'fire', '84000.000000000000000000002'],
])
  test('contradictory exact ' + direction + '/' + kind + '/' + mark + ' response keeps the original action guarded', async ({ page }) => {
    const state = await setup(page);
    state.items = [{ ...original, direction }];
    state.evalKind = kind;
    state.evalMark = mark;
    const dialog = await open(page);
    await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review check now', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog).toContainText('Original alert action unconfirmed');
    expect((await pending(page)).alertId).toBe(id);
    expect(state.writes).toHaveLength(1);
    await expect(dialog.getByTestId('price-alerts-result')).toHaveCount(0);
  });
test('signed-out chart entry performs no private alert read', async ({ page }) => {
  const state = await setup(page, { signedOut: true }),
    dialog = await open(page);
  await expect(dialog).toContainText('Sign in to manage your alerts');
  expect(state.reads).toBe(0);
  expect(state.writes).toEqual([]);
});
for (const direction of ['above', 'below'])
  test('inclusive equality fires ' + direction + ' without truncating the trigger', async ({ page }) => {
    const state = await setup(page);
    state.items = [{ ...original, direction }];
    state.evalKind = 'fire';
    state.evalMark = original.targetPrice;
    const dialog = await open(page);
    await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review check now', exact: true }).click();
    await dialog.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog).toContainText('The service returned this alert as fired.');
    expect(await pending(page)).toBeNull();
  });
test('a sourced mark longer than the target input cap remains an exact accepted mark', async ({ page }) => {
  const state = await setup(page);
  state.evalMark = '0.' + '0'.repeat(80) + '1';
  const dialog = await open(page);
  await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review check now', exact: true }).click();
  await dialog.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(dialog).toContainText('The condition was not met at this check.');
  await expect(dialog).toContainText(state.evalMark);
  expect(await pending(page)).toBeNull();
});
test('mounted absent-service evaluation is an authoritative non-firing refusal', async ({ page }) => {
  const state = await setup(page),
    dialog = await open(page);
  await dialog.getByRole('button', { name: 'Inspect alert', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review check now', exact: true }).click();
  state.evalAbsent = true;
  await dialog.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(dialog).toContainText('The service refused this evaluation.');
  expect(await pending(page)).toBeNull();
});
test('named create refusal before a missing service does not become a permanent unknown', async ({ page }) => {
  const state = await setup(page),
    dialog = await createReview(page);
  state.createMissing = true;
  await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
  await expect(dialog).toContainText('alert.price_unavailable');
  await expect(dialog).not.toContainText('Original alert action unconfirmed');
  expect(await pending(page)).toBeNull();
  expect(state.writes).toHaveLength(1);
});
test('unconfirmed alert Support exit opens canonical Support and retains the original marker', async ({ page }) => {
  const state = await setup(page),
    dialog = await createReview(page);
  state.unknown = true;
  await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
  await expect(dialog).toContainText('Original alert action unconfirmed');
  const marker = await pending(page);
  await dialog.getByRole('link', { name: 'Open Support', exact: true }).click();
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByRole('heading', { name: 'Support', exact: true, level: 1 })).toBeVisible();
  expect(await pending(page)).toEqual(marker);
  expect(state.writes).toHaveLength(1);
  await page.getByRole('link', { name: 'Trade', exact: true }).first().click();
  await open(page);
  await expect(dialog).toContainText(marker.requestId);
  expect(state.writes).toHaveLength(1);
});
test('all-kind account window controls continuation even when current-market filtering is empty', async ({ page }) => {
  const state = await setup(page);
  state.items = [
    ...Array.from({ length: 50 }, (_, i) => ({
      ...original,
      id: '55555555-5555-4555-8555-' + String(i).padStart(12, '0'),
      kind: 'funding',
    })),
    original,
  ];
  const dialog = await open(page);
  await expect(dialog.getByTestId('price-alerts-row')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Read a larger account window', exact: true }).click();
  await expect(dialog.getByTestId('price-alerts-row')).toHaveCount(1);
  await expect(dialog).toContainText('latest 100 account alerts');
  expect(state.writes).toEqual([]);
});
test('native history navigation aborts a delayed fresh review without journaling or dispatch', async ({ page }) => {
  const state = await setup(page),
    dialog = await createReview(page);
  let release;
  state.listGate = new Promise((resolve) => {
    release = resolve;
  });
  const before = state.reads;
  await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  release();
  state.listGate = null;
  await page.goForward();
  await open(page);
  const signIn = dialog.getByRole('link', { name: 'Sign in to manage your alerts', exact: true });
  if (await signIn.count()) {
    await signIn.click();
    await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('isolated-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/exchange/);
    await open(page);
  }
  await expect(dialog.getByRole('button', { name: 'Review price alert', exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]);
  expect(await pending(page)).toBeNull();
});
for (const mode of ['corrupt', 'unavailable', 'no Web Locks'])
  test(mode + ' attempt storage refuses before POST', async ({ page }) => {
    if (mode === 'corrupt')
      await page.addInitScript((owner) => localStorage.setItem('intafaced.customer.alert-unconfirmed.v1:' + owner, '{'), userId);
    if (mode === 'unavailable')
      await page.addInitScript(() => {
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('intafaced.customer.alert-unconfirmed.')) throw new Error('Unavailable device storage');
          return originalSet.call(this, key, value);
        };
      });
    if (mode === 'no Web Locks')
      await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
    const state = await setup(page),
      dialog = await open(page);
    if (mode === 'corrupt') await expect(dialog.getByRole('button', { name: 'Review price alert', exact: true })).toBeDisabled();
    else {
      await dialog.getByLabel('Trigger price (USDT per BTC)', { exact: true }).fill(original.targetPrice);
      await dialog.getByRole('button', { name: 'Review price alert', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save price alert', exact: true }).click();
    }
    await expect(dialog).toContainText('This browser cannot preserve or coordinate an alert attempt.');
    expect(state.writes).toEqual([]);
  });
test('simulated chart does not read or create live account alerts', async ({ page }) => {
  const state = await setup(page, { paper: true }),
    dialog = await open(page);
  await expect(dialog).toContainText('Simulated markets cannot create or read live account alerts.');
  expect(state.reads).toBe(0);
  expect(state.writes).toEqual([]);
});
for (const mode of ['foreign owner', 'duplicate ID'])
  test(mode + ' read refuses the whole window', async ({ page }) => {
    const state = await setup(page);
    state.items = mode === 'foreign owner' ? [{ ...original, userId: '22222222-2222-4222-8222-222222222222' }] : [original, original];
    const dialog = await open(page);
    await expect(dialog).toContainText('The service response could not be verified.');
    await expect(dialog.getByTestId('price-alerts-row')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Review price alert', exact: true })).toBeDisabled();
    expect(state.writes).toEqual([]);
  });
