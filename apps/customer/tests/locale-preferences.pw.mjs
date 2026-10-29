import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.LOCALE_EVIDENCE;
mkdirSync(output, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111';
const listingId = '33333333-3333-4333-8333-333333333333';
const vendorId = '66666666-6666-4666-8666-666666666666';
const originalId = '44444444-4444-4444-8444-444444444444';
const proposalId = '21111111-1111-4111-8111-111111111111';
const preferenceKey = 'intafaced.customer.view.v1';
const originalKey = `intafaced:more:pending:${owner}:market`;
const at = '2026-10-09T10:00:00.000Z';
const amount = '0.000000000000000001';
const originalTitle = 'Original user title / no translation';
const originalDescription = 'Original prose <opaque> 0.000000000000000001';
const assetId = 'LONG_NATIVE_ASSET_IDENTIFIER_123';
const listing = {
  id: listingId,
  vendorId,
  title: originalTitle,
  description: originalDescription,
  offerType: 'subscription',
  assetId,
  price: amount,
  periodSeconds: 3600,
  status: 'active',
  createdAt: at,
  updatedAt: at,
};
const logRow = {
  id: originalId,
  sessionId: originalId,
  agentId: 'navigator',
  sequence: 1,
  kind: 'completion',
  status: 'executed',
  tool: null,
  task: 'research-summary',
  model: null,
  inputTokens: '18',
  outputTokens: '7',
  cost: amount,
  refusalCode: null,
  messageKey: 'agents.completion.executed',
  messageParams: {},
  occurredAt: at,
};
const environments = new WeakMap(),
  summary = [];
const language = (page) => page.locator('select').filter({ has: page.locator('option[value="zh-Hans"]') });
const stored = (page, key = preferenceKey) =>
  page.evaluate((key) => (window.originalLocaleGet || Storage.prototype.getItem).call(localStorage, key), key);
async function network(context, page, baseURL, extra = {}) {
  const now = Date.now();
  const state = { stake: '40.75', reads: [], writes: [], errors: [], external: [], ...extra };
  const proposal = {
    id: proposalId,
    kind: 'curriculum',
    body: { title: originalTitle, note: originalDescription, amount },
    status: 'open',
    createdAt: new Date(now - 120000).toISOString(),
    opensAt: new Date(now - 60000).toISOString(),
    closesAt: new Date(now + 3600000).toISOString(),
  };
  const observe = (current) => current.on('pageerror', (error) => state.errors.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.routeWebSocket('**', (socket) => socket.close());
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: owner,
        accessToken: 'isolated-locale-owner',
        refreshToken: 'isolated-locale-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    (request.method() === 'GET' ? state.reads : state.writes).push({ procedure, input });
    if (state[procedure]) return state[procedure](route, input, reply);
    if (procedure === 'purchase')
      return route.fulfill({
        status: 503,
        json: { error: { message: originalDescription, data: { cause: { code: 'market.isolated_unknown' } } } },
      });
    if (procedure === 'listings') return reply([listing]);
    if (procedure === 'commerceProgramme') return reply({ commissionBps: 500, commissionConfigured: true });
    if (['myPurchases', 'myCerts', 'certDefinitions', 'curriculum', 'webauthn.list', 'listStakes', 'routes.list'].includes(procedure))
      return reply([]);
    if (procedure === 'listProposals') return reply([proposal]);
    if (procedure === 'getProposal')
      return reply({ ...proposal, tally: { forWeight: '1', againstWeight: '0', abstainWeight: '0', totalWeight: '1', voterCount: 1 } });
    if (procedure === 'stakeOf') return reply({ staked: state.stake });
    if (procedure === 'votingPower.ofProposal')
      return reply({
        proposalId: input.proposalId,
        power: state.stake,
        reason: state.stake === '0' ? 'no_stake_at_creation' : null,
        takenAt: state.stake === '0' ? null : proposal.createdAt,
        rule: { minPower: '0', code: null },
        signing: { available: false, code: 'token.signed_vote_unavailable' },
      });
    if (procedure === 'accessOf') return reply({ staked: '40.75', tier: 'flex', feeDiscountBps: 0 });
    if (procedure === 'burnedSupply') return reply({ burned: '0' });
    if (['log.mine', 'session.log'].includes(procedure)) return reply([logRow]);
    if (procedure === 'usage.current') return reply({ windowId: at, pending: amount, sessionTotal: amount, assetId: 'USDT' });
    if (procedure === 'agent.get') return reply(null);
    return route.fulfill({ status: 503, json: { message: 'Isolated unconnected read' } });
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin) {
      state.external.push(url.href);
      return route.abort();
    }
    return route.fallback();
  });
  environments.set(context, state);
  return state;
}
async function login(page, path = '/view') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-locale');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function select(page, code) {
  await language(page).selectOption(code);
  await expect(language(page)).toHaveValue(code);
}
async function fallback(page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}
async function storageFault(page, mode) {
  await page.evaluate(
    ({ key, mode }) => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem;
      const before = get.call(localStorage, key);
      window.originalLocaleGet = get;
      window.restoreLocaleStorage = () => {
        Storage.prototype.getItem = get;
        Storage.prototype.setItem = set;
      };
      if (mode === 'write')
        Storage.prototype.setItem = function (name, value) {
          if (name === key) throw new Error('isolated locale write failure');
          return set.call(this, name, value);
        };
      else
        Storage.prototype.getItem = function (name) {
          if (name === key) {
            if (mode === 'read') throw new Error('isolated locale readback failure');
            return before;
          }
          return get.call(this, name);
        };
    },
    { key: preferenceKey, mode },
  );
}
test.afterEach(async ({ context }, info) => {
  const state = environments.get(context);
  expect(state.errors).toEqual([]);
  expect(state.external).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: state.errors, productWrites: state.writes, reads: state.reads });
});
test.afterAll(() => writeFileSync(output + '/native-summary.json', JSON.stringify(summary, null, 2)));

