// World: book, freeze, gates
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { fundedTrader, openDesk, reviewLimit, signIn } from './desk.mjs';
import { api, signOutBrowser, signUpInBrowser, tool } from './stack.mjs';

// J-identity-14, in the running app (docs/roadmap/journeys.json): my account is restricted and I appeal.
// Starts signed in, with staff having restricted the account with a reason. Ends with the appeal decided by someone other
// than the person who restricted, and the restriction lifted or upheld with a reason the person can read. Moves no money.
// Independent tests (OWNER 212): every clause of each step's words is checked. Where the product has no part yet, the
// test names what the person sees and the stack tool that sets it up, so the builder has stable names to build to:
//   local-test-gates.mjs account-close <handle> grace <reasonCode> <days>   a staff close with a grace date
//   local-test-gates.mjs account-close <handle> final <reasonCode>          a final staff closure
// Steps #1 to #3, which are not built yet. #4 passes on main and lives in J-identity-14.pw.mjs, whose #1 to #3 are
// placeholders these tests replace.
const J = 'J-identity-14';

const OWNER_VALUES = JSON.parse(
  readFileSync(new URL('../../../../tooling/profiles/test-owner-values/identity.json', import.meta.url), 'utf8'),
).values;
/** Every entry of an owner reason list in identity's TEST owner values, as identity returns its words. */
function ownerReasons(setting) {
  return JSON.parse(OWNER_VALUES[setting].value).map((r) => ({ code: r.code, text: r.reason, guidance: r.guidance }));
}
const [TRADING_REASON] = ownerReasons('IDENTITY_TRADING_RESTRICTION_REASONS');
const WINDOW_DAYS = OWNER_VALUES.IDENTITY_APPEAL_WINDOW_DAYS.value;
// A closure reason from identity's fixed closure list, and its plain words on the status page.
const CLOSE_REASON = { code: 'other', words: 'another reason' };
const GRACE_DAYS = 14;

function person(prefix = 'ap') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** Staff restrict this person's trading with the TEST reason, through identity's own two-person door. */
function restrictTrading(handle) {
  expect(tool('local-test-gates.mjs', 'trading-restrict', handle, 'restrict', TRADING_REASON.code)).toMatch(
    /OK .* trading restrict: changed/,
  );
}

/** A fresh TEST person signed up in this browser, whose trading staff restricted with the TEST reason. */
async function restricted(page, prefix) {
  const who = person(prefix);
  await signUpInBrowser(page, who);
  restrictTrading(who.handle);
  lifts.push(who.handle);
  return who;
}

/** Identity's own record of this person's appeals and status, read with their session. */
async function readBack(client) {
  const appeals = await client.get('/api/identity/trpc/accountAppeal.mine');
  expect(appeals.status, JSON.stringify(appeals.body)).toBe(200);
  const status = await client.get('/api/identity/trpc/accountStatus.mine');
  expect(status.status, JSON.stringify(status.body)).toBe(200);
  return { mine: appeals.body.result.data, status: status.body.result.data };
}

/** File an appeal from the account status page, and see it listed as waiting. */
async function fileAppeal(page, text) {
  await page.goto('/uc/account');
  const panel = page.getByTestId('account-appeals');
  await expect(panel.getByText(`You can appeal within ${WINDOW_DAYS} days of the restriction starting.`)).toBeVisible();
  const submitted = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/accountAppeal.submit'));
  await panel.getByLabel('Why should this be lifted?').fill(text);
  await panel.getByRole('button', { name: 'Send appeal' }).click();
  expect((await submitted).status()).toBe(200);
  await expect(panel.getByRole('status')).toHaveText('Your appeal was sent. We will tell you the decision.');
  const listed = panel.getByTestId('account-appeals__appeal');
  await expect(listed).toHaveCount(1);
  await expect(listed).toHaveAttribute('data-status', 'submitted');
  await expect(listed).toContainText('Waiting for a decision');
  return panel;
}

/** A new limit order sent from the desk, and the desk's answer to it. */
async function sendOrder(page) {
  const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
  // 10 USDT at a fixed TEST price: over the market's minimum, under the TEST balance; the book is not needed.
  const review = await reviewLimit(page, 'buy', '10000.00', '0.001');
  await review.getByRole('button', { name: 'Confirm buy' }).click();
  return sent;
}

const lifts = [];
test.afterAll(() => {
  // Leave no journey account restricted if a test stopped before its own lift.
  for (const handle of lifts) {
    try {
      tool('local-test-gates.mjs', 'trading-restrict', handle, 'restore');
    } catch {
      // Already lifted, or never restricted.
    }
  }
});

// ── The platform posting freeze, as the founders' freeze desk does it (A asks, B approves, A runs) ─────────────────────

