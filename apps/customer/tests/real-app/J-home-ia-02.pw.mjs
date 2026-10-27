import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { nextCode } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, verifiedBusiness } from './merchant.mjs';
import { DEVICE_KEY, EDGE, ORIGIN } from './stack.mjs';

// J-home-ia-02, in the running app (docs/roadmap/journeys.json): I find any room I need. Tests titled "J-home-ia-02 #<n>"
// prove a whole step. One TEST person, signed up once; the signed-out step uses a fresh browser. #7's Business half makes
// its own verified TEST merchant with one TEST card payment, and a TEST business profile to search from.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5: svc-support's help search matches an article's id and keys, not the title a person reads, so typing the title
//   lists nothing under Help.
// - #6: the header search sends no search-miss count (kind `search_miss`) when nothing is found.
// - #7: in Business mode the header search does not look up merchant payments by id.
const J = 'J-home-ia-02';
const RUN = Date.now().toString(36);
const UNBUILT = { timeout: 5_000 };
// A published help article in the platform's own catalogue (svc-support kb-catalog, kb-account-access).
const ARTICLE = 'Sign-in and account access';

// Not serial: a step that is not built yet fails alone and the next worker signs a new person up and goes on.
test.describe.configure({ mode: 'default' });

let who;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  who = await signUp(page, 'nav');
  await page.close();
});

const mainNav = (page) => page.getByRole('navigation', { name: 'Main navigation' });

/** The rows of one top-bar door's dropdown, as { href, group } (group is the Advanced heading when the row sits under it). */
async function dropdown(page, door) {
  const item = mainNav(page)
    .getByTestId('tb-item')
    .filter({ has: page.locator('[data-testid="tb-tab"]', { hasText: new RegExp(`^${door}$`) }) });
  await item.hover();
  const menu = item.getByRole('group', { name: door });
  await expect(menu).toBeVisible();
  return menu
    .locator('a')
    .evaluateAll((links) =>
      links.map((link) => ({ href: link.getAttribute('href'), advanced: Boolean(link.closest('ul[aria-label="Advanced"]')) })),
    );
}

/** Type into the header search and return its open results panel. */
async function search(page, words) {
  const box = page.getByRole('combobox', { name: 'Search markets' });
  await box.fill(words);
  const panel = page.getByTestId('tb-search-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Pick Simple or Pro in Settings (a choice kept on this device). */
async function chooseLayout(page, mode) {
  await page.goto('/view');
  const option = page.getByRole('group', { name: 'Default view' }).getByRole('button', { name: mode, exact: true });
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/home');
}

test(`${J} #1 the top bar has five doors with full dropdowns, the same five on the phone bar; /bank is its own room; Simple groups Advanced, Pro lists every row`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await chooseLayout(page, 'Pro');
  // Five doors (owner decision 2026-10-26, "One Money door"): Assets and Bank are one Money door.
  await expect(mainNav(page).getByTestId('tb-tab')).toHaveText(['Home', 'Money', 'Trade', 'Pay', 'More']);

  // Every door's rows open live rooms; Money holds the holdings and the bank's rooms alike.
  const money = await dropdown(page, 'Money');
  expect(money[0].href).toBe('/money');
  expect(money.map((row) => row.href)).toEqual(
    expect.arrayContaining(['/uc/recharge', '/uc/withdraw', '/bank/spaces', '/bank/earn', '/bank/loans', '/bank/cards']),
  );
  for (const door of ['Pay', 'More']) expect((await dropdown(page, door)).length).toBeGreaterThan(2);

  // Pro: every Trade row is listed flat.
  const pro = await dropdown(page, 'Trade');
  expect(pro.some((row) => row.advanced)).toBe(false);
  expect(pro.map((row) => row.href)).toEqual(expect.arrayContaining(['/trade/futures', '/trade/options', '/quant']));

  // /bank opens the Bank's own overview and stays there.
  await page.goto('/bank');
  await expect(page).toHaveURL(/\/bank$/);
  await expect(page.locator('main h1').first()).toHaveText('Bank');

  // Simple: the same rows, the advanced ones under their own heading; each is still reachable by address and by search.
  await chooseLayout(page, 'Simple');
  const simple = await dropdown(page, 'Trade');
  expect(simple.map((row) => row.href).sort()).toEqual(pro.map((row) => row.href).sort());
  const advanced = simple.filter((row) => row.advanced).map((row) => row.href);
  expect(advanced).toEqual(expect.arrayContaining(['/trade/futures', '/trade/options']));
  await page.goto('/trade/futures');
  await expect(page).toHaveURL(/\/trade\/futures/);
  await expect(page.locator('main')).not.toBeEmpty();
  await page.goto('/home');
  const panel = await search(page, 'futures');
  await expect(panel.getByRole('option', { name: /Futures/ }).first()).toBeVisible();
  // Simple: Money's rarely used rows sit under Advanced too.
  const moneySimple = await dropdown(page, 'Money');
  expect(moneySimple.filter((row) => row.advanced).map((row) => row.href)).toEqual(expect.arrayContaining(['/money/pnl', '/bank/ramps']));

  // On a phone the same five doors sit in the bottom bar, in the same order, More included.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneBar = page.getByRole('navigation', { name: 'Customer doors on phone' });
  await expect(phoneBar.getByRole('link')).toHaveText(['Home', 'Money', 'Trade', 'Pay', 'More']);
  await phoneBar.getByRole('link', { name: 'More' }).click();
  await expect(page).toHaveURL(/\/more$/);
});

test(`${J} #2 More and All services list every room from the one route table, with the Web3 rooms and their blockers`, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await page.goto('/more');
  const main = page.locator('main');
  // The Web3 section: DEX, Chain and Protocol, each saying what it is and what blocks it.
  for (const [href, name] of [
    ['/dex', 'DEX'],
    ['/chain', 'Chain'],
    ['/protocol', 'Protocol'],
  ]) {
    const tile = main.locator(`a[href="${href}"]`).first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(name);
  }
  // All services: a row for each room in the route table, by area; the Web3 rooms are named as rooms, not route slugs.
  const all = main.getByRole('heading', { name: 'All services' });
  await expect(all).toBeVisible();
  for (const name of ['Earn', 'Loans', 'Futures', 'Send globally', 'Merchant home', 'Academy', 'Chain', 'DEX', 'Protocol', 'Help centre'])
    await expect(main.getByRole('link', { name, exact: true }).first()).toBeVisible();
  await expect(main.getByRole('link', { name: 'chain', exact: true })).toHaveCount(0);

  // Every tile opens its room.
  await main.locator('a[href="/chain"]').first().click();
  await expect(page).toHaveURL(/\/chain$/);
  // The room is all there with honest labels: it never calls Base INTACHAIN and says what it cannot show, never "coming soon".
  await expect(page.locator('main h1')).toHaveText('Chain');
  await expect(page.locator('main')).toContainText('Not INTACHAIN · not audited');
  await expect(page.locator('main')).not.toContainText(/coming soon/i);
});

