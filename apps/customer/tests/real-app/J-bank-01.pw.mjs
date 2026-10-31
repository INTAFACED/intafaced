import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-01, in the running app (docs/roadmap/journeys.json): I open my bank, see my accounts and spaces, and create one.
// One test per step, titled "J-bank-01 #<n>", run in order on one TEST account funded with TEST 100 USDT. The stack
// publishes labelled TEST account terms, a TEST currency list, a TEST space limit of 5 and TEST currencies for account
// details (tooling/scripts/local-test-stack.mjs, svc-bank). Balances are read through the person's own bank API. Step 7 opens
// a TEST business through that API, so the person has a business profile to switch to.
const J = 'J-bank-01';
const LIMIT = 5;
const SPACE = 'Trip TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
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

async function spaces(who) {
  const res = await (await bank(who)).query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.data;
}
const main = (rows) => rows.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
const named = (rows, name) => rows.find((s) => s.kind === 'named' && s.name === name);

test(`${J} #1 opens /bank and sees its own Overview with the Bank rooms`, async ({ page }) => {
  const who = await signUp(page, 'jbk');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });

  await signIn(page, who);
  await page.goto('/bank');
  await expect(page.getByRole('heading', { level: 1, name: 'Bank' })).toBeVisible();
  const rooms = page.locator('main [data-testid="money-bank-nav"]');
  await expect(rooms.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  for (const room of ['Spaces', 'Transfers', 'Earn', 'Loans', 'Cards', 'Ramps', 'Analytics', 'Business']) {
    await expect(rooms.getByRole('link', { name: room })).toHaveAttribute('href', `/bank/${room.toLowerCase()}`);
  }
  await expect(rooms.getByRole('link')).toHaveCount(9);
  // Overview is the bank's own page, with the person's balance by currency and space.
  await expect(page.getByText('Your spaces').first()).toBeVisible();
  await expect(page.locator('main [data-testid="money-space-row"]').filter({ hasText: 'Main' }).first()).toContainText('100 USDT');
  // An address the bank does not have is an honest unavailable page, not a blank one.
  await page.goto('/bank/no-such-room');
  await expect(page.getByText('This address is not available')).toBeVisible();
});

test(`${J} #2 reads the account panel: the published TEST terms, and no fee-free claim of its own`, async ({ page }) => {
  await signIn(page, person());
  await page.goto('/bank');
  const terms = page.getByTestId('account-terms');
  await expect(terms).toContainText('TEST base tier');
  await expect(terms).toContainText('Monthly fee');
  await expect(terms).toContainText('0 USDT');
  await expect(terms).toContainText('local-test-1');
  await expect(page.locator('main')).not.toContainText(/fee[- ]free/i);
});

test(`${J} #3 adds a currency once, and removing one that holds money is refused with Send and Convert`, async ({ page }) => {
  const who = person();
  await signIn(page, who);
  await page.goto('/bank');
  await expect(page.getByTestId('currency-USDT')).toContainText('100 USDT');
  await page.getByLabel('Currency to add').selectOption('USDC');
  await page.getByRole('button', { name: 'Add currency' }).click();
  await expect(page.getByText('USDC is on your account.')).toBeVisible();
  await expect(page.getByTestId('currency-USDC')).toBeVisible();
  // Asking again is the same currency, one space.
  expect((await (await bank(who)).mutate('currencies.add', { assetId: 'USDC' })).ok).toBe(true);
  expect((await spaces(who)).filter((s) => s.kind === 'primary' && s.assetId === 'USDC')).toHaveLength(1);

  await page.getByTestId('currency-USDT').getByRole('button', { name: 'Remove USDT' }).click();
  const refused = page.getByTestId('currency-in-use');
  await expect(refused).toContainText('USDT is still in use');
  await expect(refused).toContainText('bank.currency_in_use');
  await expect(refused.getByRole('link', { name: 'Send' })).toHaveAttribute('href', /\/bank\/transfers\?from=/);
  await expect(refused.getByRole('link', { name: 'Convert' })).toHaveAttribute('href', '/trade/convert');
  expect(main(await spaces(who)).balance).toBe('100');

  // An empty currency comes off.
  await page.getByTestId('currency-USDC').getByRole('button', { name: 'Remove USDC' }).click();
  await expect(page.getByText('USDC was removed from your account.')).toBeVisible();
  await expect(page.getByTestId('currency-USDC')).toHaveCount(0);
});

test(`${J} #4 creates a space, and at the TEST limit of ${LIMIT} the create is refused with the limit`, async ({ page }) => {
  const who = person();
  await signIn(page, who);
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Asset', { exact: true }).selectOption('USDT');
  await dialog.getByLabel('Space name').fill(SPACE);
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  // The review already shows the name, so wait for the service's own confirmation before reading the list.
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible();
  await expect(dialog).toContainText(SPACE);
  expect(named(await spaces(who), SPACE)).toBeTruthy();

  // Fill the account up to the limit through the person's own API, then ask once more in the app.
  const api = await bank(who);
  // Space 2 is locked until next year: step 5 tries it as a source.
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  for (let n = 2; n <= LIMIT; n += 1) {
    const input = { assetId: 'USDT', name: `Space ${n} TEST`, ...(n === 2 ? { lockedUntil: nextYear } : {}) };
    expect((await api.mutate('spaces.create', input)).ok).toBe(true);
  }
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  await dialog.getByLabel('Asset', { exact: true }).selectOption('USDT');
  await dialog.getByLabel('Space name').fill('One too many TEST');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toContainText(`already has ${LIMIT} spaces`);
  expect(named(await spaces(who), 'One too many TEST')).toBeUndefined();
});

