import { test, expect } from './journey.mjs';
import { api, fund, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { scanQr } from './qr-read.mjs';

// J-pay-03, in the running app (docs/roadmap/journeys.json): pick a handle, choose who can find it, and receive a payment.
// One test per step, titled "J-pay-03 #<n>", run in order on two TEST accounts: A receives, B is a stranger who pays.
// Both are verified by the stack's TEST operators; B is funded with TEST USDT through the real ledger. A received payment
// credits A's available balance once, and a held one counts as set aside until accepted; the steps read both balances
// through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5, #6: no stranger rule and no receive-by email or phone (PP-money-balance-05).
// A refusal is matched by the typed code identity sent the page (`answer`), and after it the record and balances are
// read again unchanged.
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

/** The person's own record as identity answers it to them. */
async function record(who) {
  const res = await (await api(who)).get('/api/identity/trpc/me');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Whether identity says the person can be found by their handle, read through their own API. */
async function findable(who) {
  const res = await (await api(who)).get('/api/identity/trpc/handle.get');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.discoverable;
}

/** Identity's answer when `who` looks up `handle`, through their own API. */
async function lookUp(who, handle) {
  const input = encodeURIComponent(JSON.stringify({ handle }));
  const res = await (await api(who)).get(`/api/identity/trpc/users.resolveHandle?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Both people's TEST USDT, read through their own API. */
async function balances(me, stranger) {
  return { me: (await usdt(me)).free, stranger: (await usdt(stranger)).free };
}

/** Runs `go` and returns identity's answer to the page for `procedure`: its data, or the typed refusal code it sent. */
async function answer(page, procedure, go) {
  const res = page.waitForResponse((r) => r.url().includes(`/api/identity/trpc/${procedure}`));
  res.catch(() => {}); // when `go` fails first, its own error is the one reported
  await go();
  const got = await res;
  const body = await got.json();
  return { status: got.status(), data: body.result?.data, code: body.error?.data?.cause?.code };
}

/** B sends A `amount` USDT by A's handle, through Pay's own Send, and returns the outcome text. */
async function strangerPays(page, handle, amount) {
  const { stranger } = people();
  await signOutBrowser(page.context());
  await signIn(page, stranger);
  await page.goto('/pay/send');
  await page.getByRole('textbox', { name: 'Handle' }).fill(handle);
  await page.getByRole('textbox', { name: 'Handle' }).press('Tab');
  await page.getByLabel(/Amount/).fill(amount);
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByRole('status').first()).toBeVisible({ timeout: 30_000 });
  // A refusal is an alert: the send went through only if none shows.
  await expect(page.getByRole('alert')).toHaveCount(0);
}

test(`${J} #1 opens Receive: the handle with Copy and the toast "Copied" (with no handles live, the Account ID: its own test below)`, async ({
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
  // Handles are live on this stack: identity answers `me` with the person's own handle, and Receive shows exactly it.
  const meRead = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/identity/trpc/me' && r.request().method() === 'GET' && r.status() === 200,
  );
  await page.goto('/pay/receive');
  const identityMe = await meRead;
  expect(identityMe.status()).toBe(200);
  const mine = (await identityMe.json()).result.data;
  expect(mine.handle, 'identity holds a handle for this person').toBeTruthy();
  await expect(page.getByRole('tab', { name: 'Receive' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Your handle' })).toBeVisible();
  const value = page.getByTestId('receive-value');
  await expect(value).toHaveText(`@${mine.handle}`);
  await expect(value).not.toHaveAttribute('data-mono', /.*/);
  await page.getByTestId('receive-copy').click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`@${mine.handle}`);
});

// #1's second clause is a state no running stack can show, so it is its own test, red by name. Receive falls back to
// the Account ID only when identity has no `me` procedure at all (`fetchMe` reads "procedure missing" as "no handles
// live"); every stack serves `me`, so handles are always live here. The fallback is proven in the component test
// (apps/customer/src/screens/pay/pay.pw.mjs, "receive without handles shows the Account ID in mono").
test(`${J} part of #1 with no handles live, the Account ID in mono (blocked: handles are live on every stack; identity always serves me)`, async ({
  page,
}) => {
  const { me } = people();
  await signIn(page, me);
  await page.goto('/pay/receive');
  await expect(
    page.getByRole('heading', { name: 'Your account ID' }),
    'blocked: handles are live, so Receive shows the handle',
  ).toBeVisible(UNBUILT);
});

test(`${J} #2 changes the handle: a handle that breaks a rule gets the reason naming the rule; past the lifetime change cap it refuses with the count`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { me } = people();
  await signIn(page, me);
  // The handle settings as svc-identity answers handle.get on a load of Receive: the handle, the cap and the count.
  const settingsOn = async (load) => {
    const [answer] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/handle.get') && res.request().method() === 'GET'),
      load(),
    ]);
    expect(answer.ok(), 'handle.get answers').toBe(true);
    const body = await answer.json();
    return body?.result?.data?.json ?? body?.result?.data;
  };
  const first = await settingsOn(() => page.goto('/pay/receive'));
  const changesLeft = page.getByTestId('handle-changes-left');
  // The stack's TEST cap is 3 changes in the life of an account (tooling/profiles/test-owner-values/identity.json),
  // read back from the service, and the card's count is the service's.
  expect(first).toMatchObject({ handle: me.handle, changeCap: 3, changesUsed: 0, changesLeft: 3 });
  await expect(changesLeft).toHaveText(`You can change your handle ${first.changesLeft} more times.`);
  const dialog = page.getByRole('dialog', { name: 'Change your handle' });
  // Each Save is one handle.change call; its answer is returned so the refusal's typed code is checked, not only its copy.
  const attempt = async (handle) => {
    if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Change handle' }).click(UNBUILT);
    await dialog.getByRole('textbox', { name: 'New handle' }).fill(handle);
    const [answer] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/handle.change') && res.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Save' }).click(),
    ]);
    return answer;
  };
  // The refusal's code as the customer app reads it (apps/customer/src/shared/api.ts): the domain code first.
  const codeOf = async (answer) => {
    const body = await answer.json().catch(() => ({}));
    const data = body?.error?.data;
    return data?.intafacedCode ?? body?.intafacedCode ?? data?.cause?.code ?? data?.code ?? body?.code;
  };
  // A rule refusal names the rule, and spends no change.
  const characters = await attempt('no spaces-allowed!');
  expect(characters.ok(), 'a handle with a space is refused').toBe(false);
  expect(await codeOf(characters)).toBe('identity.handle_characters');
  await expect(dialog.getByRole('alert')).toHaveText('A handle uses only letters, digits and underscore.');
  const length = await attempt('ab');
  expect(length.ok(), 'a two-letter handle is refused').toBe(false);
  expect(await codeOf(length)).toBe('identity.handle_length');
  await expect(dialog.getByRole('alert')).toHaveText('A handle has 3 to 32 characters.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(changesLeft).toHaveText('You can change your handle 3 more times.');
  // From the service, not the page: after a reload the handle is the same and no change was spent.
  expect(await settingsOn(() => page.reload())).toMatchObject({ handle: me.handle, changesUsed: 0, changesLeft: first.changeCap });
  await expect(page.getByTestId('receive-value')).toHaveText(`@${me.handle}`);
  await expect(changesLeft).toHaveText('You can change your handle 3 more times.');

  // Three changes use the cap up; each one is the handle the card shows, and the count goes down with it.
  const base = me.handle.slice(0, 28);
  const left = ['You can change your handle 2 more times.', 'You can change your handle 1 more time.'];
  let handle = me.handle;
  for (const n of [1, 2, 3]) {
    handle = `${base}_${n}`;
    expect((await attempt(handle)).ok(), `change ${n} is taken`).toBe(true);
    await expect(page.getByTestId('receive-value')).toHaveText(`@${handle}`);
    await expect(dialog).toBeHidden();
    if (n < 3) await expect(changesLeft).toHaveText(left[n - 1]);
  }
  run.write({ me: { ...me, handle } });
  // The fourth is refused with the count, and the handle stays.
  const capped = await attempt(`${base}_4`);
  expect(capped.ok(), 'a fourth change is refused').toBe(false);
  expect(await codeOf(capped)).toBe('identity.handle_change_cap_reached');
  // The refusal carries the count: the changes used, which is the cap the service published.
  expect((await capped.json()).error?.message).toBe(
    `You have changed your handle ${first.changeCap} times, the most allowed [identity.handle_change_cap_reached]`,
  );
  await expect(dialog.getByRole('alert')).toHaveText('You have changed your handle 3 times, the most allowed.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Re-read from the service: the refused fourth change left the handle and the count where they were.
  expect(await settingsOn(() => page.reload())).toMatchObject({ handle, changesUsed: first.changeCap, changesLeft: 0 });
  await expect(page.getByTestId('receive-value')).toHaveText(`@${handle}`);
  await expect(changesLeft).toHaveText('You have changed your handle 3 times, the most allowed.');
});

