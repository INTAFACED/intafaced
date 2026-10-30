import { test, expect } from '@playwright/test';
import { api, fund, journeyState, signOutBrowser, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-03 step 3's signed QR code (PP-send-request-11) in the running app, kept apart from J-pay-03.pw.mjs because it
// restarts identity. The code names the payee by account id and is signed with this stack's LOCAL TEST key, made on
// this machine and refused by identity outside dev or test. Here: with finding by handle off, the code opens Send on
// the payee; a tampered code is refused with "This code is not valid"; and with the signing key blank (identity restarted with
// LOCAL_STACK_IDENTITY_PAY_QR_KEY=off) Receive refuses the QR code with identity.qr_key_unset and a scan reads nothing.
// After each refusal the payee's own record reads the same. The payer is funded with TEST USDT through the real ledger,
// and the scanned code pays 1 TEST USDT into the payee's balance through the existing pay path.
const J = 'J-pay-03';
const run = journeyState(`${J}-qr-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function people() {
  const { payee, payer } = run.read();
  if (!payee || !payer) throw new Error(`${J} QR: the first test made no accounts, so this one has no one to act as`);
  return { payee, payer };
}

/** The payee's own record as identity answers it to them. */
const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0' };

async function record(who) {
  const res = await (await api(who)).get('/api/identity/trpc/me');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Both people's TEST USDT, read through their own API: a refusal must leave both where they were. */
async function balances(payee, payer) {
  return { payee: (await usdt(payee)).free, payer: (await usdt(payer)).free };
}

/**
 * Runs `go` and returns the answer the page itself got from identity for `procedure`: the data, or the typed refusal
 * code the service sent (`error.data.cause.code`), so a refusal is matched by its code and not only by its copy.
 */
async function answer(page, procedure, go) {
  const res = page.waitForResponse((r) => r.url().includes(`/api/identity/trpc/${procedure}`));
  await go();
  const got = await res;
  const body = await got.json();
  return { status: got.status(), data: body.result?.data, code: body.error?.data?.cause?.code };
}

/** The link Receive prints under its QR code, which is what the code encodes. */
async function receiveLink(page) {
  await page.goto('/pay/receive');
  return (await page.getByTestId('receive-link-value').textContent())?.trim() ?? '';
}

/** Restarts identity with the TEST signing key (`on`) or with it blank. */
function payQrKey(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_PAY_QR_KEY;
  if (on) delete process.env.LOCAL_STACK_IDENTITY_PAY_QR_KEY;
  else process.env.LOCAL_STACK_IDENTITY_PAY_QR_KEY = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_PAY_QR_KEY;
    else process.env.LOCAL_STACK_IDENTITY_PAY_QR_KEY = before;
  }
}

test(`${J} #3 QR: the signed code opens Send on the payee by account id; a tampered code is refused; it pays 1 TEST USDT`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const payee = await signUp(page, 'qe');
  await verify(page, payee);
  await signOutBrowser(page.context());
  const payer = await signUp(page, 'qp');
  await verify(page, payer);
  expect(fund(payer.email, 'USDT', '10').tx).toBeTruthy();
  run.reset({ payee, payer });

  await signOutBrowser(page.context());
  await signIn(page, payee);
  const link = await receiveLink(page);
  const url = new URL(link);
  expect(url.pathname).toBe('/pay/send');
  const code = url.searchParams.get('qr') ?? '';
  expect(code, 'the QR code carries a signed code').toMatch(/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
  expect(code, 'the code names the account by id, never the handle').not.toContain(payee.handle);
  await expect(page.getByTestId('pay-qr')).toBeVisible();
  const before = await record(payee);
  expect(code.split('.')[1]).toBe(before.userId);
  // Finding by handle off: the code must still open Send on this account.
  const discoverable = page.getByRole('switch', { name: 'Let people find me by my handle' });
  await discoverable.click();
  await expect(discoverable).not.toBeChecked();
  const hidden = await record(payee);
  // The handle Send must show is the one identity holds for the payee, read back, not the one this test chose.
  const handle = hidden.handle;

  await signOutBrowser(page.context());
  await signIn(page, payer);
  await page.goto('/pay/send');
  const search = await answer(page, 'users.resolveHandle', async () => {
    await page.getByRole('textbox', { name: 'Handle' }).fill(handle);
    await page.getByRole('textbox', { name: 'Handle' }).press('Tab');
  });
  expect(search, 'finding by handle is off: identity answers not found to others').toEqual({
    status: 200,
    data: { found: false },
    code: undefined,
  });
  await expect(page.getByRole('alert')).toContainText('No one with this handle');
  expect(await record(payee)).toEqual(hidden);

  const scanned = await answer(page, 'qr.resolve', () => page.goto(`${url.pathname}${url.search}`));
  expect(scanned, 'identity resolves the code to the payee by account id').toEqual({
    status: 200,
    data: { userId: hidden.userId, handle, self: false },
    code: undefined,
  });
  await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue(handle);
  await expect(page.getByTestId('recipient-found')).toContainText(`@${handle}`);
  await expect(page.getByRole('alert')).toHaveCount(0);

  // It pays through the existing pay path: 1 TEST USDT lands in the payee's balance.
  const held = toUnits((await usdt(payee)).free);
  await page.getByLabel(/Amount/).fill('1');
  await page.getByRole('button', { name: 'Review' }).click();
  const review = page.getByRole('alertdialog');
  await expect(review).toContainText(`@${handle}`);
  await review.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => toUnits((await usdt(payee)).free) - held, { timeout: 30_000 }).toBe(toUnits('1'));

  // The signature moved onto another account, and a changed last character: both refused identity.qr_invalid, and
  // nothing moves: the payee's record and both balances read the same.
  const [v, , tag, sig] = code.split('.');
  const payerId = (await api(payer)).userId;
  const paid = await balances(payee, payer);
  for (const bad of [`${v}.${payerId}.${tag}.${sig}`, `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`]) {
    const tampered = new URL(link);
    tampered.searchParams.set('qr', bad);
    const refused = await answer(page, 'qr.resolve', () => page.goto(`${tampered.pathname}${tampered.search}`));
    expect(refused, `the tampered code ${bad} is refused by its typed code`).toEqual({
      status: 400,
      data: undefined,
      code: 'identity.qr_invalid',
    });
    await expect(page.getByRole('alert')).toContainText('This code is not valid');
    await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue('');
    await expect(page.getByTestId('recipient-found')).toHaveCount(0);
    expect(await record(payee)).toEqual(hidden);
    expect(await balances(payee, payer)).toEqual(paid);
  }
});

