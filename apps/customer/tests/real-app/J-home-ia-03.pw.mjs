// World: none
import { test, expect } from './journey.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';
import { ORIGIN } from './stack.mjs';

// J-home-ia-03, in the running app (docs/roadmap/journeys.json): I make Home mine. Tests titled "J-home-ia-03 #<n>" prove
// a whole step. One TEST person on two devices (two browser contexts with nothing shared but the account).
const J = 'J-home-ia-03';

test.describe.configure({ mode: 'serial' });

let who;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  who = await signUp(page, 'hmt');
  // The app opens in Simple (owner decision 2026-10-26); this person picks Pro, a choice their account keeps for every device.
  await page.goto('/view');
  const pro = page.getByRole('group', { name: 'Default view' }).getByRole('button', { name: 'Pro', exact: true });
  const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST');
  await pro.click();
  await expect(pro).toHaveAttribute('aria-pressed', 'true');
  expect((await written).status()).toBe(200);
  await page.close();
});

/** A device: its own browser context, signed in as the person, on Pro Home (the account's choice). */
async function device(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, who);
  await page.goto('/home');
  await expect(page.getByTestId('if-home-pro')).toBeVisible();
  // While the balance call is out Home draws the assets panel as busy. This person is not verified, so once the call
  // answers the summary names that refusal and the panel goes; tiles are read only after that answer.
  await expect(page.getByTestId('hp-summary')).toContainText('Verify your identity first');
  return { context, page };
}

/** The tiles Pro Home draws, top to bottom, by the tile each element is. */
const TILE_OF = {
  'hp-started': 'started',
  'hp-work': 'work',
  'hp-assets-panel': 'holdings',
  'hp-activity': 'activity',
  'hp-markets': 'markets',
};
async function drawnTiles(page) {
  return page
    .locator('[data-testid="if-home-pro"] > *')
    .evaluateAll((nodes, names) => nodes.map((node) => names[node.getAttribute('data-testid')]).filter(Boolean), TILE_OF);
}

async function openCustomise(page) {
  await page.getByRole('button', { name: 'Customise Home' }).click();
  const dialog = page.getByRole('dialog', { name: 'Customise Home' });
  await expect(dialog).toBeVisible();
  return dialog;
}
const outcome = (dialog) => dialog.getByRole('status');

/** The `home.tiles` record identity answers to the app's own read, found in the tRPC reply whatever its wrapping. */
function homeTilesIn(body) {
  if (body && typeof body === 'object') {
    if (body.namespace === 'home.tiles' && 'version' in body) return body;
    for (const value of Object.values(body)) {
      const found = homeTilesIn(value);
      if (found) return found;
    }
  }
  return null;
}
const isRead = (res) => res.url().includes('preferences.get') && decodeURIComponent(res.url()).includes('home.tiles');
const isWrite = (res) => res.url().includes('preferences.set') && res.request().method() === 'POST';

/** The order the dialog lists, and which tiles it marks hidden. */
async function listed(dialog) {
  return dialog
    .locator('[data-tile]')
    .evaluateAll((rows) =>
      rows.map((row) => `${row.getAttribute('data-tile')}${row.getAttribute('data-hidden') === 'true' ? ' (hidden)' : ''}`),
    );
}

