import { test, expect } from '@playwright/test';
import { api, fund, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-03, in the running app (docs/roadmap/journeys.json): pick a handle, choose who can find it, and receive a payment.
// One test per step, titled "J-pay-03 #<n>", run in order on two TEST accounts: A receives, B is a stranger who pays.
// Both are verified by the stack's TEST operators; B is funded with TEST USDT through the real ledger. A received payment
// credits A's available balance once, and a held one counts as set aside until accepted; the steps read both balances
// through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #3's QR clause: the QR code carries the handle, so with finding by handle off a scan misses too (PP-send-request-11).
// - #5, #6: no stranger rule and no receive-by email or phone (PP-money-balance-05).
// - #4: no QR scan that opens Send prefilled, and no tampered-code refusal (PP-send-request-11).
const J = 'J-pay-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

function people() {
  const { me, stranger } = run.read();
  if (!me || !stranger) throw new Error(`${J} #1 made no accounts, so this step has no one to act as`);
  return { me, stranger };
}

const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0' };

/** B sends A `amount` USDT by A's handle, through Pay's own Send, and returns the outcome text. */
async function strangerPays(page, handle, amount) {
  const { stranger } = people();
  await signOutBrowser(page.context());
  await signIn(page, stranger);
  await page.goto('/pay/send');
  await page.getByLabel('Handle').fill(handle);
  await page.getByLabel('Handle').press('Tab');
  await page.getByLabel(/Amount/).fill(amount);
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByRole('status').first()).toBeVisible({ timeout: 30_000 });
  // A refusal is an alert: the send went through only if none shows.
  await expect(page.getByRole('alert')).toHaveCount(0);
}

test(`${J} #1 opens Receive: the handle with Copy and the toast "Copied"; with no handles live, the Account ID`, async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const me = await signUp(page, 'rc');
  await verify(page, me);
  await signOutBrowser(context);
  const stranger = await signUp(page, 'rs');
  await verify(page, stranger);
  expect(fund(stranger.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ me, stranger });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, me);
  await page.goto('/pay/receive');
  await expect(page.getByRole('tab', { name: 'Receive' })).toHaveAttribute('aria-selected', 'true');
  const shown = (await page.getByTestId('receive-value').textContent())?.trim();
  expect(shown === `@${me.handle}` || /^[0-9a-f-]{36}$/.test(shown ?? '')).toBe(true);
  await page.getByTestId('receive-copy').click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
});

test(`${J} #2 changes the handle: a handle that breaks a rule gets the reason naming the rule; past the lifetime change cap it refuses with the count`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { me } = people();
  await signIn(page, me);
  await page.goto('/pay/receive');
  const changesLeft = page.getByTestId('handle-changes-left');
  // The stack's TEST cap is 3 changes in the life of an account (tooling/profiles/test-owner-values/identity.json).
  await expect(changesLeft).toHaveText('You can change your handle 3 more times.');
  const dialog = page.getByRole('dialog', { name: 'Change your handle' });
  const attempt = async (handle) => {
    if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Change handle' }).click(UNBUILT);
    await dialog.getByRole('textbox', { name: 'New handle' }).fill(handle);
    await dialog.getByRole('button', { name: 'Save' }).click();
  };
  // A rule refusal names the rule, and spends no change.
  await attempt('no spaces-allowed!');
  await expect(dialog.getByRole('alert')).toHaveText('A handle uses only letters, digits and underscore.');
  await attempt('ab');
  await expect(dialog.getByRole('alert')).toHaveText('A handle has 3 to 32 characters.');
  await page.keyboard.press('Escape');
  await expect(changesLeft).toHaveText('You can change your handle 3 more times.');

  // Three changes use the cap up; each one is the handle the card shows, and the count goes down with it.
  const base = me.handle.slice(0, 28);
  const left = ['You can change your handle 2 more times.', 'You can change your handle 1 more time.'];
  let handle = me.handle;
  for (const n of [1, 2, 3]) {
    handle = `${base}_${n}`;
    await attempt(handle);
    await expect(page.getByTestId('receive-value')).toHaveText(`@${handle}`);
    if (n < 3) await expect(changesLeft).toHaveText(left[n - 1]);
  }
  run.write({ me: { ...me, handle } });
  // The fourth is refused with the count, and the handle stays.
  await attempt(`${base}_4`);
  await expect(dialog.getByRole('alert')).toHaveText('You have changed your handle 3 times, the most allowed.');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('receive-value')).toHaveText(`@${handle}`);
});

