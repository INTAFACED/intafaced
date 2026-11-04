import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, api, fromUnits, fund, journeyState, signUpInBrowser, toUnits, signOutBrowser, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-pay-01, in the running app (docs/roadmap/journeys.json): send TEST money to a person by handle and see it complete.
// One test per step, titled "J-pay-01 #<n>", run in order on TEST accounts: A sends, B receives. The stack's gates
// publish TEST send limits (`local-test-gates.mjs apply`); every number here is a TEST number on the local stack, and
// each figure the screen shows is checked against what the person's own API answers.
const J = 'J-pay-01';
const AMOUNT = '25';
const NOTE = 'Lunch, TEST';
const B_NAME = 'Bea TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function people() {
  const { sender, recipient, saved, lookalike, prober } = run.read();
  if (!sender || !recipient || !saved || !lookalike || !prober)
    throw new Error(`${J} #1 made no accounts, so this step has no one to act as`);
  return { sender, recipient, saved, lookalike, prober };
}

/** Types a handle in To and leaves the field, which is when Send looks it up. */
async function lookUp(page, handle) {
  const to = page.getByRole('textbox', { name: 'Handle', exact: true });
  await to.fill(handle);
  await to.press('Tab');
}

const usdt = async (who) => (await (await session(who)).balances()).USDT?.free ?? '0';