for (const width of [1440, 390, 320])
  test('native View declared selection keyboard and honest fallback at ' + width, async ({ page, context, baseURL }) => {
    const state = await network(context, page, baseURL);
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await expect(language(page).locator('option')).toHaveCount(129);
    await language(page).focus();
    await page.keyboard.press('e');
    await page.keyboard.press('Enter');
    await expect(language(page)).toHaveValue('es');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await select(page, 'fr');
    await expect(page.getByRole('heading', { name: 'Général', exact: true })).toBeVisible();
    await select(page, 'ar');
    await fallback(page);
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    const helper = page.locator('[data-i18n="customer.account.view.language.fallback"]');
    await expect(helper).toContainText('Arabic is selected');
    await expect(helper).toHaveAttribute('lang', 'en');
    await expect(helper).toHaveAttribute('dir', 'ltr');
    await expect(page.getByText('Preferences saved on this device.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: output + '/view-ar-' + width + '.png', fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(state.writes).toEqual([]);
  });

for (const [raw, canonical] of [
  ['zh-CN', 'zh-Hans'],
  [' FR ', 'fr'],
  ['iw', 'he'],
  ['pt', 'pt-BR'],
])
  test('actual alias hydration without read rewriting: ' + raw, async ({ page, context, baseURL }) => {
    await network(context, page, baseURL);
    const bytes = JSON.stringify({ language: raw, theme: 'light', hideBalances: true, confirmSend: false });
    await context.addInitScript(
      ({ key, bytes }) => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, bytes);
      },
      { key: preferenceKey, bytes },
    );
    await login(page);
    await expect(language(page)).toHaveValue(canonical);
    expect(await stored(page)).toBe(bytes);
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await select(page, 'de');
    const saved = await stored(page);
    expect(JSON.parse(saved)).toMatchObject({ language: 'de', theme: 'light', hideBalances: true, confirmSend: false });
    await page.reload();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await login(page);
    await expect(language(page)).toHaveValue('de');
    expect(await stored(page)).toBe(saved);
    await fallback(page);
  });

test('independent tabs use current valid storage and refuse malformed replacement without writes', async ({ page, context, baseURL }) => {
  const state = await network(context, page, baseURL);
  await login(page);
  await select(page, 'fr');
  const other = await context.newPage();
  await login(other);
  await select(other, 'ar');
  await expect(language(page)).toHaveValue('ar');
  await fallback(page);
  for (const raw of ['{bad', JSON.stringify({ language: 'zz-ZZ' }), JSON.stringify({ language: null })]) {
    await other.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: preferenceKey, raw });
    await expect(language(page)).toHaveValue('ar');
    expect(await stored(page)).toBe(raw);
  }
  await select(other, 'de');
  await expect(language(page)).toHaveValue('de');
  const current = await stored(page);
  await page.evaluate(
    ({ key, current }) =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key,
          oldValue: JSON.stringify({ language: 'ar' }),
          newValue: JSON.stringify({ language: 'es' }),
          storageArea: localStorage,
        }),
      ),
    { key: preferenceKey, current },
  );
  await expect(language(page)).toHaveValue('de');
  expect(await stored(page)).toBe(current);
  expect(state.writes).toEqual([]);
});

