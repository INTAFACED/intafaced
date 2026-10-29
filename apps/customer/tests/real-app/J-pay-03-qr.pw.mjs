import { test, expect } from '@playwright/test';
import { api, journeyState, signOutBrowser, tool } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-pay-03 step 3's signed QR code (PP-send-request-11) in the running app, kept apart from J-pay-03.pw.mjs because it
// restarts identity. The code names the payee by account id and is signed with this stack's LOCAL TEST key, made on
// this machine and refused by identity outside dev or test. Here: the code opens Send on the payee; a tampered code is
// refused with "This code is not valid"; and with the signing key blank (identity restarted with
// LOCAL_STACK_IDENTITY_PAY_QR_KEY=off) Receive refuses the QR code with identity.qr_key_unset and a scan reads nothing.
// After each refusal the payee's own record reads the same. Paying through the code is J-pay-03 #3.
const J = 'J-pay-03';
const run = journeyState(`${J}-qr-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function people() {
  const { payee, payer } = run.read();
  if (!payee || !payer) throw new Error(`${J} QR: the first test made no accounts, so this one has no one to act as`);
  return { payee, payer };
}

/** The payee's own record as identity answers it to them. */
async function record(who) {
  const res = await (await api(who)).get('/api/identity/trpc/me');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
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

test(`${J} #3 QR: the signed code opens Send on the payee by account id; a tampered code is refused`, async ({ page }) => {
  test.setTimeout(180_000);
  const payee = await signUp(page, 'qe');
  await signOutBrowser(page.context());
  const payer = await signUp(page, 'qp');
  run.reset({ payee, payer });

  await signOutBrowser(page.context());
  await signIn(page, payee);
  const link = await receiveLink(page);
  const url = new URL(link);
  expect(url.pathname).toBe('/pay/send');
  const code = url.searchParams.get('qr') ?? '';
  expect(code, 'the QR code carries a signed code').toMatch(/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  expect(code, 'the code names the account by id, never the handle').not.toContain(payee.handle);
  await expect(page.getByTestId('pay-qr')).toBeVisible();
  const before = await record(payee);
  expect(code.split('.')[1]).toBe(before.userId);

  await signOutBrowser(page.context());
  await signIn(page, payer);
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue(payee.handle);
  await expect(page.getByTestId('recipient-found')).toContainText(`@${payee.handle}`);
  await expect(page.getByRole('alert')).toHaveCount(0);

  // The signature moved onto another account, and a changed last character: both refused, and nothing is read.
  const [v, , sig] = code.split('.');
  const payerId = (await api(payer)).userId;
  for (const bad of [`${v}.${payerId}.${sig}`, `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`]) {
    const tampered = new URL(link);
    tampered.searchParams.set('qr', bad);
    await page.goto(`${tampered.pathname}${tampered.search}`);
    await expect(page.getByRole('alert')).toContainText('This code is not valid');
    await expect(page.getByRole('textbox', { name: 'Handle' })).toHaveValue('');
    await expect(page.getByTestId('recipient-found')).toHaveCount(0);
    expect(await record(payee)).toEqual(before);
  }
});

test(`${J} #3 QR: with the signing key blank, Receive refuses the QR code and a scan reads nothing`, async ({ page }) => {
  test.setTimeout(240_000);
  const { payee, payer } = people();
  await signIn(page, payee);
  const signed = await receiveLink(page);
  const before = await record(payee);
  try {
    payQrKey(false);
    await page.goto('/pay/receive');
    await expect(page.getByText('Your QR code isn’t set up')).toBeVisible();
    await expect(page.getByTestId('receive-link')).toContainText('identity.qr_key_unset');
    await expect(page.getByTestId('pay-qr')).toHaveCount(0);
    const plain = new URL((await page.getByTestId('receive-link-value').textContent())?.trim() ?? '');
    expect(plain.searchParams.has('qr'), 'with no key the link carries no code').toBe(false);

    await signOutBrowser(page.context());
    await signIn(page, payer);
    const url = new URL(signed);
    await page.goto(`${url.pathname}${url.search}`);
    await expect(page.getByRole('alert')).toContainText('Pay codes aren’t set up yet');
    await expect(page.getByTestId('recipient-found')).toHaveCount(0);
    expect(await record(payee)).toEqual(before);
  } finally {
    payQrKey(true);
  }
  // Back on, the code shared before still opens Send on the payee.
  await signOutBrowser(page.context());
  await signIn(page, payer);
  const url = new URL(signed);
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page.getByTestId('recipient-found')).toContainText(`@${payee.handle}`);
});
