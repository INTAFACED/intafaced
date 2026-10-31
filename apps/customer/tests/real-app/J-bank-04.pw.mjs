import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api, fund, journeyState, staffFreeze, toUnits, signOutBrowser } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-04, in the running app (docs/roadmap/journeys.json): I send money to a person from the bank's Transfers room.
// One test per step, titled "J-bank-04 #<n>", run in order on TEST accounts: A sends (with an authenticator app), B
// receives, and C is frozen by staff. The stack's gates publish TEST send terms for USDT and USDC with a zero fee
// (`local-test-gates.mjs apply`) and none for BTC; every number here is a TEST number on the local stack, and balances
// are read through each person's own API. #5 sends abroad through Pay's global send on the TEST stand-in, whose TEST
// catalogue puts a USDT send of 500 or more on hold for a compliance look: staff ask for a document and release it by
// API with the stack's founder sessions. #6 follows a send that left (the tracker and its signed receipt) and cancels one
// on hold, under the TEST auto-cancel window of 72 hours. Not here yet: #7 (it lands with its own slice).
const J = 'J-bank-04';
const AMOUNT = '40';
const NOTE = 'Lunch, TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code for A, keeping its step so no code is used twice. */
async function code() {
  const now = run.read();
  const { totp } = await totpLib();
  const next = await nextCode(totp, now.secret, now.step);
  run.write({ step: next.step });
  return next.code;
}

/** A session token for A through identity's own sign-in, with a fresh code. */
async function senderToken() {
  const { sender } = run.read();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: sender.email, password: sender.password, totpCode: await code() }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${sender.email} refused`);
  return token;
}

/** A's free USDT from the ledger, through A's own API. */
async function senderUsdt() {
  const res = await fetch(`${EDGE}/api/v1/account/balance`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${await senderToken()}` },
  });
  return (await res.json()).balances?.USDT?.free ?? '0';
}
const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

/** A signs in with password and a fresh code. */
async function signInSender(page) {
  const { sender } = run.read();
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', sender.email);
  await page.fill('input[name=password]', sender.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The people, made on first use: B is verified, A is verified, holds TEST 100 USDT and has an authenticator app. */
async function people(page) {
  const now = run.read();
  if (now.sender && now.recipient && now.secret) return now;
  const recipient = await signUp(page, 'jb4r');
  await verify(page, recipient);
  const sender = await signUp(page, 'jb4s');
  await verify(page, sender);
  expect(fund(sender.email, 'USDT', '100').tx).toBeTruthy();
  await page.goto('/login');
  await page.fill('input[name=identifier]', sender.email);
  await page.fill('input[name=password]', sender.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ sender, recipient, secret, step });
  // /login resets its form once a session refresh answers, which can wipe the typed email: start the next sign-in clean.
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  return run.read();
}

/** A in the Transfers room: "Another person", the handle found, a note, and the amount typed, at the review. */
async function reviewSend(page, { to, asset = 'USDT', value = AMOUNT, note = '', signedIn = false } = {}) {
  const { recipient } = await people(page);
  // Signing in on a page that is already signed in can wipe the typed email, so a second review only navigates.
  if (!signedIn) await signInSender(page);
  await page.goto('/bank/transfers');
  const source = page.getByLabel('From your space');
  await expect(source.locator('option', { hasText: asset })).not.toHaveCount(0);
  await source.selectOption({ label: (await source.locator('option', { hasText: asset }).first().innerText()).trim() });
  await page.getByLabel('Destination').selectOption({ label: 'Another person' });
  const handle = (to ?? recipient).handle;
  await page.getByPlaceholder('@handle').fill(handle);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText(`Paying @${handle}`)).toBeVisible();
  if (note) await page.getByLabel('Note for the recipient').fill(note);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(new RegExp(`Amount \\(${asset}\\)`)).fill(value);
  await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}

