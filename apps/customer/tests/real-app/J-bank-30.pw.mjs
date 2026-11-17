// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as ledgerApi, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { venueRecord } from './venue.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-bank-30, in the running app (docs/roadmap/journeys.json): my salary is paid in by direct deposit. One test per step,
// titled "J-bank-30 #<n>", run in order on one TEST account whose bank money the stack's TEST partner bank holds
// (`testPartner.set({ custody: 'off' })`, the launch model, OWNER 226), with the partner's TEST account details switched on
// and a TEST holder name, and a Savings space in USD at the partner. The stack runs the TEST payroll stand-in
// (`BANK_PAYROLL_PARTNER=payroll-sim`) and publishes the TEST direct-deposit currency list, sorter terms and a TEST
// reversal window of 5 days (tooling/profiles/test-owner-values/bank.json). The employer's credits and reversals are the
// network's signed job calls (`/internal/jobs/payroll-sim/*`), made here as the network would. Every figure the partner
// holds is read from the TEST partner's own book on loopback (`/test-partner/moves`), never back through our own doors,
// and the ledger posts nothing: the person's ledger USD figures never change. The TEST partner keeps its book in memory,
// so #1's restart of svc-bank empties it; the person's start at the partner is put back after each restart, before
// anything is paid in.
const J = 'J-bank-30';
const CURRENCY = 'USD';
const SAVINGS = 'Savings';
const EMPLOYER = 'TEST Employer Ltd';
const PARTNER_BANK = 'TEST partner bank';
// The account-details fields as the room names them (account-details-copy.ts), each with its own Copy.
const FIELD_LABELS = {
  accountNumber: 'Account number',
  sortCode: 'Sort code',
  routingNumber: 'Routing number',
  bsb: 'BSB',
  iban: 'IBAN',
  bic: 'BIC',
};
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const PAYOUTS = 'partner:outbound-payments';
const PAY_INS = 'partner:incoming-payments';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state() {
  const now = run.read();
  if (!now.who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return now;
}

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  return {
    userId: login.result.data.userId,
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

let jobCtx;
/** One signed call to a bank job door, as the payroll network makes it. */
async function network(path, body) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payroll-sim/${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The same call with no service signature: the network's door refuses it and nothing is recorded. */
async function unsigned(path, body) {
  const res = await fetch(`http://127.0.0.1:${STACK_PORTS.bank}/internal/jobs/payroll-sim/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return res.status;
}

/** Every move on the person's record at the TEST partner, oldest first, as its own book lists it. */
async function partnerMoves(userId) {
  return (await venueRecord(userId, '/moves', {}, PARTNER_RECORD, null)).value;
}
const salaryMoves = (moves) => moves.filter((m) => m.key.startsWith('salary:'));

/** The person's spaces as the bank shows them: the USD main balance and the Savings space, each the partner's figure. */
async function usdSpaces(who) {
  const res = await (await bank(who)).query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  const main = res.data.find((s) => s.kind === 'primary' && s.assetId === CURRENCY);
  const savings = res.data.find((s) => s.kind === 'named' && s.assetId === CURRENCY && s.name === SAVINGS);
  return { main, savings };
}

/** The person's ledger figures in USD, as the ledger gives them: their bank money is the partner's, so these never change. */
async function ledgerUsd(who) {
  const row = (await (await ledgerApi(who)).balances())[CURRENCY];
  return row ? { free: row.free, used: row.used, total: row.total } : null;
}

/**
 * The person's start at the TEST partner: money held there, TEST account details issued in the TEST holder name. The TEST
 * partner keeps these in memory, so after a svc-bank restart they are set again.
 */
async function atPartner(who) {
  const own = await bank(who);
  const set = await own.mutate('testPartner.set', { custody: 'off', accountDetails: 'issued', holderName: who.holderName });
  expect(set, JSON.stringify(set.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { custody: 'off', accountDetails: 'issued' } });
}

/** svc-bank restarted with the owner's direct-deposit currency list blank, or with the TEST list back (`undefined`). */
function restartBank(value) {
  const key = 'LOCAL_STACK_BANK_ACCOUNT_DETAILS_CURRENCIES';
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

const credit = (who, networkId, amount, holderName = who.holderName) =>
  network('credit', {
    networkId,
    accountDetailsId: `test-partner:${who.userId}:${CURRENCY}`,
    amount,
    currency: CURRENCY,
    originatorName: EMPLOYER,
    holderName,
  });

async function salaryPage(page, who) {
  await signIn(page, who);
  await page.goto('/bank/salary');
  await expect(page.getByTestId('salary-room')).toBeVisible({ timeout: 30_000 });
  return page.getByTestId('salary-room');
}
const feedRow = (room, networkId) => room.locator(`[data-testid="salary-credit"][data-network="${networkId}"]`);

test(`${J} #1 with the direct-deposit currency list switched off for one restart, Salary refuses bank.account_details_currencies_unset and shows no details`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const signedUp = await signUp(page, 'jb30');
  await verify(page, signedUp);
  const userId = (await bank(signedUp)).userId;
  const who = { ...signedUp, userId, holderName: `TEST ${signedUp.handle}` };
  run.reset({ who, runId: randomUUID().slice(0, 8) });
  await atPartner(who);
  // The Savings space at the partner, which the split pays into.
  const made = await (await bank(who)).mutate('spaces.create', { assetId: CURRENCY, name: SAVINGS });
  expect(made, JSON.stringify(made.body ?? {}).slice(0, 300)).toMatchObject({ ok: true });
  run.write({ ledger: await ledgerUsd(who) });

  restartBank('off');
  try {
    await atPartner(who);
    const refused = await (await bank(who)).query('salary.details', {});
    expect(refused).toMatchObject({ ok: false, code: 'bank.account_details_currencies_unset' });
    const room = await salaryPage(page, who);
    await expect(room.getByTestId('salary-details-refused')).toBeVisible();
    await expect(room.getByTestId('salary-details-refused')).toHaveAttribute('data-code', 'bank.account_details_currencies_unset');
    await expect(room.getByTestId('salary-details')).toHaveCount(0);
    await expect(room.getByTestId('account-details-set')).toHaveCount(0);
  } finally {
    restartBank(undefined);
    await atPartner(who);
  }
});

test(`${J} #2 with the TEST list back, Salary shows the partner's TEST account details with Copy on each field, and the employer form with the person's name and those details`, async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const { who } = state();
  const details = await (await bank(who)).query('salary.details', {});
  expect(details.ok, JSON.stringify(details.body ?? {}).slice(0, 300)).toBe(true);
  expect(details.data).toMatchObject({ partnerBank: PARTNER_BANK, holderName: who.holderName });
  const usd = details.data.currencies.find((c) => c.currency === CURRENCY);
  const set = usd.sets[0];
  expect(set).toMatchObject({ id: `test-partner:${who.userId}:${CURRENCY}`, partnerBank: PARTNER_BANK });
  expect(set.accountNumber).toMatch(/^TEST-USD-/);

  const room = await salaryPage(page, who);
  const shown = room.getByTestId(`account-details-${CURRENCY}`);
  await expect(shown.getByTestId('account-details-set')).toContainText(set.accountNumber);
  // Labelled TEST: the number and the bank both say so.
  await expect(shown).toContainText(PARTNER_BANK);
  // Copy on each field the partner gave: one button per field, named for it, and each copies that field's value.
  const fields = Object.entries(FIELD_LABELS).filter(([key]) => set[key] !== null);
  expect(fields.length).toBeGreaterThan(0);
  await expect(shown.getByRole('button', { name: /^Copy / })).toHaveCount(fields.length);
  for (const [key, label] of fields) {
    await shown.getByRole('button', { name: `Copy ${label}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(set[key]);
  }
  const holder = room.getByTestId('salary-holder');
  await expect(holder).toContainText(who.holderName);
  await holder.getByRole('button', { name: 'Account holder', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(who.holderName);
  const form = room.getByTestId(`salary-form-${CURRENCY}`);
  await expect(form.getByTestId('salary-form-text')).toContainText(`Account holder: ${who.holderName}`);
  await expect(form.getByTestId('salary-form-text')).toContainText(`Account number: ${set.accountNumber}`);
  await expect(form.getByTestId('salary-form-text')).toContainText(`Bank: ${PARTNER_BANK}`);
  await expect(form.getByRole('link', { name: 'Download the form', exact: true })).toHaveAttribute(
    'download',
    `salary-form-${CURRENCY}.txt`,
  );
});

test(`${J} #3 sets a salary split of 10 percent into Savings: the rule reads 10 percent to Savings and the rest to the main balance`, async ({
  page,
}) => {
  const { who } = state();
  const room = await salaryPage(page, who);
  const sorter = room.getByTestId('income-sorter');
  await expect(sorter.getByTestId('income-sorter-terms')).toHaveAttribute('data-state', 'set');
  await sorter.getByRole('button', { name: `Sort ${CURRENCY} payments`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(`${SAVINGS}: percent`, { exact: true }).fill('10');
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByText('Confirmed by the service', { exact: true })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const card = sorter.locator(`[data-testid="income-sorter-card"][data-asset="${CURRENCY}"]`);
  await expect(card).toContainText(`10% into ${SAVINGS}`);
  await expect(card).toContainText('90% stays in your account');
  // The bank saved it as one rule: 1000 basis points into Savings.
  const { savings } = await usdSpaces(who);
  const listed = await (await bank(who)).query('sorter.list', undefined);
  const rule = listed.data.sorters.find((s) => s.assetId === CURRENCY);
  expect(rule.legs).toMatchObject([{ spaceId: savings.id, shareBp: 1000 }]);
  run.write({ sorterId: rule.id });
});

test(`${J} #4 the employer pays TEST 2000.00: one credit at the partner with the feed row "Salary from ${EMPLOYER}", the split sent once, 200.00 in Savings and the main balance up by 1800.00`, async ({
  page,
}) => {
  const { who, runId, ledger } = state();
  const networkId = `jb30-${runId}-salary`;
  const before = await usdSpaces(who);
  // An unsigned call is not the network: refused, and nothing is recorded.
  expect(await unsigned('credit', { networkId })).toBe(401);

  const paid = await credit(who, networkId, '2000.00');
  expect(paid.status, JSON.stringify(paid.body).slice(0, 300)).toBe(200);
  expect(paid.body).toMatchObject({ replayed: false, credit: { state: 'received', amount: '2000', originatorName: EMPLOYER } });
  expect(paid.body.credit.legs).toMatchObject([{ status: 'settled', amount: '200', spaceId: before.savings.id }]);

  // The partner's own book: one pay-in of 2000 into the main balance, then one move of 200 into Savings, each once.
  const moves = salaryMoves(await partnerMoves(who.userId));
  expect(moves).toHaveLength(2);
  expect(moves[0]).toMatchObject({
    key: `salary:credit:${networkId}`,
    id: paid.body.credit.creditMoveId,
    from: { owner: PAY_INS, assetId: CURRENCY },
    to: { owner: who.userId, assetId: CURRENCY, spaceId: null },
    amount: '2000',
  });
  expect(moves[1]).toMatchObject({
    key: `salary:split:${networkId}:0`,
    id: paid.body.credit.legs[0].moveId,
    from: { owner: who.userId, spaceId: null },
    to: { owner: who.userId, spaceId: before.savings.id },
    amount: '200',
  });
  // The app shows the partner's figures: Savings holds 200, the main balance is up by 1800.
  const after = await usdSpaces(who);
  expect(after.main.heldAt?.label).toBe(PARTNER_BANK);
  expect(toUnits(after.main.balance) - toUnits(before.main?.balance ?? '0')).toBe(toUnits('1800'));
  expect(toUnits(after.savings.balance) - toUnits(before.savings.balance ?? '0')).toBe(toUnits('200'));
  // The ledger posts nothing for money the partner holds.
  expect(await ledgerUsd(who)).toEqual(ledger);

  const room = await salaryPage(page, who);
  const row = feedRow(room, networkId);
  await expect(row.getByTestId('salary-credit-title')).toHaveText(`Salary from ${EMPLOYER}`);
  await expect(row.getByTestId('salary-credit-amount')).toContainText('2,000');
  await expect(row.getByTestId('salary-credit-state')).toHaveText('Received');
  await expect(row.getByTestId('salary-credit-leg')).toContainText(`into ${SAVINGS}`);
  run.write({ salaryId: networkId, afterSalary: { main: after.main.balance, savings: after.savings.balance } });
});

test(`${J} #5 the network sends the same credit message again: nothing posts and the feed still shows one salary`, async ({ page }) => {
  const { who, salaryId, afterSalary, ledger } = state();
  const again = await credit(who, salaryId, '2000.00');
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body).toMatchObject({ replayed: true, credit: { state: 'received' } });
  expect(salaryMoves(await partnerMoves(who.userId))).toHaveLength(2);
  const now = await usdSpaces(who);
  expect({ main: now.main.balance, savings: now.savings.balance }).toEqual(afterSalary);
  expect(await ledgerUsd(who)).toEqual(ledger);

  const room = await salaryPage(page, who);
  await expect(room.getByTestId('salary-credit')).toHaveCount(1);
  await expect(feedRow(room, salaryId)).toHaveCount(1);
});

test(`${J} #6 a credit naming a different account holder reads Returned with bank.direct_deposit_name_mismatch and credits nothing`, async ({
  page,
}) => {
  const { who, runId, afterSalary } = state();
  const networkId = `jb30-${runId}-other-name`;
  const back = await credit(who, networkId, '300.00', 'TEST Somebody Else');
  expect(back.status, JSON.stringify(back.body).slice(0, 300)).toBe(200);
  expect(back.body.credit).toMatchObject({ state: 'returned', refusalCode: 'bank.direct_deposit_name_mismatch', creditMoveId: null });
  // The partner credited nothing under it.
  expect((await partnerMoves(who.userId)).filter((m) => m.key.includes(networkId))).toHaveLength(0);
  const now = await usdSpaces(who);
  expect({ main: now.main.balance, savings: now.savings.balance }).toEqual(afterSalary);

  const room = await salaryPage(page, who);
  const row = feedRow(room, networkId);
  await expect(row.getByTestId('salary-credit-state')).toHaveText('Returned');
  await expect(row.getByTestId('salary-credit-code')).toHaveAttribute('data-code', 'bank.direct_deposit_name_mismatch');
  await expect(row.getByTestId('salary-credit-code')).toContainText('bank.direct_deposit_name_mismatch');
});

test(`${J} #7 with the split removed, a TEST 500.00 credit arrives and the employer reverses it inside the window: credit and reversal each read back once, rows Received and Reversed, main balance back`, async ({
  page,
}) => {
  const { who, runId, sorterId, afterSalary, salaryId, ledger } = state();
  // The split removed on the Salary page.
  const room = await salaryPage(page, who);
  const card = room.locator(`[data-testid="income-sorter-card"][data-asset="${CURRENCY}"]`);
  await card.getByRole('button', { name: 'Stop sorting', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Stop sorting', exact: true }).click();
  await expect(dialog.getByText('Confirmed by the service', { exact: true })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const listed = await (await bank(who)).query('sorter.list', undefined);
  expect(listed.data.sorters.find((s) => s.id === sorterId)).toBeUndefined();

  const networkId = `jb30-${runId}-reversed`;
  const paid = await credit(who, networkId, '500.00');
  expect(paid.body.credit).toMatchObject({ state: 'received', amount: '500', legs: [] });
  expect(toUnits((await usdSpaces(who)).main.balance)).toBe(toUnits(afterSalary.main) + toUnits('500'));
  // Before the employer reverses it, the 500.00 credit's own row reads Received.
  await page.reload();
  const before = feedRow(page.getByTestId('salary-room'), networkId);
  await expect(before.getByTestId('salary-credit-state')).toHaveText('Received');
  await expect(before.getByTestId('salary-credit-amount')).toContainText('500');

  const reversed = await network('reverse', { networkId });
  expect(reversed.status, JSON.stringify(reversed.body).slice(0, 300)).toBe(200);
  expect(reversed.body.credit).toMatchObject({ state: 'reversed' });
  // Asked again, the same reversal: nothing more moves.
  const again = await network('reverse', { networkId });
  expect(again.body.credit.reversalMoveId).toBe(reversed.body.credit.reversalMoveId);

  // The partner's own book: the credit of 500 in, then its reversal of 500 out to the partner, each once.
  const moves = (await partnerMoves(who.userId)).filter((m) => m.key.endsWith(networkId));
  expect(moves).toEqual([
    expect.objectContaining({
      key: `salary:credit:${networkId}`,
      id: paid.body.credit.creditMoveId,
      from: expect.objectContaining({ owner: PAY_INS }),
      amount: '500',
    }),
    expect.objectContaining({
      key: `salary:reverse:${networkId}`,
      id: reversed.body.credit.reversalMoveId,
      from: expect.objectContaining({ owner: who.userId, spaceId: null }),
      to: expect.objectContaining({ owner: PAYOUTS }),
      amount: '500',
    }),
  ]);
  const now = await usdSpaces(who);
  expect({ main: now.main.balance, savings: now.savings.balance }).toEqual(afterSalary);
  expect(await ledgerUsd(who)).toEqual(ledger);

  await page.reload();
  const shown = page.getByTestId('salary-room');
  await expect(feedRow(shown, salaryId).getByTestId('salary-credit-state')).toHaveText('Received');
  await expect(feedRow(shown, networkId).getByTestId('salary-credit-state')).toHaveText('Reversed');
  await expect(feedRow(shown, networkId).getByTestId('salary-credit-reversed')).toBeVisible();
});

test(`${J} #8 a founder opens the bank rails desk: for the TEST currency, partner credits minus reversals against what the app showed read "matches"`, async ({
  browser,
}) => {
  const { who } = state();
  // What the app showed this person: received credits less reversals, from their own salary rows.
  const rows = (await (await bank(who)).query('salary.credits', { limit: 50 })).data;
  const shownNet = rows
    .filter((r) => r.creditMoveId !== null)
    .reduce((sum, r) => sum + toUnits(r.amount) - (r.reversalMoveId !== null ? toUnits(r.amount) : 0n), 0n);
  expect(shownNet).toBe(toUnits('2000'));
  // The partner's own book for this person agrees: credits in minus reversals out.
  const moves = salaryMoves(await partnerMoves(who.userId));
  const partnerNet = moves.reduce(
    (sum, m) =>
      m.key.startsWith('salary:credit:') ? sum + toUnits(m.amount) : m.key.startsWith('salary:reverse:') ? sum - toUnits(m.amount) : sum,
    0n,
  );
  expect(partnerNet).toBe(shownNet);

  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/bank-ops/rails');
  await expect(page.getByTestId('bank-rails-desk')).toBeVisible({ timeout: 30_000 });
  const line = page.locator(`[data-testid="salary-rail"][data-currency="${CURRENCY}"]`);
  await expect(line).toHaveAttribute('data-matches', 'true');
  await expect(line.getByTestId('salary-rail-verdict')).toHaveText('matches');
  await context.close();
});