/** A tRPC answer through the person's own session, or a thrown error naming what was refused. */
async function trpc(session, method, path, input) {
  const route = `/api/${path}`;
  const res =
    method === 'GET'
      ? await session.get(input === undefined ? route : `${route}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await session.post(route, input);
  if (res.status !== 200) throw new Error(`${path} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** A decimal as the screen writes it: thousands grouped, every fraction digit kept, none added. */
const shown = (decimal) => {
  const [whole, frac] = decimal.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
};
/** The quote's own figures for A sending TEST 25 USDT: the fee, today's limit, what is left of it now and after. */
async function terms(sender) {
  const quote = await trpc(await api(sender), 'GET', 'bank/trpc/transfers.quote', { assetId: 'USDT', amount: AMOUNT });
  const left = toUnits(quote.dailyLimit) - toUnits(quote.spentToday);
  return {
    fee: toUnits(quote.fee) === 0n ? 'No fee' : `Fee: ${shown(quote.fee)} USDT`,
    reviewFee: toUnits(quote.fee) === 0n ? 'No fee' : `${shown(quote.fee)} USDT`,
    allowance: `${shown(fromUnits(left))} of ${shown(quote.dailyLimit)} USDT left`,
    after: `${shown(fromUnits(left - toUnits(AMOUNT)))} USDT`,
    perPayment: `Up to ${shown(quote.perTransferLimit)} USDT per payment. ${shown(fromUnits(left))} USDT left today.`,
  };
}

/** The bank's name for A's main USDT space, which Send names as the source. */
async function mainSpace(sender) {
  const spaces = await trpc(await api(sender), 'GET', 'bank/trpc/spaces.list', { limit: 200 });
  const main = spaces.find((space) => space.assetId === 'USDT' && space.kind === 'primary');
  if (!main) throw new Error('A has no main USDT space');
  return `Your USDT, ${main.name} space`;
}

/** The badge's month: B joined during this run, so it is this month (UTC), as an English reader sees it. */
const joinedThisMonth = () =>
  `Member since ${new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date())}`;

/** A fresh TEST account with exactly this handle, signed up in the browser (and verified when asked); signed out after. */
async function signUpAs(page, handle, { verified = false } = {}) {
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who);
  await expect(page).not.toHaveURL(/\/register/);
  if (verified) await verify(page, who);
  else await signOutBrowser(page.context());
  return who;
}

/** A on /pay with B's handle, the amount and the note typed in: where steps 4 and 5 start. */
async function sendForm(page, { amount = AMOUNT, note = NOTE, signedIn = false } = {}) {
  const { sender, recipient } = people();
  if (!signedIn) await signIn(page, sender);
  await page.goto('/pay');
  await lookUp(page, recipient.handle);
  await expect(page.getByTestId('recipient-handle').first()).toHaveText(`@${recipient.handle}`);
  await page.getByLabel('Amount to send').fill(amount);
  if (note) await page.locator('#pay-note').fill(note);
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
}

// ── A's authenticator: from #5 on, A signs in and confirms sends with a code from it ─────────────────────────────

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code for A, keeping its step so no code is ever used twice. */
async function aCode() {
  const state = run.read();
  if (!state.secret) throw new Error(`${J} #5 set up no authenticator for A, so there is no code to give`);
  const { totp } = await totpLib();
  const next = await nextCode(totp, state.secret, state.step);
  run.write({ step: next.step });
  return next.code;
}

/** A six-digit code that is none of the authenticator's codes for the steps around now: a wrong code. */
async function wrongCode() {
  const { totp } = await totpLib();
  const { secret } = run.read();
  const now = Math.floor(Date.now() / 30_000);
  const near = new Set([-2, -1, 0, 1, 2].map((d) => totp(secret, { at: new Date((now + d) * 30_000) })));
  let code = 123456;
  while (near.has(String(code).padStart(6, '0'))) code = (code + 1) % 1_000_000;
  return String(code).padStart(6, '0');
}

/**
 * The person's own API session. Once A has an authenticator each sign-in spends a code (a 30-second step), so A's
 * session is kept for this file's run while it is young; everyone else signs in afresh.
 */
const kept = new Map();
async function session(who) {
  const state = run.read();
  if (!state.secret || who.email !== state.sender?.email) return api(who);
  const held = kept.get(who.email);
  if (held && Date.now() - held.at < 4 * 60_000) return held.client;
  const client = await api(who, { totpCode: await aCode() });
  kept.set(who.email, { client, at: Date.now() });
  return client;
}

/** Signs A in on the page with the password and a fresh code, as a person with an authenticator does. */
async function signInA(page) {
  const { sender } = people();
  const totpCode = await aCode();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', sender.email);
  await page.fill('input[name=password]', sender.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * The owner's money-out rule on the stack's bank: `required` asks for a fresh confirmation on every send to another
 * person (BANK_STEP_UP_MONEY_OUT, ADR 2026-10-14-money-out-step-up); off is the stack's default. Set for the restart only.
 */
function stepUpRule(required) {
  const key = 'LOCAL_STACK_BANK_STEP_UP_MONEY_OUT';
  const before = process.env[key];
  if (required) process.env[key] = 'required';
  else delete process.env[key];
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

/** A's transfers out of exactly this amount, as the bank lists them. */
async function sentOf(amount) {
  const page = await trpc(await session(people().sender), 'GET', 'bank/trpc/transfers.list', { limit: 200 });
  return page.items.filter((item) => item.kind === 'transfer_out' && toUnits(item.amount) === toUnits(amount));
}

/** Every `transfers.toUser` the page sends, by body, so a second post would be seen even if the bank refused it. */
function sends(page) {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.toUser')) seen.push(req.postDataJSON());
  });
  return seen;
}

/** The Send room is what is on screen: the Send tab chosen, the To field ready, and no not-found page. */
async function onSend(page) {
  await expect(page).toHaveURL(/\/pay(\/send)?(\?|$)/);
  await expect(page.getByRole('tab', { name: 'Send', selected: true })).toBeVisible();
  await expect(page.getByTestId('send-panel')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Handle', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
  await expect(page.getByText(/page not found/i)).toHaveCount(0);
}

/** The personal rooms the Pay card offers as its own tabs, beside Send. */
const TABS = ['Receive', 'Request', 'Bills', 'Global'];
/** Every other personal Pay room, by its name and address (apps/customer/src/app/navigation.ts). */
const OTHER_ROOMS = [
  ['Scheduled', '/pay/scheduled'],
  ['Contacts', '/pay/contacts'],
  ['Send limits', '/pay/send/limits'],
  ['Pay fees', '/pay/fees'],
  ['Pay preferences', '/pay/preferences'],
  ['Scan to pay', '/pay/scan'],
  ['Cases', '/pay/cases'],
];

test(`${J} #1 opens Pay from the navigation or a deep link and lands on Send, with the other personal rooms listed`, async ({ page }) => {
  // The start: two verified members; B has named their profile; A holds TEST 100 USDT and a little TEST BTC in the
  // ledger, and has saved @<saved> as a recipient. @<lookalike> is another member whose handle imitates the saved one;
  // it holds TEST 1 USDT, so its own Send room has a To field when it is the one that runs out of lookups in #2.
  const tag = Date.now().toString(36);
  const saved = await signUpAs(page, `jpcleo${tag}`);
  const lookalike = await signUpAs(page, `jpc1eo${tag}`, { verified: true });
  const recipient = await signUp(page, 'jpb');
  await verify(page, recipient);
  const b = await api(recipient);
  const profile = await trpc(b, 'GET', 'identity/trpc/profile.get');
  expect((await trpc(b, 'POST', 'identity/trpc/profile.update', { displayName: B_NAME, ifVersion: profile.version })).displayName).toBe(
    B_NAME,
  );
  const sender = await signUp(page, 'jpa');
  await verify(page, sender);
  expect(fund(sender.email, 'USDT', '100').tx).toBeTruthy();
  expect(fund(sender.email, 'BTC', '0.01').tx).toBeTruthy();
  expect(fund(lookalike.email, 'USDT', '1').tx).toBeTruthy();
  const a = await api(sender);
  await trpc(a, 'POST', 'identity/trpc/recipients.add', {
    handle: saved.handle,
    label: 'Cleo',
    idempotencyKey: `save:${saved.handle}:${J}`,
  });
  expect((await trpc(a, 'GET', 'identity/trpc/recipients.list', { limit: 100 })).map((row) => row.handle)).toEqual([saved.handle]);
  run.reset({
    sender,
    recipient,
    saved: saved.handle,
    lookalike: lookalike.handle,
    prober: lookalike,
    before: { sender: await usdt(sender), recipient: await usdt(recipient) },
  });
  expect(run.read().before).toEqual({ sender: '100', recipient: '0' });

  // From the navigation.
  await signIn(page, sender);
  await page.goto('/');
  await page.getByRole('link', { name: 'Pay', exact: true }).first().click();
  await onSend(page);
  // The other personal rooms are listed in the room itself: the card's tabs, then a list of links to the rest.
  for (const name of TABS) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  const list = page.getByRole('navigation', { name: 'More in Pay' });
  for (const [name, href] of OTHER_ROOMS) await expect(list.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  await expect(list.getByRole('link')).toHaveCount(OTHER_ROOMS.length);

  // From a deep link, typed or shared: /pay and /pay/send open the same Send room.
  for (const address of ['/pay', '/pay/send']) {
    await page.goto(address);
    await onSend(page);
  }
});

test(`${J} #2 types a handle in To and sees who it is, or a plain answer, and a look-alike of a saved recipient is flagged`, async ({
  page,
}) => {
  const { sender, recipient, saved, lookalike, prober } = people();
  await signIn(page, sender);
  await page.goto('/pay');
  const status = page.getByTestId('to-status');

  // B: their name, their handle and the member badge, and no look-alike flag.
  await lookUp(page, recipient.handle);
  await expect(status.getByTestId('recipient-name')).toHaveText(B_NAME);
  await expect(status.getByTestId('recipient-handle')).toHaveText(`@${recipient.handle}`);
  await expect(status.getByTestId('recipient-member')).toHaveText(joinedThisMonth());
  await expect(page.getByTestId('pay-lookalike')).toHaveCount(0);

  // An unknown handle and one's own handle each get a plain answer, not a raw code.
  const nobody = `nobody${Date.now().toString(36)}`;
  await lookUp(page, nobody);
  await expect(status).toContainText(`We couldn’t find @${nobody}. Check the spelling.`);
  await expect(status.getByTestId('recipient-found')).toHaveCount(0);
  await lookUp(page, recipient.handle.slice(0, 2));
  await expect(status).toContainText('A handle has 3 to 32 letters, numbers or underscores.');
  await lookUp(page, sender.handle);
  await expect(status).toContainText('That’s you. Pick someone else.');
  await expect(status.getByTestId('recipient-found')).toHaveCount(0);

  // The saved recipient is not flagged; a member whose handle imitates them is, before anything can be sent.
  await lookUp(page, saved);
  await expect(status.getByTestId('recipient-handle')).toHaveText(`@${saved}`);
  await expect(page.getByTestId('pay-lookalike')).toHaveCount(0);
  await lookUp(page, lookalike);
  await expect(status.getByTestId('recipient-handle')).toHaveText(`@${lookalike}`);
  await expect(page.getByTestId('pay-lookalike')).toHaveText(
    `Careful: @${lookalike} looks like @${saved}, someone you saved. Check this is the right person before you send.`,
  );
  await expect(page.getByTestId('pay-dialog')).toHaveCount(0);
  await signOutBrowser(page.context());

  // Too many lookups: a member (the look-alike account, not A, whose lookups the next steps need) spends their lookup
  // budget (30 a minute) through their own session, then types a handle in their own Send room.
  const own = await api(prober);
  const ask = () =>
    own.get(`/api/identity/trpc/users.resolveHandle?input=${encodeURIComponent(JSON.stringify({ handle: sender.handle }))}`);
  let refused = null;
  for (let i = 0; i < 40 && !refused; i++) {
    const res = await ask();
    if (res.status === 429) refused = res;
    else expect(res.status).toBe(200);
  }
  expect(refused, 'identity never refused a lookup within 40 asks').not.toBeNull();
  await signIn(page, prober);
  await page.goto('/pay');
  await lookUp(page, sender.handle);
  await expect(status).toContainText('Too many lookups. Wait a minute, then try again.');
  await expect(status.getByTestId('recipient-found')).toHaveCount(0);
});

test(`${J} #3 picks the asset (stablecoin first), enters TEST 25 USDT and a note, and sees the exact amount, the note, the source space and the fee line`, async ({
  page,
}) => {
  const { sender, recipient } = people();
  await signIn(page, sender);
  await page.goto('/pay');
  await lookUp(page, recipient.handle);
  await expect(page.getByTestId('to-status').getByTestId('recipient-handle')).toHaveText(`@${recipient.handle}`);

  // The picker lists the stablecoin first and starts on it; A also holds BTC, listed after.
  await page.getByRole('combobox', { name: 'Asset to send' }).click();
  const options = page.getByRole('option');
  await expect(options.first()).toHaveText('USDT');
  await expect(options.filter({ hasText: 'BTC' })).toHaveCount(1);
  await options.first().click();
  await expect(page.getByRole('combobox', { name: 'Asset to send' })).toContainText('USDT');

  // The amount is shown in exact units: every digit typed, nothing rounded or padded.
  const amount = page.getByLabel('Amount to send');
  await amount.fill('25.000001');
  await expect(page.getByTestId('pay-summary-amount')).toHaveText('25.000001 USDT');
  await amount.fill(AMOUNT);
  await expect(page.getByTestId('pay-summary-amount')).toHaveText(`${AMOUNT} USDT`);
  await page.locator('#pay-note').fill(NOTE);
  await expect(page.getByTestId('pay-summary-note')).toHaveText(NOTE);
  await expect(page.getByTestId('pay-summary-source')).toHaveText(await mainSpace(sender));

  // The fee line is the published one for this amount: free here, as the quote answers.
  const expected = await terms(sender);
  const line = page.getByTestId('pay-terms');
  await expect(line).toHaveAttribute('data-terms', 'ok');
  await expect(line).toHaveText(`${expected.fee}. ${expected.perPayment}`);
  await expect(page.getByTestId('pay-review')).toBeEnabled();
});

test(`${J} #4 presses Review and sees amount, recipient identity, source, note, fee and today's allowance, with a first-time caution and no test payment`, async ({
  page,
}) => {
  const { sender, recipient } = people();
  const expected = await terms(sender);
  await sendForm(page);
  await page.getByTestId('pay-review').click();
  const dialog = page.getByTestId('pay-dialog');
  await expect(dialog).toBeVisible();
  const to = dialog.getByTestId('pay-review-to');
  await expect(to.getByTestId('recipient-name')).toHaveText(B_NAME);
  await expect(to.getByTestId('recipient-handle')).toHaveText(`@${recipient.handle}`);
  await expect(to.getByTestId('recipient-member')).toHaveText(joinedThisMonth());
  await expect(dialog.getByTestId('pay-review-amount')).toContainText(`${AMOUNT} USDT`);
  await expect(dialog.getByTestId('pay-review-from')).toContainText(await mainSpace(sender));
  await expect(dialog.getByTestId('pay-review-note')).toContainText(NOTE);
  await expect(dialog.getByTestId('pay-review-fee')).toContainText(expected.reviewFee);
  await expect(dialog.getByTestId('pay-review-allowance')).toContainText(expected.allowance);
  await expect(dialog.getByTestId('pay-review-left')).toContainText(expected.after);
  // B is a first-time recipient: a caution, and the promise that no test payment is sent for them.
  await expect(dialog.getByTestId('pay-first-time')).toHaveText(
    `You haven’t sent to @${recipient.handle} before. Check the handle with them. We never send a test payment for you: only the amount you confirm here moves.`,
  );
  await expect(dialog.getByTestId('pay-review-lookalike')).toHaveCount(0);
  // Nothing has moved, not even a small test amount: both balances as they were, and no transfer out of A.
  await page.waitForTimeout(2000);
  expect(await usdt(sender)).toBe(run.read().before.sender);
  expect(await usdt(recipient)).toBe(run.read().before.recipient);
  const sent = await trpc(await api(sender), 'GET', 'bank/trpc/transfers.list', { limit: 50 });
  expect(sent.items.filter((item) => item.kind === 'transfer_out')).toEqual([]);
  await expect(dialog).toBeVisible();
});

test(`${J} #5 confirms through the owner's fresh confirmation step: a wrong code is refused, and a double click, a held reply or a reload never sends twice`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { sender, recipient } = people();
  // A sets up an authenticator app, as a person who confirms payments with a code does.
  await signIn(page, sender);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  const before = { sender: await usdt(sender), recipient: await usdt(recipient) };
  expect(before).toEqual(run.read().before);

  // The owner's rule asks for a fresh confirmation before money leaves for another person.
  stepUpRule(true);
  try {
    const posted = sends(page);
    const approved = () => posted.filter((body) => typeof body.stepUpApprovalId === 'string');
    await sendForm(page, { signedIn: true });
    await page.getByTestId('pay-review').click();
    // A double click on Send: one call, which the bank refuses because the rule asks for a fresh confirmation.
    await page.getByTestId('pay-send').dblclick();
    const stepUp = page.getByTestId('pay-step-up');
    await expect(stepUp).toBeVisible();
    await expect(stepUp.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
    await expect(stepUp).toContainText('This sends money to another person, so we check it’s you first.');
    expect(posted).toHaveLength(1);
    expect(approved()).toEqual([]);

    // A wrong code is refused, and nothing moves.
    await stepUp.getByLabel('Authenticator code').fill(await wrongCode());
    await page.getByTestId('pay-step-up-confirm').click();
    await expect(page.getByTestId('pay-step-up-problem')).toHaveText(
      'That code didn’t match, so nothing was sent. Check your authenticator app and try again.',
    );
    await expect(page.getByTestId('pay-receipt')).toHaveCount(0);
    expect(approved()).toEqual([]);
    expect(await usdt(sender)).toBe(before.sender);
    expect(await usdt(recipient)).toBe(before.recipient);
    expect(await sentOf(AMOUNT)).toEqual([]);

    // The right code, confirmed with a double click: one send carries the approval, and the ledger posts once.
    await stepUp.getByLabel('Authenticator code').fill(await aCode());
    await page.getByTestId('pay-step-up-confirm').dblclick();
    await expect(page.getByTestId('pay-receipt')).toBeVisible();
    await expect(page.getByTestId('pay-receipt-amount')).toContainText(AMOUNT);
    const reference = (await page.getByTestId('pay-receipt-reference').innerText()).trim();
    expect(reference).not.toBe('');
    run.write({ reference });
    expect(approved()).toHaveLength(1);
    expect(new Set(posted.map((body) => body.transferId)).size).toBe(1);
    expect(toUnits(before.sender) - toUnits(await usdt(sender))).toBe(toUnits(AMOUNT));
    expect(toUnits(await usdt(recipient)) - toUnits(before.recipient)).toBe(toUnits(AMOUNT));
    expect(await sentOf(AMOUNT)).toHaveLength(1);

    // A second payment, TEST 1.5 USDT, whose reply is held on its way back: A double clicks, then reloads the page.
    const second = '1.5';
    const mid = { sender: await usdt(sender), recipient: await usdt(recipient) };
    const posted2 = sends(page);
    let release;
    const released = new Promise((resolve) => (release = resolve));
    let reached;
    const arrived = new Promise((resolve) => (reached = resolve));
    await page.route('**/api/bank/trpc/transfers.toUser', async (route) => {
      if (typeof route.request().postDataJSON()?.stepUpApprovalId !== 'string') return route.continue();
      const answer = await route.fetch();
      reached();
      await released;
      await route.fulfill({ response: answer }).catch(() => undefined);
    });
    await sendForm(page, { amount: second, note: null, signedIn: true });
    await page.getByTestId('pay-review').click();
    await page.getByTestId('pay-send').click();
    await expect(stepUp).toBeVisible();
    await stepUp.getByLabel('Authenticator code').fill(await aCode());
    await page.getByTestId('pay-step-up-confirm').dblclick();
    await arrived;
    // While the reply is held, the button says it is sending and cannot be pressed again.
    await expect(page.getByTestId('pay-step-up-confirm')).toBeDisabled();
    await expect(page.getByTestId('pay-step-up-confirm')).toHaveText('Sending…');
    await page.reload();
    release();
    // After the reload, Send waits on the payment that was on its way: it is not sent again, and Review stays off.
    await expect(page.getByTestId('pay-waiting')).toContainText('We’re still confirming your last payment.');
    await expect(page.getByTestId('pay-review')).toBeDisabled();
    await page.waitForTimeout(2000);
    await page.unroute('**/api/bank/trpc/transfers.toUser');
    expect(posted2.filter((body) => typeof body.stepUpApprovalId === 'string')).toHaveLength(1);
    expect(toUnits(mid.sender) - toUnits(await usdt(sender))).toBe(toUnits(second));
    expect(toUnits(await usdt(recipient)) - toUnits(mid.recipient)).toBe(toUnits(second));
    expect(await sentOf(second)).toHaveLength(1);
    run.write({ second });
  } finally {
    stepUpRule(false);
  }
});

/** The 25 USDT payment's status page, opened from its receipt link on the person's recent payments in Pay. */
async function statusPage(page) {
  await page.goto('/pay');
  const row = page.getByTestId('recent-payment').filter({ hasText: new RegExp(`[−+]${AMOUNT} USDT`) });
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: /receipt/i }).click();
  await expect(page).toHaveURL(/\/money\/activity\/[^/?]+/);
}

test(`${J} #6 reads the payment status page: Completed for both parties, no Cancel button, and a pointer to refund`, async ({ page }) => {
  test.setTimeout(240_000);
  const { sender, recipient } = people();
  const { reference } = run.read();
  if (!reference) throw new Error(`${J} #5 sent nothing, so there is no payment to read`);
  const sides = [
    {
      signIn: () => signInA(page),
      note: `This payment is complete and can’t be cancelled. To get it back, ask @${recipient.handle} to send you a refund.`,
      link: 'Make a payment request',
      href: '/pay/request',
    },
    {
      signIn: () => signIn(page, recipient),
      note: `This payment is complete and can’t be cancelled. To refund it, send it back to @${sender.handle}.`,
      link: `Refund @${sender.handle}`,
      href: `/pay/send?to=${sender.handle}&amount=${AMOUNT}&asset=USDT`,
    },
  ];
  for (const side of sides) {
    await side.signIn();
    await statusPage(page);
    await expect(page.getByTestId('money-act__done')).toHaveText('Completed');
    await expect(page.getByTestId('money-act__hold')).toHaveCount(0);
    await expect(page.getByText(NOTE)).toBeVisible();
    await expect(page.getByText(reference).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /cancel/i })).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Report a problem' }).or(page.getByRole('button', { name: 'Report a problem' })),
    ).toBeVisible();
    const refund = page.getByTestId('money-refund');
    await expect(refund).toHaveText(`${side.note} ${side.link}`);
    await expect(refund.getByRole('link', { name: side.link, exact: true })).toHaveAttribute('href', side.href);
    await signOutBrowser(page.context());
  }
});