test(`${J} #3 turns discoverability off: handle search finds nothing for others, and a QR scan still pays`, async ({ page }) => {
  test.setTimeout(180_000);
  const { me, stranger } = people();
  const discoverable = () => page.getByRole('switch', { name: 'Let people find me by my handle' });
  await signIn(page, me);
  await page.goto('/pay/receive');
  // The handle the stranger looks for is this account's current one (#2 changed it), read back from identity.
  const mine = await record(me);
  await expect(page.getByTestId('receive-value')).toHaveText(`@${mine.handle}`);
  // The stranger's camera reads the QR code drawn on Receive: it encodes the link printed under it, to Send.
  const link = (await page.getByTestId('receive-link-value').textContent())?.trim() ?? '';
  expect(await scanQr(page.getByTestId('pay-qr')), 'the drawn QR code scans to the printed link').toBe(link);
  expect(new URL(link).pathname, 'the QR code opens Send for this account').toBe('/pay/send');
  // While findable, the same handle search finds this account, so the miss below is the switch's doing.
  expect(await findable(me)).toBe(true);
  expect(await lookUp(stranger, mine.handle)).toEqual({ found: true, userId: mine.userId, handle: mine.handle, self: false });
  await discoverable().click();
  await expect(discoverable()).not.toBeChecked();
  await page.reload();
  await expect(discoverable(), 'the switch stays off after a reload').not.toBeChecked();
  expect(await findable(me), 'identity stores the switch off').toBe(false);
  const hidden = await record(me);
  try {
    await signOutBrowser(page.context());
    await signIn(page, stranger);
    await page.goto('/pay/send');
    const search = await answer(page, 'users.resolveHandle', async () => {
      await page.getByRole('textbox', { name: 'Handle' }).fill(mine.handle);
      await page.getByRole('textbox', { name: 'Handle' }).press('Tab');
    });
    expect(search, 'identity answers not found to others').toEqual({ status: 200, data: { found: false }, code: undefined });
    await expect(page.getByRole('alert')).toHaveText(`No one with this handle. We couldn’t find @${mine.handle}. Check the spelling.`);
    expect(await record(me)).toEqual(hidden);

    // The stranger scans the QR code: Send opens on this account and the payment lands once: this account's balance
    // rises by exactly 1 TEST USDT and the stranger's falls by exactly 1, both read from the service.
    const before = toUnits((await usdt(me)).free);
    const spending = toUnits((await usdt(stranger)).free);
    const url = new URL(link);
    const scanned = await answer(page, 'qr.resolve', () => page.goto(`${url.pathname}${url.search}`));
    expect(scanned, 'the QR code resolves to this account by its id').toEqual({
      status: 200,
      data: { userId: mine.userId, handle: mine.handle, self: false },
      code: undefined,
    });
    await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue(mine.handle);
    await expect(page.getByTestId('recipient-found')).toContainText(`@${mine.handle}`);
    await expect(page.getByRole('alert'), 'the QR link opens Send on this account').toHaveCount(0);
    await page.getByLabel(/Amount/).fill('1');
    await page.getByRole('button', { name: 'Review' }).click({ timeout: 15_000 });
    await page.getByRole('alertdialog').getByRole('button', { name: /^Send/ }).click({ timeout: 15_000 });
    await expect(page.getByRole('status').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => toUnits((await usdt(me)).free) - before, { timeout: 30_000 }).toBe(toUnits('1'));
    await expect.poll(async () => spending - toUnits((await usdt(stranger)).free), { timeout: 30_000 }).toBe(toUnits('1'));
    // Once: a fresh read of both still shows exactly one payment.
    expect(toUnits((await usdt(me)).free) - before).toBe(toUnits('1'));
    expect(spending - toUnits((await usdt(stranger)).free)).toBe(toUnits('1'));
  } finally {
    // Back on, so #5 can be paid by handle.
    await signOutBrowser(page.context());
    await signIn(page, me);
    await page.goto('/pay/receive');
    if (!(await discoverable().isChecked())) await discoverable().click();
    await expect(discoverable()).toBeChecked();
    expect(await findable(me)).toBe(true);
    expect(await lookUp(stranger, mine.handle), 'found again once back on').toEqual({
      found: true,
      userId: mine.userId,
      handle: mine.handle,
      self: false,
    });
  }
});