test(`${J} #5 moves TEST 20 from the main balance into the space, and a locked source is refused before any request`, async ({ page }) => {
  const who = person();
  const before = await spaces(who);
  const trip = named(before, SPACE);
  await signIn(page, who);
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main(before).id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('To which of your accounts').selectOption(trip.id);
  await dialog.getByLabel(/Amount/).fill('20');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText(/ledger/i).first()).toBeVisible();

  const after = await spaces(who);
  expect(toUnits(main(before).balance) - toUnits(main(after).balance)).toBe(toUnits('20'));
  expect(toUnits(named(after, SPACE).balance) - toUnits(trip.balance)).toBe(toUnits('20'));
  // The sum of the spaces is still the ledger total.
  expect(toUnits(main(after).balance) + toUnits(named(after, SPACE).balance)).toBe(toUnits('100'));

  // The move is in the history, on the space it went to.
  await page.goto('/money/activity');
  const move = page.locator('main tr, main li, main article').filter({ hasText: 'Moved between your accounts' }).filter({ hasText: SPACE });
  await expect(move.first()).toContainText('+20 USDT');

  // A space locked until next year cannot be a source; the app says so and sends nothing.
  const locked = named(after, 'Space 2 TEST');
  const sent = [];
  page.on('request', (req) => req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.') && sent.push(req.url()));
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(locked.id);
  await page.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByLabel('To which of your accounts').selectOption(trip.id);
  await dialog.getByLabel(/Amount/).fill('1');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog.getByText('This space is locked', { exact: false })).toBeVisible();
  expect(sent).toEqual([]);
});

test(`${J} #6 opens account details: each currency needs a banking partner, rail.bank, and no number is shown`, async ({ page }) => {
  await signIn(page, person());
  await page.goto('/bank');
  for (const currency of ['EUR', 'GBP', 'USD']) {
    const block = page.getByTestId(`account-details-${currency}`);
    await expect(block).toContainText('Needs a banking partner. It is switched off in this build.');
    await expect(block).toContainText('rail.bank');
    await expect(block.getByTestId('account-details-set')).toHaveCount(0);
  }
  await expect(page.locator('main')).not.toContainText(/IBAN|Sort code|Account number/);
});

/** The bank reads the page made, each with the input it sent. `business.list` is the profile picker's own list. */
function bankReads(page) {
  const reads = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    const match = /\/api\/bank\/trpc\/([^/?]+)$/.exec(url.pathname);
    if (req.method() !== 'GET' || !match || match[1] === 'business.list') return;
    const raw = url.searchParams.get('input');
    reads.push({ procedure: match[1], input: raw === null ? undefined : JSON.parse(raw) });
  });
  return reads;
}

test(`${J} #7 switches to a business profile: every bank read carries it, and a profile not held is refused with no side effect`, async ({
  page,
}) => {
  const who = person();
  const api = await bank(who);
  const accountId = randomUUID();
  const business = `business:${accountId}`;
  const opened = await api.mutate('business.create', { accountId, name: 'Studio TEST', assetId: 'USDT', spendThreshold: '10' });
  expect(opened.ok, JSON.stringify(opened.body ?? {}).slice(0, 300)).toBe(true);

  await signIn(page, who);
  await page.goto('/bank');
  await expect(page.getByTestId('account-profile')).toContainText('Your personal account');

  // Switch in the account menu, then open the bank again and watch what it asks for.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-business').filter({ hasText: 'Studio TEST' }).click();
  await expect(page).toHaveURL(/\/pay\/merchant/);
  const reads = bankReads(page);
  await page.goto('/bank');
  const profile = page.getByTestId('account-profile');
  await expect(profile).toContainText('Studio TEST');
  await expect(profile).toContainText('Your role: Administrator');
  // A business has no account of its own: no company terms, currencies or details, and no personal money shown as its own.
  const home = page.getByTestId('account-home');
  await expect(home.getByText('No company account')).toHaveCount(2);
  await expect(home).toContainText('bank.company_account_unwired');
  await expect(page.getByTestId('account-details-company')).toContainText('bank.company_account_unwired');
  await expect(page.getByTestId('currency-USDT')).toHaveCount(0);
  await expect(page.getByTestId('account-terms')).toHaveCount(0);

  // The four account reads must be among them, and every bank read the page made carries the profile: a read added to a
  // business view later without it fails here.
  const asked = new Set(reads.map((r) => r.procedure));
  for (const procedure of ['accounts.profile', 'accounts.features', 'currencies.list', 'accountDetails.list'])
    expect(asked).toContain(procedure);
  for (const read of reads) expect(read, `${read.procedure} carried no profile`).toMatchObject({ input: { profile: business } });

  // A business the person does not hold, asked for straight at the bank: refused, and nothing on the account changes.
  const before = await spaces(who);
  const forged = `business:${randomUUID()}`;
  for (const [kind, procedure, input] of [
    ['query', 'accounts.profile', { profile: forged }],
    ['query', 'currencies.list', { profile: forged }],
    ['mutate', 'currencies.add', { assetId: 'USDC', profile: forged }],
    ['mutate', 'currencies.remove', { assetId: 'USDT', profile: forged }],
  ]) {
    const res = await api[kind](procedure, input);
    expect(res, procedure).toMatchObject({ ok: false, status: 403, code: 'bank.profile_not_held' });
  }
  expect(await spaces(who)).toEqual(before);

  // Back to Personal: the account's own terms and money are there again.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-personal').click();
  await page.goto('/bank');
  await expect(page.getByTestId('account-profile')).toContainText('Your personal account');
  await expect(page.getByTestId('account-terms')).toContainText('TEST base tier');
  await expect(page.getByTestId('currency-USDT')).toContainText('80 USDT');
});