test(`${J} #1 Customise Home hides and reorders tiles on the account: the same layout on another device, Reset, and a conflict keeps the newer layout`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const a = await device(browser);
  const shipped = await drawnTiles(a.page);
  expect(shipped).toContain('markets');
  expect(shipped.indexOf('activity')).toBeLessThan(shipped.indexOf('markets'));

  // Hide the markets tile and move Recent activity up two places: past Holdings (not drawn for this unverified
  // person) and past the work list, which is drawn, so the move shows on Home itself.
  let dialog = await openCustomise(a.page);
  const shippedList = await listed(dialog);
  expect(shippedList.some((tile) => tile.endsWith('(hidden)'))).toBe(false);
  await dialog.getByRole('checkbox', { name: 'Show Markets' }).uncheck();
  await expect(outcome(dialog)).toHaveText('Saved to your account.');
  for (const step of [1, 2]) {
    await dialog.getByRole('button', { name: 'Move Recent activity up' }).click();
    await expect(outcome(dialog), `move ${step}`).toHaveText('Saved to your account.');
  }
  // The new order is the shipped one with Recent activity two places higher, and Markets is marked hidden.
  const shippedOrder = shippedList.map((tile) => tile.replace(/ \(hidden\)$/, ''));
  const at = shippedOrder.indexOf('activity');
  expect(at, 'Recent activity can move up twice').toBeGreaterThan(1);
  const order = [...shippedOrder];
  order.splice(at - 2, 0, ...order.splice(at, 1));
  const chosen = await listed(dialog);
  expect(chosen).toEqual(order.map((tile) => (tile === 'markets' ? 'markets (hidden)' : tile)));
  await dialog.getByRole('button', { name: 'Done' }).click();

  // After a reload the account answers that layout to the app's own read: this order, Markets hidden.
  const reread = a.page.waitForResponse(isRead);
  await a.page.reload();
  const stored = homeTilesIn(await (await reread).json());
  expect(stored?.value).toEqual({ order, hidden: ['markets'] });
  // The tile is gone, and Customise lists it as hidden; the other tiles are drawn in the new order.
  await expect(a.page.getByTestId('if-home-pro')).toBeVisible();
  await expect(a.page.getByTestId('hp-markets')).toHaveCount(0);
  // Pro Home draws its tiles in the stored order: Recent activity now sits above the tile it passed, and Markets is gone.
  expect(shipped).toContain('work');
  expect(shipped.indexOf('work')).toBeLessThan(shipped.indexOf('activity'));
  const mine = await drawnTiles(a.page);
  expect(mine).toEqual(order.filter((tile) => tile !== 'markets' && shipped.includes(tile)));
  expect(mine.indexOf('activity')).toBeLessThan(mine.indexOf('work'));
  dialog = await openCustomise(a.page);
  expect(await listed(dialog)).toEqual(chosen);
  await dialog.getByRole('button', { name: 'Done' }).click();
  // Hiding the tile hid nothing else: the markets are still a door in the top bar.
  await expect(a.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Trade' })).toBeVisible();

  // Another device, with nothing stored in its browser, shows the same Home.
  const b = await device(browser);
  await expect(b.page.getByTestId('hp-markets')).toHaveCount(0);
  expect(await drawnTiles(b.page)).toEqual(mine);

  // Both devices have the layout open at the same version. A changes it first; B's change then meets a version
  // conflict, and B shows the newer layout instead of writing over it.
  const onA = await openCustomise(a.page);
  const onB = await openCustomise(b.page);
  await onA.getByRole('checkbox', { name: 'Show Recent activity' }).uncheck();
  await expect(outcome(onA)).toHaveText('Saved to your account.');
  // B's write is refused by identity as a version conflict, and the dialog says it is a conflict; the box goes back.
  const refused = b.page.waitForResponse(isWrite);
  await onB.getByRole('checkbox', { name: 'Show Markets' }).click();
  const answer = await refused;
  expect(answer.status()).toBe(409);
  expect(JSON.stringify(await answer.json())).toContain('preferences.version_conflict');
  await expect(outcome(onB)).toHaveAttribute('data-outcome', 'conflict');
  await expect(onB.locator('[data-tile="activity"]')).toHaveAttribute('data-hidden', 'true');
  await expect(onB.locator('[data-tile="markets"]')).toHaveAttribute('data-hidden', 'true');
  await onB.getByRole('button', { name: 'Done' }).click();
  await b.page.reload();
  await expect(b.page.getByTestId('hp-activity')).toHaveCount(0);
  await expect(b.page.getByTestId('hp-markets')).toHaveCount(0);

  // Reset returns the shipped order with every tile shown, on both devices.
  const reset = await openCustomise(b.page);
  await reset.getByRole('button', { name: 'Reset' }).click();
  await expect(outcome(reset)).toHaveText('Saved to your account.');
  expect(await listed(reset)).toEqual(shippedList);
  await reset.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => drawnTiles(b.page)).toEqual(shipped);
  await onA.getByRole('button', { name: 'Done' }).click();
  await a.page.reload();
  await expect(a.page.getByTestId('if-home-pro')).toBeVisible();
  await expect.poll(() => drawnTiles(a.page)).toEqual(shipped);

  await a.context.close();
  await b.context.close();
});

