// World: gates
import { randomBytes, randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, mailedLines, signUpInBrowser, tool } from './stack.mjs';

// J-identity-10, in the running app (docs/roadmap/journeys.json): I set my language, display and notification choices.
// Starts signed in on device A, and signed in again on device B later. Ends with the same language, display currency and
// notification choices on both devices, and security notices that cannot be turned off. Moves no money.
// Independent tests (OWNER 212): written from the step's own words, not from the build. Each checks every clause of its
// step; a clause the product has no part for yet is written against what the person sees, with stable names to build to.
const J = 'J-identity-10';

// The device copy of the display choices (apps/customer/src/shared/preferences.ts).
const DEVICE_COPY = 'intafaced.customer.view.v1';
// Words a person should never read on these pages: service, code and build words.
const INTERNAL =
  /\bfixture|lifecycle|\bledger\b|partition|identity service|\bnamespace\b|\buserId\b|\bprincipal\b|\btrpc\b|\bsvc-|\b(identity|notify|vendor|preferences|rank)\.[a-z_]+|\bI-[a-z]+-[a-z-]+-\d+/i;

function person(prefix = 'pf') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** Sign in on this browser the way a person does, from /login. */
async function signIn(page, who) {
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The account's own record in one identity preferences namespace (null when nothing is stored). */
async function stored(client, namespace) {
  const input = encodeURIComponent(JSON.stringify({ namespace }));
  const res = await client.get(`/api/identity/trpc/preferences.get?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A write to identity's preferences door, as any client could send it. */
async function setPreference(client, namespace, value) {
  const { version } = await stored(client, namespace);
  return client.post('/api/identity/trpc/preferences.set', {
    namespace,
    value,
    ifVersion: version,
    clientRequestId: `${J}-${namespace}-${randomUUID()}`,
  });
}

/** svc-notify's own read for this person, through Edge. */
async function notifyRead(client, procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await client.get(`/api/notify/trpc/${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Every request this page sends to identity's preferences door, from now on. */
function watchPreferenceCalls(page) {
  const calls = [];
  page.on('request', (req) => {
    if (/\/api\/identity\/trpc\/[^?]*preferences\./.test(req.url())) calls.push(`${req.method()} ${req.url()}`);
  });
  return calls;
}

test(`${J} #1 opens Account and copies my UID: the UID in mono type with a Copy button, the rank card, no internal words`, async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const who = person('pfa');
  await signUpInBrowser(page, who);
  const { userId } = await api(who);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/uc/account');

  // The UID is the account's own id, shown whole, in a monospace face.
  const section = page.locator('section[aria-label="Account ID"]');
  const uid = section.getByTestId('subaccounts__ref');
  await expect(uid).toHaveText(userId);
  expect(await uid.evaluate((node) => getComputedStyle(node).fontFamily), 'the UID is set in mono type').toMatch(/mono/i);

  // Copy puts exactly that UID on the clipboard and says so.
  const copy = section.getByRole('button', { name: 'Copy account ID' });
  await expect(copy).toHaveText('Copy');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(userId);

  // The rank card is on the page, loaded.
  const rank = page.getByTestId('rank-perks');
  await expect(rank).toBeVisible();
  await expect(rank).toContainText(/Rank \d+/);

  // No internal words anywhere on Account.
  await expect(page.getByTestId('acct')).toBeVisible();
  expect(await page.getByTestId('acct').innerText()).not.toMatch(INTERNAL);
});

test(`${J} #2 picks Spanish and a display currency: applies at once and on device B after sign-in; one not offered is refused; signed out only the browser cache applies and nothing is sent`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const who = person('pfl');
  await signUpInBrowser(page, who);
  const client = await api(who);

  // Device A: the Display screen offers a display currency and the languages with written copy.
  await page.goto('/view');
  const currency = page.getByRole('combobox', { name: 'Display currency', exact: true });
  await expect(currency, 'the Display screen offers a display currency').toBeVisible();
  await currency.selectOption('BTC');
  await expect(currency).toHaveValue('BTC');
  const language = page.getByRole('combobox', { name: 'Language', exact: true });
  await expect(language.locator('option[value="es"]')).toHaveCount(1);
  await language.selectOption('es');

  // Applies at once, without a reload: the page itself is Spanish now.
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('es');
  await expect(page.getByRole('combobox', { name: 'Idioma', exact: true })).toHaveValue('es');
  await expect(page.getByRole('combobox', { name: 'Moneda de visualización', exact: true })).toHaveValue('BTC');

  // Both choices reach the account.
  await expect.poll(async () => (await stored(client, 'account.display')).value?.locale ?? null, { timeout: 20_000 }).toBe('es');
  const accountCurrency = async () =>
    (await stored(client, 'account.display')).value?.displayCurrency ?? (await stored(client, 'ui.view')).value?.displayCurrency ?? null;
  await expect.poll(accountCurrency, { timeout: 20_000 }).toBe('BTC');

  // Device B, later: a browser with no copy of its own shows Spanish and BTC once the person signs in there.
  const deviceB = await browser.newContext();
  try {
    const pageB = await deviceB.newPage();
    await signIn(pageB, who);
    await pageB.goto('/view');
    await expect.poll(() => pageB.evaluate(() => document.documentElement.lang), { timeout: 20_000 }).toBe('es');
    await expect(pageB.getByRole('combobox', { name: 'Idioma', exact: true })).toHaveValue('es');
    await expect(pageB.getByRole('combobox', { name: 'Moneda de visualización', exact: true })).toHaveValue('BTC');
  } finally {
    await deviceB.close();
  }

  // A language or a currency the app does not offer is refused by the account, and nothing changes.
  const before = await stored(client, 'account.display');
  await page.goto('/view');
  const offered = await page
    .getByRole('combobox', { name: 'Idioma', exact: true })
    .locator('option')
    .evaluateAll((os) => os.map((o) => o.value));
  expect(offered, 'German has no written copy, so it is not offered').not.toContain('de');
  for (const value of [
    { locale: 'de', displayCurrency: before.value?.displayCurrency ?? null },
    { locale: 'xx-TEST', displayCurrency: before.value?.displayCurrency ?? null },
    { locale: 'es', displayCurrency: 'XYZ' },
  ]) {
    const refused = await setPreference(client, 'account.display', value);
    expect(refused.status, `${JSON.stringify(value)} is refused: ${JSON.stringify(refused.body).slice(0, 300)}`).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
  }
  const viewRefused = await setPreference(client, 'ui.view', { displayCurrency: 'XYZ' });
  expect(viewRefused.status, JSON.stringify(viewRefused.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
  expect(viewRefused.status).toBeLessThan(500);
  expect((await stored(client, 'account.display')).value).toEqual(before.value);
  expect(await accountCurrency()).toBe('BTC');

  // Signed out, in a browser of its own: the choice applies from this browser's cache only, and nothing is sent.
  const visitor = await browser.newContext();
  try {
    const out = await visitor.newPage();
    const calls = watchPreferenceCalls(out);
    await out.goto('/login');
    const pick = out.getByRole('combobox', { name: 'Language', exact: true });
    await expect(pick, 'a signed-out visitor can choose the language').toBeVisible();
    await pick.selectOption('es');
    await expect.poll(() => out.evaluate(() => document.documentElement.lang)).toBe('es');
    const cached = await out.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), DEVICE_COPY);
    expect(cached).toMatchObject({ language: 'es' });
    await out.reload();
    await expect.poll(() => out.evaluate(() => document.documentElement.lang)).toBe('es');
    await expect(out.getByRole('combobox', { name: 'Idioma', exact: true })).toHaveValue('es');
    expect(calls, 'signed out, no preference is sent to the account').toEqual([]);
  } finally {
    await visitor.close();
  }
});

test(`${J} #3 turns promotions email off in notification settings: a category by channel grid; a switched-off channel shows its notice; the promotion mail stops; security is locked on`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person('pfn');
  await signUpInBrowser(page, who);
  const client = await api(who);

  // The grid: every category by every channel, as the person's own rows.
  await page.goto('/notifications?view=settings');
  const grid = page.locator('[role="region"][aria-label="What reaches you, by category"]');
  await expect(grid).toBeVisible();
  for (const channel of ['Inbox in the app', 'Email', 'Phone notifications', 'Text message'])
    await expect(grid.getByRole('columnheader', { name: channel, exact: true })).toBeVisible();
  for (const category of ['Security', 'Orders', 'Promotions'])
    await expect(grid.getByRole('rowheader', { name: new RegExp(`^${category}`) })).toBeVisible();
  const rows = await notifyRead(client, 'notify.categoryPrefs');
  expect(new Set(rows.map((r) => r.category)).size * new Set(rows.map((r) => r.channel)).size).toBe(rows.length);
  await expect(grid.getByRole('switch')).toHaveCount(rows.length);

  // A channel the platform has switched off says so in every cell, in plain words; text messages are off on this stack.
  const off = rows.filter((r) => r.notConnected);
  expect(
    off.map((r) => r.channel),
    'text messages are a switched-off channel here',
  ).toContain('sms');
  for (const row of off) {
    const cell = cellOf(grid, row);
    await expect(cell).toContainText('Not connected on this platform, so nothing can be sent here.');
  }
  // Email is connected, so promotions by email is the person's own switch.
  expect(rows.find((r) => r.category === 'promotions' && r.channel === 'email')).toMatchObject({ notConnected: null, locked: false });

  // Security is locked on: every security cell is on and cannot be changed, and the account refuses a write to it.
  for (const row of rows.filter((r) => r.category === 'security')) {
    const cell = grid.getByRole('switch', { name: cellName(row), exact: true });
    await expect(cell).toBeChecked();
    await expect(cell).toBeDisabled();
    if (!row.notConnected) await expect(cellOf(grid, row)).toContainText('Always on. We keep this one on for your protection.');
  }
  const locked = await client.post('/api/notify/trpc/notify.setCategoryPref', {
    category: 'security',
    channel: 'email',
    enabled: false,
    clientRequestId: `${J}-security-${randomUUID()}`,
  });
  expect(locked.status, JSON.stringify(locked.body).slice(0, 300)).toBe(200);
  expect(locked.body.result.data.locked).toBe(true);
  expect((await notifyRead(client, 'notify.categoryPrefs')).find((r) => r.category === 'security' && r.channel === 'email').enabled).toBe(
    true,
  );
  // Before: a TEST promotion reaches this person by email (the channel works, so its stopping means something).
  expect(tool('local-test-gates.mjs', 'notify-promotion', who.handle)).toMatch(/OK .* promotion sent/);
  await expect.poll(() => mailedLines(who.email, 'promotion').length, { timeout: 30_000 }).toBe(1);

  // Turn promotions email off: it reads back off, here, on the account and after a reload.
  const promoEmail = grid.getByRole('switch', { name: 'Promotions, Email', exact: true });
  await expect(promoEmail).toBeEnabled();
  await expect(promoEmail).toBeChecked();
  await promoEmail.click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^Saved$/ })
      .first(),
  ).toBeVisible();
  await expect(promoEmail).not.toBeChecked();
  expect((await notifyRead(client, 'notify.categoryPrefs')).find((r) => r.category === 'promotions' && r.channel === 'email').enabled).toBe(
    false,
  );
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Promotions, Email', exact: true })).not.toBeChecked();

  // The promotion mail stops: the next TEST promotion reaches the inbox but sends no email.
  expect(tool('local-test-gates.mjs', 'notify-promotion', who.handle)).toMatch(/OK .* promotion sent/);
  await expect
    .poll(async () => (await notifyRead(client, 'notify.list', { limit: 100 })).items.filter((n) => /^promo\./.test(n.kind)).length, {
      timeout: 30_000,
    })
    .toBe(2);
  await page.waitForTimeout(5_000);
  expect(mailedLines(who.email, 'promotion'), 'no promotion mail after promotions email is off').toHaveLength(1);

  expect(await page.locator('[role="region"][aria-label="What reaches you, by category"]').innerText()).not.toMatch(INTERNAL);
});