test(`${J} #3 QR: with the signing key blank, Receive refuses the QR code and a scan reads nothing`, async ({ page }) => {
  test.setTimeout(240_000);
  const { payee, payer } = people();
  await signIn(page, payee);
  const signed = await receiveLink(page);
  const before = await record(payee);
  const held = await balances(payee, payer);
  try {
    payQrKey(false);
    const mine = await answer(page, 'qr.mine', () => page.goto('/pay/receive'));
    expect(mine, 'with the key blank no code is made').toEqual({ status: 412, data: undefined, code: 'identity.qr_key_unset' });
    await expect(page.getByText('Your QR code isn’t set up')).toBeVisible();
    await expect(page.getByTestId('receive-link')).toContainText('identity.qr_key_unset');
    await expect(page.getByTestId('pay-qr')).toHaveCount(0);
    const plain = new URL((await page.getByTestId('receive-link-value').textContent())?.trim() ?? '');
    expect(plain.searchParams.has('qr'), 'with no key the link carries no code').toBe(false);

    await signOutBrowser(page.context());
    await signIn(page, payer);
    const url = new URL(signed);
    const refused = await answer(page, 'qr.resolve', () => page.goto(`${url.pathname}${url.search}`));
    expect(refused, 'with the key blank a scan is refused by its typed code').toEqual({
      status: 412,
      data: undefined,
      code: 'identity.qr_key_unset',
    });
    await expect(page.getByRole('alert')).toContainText('Pay codes are off');
    await expect(page.getByTestId('recipient-found')).toHaveCount(0);
    expect(await record(payee)).toEqual(before);
    expect(await balances(payee, payer)).toEqual(held);
  } finally {
    payQrKey(true);
  }
  // Back on, the code shared before still opens Send on the payee.
  await signOutBrowser(page.context());
  await signIn(page, payer);
  const url = new URL(signed);
  const again = await answer(page, 'qr.resolve', () => page.goto(`${url.pathname}${url.search}`));
  expect(again.data?.userId).toBe(before.userId);
  await expect(page.getByTestId('recipient-found')).toContainText(`@${before.handle}`);
});