test(`${J} #3 typing "earn" in the header search shows Money > Earn, and Enter opens it`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/home');
  const panel = await search(page, 'earn');
  const row = panel.getByRole('option').filter({ hasText: 'Money > Earn' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Earn');
  // The first page row is Earn; Enter opens the active row.
  await expect(panel.getByRole('option').first()).toContainText('Earn');
  await page.getByRole('combobox', { name: 'Search markets' }).press('Enter');
  await expect(page).toHaveURL(/\/bank\/earn/);
});

test(`${J} #4 typing "chain" lists the parked room and says it opens to its blockers`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/home');
  const panel = await search(page, 'chain');
  const row = panel.getByRole('option').filter({ hasText: 'More > Chain' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Opens to its blockers');
  await row.click();
  await expect(page).toHaveURL(/\/chain$/);
});

test(`${J} #5 typing a help article's title lists it under Help and opens it; with no help result limit set the search says so and still offers Help`, async ({
  page,
}) => {
  await signIn(page, who);
  // The result limit is an owner value. While it is blank (as it is until the owner sets it), Help says why it lists no
  // articles and still offers Help itself. The stack publishes a TEST limit, so this part answers home.config as blank.
  const blankCap = async (route) => {
    if (!route.request().url().includes('home.config')) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    // Only home.config's answer is changed; any other answer in a batch, or an error, goes through as it came.
    const blank = (one) =>
      one?.result?.data && 'searchResultCap' in one.result.data
        ? { ...one, result: { ...one.result, data: { ...one.result.data, searchResultCap: null } } }
        : one;
    await route.fulfill({ response: res, json: Array.isArray(body) ? body.map(blank) : blank(body) });
  };
  await page.route('**/api/ops/trpc/**', blankCap);
  await page.goto('/home');
  const unset = await search(page, ARTICLE);
  await expect(
    unset.getByRole('status').filter({ hasText: 'Help articles are hidden: no limit for the number of results is set.' }),
  ).toBeVisible();
  await unset.getByRole('option', { name: 'Open Help', exact: true }).click();
  await expect(page).toHaveURL(/\/support$/);
  await page.unroute('**/api/ops/trpc/**', blankCap);

  // With the limit set, the article is listed under Help by the title a person reads, and opens.
  await page.goto('/home');
  const panel = await search(page, ARTICLE);
  const article = panel.getByRole('option', { name: ARTICLE, exact: true });
  await expect(article).toBeVisible(UNBUILT);
  await article.click();
  await expect(page).toHaveURL(/\/helpdetail\?id=kb-account-access/);
  await expect(page.locator('main')).toContainText(ARTICLE);
});

test(`${J} #6 a search that finds nothing says so plainly, and one miss is counted for the founders without who searched`, async ({
  page,
}) => {
  await signIn(page, who);
  await page.goto('/home');
  const counted = [];
  page.on('request', (req) => {
    if ((req.postData() ?? '').includes('search_miss')) counted.push(req.postData());
  });
  const words = `zq nothing ${RUN}`;
  const panel = await search(page, words);
  await expect(panel.getByRole('status').filter({ hasText: `No results for "${words}"` })).toBeVisible();
  // Help is still offered, so a miss has somewhere to go.
  await expect(panel.getByRole('option', { name: 'Open Help', exact: true })).toBeVisible();

  // One count of kind search_miss goes to the founders' metrics desk (HM-desks-02), carrying neither the account nor
  // the words searched (storing the words is a separate owner switch, off while blank).
  await expect.poll(() => counted.length, UNBUILT).toBe(1);
  expect(counted[0]).not.toContain(words);
  expect(counted[0]).not.toContain(RUN);
  expect(counted[0]).not.toContain(who.email);
  expect(counted[0]).not.toContain(who.handle);
});

/** A stable uuid for a journey key, so a create sent again in this run names the same record (idempotency keys are business keys). */
function uuidOf(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One authenticated call through Edge as `who`; the answer's data, or an error naming the refusal. */
async function call(route, token, body) {
  const res = await fetch(`${EDGE}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: ORIGIN,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!res.ok || !json?.result) throw new Error(`${route} refused: ${res.status} ${text.slice(0, 300)}`);
  return json.result.data;
}

test(`${J} #7 in Business mode a merchant payment id finds the payment; in Personal mode Business-only rooms are absent from search`, async ({
  browser,
  page,
}) => {
  test.setTimeout(600_000);
  // Personal: Business-only rooms such as Payouts are not offered. The search has settled once Help has answered.
  await signIn(page, who);
  await page.goto('/home');
  const personal = await search(page, 'payouts');
  await expect(personal.getByRole('option', { name: 'Open Help', exact: true })).toBeVisible();
  await expect(personal.getByRole('status').filter({ hasText: 'Searching Help' })).toHaveCount(0);
  await expect(personal.getByRole('option', { name: /Payouts/ })).toHaveCount(0);

  // Business: a verified TEST merchant takes one TEST card payment, and its owner, in a browser of its own, switches to a
  // TEST business profile.
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  try {
    const owner = await context.newPage();
    const person = await businessReadyPerson(owner, 'nav7', '/pay/onboarding');
    const merchantId = await openBusiness(owner, person, `TEST Search ${RUN}`);
    await verifiedBusiness(owner, person, merchantId);
    const { code, step } = await nextCode(person.totp, person.secret, person.step);
    person.step = step;
    const login = await call('/api/identity/trpc/auth.login', null, {
      deviceKey: DEVICE_KEY,
      identifier: person.email,
      password: person.password,
      totpCode: code,
    });
    const payment = await call('/api/pay/trpc/payment.create', login.accessToken, {
      requestId: uuidOf(`${J}:payment:${RUN}`),
      merchantId,
      amount: '12.00',
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      customerRef: `TEST-${RUN}`,
      metadata: { reference: `${J}-${RUN}` },
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await call('/api/bank/trpc/business.create', login.accessToken, {
      accountId: uuidOf(`${J}:business:${RUN}`),
      name: `TEST Search ${RUN}`,
      assetId: 'USDT',
      spendThreshold: '10',
    });
    await owner.goto('/home');
    await owner.getByRole('button', { name: 'Account menu' }).click();
    await owner
      .getByTestId('profile-business')
      .filter({ hasText: `TEST Search ${RUN}` })
      .click();
    await expect(owner).toHaveURL(/\/pay\/merchant/);
    // The merchant portal has no header search; Home does, and the profile stays Business.
    await owner.goto('/home');

    // Business rooms are offered now, and the payment is found by its id and opens its record.
    const business = await search(owner, 'payouts');
    await expect(business.getByRole('option', { name: /Payouts/ }).first()).toBeVisible();
    const found = await search(owner, payment.id);
    const row = found.getByRole('option').filter({ hasText: payment.id });
    await expect(row).toBeVisible(UNBUILT);
    await row.click();
    await expect(owner).toHaveURL(new RegExp(payment.id));
  } finally {
    await context.close();
  }
});

test(`${J} #8 a deep link while signed out: public rooms open, private rooms ask to sign in and come back to the same room`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // Public rooms open as they are.
  for (const path of ['/help', '/trade']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText('Sign in to continue')).toHaveCount(0);
  }
  // A private room, with its query, asks to sign in and then opens exactly that room.
  const target = '/money?asset=BTC';
  await page.goto(target);
  await expect(page.getByText('Sign in to continue')).toBeVisible();
  await page.locator('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(new RegExp(`${target.replace('?', '\\?')}$`));
  await expect(page.getByText('Sign in to continue')).toHaveCount(0);
  await context.close();
});