const CATEGORY_WORDS = {
  security: 'Security',
  orders: 'Orders and trades',
  price_alerts: 'Price alerts',
  promotions: 'Promotions',
  news: 'News and product updates',
  status: 'Service status',
};
const CHANNEL_WORDS = { in_app: 'Inbox in the app', email: 'Email', push: 'Phone notifications', sms: 'Text message' };
/** The switch's name for one cell, as the grid labels it: "<category>, <channel>". */
function cellName(row) {
  return `${CATEGORY_WORDS[row.category]}, ${CHANNEL_WORDS[row.channel]}`;
}
/** The grid cell that holds one row's switch and its reason. */
function cellOf(grid, row) {
  return grid.getByRole('cell').filter({ has: grid.page().getByRole('switch', { name: cellName(row), exact: true }) });
}

test(`${J} #4 sees my rank and perks on Account: rank, XP and the perks the rank unlocks, read from the rank table`, async ({ page }) => {
  test.setTimeout(120_000);
  const who = person('pfr');
  await signUpInBrowser(page, who);
  const client = await api(who);
  // The account's own rank and the perks identity reads for it from the rank table.
  const rankRes = await client.get('/api/identity/trpc/rank.get');
  expect(rankRes.status, JSON.stringify(rankRes.body).slice(0, 300)).toBe(200);
  const rank = rankRes.body.result.data;
  const perksRes = await client.get('/api/identity/trpc/rank.perks');
  expect(perksRes.status, JSON.stringify(perksRes.body).slice(0, 300)).toBe(200);
  const perks = perksRes.body.result.data;

  await page.goto('/uc/account');
  const card = page.getByTestId('rank-perks');
  await expect(card).toBeVisible();
  // Rank and XP, as identity holds them.
  await expect(card).toContainText(`Rank ${rank.rank}`);
  await expect(card).toContainText('Lifetime XP');
  await expect(card).toContainText(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(BigInt(rank.xp)));
  if (rank.nextRankAt !== null) {
    await expect(card).toContainText('XP to next rank');
    await expect(card).toContainText(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(BigInt(rank.nextRankAt)));
  }
  // The perks this rank unlocks, as the rank table gives them.
  await expect(card).toContainText('Current perks');
  await expect(card).toContainText('Trading fee discount');
  await expect(card).toContainText(`${perks.feeDiscountBps / 100}%`);
  expect(await card.innerText()).not.toMatch(INTERNAL);
});