for (const mode of ['write', 'read', 'mismatch'])
  test('visit-only RAM survives actual ' + mode + ' persistence failure and opposing current save', async ({ page, context, baseURL }) => {
    const state = await network(context, page, baseURL);
    await login(page);
    await select(page, 'es');
    const before = await stored(page);
    await storageFault(page, mode);
    await select(page, 'ar');
    await fallback(page);
    await expect(page.getByText('Selected for this visit only. This browser can’t save it.', { exact: true })).toBeVisible();
    await expect(page.getByText('Preferences saved on this device.', { exact: true })).toHaveCount(0);
    if (mode === 'write') expect(await stored(page)).toBe(before);
    else expect(JSON.parse(await stored(page)).language).toBe('ar');
    await page.evaluate(() => window.restoreLocaleStorage());
    await select(page, 'de');
    await expect(page.getByText('Preferences saved on this device.', { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]);
  });

test('same-language successful external write retires obsolete visit-only acknowledgement', async ({ page, context, baseURL }) => {
  const state = await network(context, page, baseURL);
  await login(page);
  await select(page, 'es');
  await storageFault(page, 'write');
  await select(page, 'ar');
  await expect(page.getByText('Selected for this visit only. This browser can’t save it.', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await login(other);
  await select(other, 'ar');
  await expect(language(page)).toHaveValue('ar');
  await expect(page.getByText('Selected for this visit only. This browser can’t save it.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Preferences saved on this device.', { exact: true })).toHaveCount(0);
  expect(JSON.parse(await stored(page)).language).toBe('ar');
  expect(state.writes).toEqual([]);
});

test('cross-tab locale preserves staged private purchase and exact dispatched original with no replay', async ({
  page,
  context,
  baseURL,
}) => {
  const state = await network(context, page, baseURL);
  await login(page, '/market');
  await page.getByRole('button', { name: 'Buy ' + originalTitle, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(amount);
  await expect(dialog).toContainText(assetId);
  const oldDocument = await page.evaluate(() => performance.timeOrigin);
  const other = await context.newPage();
  await login(other);
  await select(other, 'ar');
  await fallback(page);
  await expect(dialog).toHaveAccessibleName('Review purchase');
  await expect(dialog.locator('[lang="en"]').first()).toBeVisible();
  await expect(dialog).toContainText(amount);
  await expect(dialog).toContainText(originalTitle);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(oldDocument);
  await dialog.getByRole('button', { name: 'Confirm purchase', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toEqual({ procedure: 'purchase', input: { listingId, purchaseId: state.writes[0].input.purchaseId } });
  const original = await stored(page, originalKey);
  expect(JSON.parse(original)).toMatchObject({ reference: state.writes[0].input.purchaseId });
  expect(original).not.toContain(amount);
  expect(original).not.toContain(originalDescription);
  await select(other, 'de');
  await fallback(page);
  expect(await stored(page, originalKey)).toBe(original);
  await expect(page.locator('[lang="und"]').filter({ hasText: originalDescription }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Check original outcome', exact: true }).click();
  await expect.poll(() => state.reads.filter((r) => r.procedure === 'myPurchases').length).toBeGreaterThan(1);
  expect(await stored(page, originalKey)).toBe(original);
  expect(state.writes).toHaveLength(1);
});

test('Academy strict original storage conflict stays byte-exact with authored English recovery', async ({ page, context, baseURL }) => {
  const state = await network(context, page, baseURL);
  const key = `intafaced:more:pending:${owner}:academy`;
  const original = JSON.stringify({
    id: originalId,
    title: 'Original opaque grant title',
    reference: `cert:${owner}:foundations`,
    operation: 'room',
  });
  await context.addInitScript(
    ({ key, original, preferenceKey }) => {
      localStorage.setItem(key, original);
      localStorage.setItem(preferenceKey, JSON.stringify({ language: 'ar' }));
    },
    { key, original, preferenceKey },
  );
  await login(page, '/academy');
  await fallback(page);
  const heading = page.getByRole('heading', { name: 'Recovery storage is unreadable', exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute('lang', 'en');
  expect(await stored(page, key)).toBe(original);
  expect(state.writes).toEqual([]);
});

test('Token authored current-stake refusal stays English and preserves original proposal/body', async ({ page, context, baseURL }) => {
  const state = await network(context, page, baseURL);
  await context.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ language: 'ar' })), preferenceKey);
  await login(page, '/token');
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect proposal ' + proposalId, exact: true }).click();
  await page.getByRole('button', { name: 'Review for', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(proposalId);
  state.stake = '0';
  await dialog.getByRole('button', { name: 'Cast vote', exact: true }).click();
  const refusal = page
    .locator('.failure')
    .getByText('You had no voting power when this proposal was created, so you cannot vote on it.', { exact: true });
  await expect(refusal).toBeVisible();
  expect(await refusal.evaluate((node) => node.closest('[lang]')?.getAttribute('lang'))).toBe('en');
  await expect(page.locator('.token-proposal-body')).toContainText(originalDescription);
  expect(state.writes).toEqual([]);
  await fallback(page);
});

test('Agents hidden cost uses actual English metadata while exact service values remain intact', async ({ page, context, baseURL }) => {
  const state = await network(context, page, baseURL);
  await context.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ language: 'ar', hideBalances: true })), preferenceKey);
  await login(page, '/agents');
  await page.getByRole('button', { name: 'Inspect session', exact: true }).click();
  const hidden = page.locator('.agent-session-history dd').filter({ hasText: /^Hidden$/ });
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toHaveAttribute('lang', 'en');
  expect(state.reads.some((r) => r.procedure === 'session.log' && r.input.sessionId === originalId)).toBe(true);
  expect(logRow.cost).toBe(amount);
  expect(state.writes).toEqual([]);
  await fallback(page);
});

test('ordinary Trade wrapper keeps empty Arabic request in English LTR without original writes', async ({ page, context, baseURL }) => {
  const state = await network(context, page, baseURL);
  await context.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ language: 'ar' })), preferenceKey);
  await login(page, '/exchange');
  await expect(page.locator('.trade-root')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.trade-root')).toHaveAttribute('dir', 'ltr');
  await fallback(page);
  expect(state.writes).toEqual([]);
});