test(`${J} #4 shows the QR to a friend who scans it: Send opens prefilled with a payee preview; a tampered code is refused; with the camera denied an image upload works`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { me, stranger } = people();
  await signIn(page, me);
  await page.goto('/pay/receive');
  const mine = await record(me);
  await expect(page.getByTestId('pay-qr')).toBeVisible();
  const link = (await page.getByTestId('receive-link-value').textContent())?.trim() ?? '';
  expect(await scanQr(page.getByTestId('pay-qr')), 'the drawn QR code scans to the printed link').toBe(link);
  // The image the friend will upload is the QR code exactly as Receive draws it.
  const picture = await page.getByTestId('pay-qr').screenshot();
  const url = new URL(link);
  const code = url.searchParams.get('qr') ?? '';
  expect(code, 'the QR code carries a signed pay code').toMatch(/^v1\./);

  // The friend opens what the QR code scanned to: Send prefilled with the payee preview identity resolved.
  await signOutBrowser(page.context());
  await signIn(page, stranger);
  const scanned = await answer(page, 'qr.resolve', () => page.goto(`${url.pathname}${url.search}`));
  expect(scanned).toEqual({ status: 200, data: { userId: mine.userId, handle: mine.handle, self: false }, code: undefined });
  await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue(mine.handle);
  await expect(page.getByTestId('recipient-found')).toContainText(`@${mine.handle}`);

  // A tampered code (its last character changed) refuses identity.qr_invalid, and nothing moves.
  const held = await balances(me, stranger);
  const tampered = new URL(link);
  tampered.searchParams.set('qr', `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`);
  const refused = await answer(page, 'qr.resolve', () => page.goto(`${tampered.pathname}${tampered.search}`));
  expect(refused).toEqual({ status: 400, data: undefined, code: 'identity.qr_invalid' });
  await expect(page.getByRole('alert')).toContainText('This code is not valid');
  await expect(page.getByTestId('recipient-found')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue('');
  expect(await record(me)).toEqual(mine);
  expect(await balances(me, stranger)).toEqual(held);

  // With the camera denied, Scan to pay refuses the camera by name, and an image of the QR code opens Send on the payee.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('/pay/scan');
  await page.getByRole('button', { name: 'Scan with the camera' }).click();
  await expect(page.locator('[data-kind="refused"]')).toContainText('scan.camera_denied');
  await expect(page.locator('video')).toHaveCount(0);
  const uploaded = await answer(page, 'qr.resolve', () =>
    page.getByLabel('Choose an image of a QR code').setInputFiles({ name: 'pay-qr.png', mimeType: 'image/png', buffer: picture }),
  );
  expect(uploaded).toEqual({ status: 200, data: { userId: mine.userId, handle: mine.handle, self: false }, code: undefined });
  await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue(mine.handle);
  await expect(page.getByTestId('recipient-found')).toContainText(`@${mine.handle}`);
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