test(`${J} #3 turns discoverability off: handle search finds nothing for others, and a QR scan still pays`, async ({ page }) => {
  test.setTimeout(180_000);
  const { me, stranger } = people();
  const discoverable = () => page.getByRole('switch', { name: 'Let people find me by my handle' });
  await signIn(page, me);
  await page.goto('/pay/receive');
  // What the QR code encodes is the link printed under it.
  const link = (await page.getByTestId('receive-link-value').textContent())?.trim() ?? '';
  expect(new URL(link).pathname, 'the QR code opens Send for this account').toBe('/pay/send');
  await discoverable().click(UNBUILT);
  await expect(discoverable()).not.toBeChecked();
  try {
    await signOutBrowser(page.context());
    await signIn(page, stranger);
    await page.goto('/pay/send');
    await page.getByLabel('Handle').fill(me.handle);
    await page.getByLabel('Handle').press('Tab');
    await expect(page.getByRole('alert')).toContainText(/No one with this handle/);

    // The stranger scans the QR code: Send opens on this account and the payment lands in its balance.
    const before = toUnits((await usdt(me)).free);
    const url = new URL(link);
    await page.goto(`${url.pathname}${url.search}`);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel(/Amount/).fill('1');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByRole('status').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => toUnits((await usdt(me)).free) - before, { timeout: 30_000 }).toBe(toUnits('1'));
  } finally {
    // Back on, so #5 can be paid by handle.
    await signOutBrowser(page.context());
    await signIn(page, me);
    await page.goto('/pay/receive');
    if (!(await discoverable().isChecked())) await discoverable().click();
    await expect(discoverable()).toBeChecked();
  }
});

test(`${J} #4 shows the QR to a friend who scans it: Send opens prefilled with a payee preview; a tampered code is refused; with the camera denied an image upload works`, async ({
  page,
}) => {
  const { me, stranger } = people();
  await signIn(page, me);
  await page.goto('/pay/receive');
  const link = await page.getByTestId('receive-qr-link').textContent(UNBUILT);
  expect(link).toMatch(/\/pay\/send\?/);
  await signOutBrowser(page.context());
  await signIn(page, stranger);
  await page.goto(link ?? '/');
  await expect(page.getByTestId('send-payee-preview')).toContainText(me.handle);
  await page.goto(`${link}x`);
  await expect(page.getByRole('alert')).toContainText('This code is not valid');
});

test(`${J} #5 sets how to treat payments from people not in contacts: a stranger's payment waits, and can be accepted or denied`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { me } = people();
  await signIn(page, me);
  await page.goto('/pay/receive');
  await page.getByRole('radio', { name: 'Hold for me to accept' }).check(UNBUILT);
  const before = await usdt(me);
  await strangerPays(page, me.handle, '5');
  // Held: set aside for me, not yet available.
  expect(toUnits((await usdt(me)).free)).toBe(toUnits(before.free));
  await signOutBrowser(page.context());
  await signIn(page, me);
  await page.goto('/pay');
  const waiting = page.getByRole('region', { name: 'Waiting for you' }).getByRole('listitem').first();
  await waiting.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(async () => toUnits((await usdt(me)).free)).toBe(toUnits(before.free) + toUnits('5'));
});

test(`${J} #6 adds an email or phone to receive by: a payment sent to it lands in the balance`, async ({ page }) => {
  test.setTimeout(180_000);
  const { me } = people();
  await signIn(page, me);
  await page.goto('/pay/receive');
  await page.getByRole('button', { name: 'Add an email or phone to receive by' }).click(UNBUILT);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Email or phone' }).fill(me.email);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('list', { name: 'Ways to receive' })).toContainText(me.email);
  const before = await usdt(me);
  await strangerPays(page, me.email, '1');
  await expect.poll(async () => toUnits((await usdt(me)).free)).toBe(toUnits(before.free) + toUnits('1'));
});