const founders = { a: null, b: null };
async function founderPages(browser) {
  for (const key of ['a', 'b']) {
    if (founders[key]) continue;
    founders[key] = await (await browser.newContext()).newPage();
    await founderSignIn(founders[key], key);
    await founders[key].goto(`${ADMIN}/`, { waitUntil: 'load' });
  }
  return founders;
}
const freezeStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);
const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));
const readFreeze = (page) => page.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());
async function setPostingFreeze(browser, frozen) {
  const { a, b } = await founderPages(browser);
  const record = await readFreeze(a);
  expect(record.ok, JSON.stringify(record)).toBe(true);
  if (record.state.frozen === frozen) return;
  const version = record.state.version;
  const request = frozen
    ? { kind: 'ledger.freeze', reason: `LOCAL TEST ${J} #2 posting freeze`, version }
    : { kind: 'ledger.unfreeze', version };
  const confirm = frozen ? 'FREEZE LEDGER' : 'UNFREEZE LEDGER';
  const proposed = await freezeStep(a, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await freezeStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await freezeStep(a, { step: 'execute', request, confirm, approvalId: packet.approvalId, operationId: packet.operationId });
  expect(ran.body.ok, JSON.stringify(ran.body)).toBe(true);
  expect((await readFreeze(a)).state.frozen).toBe(frozen);
}
let freezeOn = false;
// A freeze left on refuses every later journey's posts on this stack, so a test that stopped inside one lifts it here.
test.afterEach(async ({ browser }) => {
  if (!freezeOn) return;
  founders.a = null;
  founders.b = null;
  await setPostingFreeze(browser, false);
  freezeOn = false;
});
test.afterAll(async () => {
  for (const key of ['a', 'b']) await founders[key]?.context().close();
});

// ── The steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #1 signs in to a restricted account: the status page shows the state, the stored reason in plain words and what is blocked; a staff close with a grace date lets me withdraw but not trade until the date`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Restricted: staff restricted trading with the TEST reason; the person signs in and opens the status page.
  const who = person('apr');
  await signUpInBrowser(page, who);
  restrictTrading(who.handle);
  lifts.push(who.handle);
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  // The state.
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  await expect(status.getByTestId('account-status__state')).toHaveText('Some actions are restricted on your account.');
  // The stored reason code, in plain words: the owner's sentence and next step for it, never the code itself.
  const client = await api(who);
  const stored = (await readBack(client)).status.restrictions.filter((r) => r.kind === 'trading_restricted');
  expect(stored.map((r) => r.owner)).toEqual([TRADING_REASON]);
  const row = status.getByTestId('account-status__restrictions').locator('li[data-kind="trading_restricted"]');
  await expect(row).toHaveAttribute('data-reason', TRADING_REASON.code);
  await expect(row).toContainText(TRADING_REASON.text);
  await expect(row).toContainText(`Next: ${TRADING_REASON.guidance}`);
  await expect(status).not.toContainText(TRADING_REASON.code);
  // The actions blocked.
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(['Trade']);

  // A staff close with a grace date: until the date the person can withdraw but not trade, and the page says until when.
  const closing = person('apc');
  await signOutBrowser(page.context());
  await signUpInBrowser(page, closing);
  expect(tool('local-test-gates.mjs', 'account-close', closing.handle, 'grace', CLOSE_REASON.code, String(GRACE_DAYS))).toMatch(
    /OK .* account close: closed/,
  );
  const closingClient = await api(closing);
  const record = (await readBack(closingClient)).status;
  expect(record.state).toBe('closed');
  const graceUntil = record.restrictions.find((r) => r.kind === 'closed')?.graceUntil;
  expect(graceUntil, 'the close carries its grace date').toBeTruthy();
  const days = (Date.parse(graceUntil) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(GRACE_DAYS - 1);
  expect(days).toBeLessThanOrEqual(GRACE_DAYS);
  await page.goto('/uc/account');
  const closingStatus = page.getByTestId('account-status');
  await expect(closingStatus.getByTestId('account-status__state')).toHaveAttribute('data-state', 'closed');
  await expect(closingStatus.getByTestId('account-status__state')).toHaveAttribute('data-grace-until', graceUntil);
  const closedRow = closingStatus.getByTestId('account-status__restrictions').locator('li[data-kind="closed"]');
  await expect(closedRow).toContainText(`Reason: ${CLOSE_REASON.words}.`);
  await expect(closingStatus.getByTestId('account-status__can')).toContainText('Start a send to a withdrawal address');
  await expect(closingStatus.getByTestId('account-status__cannot')).toContainText('Trade');
  // Identity's own record agrees: a send out stays open until the date, trading does not.
  expect(record.canStill).toContain('withdraw_to_address');
  expect(record.cannot.map((c) => c.action)).toContain('trade');
});