test(`${J} #1 opens Send and picks the rail: each rail has its own form, and with no partner the notice names rail.bank and the send is kept`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Step 1 starts the journey again: new people, no sends.
  run.reset({});
  await people(page);
  await signInSender(page);
  const before = await senderUsdt();
  await page.goto('/bank/transfers');
  const panel = page.getByTestId('rail-send');
  const how = panel.getByLabel('How to send');
  await expect(how.locator('option')).toHaveText(
    ['', 'ACH (US bank account)', 'Domestic wire (US)', 'Real-time payment (US)', 'SEPA (euro bank account)', 'Phone number or email'],
    {
      timeout: 30_000,
    },
  );
  // Each rail's own form, as the bank publishes it, and the notice before anything is asked.
  const forms = {
    'ACH (US bank account)': ['Account holder’s full name', 'Routing number (9 digits)', 'Account number', 'Account type'],
    'Domestic wire (US)': ['Account holder’s full name', 'Routing number (9 digits)', 'Account number', 'Bank name'],
    'Real-time payment (US)': ['Account holder’s full name', 'Routing number (9 digits)', 'Account number'],
    'SEPA (euro bank account)': ['Account holder’s full name', 'IBAN', 'BIC (optional)', 'Transfer type'],
    'Phone number or email': ['They are found by', 'Their phone number or email'],
  };
  const form = panel.getByTestId('rail-send-form');
  for (const [label, fields] of Object.entries(forms)) {
    await how.selectOption({ label });
    await expect(form.locator('label > span:first-child')).toHaveText(fields);
    await expect(panel.getByTestId('rail-send-notice')).toHaveText(
      `Send over ${label} needs bank rails. It is switched off in this build. Reference: rail.bank`,
    );
  }
  // A send over ACH to a TEST account: a fresh code, then kept refused with rail.bank, and nothing leaves the balance.
  await how.selectOption({ label: 'ACH (US bank account)' });
  await form.getByLabel('Account holder’s full name').fill('Ada TEST');
  await form.getByLabel('Routing number (9 digits)').fill('021000022');
  await form.getByLabel('Account number').fill('000123456789');
  await form.getByLabel('Account type').selectOption({ label: 'Savings' });
  const source = panel.getByLabel('Send from');
  await source.selectOption({ label: (await source.locator('option', { hasText: 'USDT' }).first().innerText()).trim() });
  await panel.getByLabel('Amount to send').fill('25');
  await expect(panel.getByTestId('rail-send-list')).toContainText('You have not sent to a bank account.');
  // A routing number whose check digit is wrong is answered on the form by the bank, before any code is asked for.
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('rail-send-problem')).toContainText('routing number', { timeout: 30_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await form.getByLabel('Routing number (9 digits)').fill('021000021');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const kept = panel.getByTestId('rail-send-kept');
  await expect(kept).toContainText('This send was not made', { timeout: 30_000 });
  await expect(kept).toContainText(
    'Send over ACH (US bank account) needs bank rails. It is switched off in this build. Reference: rail.bank',
  );
  const rows = panel.getByTestId('rail-send-row');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toContainText('Not sent');
  await expect(rows.first()).toContainText('25');
  await expect(rows.first()).toContainText('Ada TEST · …6789');
  await expect(rows.first()).toContainText('Reference: rail.bank');
  // The full account number is never shown back.
  await expect(panel.getByTestId('rail-send-list')).not.toContainText('000123456789');
  expect(toUnits(await senderUsdt())).toBe(toUnits(before));
});