/**
 * B's payment event delivered again: the bank's personal_transfer.posted for this payment, read off the stack's bus and
 * published once more with its payload unchanged (same transfer) under a new envelope key, so the bus does not drop it as
 * its own duplicate and svc-notify is what must hold. Returns the payload.
 */
function redeliverPayment(ledgerTxId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, LEDGER_TX: ledgerTxId } = process.env;
    const subject = EVENT_CATALOG.personalTransferPosted.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName('bank', prefix);
    const { state } = await jsm.streams.info(stream);
    let payload;
    for (let seq = state.last_seq; seq >= state.first_seq && !payload; seq -= 1) {
      const m = await jsm.streams.getMessage(stream, { seq }).catch(() => null);
      if (m?.subject !== subject) continue;
      const env = decodeEnvelope(m.data);
      if (env.payload.ledgerTxId === ledgerTxId) payload = env.payload;
    }
    await nc.close();
    if (!payload) throw new Error('no ' + subject + ' for ' + ledgerTxId + ' in ' + stream);
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-bank', streamPrefix: prefix });
    await bus.publish('personalTransferPosted', payload, { idempotencyKey: payload.transferId + ':again:' + Date.now() });
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(ROOT, 'packages', 'events'),
    env: { ...process.env, NATS_URL: 'nats://127.0.0.1:14232', NATS_STREAM_PREFIX: 'LOCAL_TEST', LEDGER_TX: ledgerTxId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the payment event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** Until svc-notify's consumer of posted personal sends has taken and acknowledged every message on the bus. */
async function noticesCaughtUp() {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'notify-personal-transfer-posted');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
}

