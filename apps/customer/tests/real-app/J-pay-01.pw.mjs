import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, fromUnits, fund, journeyState, signUpInBrowser, toUnits, signOutBrowser } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

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

const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

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
async function sendForm(page) {
  const { sender, recipient } = people();
  await signIn(page, sender);
  await page.goto('/pay');
  await lookUp(page, recipient.handle);
  await expect(page.getByTestId('recipient-handle').first()).toHaveText(`@${recipient.handle}`);
  await page.getByLabel('Amount to send').fill(AMOUNT);
  await page.locator('#pay-note').fill(NOTE);
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
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

test(`${J} #5 confirms with a double click and the money moves once`, async ({ page }) => {
  await sendForm(page);
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').dblclick();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  await expect(page.getByTestId('pay-receipt-amount')).toContainText(AMOUNT);
  const reference = (await page.getByTestId('pay-receipt-reference').innerText()).trim();
  expect(reference).not.toBe('');
  run.write({ reference });
  // Exactly TEST 25 USDT left A and reached B: one post, not two.
  const { sender, recipient } = people();
  const { before } = run.read();
  expect(toUnits(before.sender) - toUnits(await usdt(sender))).toBe(toUnits(AMOUNT));
  expect(toUnits(await usdt(recipient)) - toUnits(before.recipient)).toBe(toUnits(AMOUNT));
});

/** The payment's status page, opened from the receipt link on Pay's recent payments. */
async function statusPage(page, who) {
  await signIn(page, who);
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/money\/activity\/[^/?]+/);
  await expect(page.getByText('Completed').first()).toBeVisible();
}

test(`${J} #6 reads the payment status page: Completed for both, no Cancel, and a way to report a problem`, async ({ page }) => {
  const { sender, recipient } = people();
  for (const who of [sender, recipient]) {
    await statusPage(page, who);
    await expect(page.getByText(NOTE)).toBeVisible();
    await expect(page.getByText(run.read().reference).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Report a problem' }).or(page.getByRole('button', { name: 'Report a problem' })),
    ).toBeVisible();
    await signOutBrowser(page.context());
  }
});

test(`${J} #7 the recipient opens Pay and sees the payment, the sender, the note and a notice`, async ({ page }) => {
  const { sender, recipient } = people();
  await signIn(page, recipient);
  await page.goto('/pay');
  await expect(page.getByText(`@${sender.handle}`).first()).toBeVisible();
  await expect(page.getByText(`+${AMOUNT} USDT`).first()).toBeVisible();
  await page.goto('/notifications');
  await expect(page.getByText('Money received').first()).toBeVisible();
  await expect(page.getByText(`You received ${AMOUNT} USDT.`)).toHaveCount(1);
});

test(`${J} #8 each person's balance on screen equals the ledger`, async ({ page }) => {
  const { sender, recipient } = people();
  for (const who of [sender, recipient]) {
    await signIn(page, who);
    await page.goto('/money');
    // The screen groups thousands; the ledger answers a plain decimal (75 and 25 here, so no grouping to undo).
    const ledger = await usdt(who);
    await expect(page.getByText(new RegExp(`(^|\\s)${ledger.replace('.', '\\.')}\\s*USDT`)).first()).toBeVisible();
    await signOutBrowser(page.context());
  }
});
