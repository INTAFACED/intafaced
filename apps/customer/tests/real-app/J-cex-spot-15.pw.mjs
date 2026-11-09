// World: book
import { test, expect } from './journey.mjs';
import { openDesk, signUp, verify } from './desk.mjs';
import { draftNotice, publishNotice } from './notices.mjs';

// J-cex-spot-15, in the running app (docs/roadmap/journeys.json): a developer builds a trading bot against the API.
// One test per step, titled "J-cex-spot-15 #<n>", checking what the step's words say. The steps here read the portal,
// the error catalogues, the changelog, the bot policy and the order types the API publishes; nothing places an order or
// moves money. #2 publishes two TEST changelog entries through the founders' four-eyes desk, as an operator would.
const J = 'J-cex-spot-15';

test.describe.configure({ mode: 'default' });

/** The app's own "no such route" screen, and the portal's "no such developer page": a dead entry shows one of them. */
const DEAD = /Page not found|No such developer page/;

test(`${J} #1 opens /developers: each listed surface links to a real route, and none is a dead entry`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/developers');
  await expect(page.getByRole('heading', { name: 'Developers', level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  // Every link the portal home lists, read from the page itself, so a surface added later is covered too.
  const hrefs = [...new Set(await main.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? '')))];
  expect(hrefs.length, 'the home lists its surfaces').toBeGreaterThan(20);
  for (const href of hrefs) {
    // Each entry is an address inside the app: no empty link, no "#", no off-site address.
    expect(href, `entry ${JSON.stringify(href)}`).toMatch(/^\/[a-z]/);
  }
  for (const href of hrefs) {
    await page.goto(href);
    const opened = page.getByRole('main');
    // A real route draws its own page with a top heading, and neither not-found screen.
    await expect(opened.getByRole('heading', { level: 1 }).first(), `${href} has its own page`).toBeVisible();
    await expect(opened, `${href} is not a dead entry`).not.toContainText(DEAD);
    // A section whose page is not written in this build says what it waits for, by its slice id: an honest state on a
    // real route, never a blank page.
    const waits = opened.getByText(/It waits for [A-Z]{2}-[a-z-]+-\d{2}\./);
    if (await waits.count()) await expect(waits).toBeVisible();
  }
  // The two surfaces a bot builder reads first are listed and written here.
  await page.goto('/developers');
  for (const name of ['Order types', 'Bot policy']) {
    const link = main.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    await expect(link.locator('xpath=..')).toContainText('Page in this portal');
  }
});

test(`${J} #2 reads the error format and the changelog: each code with its severity and category, and changelog notices in the chosen language`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Each error code, in both catalogues, names its severity and its category, in columns of its own.
  for (const [path, id] of [
    ['/developers/errors', 'trade-errors-catalogue'],
    ['/developers/errors/auth', 'auth-errors-catalogue'],
  ]) {
    await page.goto(path);
    const table = page.getByTestId(id);
    const head = (await table.locator('thead th').allInnerTexts()).map((text) => text.trim());
    expect(head.slice(3, 5), `${path} has severity and category columns`).toEqual(['Severity', 'Category']);
    const rows = table.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-severity', /^(error|temporary|uncertain)$/);
      await expect(row).toHaveAttribute('data-category', /^(request|authentication|signature|permission|account|platform)$/);
      await expect(row.locator('td').nth(2)).toHaveText(/^(Error|Temporary|Uncertain): \S/);
      await expect(row.locator('td').nth(3)).toHaveText(/^(Request|Authentication|Signature|Permission|Account|Platform)$/);
    }
  }
  // An order body refusal and the posting freeze differ in severity: one is fixed, the other waits.
  await page.goto('/developers/errors');
  await expect(page.locator('#trade\\.validation_failed')).toHaveAttribute('data-severity', 'error');
  await expect(page.locator('#posting_frozen')).toHaveAttribute('data-severity', 'temporary');

  // Two TEST changelog entries, published as founders publish them: one the operator also wrote in Spanish, one only in
  // English. Each run's titles are its own, so an earlier run's entries never stand in for these.
  const run = Date.now().toString(36);
  const es = { title: `TEST ${run}: nuevo campo en las órdenes`, body: `TEST ${run}: envía el campo nuevo con cada orden.` };
  const translated = { title: `TEST ${run}: a new order field`, body: `TEST ${run}: send the new field with each order.` };
  const englishOnly = { title: `TEST ${run}: a new market data stream`, body: `TEST ${run}: subscribe to the new stream.` };
  for (const [key, text, translations] of [
    [`${run}-es`, translated, { es }],
    [`${run}-en`, englishOnly, null],
  ]) {
    const draft = await draftNotice({
      kind: 'changelog',
      ...text,
      minutes: 10,
      key: `${J}-${key}`,
      changelog: { area: 'trading', breaking: false },
      ...(translations ? { translations } : {}),
    });
    expect((await publishNotice(draft, `${J}-${key}`)).status).toBe('published');
  }

  // A developer who chose Spanish (on the sign-in page's language menu, kept in this browser) reads the changelog.
  await page.goto('/login');
  await page.getByLabel('Language').selectOption('es');
  await page.goto('/developers/changelog');
  await expect(page.getByRole('heading', { name: 'Registro de cambios', level: 1 })).toBeVisible();
  const inSpanish = page.locator('article').filter({ has: page.getByRole('heading', { name: es.title, exact: true }) });
  await expect(inSpanish).toHaveCount(1);
  await expect(inSpanish).toHaveAttribute('lang', 'es');
  await expect(inSpanish).toContainText(es.body);
  await expect(inSpanish.getByTestId('changelog-not-in-language')).toHaveCount(0);
  // The entry with no Spanish text shows its English source, marked as English, and says so in Spanish.
  const notTranslated = page.locator('article').filter({ has: page.getByRole('heading', { name: englishOnly.title, exact: true }) });
  await expect(notTranslated).toHaveCount(1);
  await expect(notTranslated).toHaveAttribute('lang', 'en');
  await expect(notTranslated.getByTestId('changelog-not-in-language')).toHaveText(
    'Esta entrada no tiene texto en tu idioma, así que se muestra en inglés.',
  );

  // Back in English, the same entry reads in English, with no note.
  await page.goto('/login');
  await page.getByLabel('Idioma').selectOption('en');
  await page.goto('/developers/changelog');
  await expect(page.getByRole('heading', { name: 'Changelog', level: 1 })).toBeVisible();
  const inEnglish = page.locator('article').filter({ has: page.getByRole('heading', { name: translated.title, exact: true }) });
  await expect(inEnglish).toHaveAttribute('lang', 'en');
  await expect(inEnglish).toContainText(translated.body);
  await expect(page.getByRole('heading', { name: es.title })).toHaveCount(0);
});