test(`${J} #2 adds a recipient: forms per country, a name check and an invite, and a new payee inside the window refuses with its end time`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await people(page);
  await signInSender(page);
  const before = await senderUsdt();
  await page.goto('/bank/transfers');
  const book = page.getByTestId('payee-book');
  // The country picks the forms: a US account is paid over ACH, a wire or a real-time payment; a German one over SEPA.
  const country = book.getByLabel('Country of the account');
  const how = book.getByLabel('How they are paid');
  await country.selectOption({ label: 'United States' }, { timeout: 30_000 });
  await expect(how.locator('option')).toHaveText([
    '',
    'ACH (US bank account)',
    'Domestic wire (US)',
    'Real-time payment (US)',
    'Phone number or email',
  ]);
  await country.selectOption({ label: 'Germany' });
  await expect(how.locator('option')).toHaveText(['', 'SEPA (euro bank account)', 'Phone number or email']);
  await how.selectOption({ label: 'SEPA (euro bank account)' });
  const form = book.getByTestId('payee-form');
  await expect(form.locator('label > span:first-child')).toHaveText([
    'Account holder’s full name',
    'IBAN',
    'BIC (optional)',
    'Transfer type',
  ]);
  await form.getByLabel('Account holder’s full name').fill('Bea TEST');
  // A French IBAN is not an account in Germany: the bank says so on the form, before any code is asked for.
  await form.getByLabel('IBAN').fill('FR14 2004 1010 0505 0001 3M02 606');
  await book.getByLabel('Nickname').fill('Bea in Berlin');
  await book.getByRole('button', { name: 'Save recipient' }).click();
  await expect(book.getByTestId('payee-problem')).toContainText('not an account in DE', { timeout: 30_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await form.getByLabel('IBAN').fill('DE89 3704 0044 0532 0130 00');
  await book.getByRole('button', { name: 'Save recipient' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  const row = book.getByTestId('payee-row');
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText('Bea in Berlin');
  await expect(row).toContainText('Bea TEST · …3000');
  // Name verification needs a banking partner: cannot check, named rail.bank. The TEST window is 24 hours.
  await expect(row.getByTestId('payee-name-check')).toHaveText(
    'Name check: cannot check. It needs bank rails, which are switched off in this build. Reference: rail.bank',
  );
  const waiting = (await row.getByTestId('payee-cooling').innerText()).trim();
  expect(waiting).toMatch(/^New recipient: money can go to them from .+\.$/);
  const ends = waiting.replace(/^New recipient: money can go to them from /, '').replace(/\.$/, '');
  // The invite emails a link, and email delivery is switched off here: refused by name.
  const invite = book.getByTestId('payee-invite');
  await invite.getByLabel('Their email').fill('bea.test@example.com');
  await invite.getByRole('button', { name: 'Send the invite' }).click();
  await expect(invite.getByTestId('payee-invite-answer')).toHaveText(
    'Invites are sent by email, and email delivery is switched off in this build. Reference: bank.payee_invite_unwired',
    { timeout: 30_000 },
  );
  // Sending to the new payee inside the window refuses with its end time; nothing is asked for, kept or taken.
  const panel = page.getByTestId('rail-send');
  await panel.getByLabel('Send to', { exact: true }).selectOption({ label: 'Bea in Berlin · Bea TEST · …3000' });
  await expect(panel.getByTestId('rail-send-notice')).toContainText('SEPA (euro bank account)');
  const source = panel.getByLabel('Send from');
  await source.selectOption({ label: (await source.locator('option', { hasText: 'USDT' }).first().innerText()).trim() });
  await panel.getByLabel('Amount to send').fill('10');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('rail-send-problem')).toHaveText(
    `New recipient: money can go to them from ${ends}. Reference: bank.payee_cooling_active`,
    { timeout: 30_000 },
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel.getByTestId('rail-send-row')).toHaveCount(1);
  expect(toUnits(await senderUsdt())).toBe(toUnits(before));
});

test(`${J} #3 reviews the transfer: fee lines that add up, and Confirm off with the missing fee named`, async ({ page }) => {
  test.setTimeout(240_000);
  const dialog = await reviewSend(page);
  const { recipient, sender } = run.read();
  const received = await usdt(recipient);
  await expect(dialog).toContainText(`@${recipient.handle}`);
  const rows = dialog.getByTestId('review-terms-row');
  await expect(rows).toHaveCount(4);
  // The service's published TEST fee is zero: one fee line, a total equal to it, and the amount is all that leaves.
  await expect(rows.nth(0)).toContainText('Transfer fee');
  await expect(rows.nth(0)).toContainText('0 USDT');
  await expect(rows.nth(1)).toContainText('Fees in total');
  await expect(rows.nth(1)).toContainText('0 USDT');
  await expect(rows.nth(2)).toContainText('Taken from your account');
  await expect(rows.nth(2)).toContainText(`${AMOUNT} USDT`);
  await expect(rows.nth(3)).toContainText('Left to send today after this');
  // Nothing blocks it: the code field that confirms the send is open.
  await expect(dialog.getByTestId('step-up-confirm').getByLabel('Authenticator code')).toBeEnabled();
  await expect(dialog.getByTestId('review-terms-blocked')).toHaveCount(0);
  // Reviewing moves nothing.
  expect(await usdt(recipient)).toBe(received);

  // BTC has no published fee or limits on this stack: the review names what is missing and Confirm stays off.
  const added = await fetch(`${EDGE}/api/bank/trpc/currencies.add`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${await senderToken()}` },
    body: JSON.stringify({ assetId: 'BTC' }),
  });
  expect(added.status, 'add BTC to the account').toBe(200);
  expect(fund(sender.email, 'BTC', '0.01').tx).toBeTruthy();
  const btc = await reviewSend(page, { asset: 'BTC', value: '0.001', signedIn: true });
  const blocked = btc.getByTestId('review-terms-blocked');
  await expect(blocked).toContainText('No fee or sending limit is published for BTC');
  await expect(blocked).toContainText('bank.personal_transfer_terms_unset');
  await expect(btc.getByTestId('step-up-confirm').getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await expect(btc.getByTestId('step-up-confirm').getByLabel('Authenticator code')).toBeDisabled();
  await expect(btc.getByTestId('review-terms-row')).toHaveCount(0);
});

test(`${J} #4 confirms with a fresh code: the money reaches the person once, and a frozen recipient is refused`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const dialog = await reviewSend(page, { note: NOTE });
  const { recipient } = run.read();
  const before = await usdt(recipient);
  const senderBefore = await senderUsdt();
  // A send to another person needs a fresh second factor for exactly this send, with its note.
  const stepUp = dialog.getByTestId('step-up-confirm');
  await expect(stepUp).toContainText('Confirm it’s you');
  await stepUp.getByLabel('Authenticator code').fill(await code());
  await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByTestId('step-up-confirm')).toHaveCount(0, { timeout: 30_000 });
  await expect(dialog).not.toContainText('Nothing was sent');
  await expect.poll(async () => toUnits(await usdt(recipient)), { timeout: 30_000 }).toBe(toUnits(before) + toUnits(AMOUNT));
  expect(toUnits(await senderUsdt())).toBe(toUnits(senderBefore) - toUnits(AMOUNT));

  // C is frozen by staff after A picked them (a frozen account is not found by handle at all): the bank refuses the
  // send before any posting, and it is never shown as sent.
  const other = await (await browser.newContext()).newPage();
  const frozen = await signUp(other, 'jb4c');
  await verify(other, frozen);
  const refused = await reviewSend(page, { to: frozen, value: '1', signedIn: true });
  await staffFreeze(frozen);
  const confirm = refused.getByTestId('step-up-confirm');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(refused).toContainText('That person cannot receive this right now. Nothing was sent.', { timeout: 30_000 });
  expect(toUnits(await senderUsdt())).toBe(toUnits(senderBefore) - toUnits(AMOUNT));
});

let founderSessions;
/** The stack's founder sessions, signed in once for the file. */
function founders() {
  founderSessions ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { ctx, sessions: await gates.approverSessions(ctx) };
  })();
  // A failed sign-in is not kept: the next staff call signs in again.
  founderSessions.catch(() => {
    founderSessions = undefined;
  });
  return founderSessions;
}