test(`${J} #7 the recipient opens Pay: the payment, note and sender in activity, one in-app notice even for a duplicate event, and the mandatory class locked on`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sender, recipient } = people();
  const { reference } = run.read();
  if (!reference) throw new Error(`${J} #5 sent nothing, so there is nothing to receive`);
  await signIn(page, recipient);
  await page.goto('/pay');
  const row = page.getByTestId('recent-payment').filter({ hasText: `+${AMOUNT} USDT` });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('recent-payment-who')).toHaveText(`Received from @${sender.handle}`);
  await expect(row.getByTestId('recent-payment-note')).toHaveText(NOTE);
  await expect(row.getByTestId('recent-payment-amount')).toHaveText(`+${AMOUNT} USDT`);
  await expect(row.getByTestId('recent-payment-status')).toHaveText('Completed');

  // The in-app notice: one, and still one after the same payment's event is delivered again.
  const received = `You received ${AMOUNT} USDT.`;
  await page.goto('/notifications');
  await expect(page.getByText('Money received').first()).toBeVisible();
  await expect(page.getByText(received, { exact: true })).toHaveCount(1);
  expect(redeliverPayment(reference).ledgerTxId).toBe(reference);
  await noticesCaughtUp();
  await page.reload();
  await expect(page.getByText('Money received').first()).toBeVisible();
  await expect(page.getByText(received, { exact: true })).toHaveCount(1);

  // The class payment notices belong to is mandatory in the app: its in-app switch is on and locked, and says why.
  await page.goto('/notifications?view=settings');
  const toggle = page.getByRole('switch', { name: 'Orders and trades, Inbox in the app', exact: true });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  const orders = page.getByRole('row').filter({ hasText: 'Fills, ended orders, escrow and payment updates' });
  await expect(orders).toHaveCount(1);
  await expect(orders.getByRole('cell').first()).toContainText('Always on. We keep this one on for your protection.');
});

