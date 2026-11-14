// World: stack, restart
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { signIn, signUp } from './desk.mjs';
import { nextCode } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, verifiedBusiness } from './merchant.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, tool } from './stack.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { rooms } from '../../src/app/navigation.ts';
import { isHiddenPath } from '../../src/app/feature-registry.ts';

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
  return menu.locator('a').evaluateAll((links) =>
    links.map((link) => ({
      href: link.getAttribute('href'),
      title: link.querySelector('strong')?.textContent?.trim() ?? '',
      advanced: Boolean(link.closest('ul[aria-label="Advanced"]')),
    })),
  );
}

/**
 * Runs `fn` with svc-ops restarted on one owner value blank (`LOCAL_STACK_OPS_<NAME>=off`,
 * tooling/scripts/local-stack-services/ops.mjs), and restarts it on the TEST value after, even when `fn` fails.
 */
async function withOpsValueBlank(key, fn) {
  const restart = (value) => {
    const before = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      tool('local-test-stack.mjs', 'restart', 'ops');
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  };
  restart('off');
  try {
    return await fn();
  } finally {
    restart(undefined);
  }
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
  test.setTimeout(300_000);
  // Every row of each door's dropdown for a signed-in person, in order (the app's menu table, apps/customer/src/app/menus.ts);
  // `true` marks a row that sits under the Advanced heading in Simple.
  const MENUS = {
    Money: [
      ['/money'],
      ['/uc/recharge'],
      ['/uc/withdraw'],
      ['/bank/transfers'],
      ['/bank/spaces'],
      ['/bank/cards'],
      ['/bank/earn'],
      ['/bank/loans'],
      ['/money/activity'],
      ['/money/pnl', true],
      ['/uc/withdraw/address', true],
      ['/bank/ramps', true],
      ['/bank/analytics', true],
      ['/bank/business', true],
    ],
    Trade: [
      ['/trade'],
      ['/trade/spot/BTC-USDT'],
      ['/trade/buy'],
      ['/trade/convert'],
      ['/trade/margin', true],
      ['/trade/futures', true],
      ['/trade/options', true],
      ['/trade/copy', true],
      ['/trade/bots', true],
      ['/otc', true],
      ['/execution', true],
      ['/quant', true],
      ['/quant/editor', true],
      ['/money/activity?tab=orders', true],
    ],
    Pay: [['/pay/send'], ['/pay/receive'], ['/pay/request'], ['/pay/bills'], ['/pay/global'], ['/p2p'], ['/pay/merchant']],
    More: [['/academy'], ['/more'], ['/support'], ['/view']],
  };
  const hrefs = (door) => MENUS[door].map(([href]) => href);
  const advancedOf = (door) => MENUS[door].filter(([, advanced]) => advanced).map(([href]) => href);
  await signIn(page, who);
  await chooseLayout(page, 'Pro');
  // Five doors (owner decision 2026-10-26, "One Money door"): Assets and Bank are one Money door.
  const DOORS = ['Home', 'Money', 'Trade', 'Pay', 'More'];
  await expect(mainNav(page).getByTestId('tb-tab')).toHaveText(DOORS);

  // Pro: every door lists every one of its rows, in order, flat (no Advanced group); Home is a plain link.
  const pro = {};
  for (const door of Object.keys(MENUS)) {
    pro[door] = await dropdown(page, door);
    expect(
      pro[door].map((row) => row.href),
      `${door} in Pro`,
    ).toEqual(hrefs(door));
    expect(
      pro[door].some((row) => row.advanced),
      `${door} in Pro has an Advanced group`,
    ).toBe(false);
  }
  // Money holds the holdings and the bank's rooms alike, the portfolio first.
  expect(pro.Money[0].href).toBe('/money');
  expect(pro.Money.map((row) => row.href)).toEqual(
    expect.arrayContaining(['/uc/recharge', '/uc/withdraw', '/bank/spaces', '/bank/earn', '/bank/loans', '/bank/cards']),
  );

  // /bank opens the Bank's own overview and stays there: not the Money page.
  await page.goto('/bank');
  await expect(page).toHaveURL(/\/bank$/);
  await expect(page.locator('main h1').first()).toHaveText('Bank');
  await page.goto('/money');
  await expect(page).toHaveURL(/\/money$/);
  await expect(page.locator('main h1').first()).not.toHaveText('Bank');

  // Simple: the same rows in every door, the advanced ones under their own Advanced heading.
  await chooseLayout(page, 'Simple');
  const advanced = [];
  for (const door of Object.keys(MENUS)) {
    const simple = await dropdown(page, door);
    expect(simple.map((row) => row.href).sort(), `${door} in Simple`).toEqual([...hrefs(door)].sort());
    expect(
      simple.filter((row) => row.advanced).map((row) => row.href),
      `${door}'s Advanced group`,
    ).toEqual(advancedOf(door));
    advanced.push(...simple.filter((row) => row.advanced));
  }

  // Every room in Simple is still reachable by its address and by the header search, the advanced ones included. A
  // Business-only room (Business approvals, /bank/business) is the exception for search in Personal mode, as #7 says; it
  // is still reached by its address here.
  const BUSINESS_ONLY = new Set(['/bank/business']);
  // Search lists a room by its name in the route table (apps/customer/src/app/navigation.ts). Two rows carry a menu label of
  // their own: the room they open is named here.
  const ROOM_NAME = { '/quant/editor': 'Code editor', '/money/activity?tab=orders': 'Activity' };
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const { href, title } of advanced) {
    expect(title, `${href} has a title in its row`).not.toBe('');
    await page.goto(href);
    await expect(page, `${href} by address`).toHaveURL(new RegExp(`${escape(href.split('?')[0])}(\\?|$)`));
    await expect(page.locator('main'), `${href} by address`).not.toBeEmpty();
    if (BUSINESS_ONLY.has(href)) continue;
    await page.goto('/home');
    const name = ROOM_NAME[href] ?? title;
    const panel = await search(page, name);
    await expect(panel.getByRole('option', { name: new RegExp(escape(name)) }).first(), `${name} (${href}) by search`).toBeVisible();
  }

  // On a phone the same five doors sit in the bottom bar, in the same order, More included.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneBar = page.getByRole('navigation', { name: 'Customer doors on phone' });
  await expect(phoneBar.getByRole('link')).toHaveText(DOORS);
  await phoneBar.getByRole('link', { name: 'More' }).click();
  await expect(page).toHaveURL(/\/more$/);
});