/** Staff act on a global send by API, as the ops desk would: founder `a` or `b` of the local stack. */
async function staff(procedure, input, founder) {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.mutate('bank', `global.ops.${procedure}`, input, sessions[founder].token);
  if (!res.json?.result?.data) throw new Error(`staff ${procedure} refused: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** A's global sends, newest first, through A's own API. */
async function globalSends() {
  const res = await fetch(`${EDGE}/api/bank/trpc/global.list?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${await senderToken()}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result?.data) throw new Error(`global.list refused: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data.items;
}

/** Pay's global send to Germany with a recipient saved for it, the amount quoted (TEST rate 2), and confirmed. */
async function globalSend(page, { name, account, value, receive }) {
  await page.goto('/pay/global');
  const card = page.getByTestId('global-card');
  const where = card.getByLabel('Where it goes');
  await expect(where.locator('option', { hasText: 'DE · EUR · sepa' })).toHaveCount(1, { timeout: 30_000 });
  await where.selectOption({ label: 'DE · EUR · sepa' });
  const recipients = card.getByLabel('Recipient', { exact: true });
  if ((await recipients.locator('option', { hasText: name }).count()) === 0) {
    await card.getByLabel('Recipient’s full name').fill(name);
    await card.getByLabel('Account number or IBAN').fill(account);
    await card.getByTestId('global-recipient-save').click();
    await expect(recipients.locator('option', { hasText: name })).toHaveCount(1, { timeout: 30_000 });
  }
  await recipients.selectOption((await recipients.locator('option', { hasText: name }).first().getAttribute('value')) ?? '');
  await card.getByLabel('You send').fill(value);
  await card.getByRole('button', { name: 'Get a quote' }).click();
  await expect(card.getByTestId('global-quote')).toContainText(`${receive} EUR`, { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send' }).click();
  const confirm = card.getByTestId('global-confirm');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm with a code' }).click();
  return card;
}

test(`${J} #5 meets a compliance hold: the send waits, the bank asks for a document, the upload is taken once, and a blocked payee is refused`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const { sender } = await people(page);
  expect(fund(sender.email, 'USDT', '600').tx).toBeTruthy();
  await signInSender(page);
  const before = await senderUsdt();

  // 500 USDT reaches the stand-in's TEST screening line: the send is recorded on hold, and nothing leaves the balance.
  let card = await globalSend(page, { name: 'Cara TEST', account: 'DE89 3704 0044 0532 0130 00', value: '500', receive: '1000' });
  await expect(card.getByTestId('global-sent')).toBeVisible({ timeout: 30_000 });
  const first = card.getByTestId('global-history').locator('li').first();
  await expect(first).toHaveAttribute('data-status', 'held', { timeout: 30_000 });
  await expect(first).toContainText('500 USDT to EUR · On hold');
  await expect(first.getByTestId('global-hold')).toContainText('This send is on hold');
  await expect(first.getByTestId('global-hold-ask')).toHaveCount(0);
  expect(toUnits(await senderUsdt())).toBe(toUnits(before));
  const waiting = (await globalSends()).find((one) => one.amount === '500' && one.status === 'held');
  expect(waiting).toBeTruthy();

  // Staff ask for a document. The person sees the ask and one upload box.
  const ask = 'TEST: a payslip or an invoice that shows where this money comes from.';
  await staff('requestInfo', { sendId: waiting.id, infoRequest: ask }, 'a');
  await page.reload();
  card = page.getByTestId('global-card');
  const row = card.getByTestId('global-history').locator('li[data-status="held"]').first();
  const hold = row.getByTestId('global-hold');
  await expect(hold.getByTestId('global-hold-ask')).toHaveText(`We need one more thing from you: ${ask}`);
  await hold.getByLabel('Upload a file').setInputFiles({
    name: 'proof-TEST.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% TEST proof for a local journey\n%%EOF\n'),
  });
  await expect(hold).toContainText('Thanks. Your file is with our team and the send is under review.', { timeout: 30_000 });
  // Taken once: the box is gone, and after a reload it stays gone.
  await expect(hold.locator('input[type=file]')).toHaveCount(0);
  await page.reload();
  const again = page
    .getByTestId('global-card')
    .getByTestId('global-history')
    .locator('li[data-status="held"]')
    .first()
    .getByTestId('global-hold');
  await expect(again).toContainText('Thanks. Your file is with our team and the send is under review.', { timeout: 30_000 });
  await expect(again.locator('input[type=file]')).toHaveCount(0);
  expect(toUnits(await senderUsdt())).toBe(toUnits(before));

  // Another person releases it: only now does the money leave, once.
  // (Each balance read signs in with a fresh code, one per 30 seconds, so the release's own answer is read, not polled.)
  expect(await staff('release', { sendId: waiting.id }, 'b')).toMatchObject({ id: waiting.id, status: 'sent' });
  expect(toUnits(await senderUsdt())).toBe(toUnits(before) - toUnits('500'));

  // The stack's TEST payee controls block one made-up account: a send to it is refused before anything is posted.
  card = await globalSend(page, { name: 'Dan TEST', account: '999000000001', value: '10', receive: '20' });
  await expect(card.getByTestId('global-failure')).toHaveText(
    'We can’t send this payment This payment can’t be sent to that recipient right now. Nothing was taken from your balance.',
    { timeout: 30_000 },
  );
  expect(toUnits(await senderUsdt())).toBe(toUnits(before) - toUnits('500'));
});