test(`${J} #8 either person opens the balance page: the balance on screen equals the ledger's, and the payment's row shows its date`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sender, recipient } = people();
  const { reference, before, second } = run.read();
  if (!reference || !second) throw new Error(`${J} #5 sent nothing, so there is no balance to read`);
  const moved = toUnits(AMOUNT) + toUnits(second);
  for (const side of [
    { who: sender, signIn: () => signInA(page), expected: toUnits(before.sender) - moved, sign: '−' },
    { who: recipient, signIn: () => signIn(page, recipient), expected: toUnits(before.recipient) + moved, sign: '+' },
  ]) {
    await side.signIn();
    // The ledger's USDT balance for this person, through their own API: what this run moved, exactly.
    const ledger = await usdt(side.who);
    expect(toUnits(ledger)).toBe(side.expected);
    // Money: the balance is shown as the ledger answers it (the screen groups thousands; none here to undo).
    await page.goto('/money');
    await expect(page.getByText(new RegExp(`(^|\\s)${ledger.replace('.', '\\.')}\\s*USDT`)).first()).toBeVisible();
    // The balance page for USDT: the bank's check of every entry against the ledger's balance, and that balance.
    await page.goto('/money/balance/USDT');
    const check = page.getByText(/^All \d+ entries add up to your balance: /);
    await expect(check).toBeVisible();
    const onScreen = (await check.innerText()).match(/your balance: ([\d,.]+) USDT\.$/)?.[1];
    expect(onScreen, 'the balance line names a figure').toBeTruthy();
    expect(toUnits(onScreen.replaceAll(',', ''))).toBe(toUnits(ledger));
    // The payment's row: its reference, its date, and the amount on this person's side.
    const row = page.getByRole('row').filter({ hasText: reference });
    await expect(row).toHaveCount(1);
    await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    await expect(row).toContainText(`${side.sign}${AMOUNT}`);
    await signOutBrowser(page.context());
  }
});