test(`${J} #3 reads the bot policy: "Bot policy: not yet published" until it is, and nothing claims permission`, async ({ page }) => {
  // The owner has published no bot policy, and the stack sets none (tooling/profiles/test-owner-values/trade.json has
  // no TRADE_DEVELOPER_BOT_POLICY): svc-trade answers its one refusal, and the page says so.
  const read = await page.request.get('/api/trade/developer-portal/bot-policy');
  expect(read.status(), await read.text()).toBe(503);
  expect((await read.json()).code).toBe('trade.developer_bot_policy_unset');

  await page.goto('/developers');
  await page.getByRole('main').getByRole('link', { name: 'Bot policy', exact: true }).click();
  await expect(page).toHaveURL(/\/developers\/bot-policy$/);
  await expect(page.getByRole('heading', { name: 'Bot policy', level: 1 })).toBeVisible();
  const state = page.getByTestId('developers-bot-policy-state');
  await expect(state).toHaveAttribute('data-state', 'unset');
  await expect(state).toHaveAttribute('data-code', 'trade.developer_bot_policy_unset');
  await expect(state).toContainText('Bot policy: not yet published');
  // Nothing on the page, or in its machine-readable variant, claims a bot is allowed.
  const CLAIM = /\b(?:bots? (?:are|is) (?:allowed|permitted)|you may (?:run|use) a bot|permission to run a bot is granted)\b/i;
  await expect(page.getByRole('main')).not.toContainText(CLAIM);
  await expect(page.getByRole('main')).toContainText('Nothing on this site grants permission to run a bot.');
  // The machine-readable variant is static, so it states no policy either way: it names the live read instead.
  const markdown = await page.request.get('/developers/bot-policy.md');
  expect(markdown.status()).toBe(200);
  const text = await markdown.text();
  expect(text).toContain('GET /api/trade/developer-portal/bot-policy');
  expect(text).not.toMatch(CLAIM);
});

test(`${J} #4 reads which order types the API accepts: the same list the ticket shows`, async ({ page }) => {
  test.setTimeout(240_000);
  // What the API itself says it takes: GET /api/v1/order-types, through the edge.
  const answer = await page.request.get('/api/v1/order-types');
  expect(answer.status(), await answer.text()).toBe(200);
  const published = await answer.json();
  expect(published.accepted.length).toBeGreaterThan(0);

  // The portal's page names each accepted type, in the API's order.
  await page.goto('/developers');
  await page.getByRole('main').getByRole('link', { name: 'Order types', exact: true }).click();
  await expect(page).toHaveURL(/\/developers\/order-types$/);
  const accepted = page.getByTestId('order-types-accepted').locator('tbody tr');
  await expect(accepted).toHaveCount(published.accepted.length);
  expect(await accepted.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-type')))).toEqual(
    published.accepted.map((row) => row.id),
  );
  const docNames = (await accepted.locator('th').allInnerTexts()).map((name) => name.trim());
  // Each row shows the API's own example body for that type, whole.
  const examples = await accepted.locator('pre').allInnerTexts();
  expect(examples.map((text) => JSON.parse(text))).toEqual(published.accepted.map((row) => row.send.example));
  const refused = page.getByTestId('order-types-refused').locator('tbody tr');
  await expect(refused).toHaveCount(published.refused.length);
  const docRefused = (await refused.locator('th').allInnerTexts()).map((name) => name.trim());
  for (const row of published.refused) {
    await expect(page.locator(`[data-testid="order-types-refused"] tbody tr[data-type="${row.id}"]`)).toContainText(row.code);
  }

  // The trading ticket a person sees: its type tabs, in order, and the kinds it lists as unavailable.
  const who = await signUp(page, 'cs15t');
  await verify(page, who);
  await openDesk(page, who, 'BTC/USDT');
  const tabs = page.getByRole('tablist', { name: 'Order type' }).getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  const ticketNames = (await tabs.allInnerTexts()).map((name) => name.trim());
  expect(ticketNames, 'the API lists exactly the ticket’s types, in the ticket’s order').toEqual(docNames);
  await page.getByRole('button', { name: 'Other order types (not available)' }).click();
  // What the ticket lists as unavailable, the API lists as refused: the menu's items, once it has opened, in order.
  await expect(page.getByRole('menuitem')).toHaveText(docRefused);
});