test(`${J} #6 watches the tracker, downloads a signed receipt with the ledger id and hash, and cancels a send on hold under the auto-cancel rule`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const { sender } = await people(page);
  expect(fund(sender.email, 'USDT', '600').tx).toBeTruthy();
  await signInSender(page);
  const before = await senderUsdt();

  // A send that leaves: the tracker shows its states, and the newest row has gone one step of three.
  let card = await globalSend(page, { name: 'Cara TEST', account: 'DE89 3704 0044 0532 0130 00', value: '40', receive: '80' });
  await expect(card.getByTestId('global-sent')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('pay-steps').last().locator('li')).toHaveText(['Sent', 'On its way', 'Arrived']);
  const sentRow = card.getByTestId('global-history').locator('li').first();
  await expect(sentRow).toContainText('40 USDT to EUR · Sent (1/3)', { timeout: 30_000 });

  // The receipt: a file, signed, naming the ledger transaction; its hash on screen is the hash of the file.
  const sent = (await globalSends()).find((one) => one.amount === '40' && one.status === 'sent');
  expect(sent?.ledgerTxId).toBeTruthy();
  const receipt = sentRow.getByTestId('global-receipt');
  const [download] = await Promise.all([page.waitForEvent('download'), receipt.getByRole('button', { name: 'Download receipt' }).click()]);
  expect(download.suggestedFilename()).toBe(`receipt-${sent.id}.txt`);
  const file = readFileSync(await download.path(), 'utf8');
  expect(file).toContain(`Ledger transaction: ${sent.ledgerTxId}`);
  expect(file).toContain('Sent: 40 USDT');
  expect(file).toContain('To: Cara TEST · …3000 (DE, sepa)');
  await expect(receipt.getByTestId('global-receipt-ledger')).toHaveText(`Ledger record: ${sent.ledgerTxId}`);
  await expect(receipt.getByTestId('global-receipt-hash')).toHaveText(`SHA-256: ${createHash('sha256').update(file).digest('hex')}`);
  await expect(receipt).toContainText(/Signed: [0-9a-f]{64}/);
  expect(toUnits(await senderUsdt())).toBe(toUnits(before) - toUnits('40'));

  // A send on hold shows the owner's auto-cancel rule with its time, and the customer cancels it: nothing leaves.
  card = await globalSend(page, { name: 'Cara TEST', account: 'DE89 3704 0044 0532 0130 00', value: '500', receive: '1000' });
  const heldRow = card.getByTestId('global-history').locator('li').first();
  await expect(heldRow).toHaveAttribute('data-status', 'held', { timeout: 30_000 });
  await expect(heldRow.getByTestId('global-hold-autocancel')).toHaveText(
    /^If it is still on hold at \d{4}-\d{2}-\d{2}T\S+Z, it is cancelled automatically and nothing is taken from your balance\.$/,
    { timeout: 30_000 },
  );
  const at = (await heldRow.getByTestId('global-hold-autocancel').innerText()).match(/at (\S+Z),/)[1];
  const waiting = (await globalSends()).find((one) => one.amount === '500' && one.status === 'held');
  // The TEST window is 72 hours from the hold, which was placed as the send was made.
  expect(Math.abs(Date.parse(at) - Date.parse(waiting.createdAt) - 72 * 3_600_000)).toBeLessThan(60_000);
  await heldRow.getByTestId('global-cancel').click();
  const cancelled = card.getByTestId('global-history').locator('li[data-status="cancelled"]').first();
  await expect(cancelled).toHaveText('500 USDT to EUR · Cancelled — You cancelled it. Nothing was taken from your balance.', {
    timeout: 30_000,
  });
  await expect(cancelled.getByTestId('global-receipt')).toHaveCount(0);
  expect(toUnits(await senderUsdt())).toBe(toUnits(before) - toUnits('40'));
  // Staff can no longer release it: it is out of the queue and nothing posts.
  await expect(staff('release', { sendId: waiting.id }, 'b')).rejects.toThrow(/bank.hold_not_found/);
});