/** A device for `person`: its own browser context, signed in, on Home in whatever view the account holds. */
async function signedIn(browser, person) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, person);
  await page.goto('/home');
  return { context, page };
}
const isViewWrite = (req) => req.url().includes('preferences.set') && req.method() === 'POST' && (req.postData() ?? '').includes('ui.view');
/** The top bar's Simple or Pro switch. */
const modeSwitch = (page) => page.getByRole('group', { name: 'Simple or Pro layout' }).first();
/** The Trade door's menu, opened from the top bar: Simple lists the advanced desks under their own heading, Pro in one list. */
async function tradeMenu(page) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('link', { name: 'Trade' }).hover();
  const menu = page.getByTestId('tb-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test(`${J} #2 Simple to Pro changes Home and the Trade list at once, follows the account to another device, keeps the local value with a note when the write is refused, and a typed URL opens in either mode`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const setup = await browser.newPage();
  const person = await signUp(setup, 'hmm');
  await setup.close();
  const a = await signedIn(browser, person);
  // A new account opens in Simple: Simple Home, and the Trade list puts the advanced desks under "Advanced".
  await expect(a.page.getByTestId('if-home')).toBeVisible();
  let menu = await tradeMenu(a.page);
  await expect(menu.getByRole('list', { name: 'Advanced' })).toBeVisible();
  await expect(menu.getByRole('link', { name: /Futures/ })).toBeVisible();

  // Switch to Pro: Home and the Trade list change at once, with no reload, and the choice is written to the account.
  const written = a.page.waitForResponse((res) => isViewWrite(res.request()));
  await modeSwitch(a.page).getByRole('button', { name: 'Pro', exact: true }).click();
  await expect(a.page.getByTestId('if-home-pro')).toBeVisible();
  await expect(a.page.getByTestId('if-home')).toHaveCount(0);
  menu = await tradeMenu(a.page);
  await expect(menu.getByRole('list', { name: 'Advanced' })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: /Futures/ })).toBeVisible();
  expect((await written).status()).toBe(200);

  // Pro on device A is Pro on device B, a browser with nothing stored.
  const b = await signedIn(browser, person);
  await expect(b.page.getByTestId('if-home-pro')).toBeVisible();
  await expect(modeSwitch(b.page).getByRole('button', { name: 'Pro', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // A refused write: device A goes back to Simple while the account refuses the write. A keeps Simple and says the choice
  // was not saved to the account; the account still holds Pro, so device B stays Pro after a reload.
  await a.page.route('**/preferences.set**', (route) =>
    isViewWrite(route.request()) ? route.fulfill({ status: 503, body: 'TEST refusal' }) : route.continue(),
  );
  const refused = a.page.waitForResponse((res) => isViewWrite(res.request()));
  await modeSwitch(a.page).getByRole('button', { name: 'Simple', exact: true }).click();
  expect((await refused).status()).toBe(503);
  await expect(a.page.getByTestId('if-home')).toBeVisible();
  await expect(modeSwitch(a.page).getByRole('button', { name: 'Simple', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(a.page.locator('[data-view-sync="not-saved"]').first()).toHaveText(
    'Not saved to your account. Your choice applies on this device.',
  );
  await b.page.reload();
  await expect(b.page.getByTestId('if-home-pro')).toBeVisible();
  await a.page.unroute('**/preferences.set**');

  // A typed URL opens whatever the mode: an advanced desk in Simple (A) and in Pro (B), and Home in each.
  for (const { page, home } of [
    { page: a.page, home: 'if-home' },
    { page: b.page, home: 'if-home-pro' },
  ]) {
    await page.goto('/trade/futures');
    await expect(page).toHaveURL(/\/trade\/futures$/);
    await expect(page.getByRole('main')).toBeVisible();
    await page.goto('/home');
    await expect(page.getByTestId(home)).toBeVisible();
  }
  await a.context.close();
  await b.context.close();
});

/** Every money figure inside `scope`, and how many of them are masked. */
async function maskedFigures(scope) {
  const figures = scope.locator('[data-slot="hero-number"], [data-slot="money"], [data-slot="amount"]');
  const count = await figures.count();
  const masked = await scope
    .locator(
      '[data-slot="hero-number"][data-hidden="true"], [data-slot="money"][data-hidden="true"], [data-slot="amount"][data-hidden="true"]',
    )
    .count();
  return { count, masked };
}
/** Every figure on Home and on Assets is drawn, and all of them are masked (`hidden`) or none are. */
async function expectFigures(page, hidden) {
  await page.goto('/home');
  const home = page.getByTestId('if-home-pro');
  await expect(home.getByTestId('hp-summary')).toBeVisible();
  await expect(home.locator('[data-slot="hero-number"]').first()).toBeVisible();
  await expect.poll(async () => (await maskedFigures(home)).count).toBeGreaterThan(1);
  await expect
    .poll(
      async () => {
        const { count, masked } = await maskedFigures(home);
        return hidden ? masked === count : masked === 0;
      },
      `Home figures ${hidden ? 'all hidden' : 'all shown'}`,
    )
    .toBe(true);
  await page.goto('/money');
  const assets = page.getByRole('main');
  await expect.poll(async () => (await maskedFigures(assets)).count).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const { count, masked } = await maskedFigures(assets);
        return hidden ? masked === count : masked === 0;
      },
      `Assets figures ${hidden ? 'all hidden' : 'all shown'}`,
    )
    .toBe(true);
}

test(`${J} #3 the eye hides amounts on every tile and on Assets, and the choice follows the account, not the browser`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const setup = await browser.newPage();
  // A verified person with TEST money, so Home and Assets have figures to hide.
  const person = await fundedTrader(setup, 'hme', '250');
  await setup.goto('/view');
  const pro = setup.getByRole('group', { name: 'Default view' }).getByRole('button', { name: 'Pro', exact: true });
  const proWritten = setup.waitForResponse((res) => isViewWrite(res.request()));
  await pro.click();
  expect((await proWritten).status()).toBe(200);
  await setup.close();

  const a = await signedIn(browser, person);
  await expectFigures(a.page, false);
  // The eye on Home hides them, and the choice is written to the account.
  await a.page.goto('/home');
  const written = a.page.waitForResponse((res) => isViewWrite(res.request()));
  await a.page.getByTestId('hp-label').getByRole('button', { name: 'Hide balances' }).click();
  expect((await written).status()).toBe(200);
  await expectFigures(a.page, true);

  // Not the browser: this browser's own copy is cleared, and the account's choice comes back after a reload.
  await a.page.evaluate(() => localStorage.clear());
  await expectFigures(a.page, true);
  // Another browser, with nothing stored, hides them too.
  const b = await signedIn(browser, person);
  await expectFigures(b.page, true);

  // Shown again from B: A shows them after a reload.
  await b.page.goto('/home');
  const shown = b.page.waitForResponse((res) => isViewWrite(res.request()));
  await b.page.getByTestId('hp-label').getByRole('button', { name: 'Show balances' }).click();
  expect((await shown).status()).toBe(200);
  await expectFigures(b.page, false);
  await expectFigures(a.page, false);
  await a.context.close();
  await b.context.close();
});

/** The language list in `scope`: each option's text, by group label. */
async function languageList(scope) {
  return scope
    .locator('select')
    .first()
    .evaluate((select) =>
      Object.fromEntries(
        [...select.querySelectorAll('optgroup')].map((group) => [
          group.label,
          [...group.querySelectorAll('option')].map((o) => ({ code: o.value, text: o.textContent })),
        ]),
      ),
    );
}
/** Checks one language list: every written language but English says its share, a machine-written one says so, and the
 * languages with no written copy say they show English and carry no share. */
function expectHonestList(list) {
  const written = list['Written in the app'];
  expect(written?.[0]).toEqual({ code: 'en', text: 'English' });
  expect(written.length, 'at least one language besides English is written').toBeGreaterThan(1);
  for (const option of written.slice(1)) expect(option.text, option.code).toMatch(/ · (<1|\d{1,3})% written( · Machine-translated)?$/);
  expect(
    written.some((option) => option.text.endsWith(' · Machine-translated')),
    'a machine-written language is labelled',
  ).toBe(true);
  for (const option of list['Not written, shows English'] ?? []) expect(option.text, option.code).not.toMatch(/written|Machine/);
}

test(`${J} #5 the interface language list on sign-in and in the avatar menu states each language's written share and labels machine translation`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // On sign-in.
  await page.goto('/login');
  const onSignIn = page.locator('[data-language-menu]').first();
  await expect(onSignIn).toBeVisible();
  const list = await languageList(onSignIn);
  expectHonestList(list);
  // Picking a machine-written language says so under the list, with the same share the list showed.
  const machine = list['Written in the app'].find((option) => option.text.endsWith(' · Machine-translated'));
  const share = / · (<1|\d{1,3})% written/.exec(machine.text)[1];
  await onSignIn.locator('select').first().selectOption(machine.code);
  await expect(onSignIn.locator('[data-language-machine]')).toBeVisible();
  await expect(onSignIn.locator('[data-language-note]')).toContainText(`${share}%`);
  // English carries no machine note.
  await onSignIn.locator('select').first().selectOption('en');
  await expect(onSignIn.locator('[data-language-machine]')).toHaveCount(0);
  await expect(onSignIn.locator('[data-language-note]')).toHaveText('English is the language the app is written in.');

  // In the avatar menu, signed in: the same honest list.
  await signIn(page, who);
  await page.goto('/home');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const inMenu = page.locator('.tb-account-language [data-language-menu]');
  await expect(inMenu).toBeVisible();
  const menuList = await languageList(inMenu);
  expectHonestList(menuList);
  expect(menuList).toEqual(list);
  await context.close();
});