test(`${J} #2 opens a refusal on any screen: the same reason wording everywhere`, async ({ page }) => {
  test.setTimeout(300_000);
  // A verified person with TEST USDT, so an order reaches the trading check: the restriction is what refuses it.
  const who = await fundedTrader(page, 'apw', '100');
  restrictTrading(who.handle);
  lifts.push(who.handle);
  await openDesk(page, who);
  const answer = await sendOrder(page);
  expect(answer.status()).toBe(403);
  expect((await answer.json()).intafacedCode).toBe('trade.account_restricted');
  // The desk's refusal gives the reason in the same words as the status page: the stored reason's owner sentence.
  const main = page.getByRole('main');
  await expect(main.getByText(TRADING_REASON.text)).toBeVisible();
  await expect(main).not.toContainText(TRADING_REASON.code);
  await expect(main).not.toContainText('trade.account_restricted');
  await page.goto('/uc/account');
  const row = page.getByTestId('account-status__restrictions').locator('li[data-kind="trading_restricted"]');
  await expect(row).toContainText(TRADING_REASON.text);
});

test(`${J} #2 ledger.frozen shows the platform message and never "account restricted"`, async ({ page, browser }) => {
  test.setTimeout(360_000);
  // A verified sender with TEST USDT and a recipient: the platform freeze, not a missing level or balance, refuses it.
  const recipient = person('apt');
  const other = await browser.newContext();
  try {
    await signUpInBrowser(await other.newPage(), recipient);
  } finally {
    await other.close();
  }
  const who = await fundedTrader(page, 'apf', '100');
  await signIn(page, who);
  const client = await api(who);
  const before = (await client.balances()).USDT;
  try {
    freezeOn = true;
    await setPostingFreeze(browser, true);
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/transfers.toUser') && r.request().method() === 'POST');
    await page.goto('/pay');
    const to = page.getByRole('textbox', { name: 'Handle', exact: true });
    await to.fill(recipient.handle);
    await to.press('Tab');
    await expect(page.getByTestId('recipient-handle').first()).toHaveText(`@${recipient.handle}`);
    await page.getByLabel('Amount to send').fill('5');
    await page.getByTestId('pay-review').click();
    await page.getByTestId('pay-send').click();
    const answer = await sent;
    expect(JSON.stringify(await answer.json())).toContain('ledger.frozen');
    // The platform message, and nowhere on the page a word that makes it this account's restriction.
    const main = page.getByRole('main');
    await expect(main.getByText('Money movement is paused for everyone')).toBeVisible();
    await expect(main).toContainText(
      'Money movement is paused across the platform right now. Your account is not on hold. Nothing was done.',
    );
    await expect(page.locator('body')).not.toContainText(/account (is )?restricted|restricted on your account|restricted/i);
    await expect(page.getByTestId('pay-receipt')).toHaveCount(0);
    expect((await client.balances()).USDT).toEqual(before);
  } finally {
    await setPostingFreeze(browser, false);
    freezeOn = false;
  }
});

test(`${J} #3 files an appeal: one open appeal at a time, a second is refused, a final closure refuses with "appeal not allowed"`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await restricted(page, 'apf');
  const client = await api(who);
  const panel = await fileAppeal(page, 'TEST: I only placed ordinary orders.');

  // Identity holds exactly that one appeal, open, for this restriction.
  const first = await readBack(client);
  expect(first.mine.windowDays).toBe(Number(WINDOW_DAYS));
  expect(first.mine.appeals).toHaveLength(1);
  expect(first.mine.appeals[0]).toMatchObject({
    restriction: 'trading_restricted',
    status: 'submitted',
    text: 'TEST: I only placed ordinary orders.',
    decision: null,
  });
  // While it is open the page offers no second form.
  await expect(panel.getByTestId('account-appeals__form')).toHaveCount(0);
  // A second appeal, sent straight to identity, is refused by name, and nothing is added.
  const second = await client.post('/api/identity/trpc/accountAppeal.submit', {
    restriction: 'trading_restricted',
    text: 'TEST: a second appeal',
    clientRequestId: `j14-second-${who.handle}`,
  });
  expect(second.status, JSON.stringify(second.body)).toBe(409);
  expect(second.body.error.data.cause.code).toBe('identity.appeal_open');
  expect((await readBack(client)).mine.appeals).toEqual(first.mine.appeals);
  await page.reload();
  await expect(page.getByTestId('account-appeals').getByTestId('account-appeals__appeal')).toHaveCount(1);

  // A final closure: the person who tries to appeal it is told "appeal not allowed", and no appeal is kept.
  const closed = person('apx');
  await signOutBrowser(page.context());
  await signUpInBrowser(page, closed);
  expect(tool('local-test-gates.mjs', 'account-close', closed.handle, 'final', CLOSE_REASON.code)).toMatch(/OK .* account close: closed/);
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=identifier]', closed.email);
  await page.fill('input[name=password]', closed.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByText('This account is closed.')).toBeVisible();
  const appeal = page.getByRole('button', { name: 'Appeal this closure' });
  await expect(appeal).toBeVisible();
  const refused = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/accountAppeal.submit'));
  await appeal.click();
  const answer = await refused;
  expect(answer.status()).toBe(403);
  expect(JSON.stringify(await answer.json())).toContain('identity.appeal_not_allowed');
  await expect(page.getByRole('alert')).toContainText('Appeal not allowed');
});