// #2's route table: the app's one list of rooms (apps/customer/src/app/navigation.ts), read here as the app reads it.
// A room is a page of its own when it is no alias, no parameter route, not hidden from search, not a founder desk and not
// one of the merchant portal's inner pages (reached from Merchant home; Merchant home and Business approvals are the way in).
// It is listed under its door, or under Web3, Account or Information for the rooms outside every door.
const ownPage = (room) =>
  !room.alias &&
  !room.hidden &&
  room.area !== 'team' &&
  !/[:*]/.test(room.path) &&
  (!room.business || room.path === '/pay/merchant' || room.path === '/bank/business') &&
  !isHiddenPath(room.path);
const groupOf = (room) =>
  room.area === 'public' ? 'Information' : room.area === 'web3' ? 'Web3' : room.area === 'person' ? 'Account' : room.door;
// What each Web3 tile's blocker words mean, and where its room lists that blocker in full: the room tab and the action.
const WEB3 = [
  {
    href: '/dex',
    name: 'DEX',
    words: { 'nothing submits trades': ['/dex', 'swap', 'no_execution_path'], 'not audited': ['/dex', 'swap', 'not_audited'] },
  },
  {
    href: '/chain',
    name: 'Chain',
    words: {
      'no chain service': ['/chain/validators', 'stake', 'no_chain_service'],
      'not audited': ['/chain/validators', 'stake', 'not_audited'],
    },
  },
  {
    href: '/protocol',
    name: 'Protocol',
    words: {
      'not audited': ['/protocol', 'smartAccount', 'not_audited'],
      'no bridge service': ['/protocol/rails', 'bridge', 'no_bridge_service'],
    },
  },
];