test(`${J} #7 sends to the wrong person and asks for it back: what can be asked, then the rail return shows bounced back and is refunded once`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const { sender } = await people(page);
  expect(fund(sender.email, 'USDT', '100').tx).toBeTruthy();
  await signInSender(page);
  const before = await senderUsdt();

  // 40 USDT leaves for the wrong person.
  let card = await globalSend(page, { name: 'Eve TEST', account: 'DE02 1203 0000 0000 2020 51', value: '40', receive: '80' });
  await expect(card.getByTestId('global-sent')).toBeVisible({ timeout: 30_000 });
  let row = card.getByTestId('global-history').locator('li').first();
  await expect(row).toContainText('40 USDT to EUR · Sent (1/3)', { timeout: 30_000 });
  const sent = (await globalSends()).find((one) => one.amount === '40' && one.status === 'sent' && one.recallReason === null);
  expect(sent?.ledgerTxId).toBeTruthy();

  // The wrong-recipient path says what can be asked before anything is asked, and keeps the request on the send.
  await row.getByTestId('global-recall-open').click();
  await expect(row.getByTestId('global-recall-what')).toHaveText(
    'We can ask the receiving bank to send it back. They need the recipient’s agreement, so it is not guaranteed, and it can take several weeks. If it comes back, it shows here as bounced back and is refunded to your balance once.',
  );
  const reason = 'Wrong person: I picked Eve TEST instead of Cara TEST.';
  await row.getByTestId('global-recall-reason').fill(reason);
  await row.getByTestId('global-recall-send').click();
  await expect(card.getByTestId('global-history').locator('li').first().getByTestId('global-recall-status')).toHaveText(
    `You asked for this back: ${reason}. We will show the answer here.`,
    { timeout: 30_000 },
  );
  expect(toUnits(await senderUsdt())).toBe(toUnits(before) - toUnits('40'));

  // The rail sends it back: staff record the return with its reference, and the send shows bounced back; nothing posts yet.
  expect(await staff('recordReturn', { sendId: sent.id, returnRef: `TEST-RETURN-${sent.id}` }, 'a')).toMatchObject({
    id: sent.id,
    status: 'returned',
  });
  await page.reload();
  card = page.getByTestId('global-card');
  row = card.getByTestId('global-history').locator(`li[data-status="returned"]`).first();
  await expect(row).toContainText('40 USDT to EUR · Bounced back — The receiving bank sent it back.', { timeout: 30_000 });
  await expect(row.getByTestId('global-recall-status')).toContainText(reason);

  // Four-eyes: whoever recorded the return cannot refund it. Another person refunds it, and a second refund credits nothing.
  await expect(staff('refundReturn', { sendId: sent.id }, 'a')).rejects.toThrow(/bank.refund_same_operator/);
  expect(await staff('refundReturn', { sendId: sent.id }, 'b')).toMatchObject({ id: sent.id, status: 'refunded' });
  expect(await staff('refundReturn', { sendId: sent.id }, 'b')).toMatchObject({ id: sent.id, status: 'refunded' });
  expect(toUnits(await senderUsdt())).toBe(toUnits(before));
  await page.reload();
  row = page.getByTestId('global-card').getByTestId('global-history').locator(`li[data-status="refunded"]`).first();
  await expect(row).toContainText('40 USDT to EUR · Refunded — It came back, and 40 USDT was refunded to your balance, once.', {
    timeout: 30_000,
  });
  await expect(row.getByTestId('global-recall-open')).toHaveCount(0);
});