test(`${J} #2 More and All services list every room from the one route table, with the Web3 rooms and their blockers`, async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, who);
  await page.goto('/more');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'More' })).toBeVisible();

  // All services: one link for every room of the route table that is a page of its own, under its group, and nothing else.
  const index = main.locator('section[aria-labelledby="more-all-services"]');
  await expect(index.getByRole('heading', { name: 'All services' })).toBeVisible();
  const expected = new Map();
  for (const room of rooms.filter(ownPage)) {
    const group = groupOf(room);
    if (!group) throw new Error(`${room.path} has no door or area group`);
    if (![...expected.values()].some((paths) => paths.includes(room.path)))
      expected.set(group, [...(expected.get(group) ?? []), room.path]);
  }
  expect([...expected.values()].flat().length, 'rooms in the route table that are pages of their own').toBeGreaterThan(100);
  const shown = await index.locator('section[aria-labelledby^="more-index-"]').evaluateAll((groups) =>
    groups.map((group) => ({
      id: group.getAttribute('aria-labelledby').replace('more-index-', ''),
      links: [...group.querySelectorAll('a')].map((link) => ({ href: link.getAttribute('href'), text: link.textContent.trim() })),
    })),
  );
  expect(shown.map((group) => group.id).sort(), 'the groups').toEqual([...expected.keys()].sort());
  for (const group of shown) {
    expect(group.links.map((link) => link.href).sort(), `${group.id}: a link for every room, and only those`).toEqual(
      [...expected.get(group.id)].sort(),
    );
    for (const link of group.links) expect(link.text, `${link.href} is named`).not.toBe('');
  }

  // No hand-edited list: the index follows the route table, so rooms with no More tile are listed all the same. A room added
  // to the table is in `expected` on the next run and must show here, with no tile edit.
  const tiles = new Set(await main.getByTestId('more-tile').evaluateAll((links) => links.map((link) => link.getAttribute('href'))));
  const untiled = [...expected.values()].flat().filter((path) => !tiles.has(path));
  expect(untiled.length, 'rooms listed with no tile of their own').toBeGreaterThan(50);
  for (const path of untiled) await expect(index.locator(`a[href="${path}"]`), `${path} listed without a tile`).toHaveCount(1);

  // Web3: /dex, /chain and /protocol are tiles in the Web3 section, each naming its blockers, and are listed under Web3.
  const web3 = main.locator('section[aria-labelledby="more-web3"]');
  await expect(web3.getByRole('heading', { name: 'Web3' })).toBeVisible();
  const web3Index = index.locator('section[aria-labelledby="more-index-Web3"]');
  for (const { href, name, words } of WEB3) {
    const tile = web3.locator(`a[href="${href}"]`);
    await expect(tile, `${href} tile under Web3`).toHaveCount(1);
    await expect(tile.getByTestId('more-tile__title')).toHaveText(name);
    const line = tile.getByTestId('more-tile__line');
    await expect(line, `${href} names its blockers`).toHaveText(`Blocked: ${Object.keys(words).join(' · ')}`);
    expect(await line.evaluate((node) => node.scrollWidth <= node.clientWidth), `${href}'s blockers are read whole`).toBe(true);
    await expect(web3Index.locator(`a[href="${href}"]`), `${href} listed under Web3`).toHaveText(name);
  }
  await expect(index.getByRole('link', { name: 'chain', exact: true })).toHaveCount(0);

  // Each blocker a tile names is one its room lists in full, for the room's own action.
  for (const { href, words } of WEB3) {
    for (const [word, [at, action, code]] of Object.entries(words)) {
      await page.goto(at);
      const row = page.locator(`main [data-action="${action}"]`);
      await expect(row.getByRole('button').first(), `${href}: ${action} is refused`).toBeDisabled();
      await row.locator('summary').click();
      await expect(row.locator(`[data-blocker="${code}"]`).first(), `${href} "${word}": its room lists ${code}`).toBeVisible();
    }
  }

  // A tile opens its room, which is all there with honest labels: never INTACHAIN, never "coming soon".
  await page.goto('/more');
  await web3.locator('a[href="/chain"]').click();
  await expect(page).toHaveURL(/\/chain$/);
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
  // Planted fault 7, after every assertion above has run: on main only, it fails here until the automatic revert of
  // this commit merges.
  if (process.env.GITHUB_REF === 'refs/heads/main') throw new Error('planted fault: J-home-ia-02 #3 fails on main until its revert merges');
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
  test.setTimeout(240_000);
  await signIn(page, who);
  // The result limit is an owner value. With it blank on the running stack (svc-ops restarted without it), Help says
  // why it lists no articles and still offers Help itself.
  await withOpsValueBlank('LOCAL_STACK_OPS_HOME_SEARCH_RESULT_CAP', async () => {
    await page.goto('/home');
    const unset = await search(page, ARTICLE);
    await expect(
      unset.getByRole('status').filter({ hasText: 'Help articles are hidden: no limit for the number of results is set.' }),
    ).toBeVisible();
    await expect(unset.getByRole('option', { name: ARTICLE, exact: true })).toHaveCount(0);
    await unset.getByRole('option', { name: 'Open Help', exact: true }).click();
    await expect(page).toHaveURL(/\/support$/);
  });

  // With the limit set, the article is listed under Help by the title a person reads, and opens.
  await page.goto('/home');
  const panel = await search(page, ARTICLE);
  const article = panel.getByRole('option', { name: ARTICLE, exact: true });
  await expect(article).toBeVisible(UNBUILT);
  await article.click();
  await expect(page).toHaveURL(/\/helpdetail\?id=kb-account-access/);
  await expect(page.locator('main')).toContainText(ARTICLE);
});

/** The founders' search-miss total on the console's Notify desk (svc-notify `navMetrics.searchMisses`, admin:read). */
async function founderMisses(page) {
  await page.goto(`${ADMIN}/notify`);
  const panel = page.getByTestId('search-misses');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('search-misses-failed')).toHaveCount(0);
  const text = await panel.getByTestId('search-misses-total').innerText();
  const m = /^(\d+) miss(es)? from /.exec(text);
  if (!m) throw new Error(`the founders' search-miss total reads "${text}"`);
  return { total: Number(m[1]), panel };
}

test(`${J} #6 a search that finds nothing says so plainly, and one miss is counted for the founders without who searched`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  // The founders' count before this person's miss, read where the founders read it.
  const desk = await (await browser.newContext()).newPage();
  await founderSignIn(desk, 'a');
  const before = await founderMisses(desk);
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

  // The founders' desk now counts this miss (others' misses may land too, so at least one more), and what it shows is a
  // count per day: neither the words searched nor who searched appear anywhere on it.
  await expect.poll(async () => (await founderMisses(desk)).total, { timeout: 30_000 }).toBeGreaterThan(before.total);
  const after = await founderMisses(desk);
  await expect(after.panel).not.toContainText(words);
  await expect(after.panel).not.toContainText(RUN);
  await expect(after.panel).not.toContainText(who.email);
  await expect(after.panel).not.toContainText(who.handle);
  await desk.context().close();
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
