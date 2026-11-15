// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { withPartner } from './partner.mjs';

// J-bank-01, in the running app (docs/roadmap/journeys.json): I open my bank, see my accounts and spaces, and create one.
// One test per step, titled "J-bank-01 #<n>", run in order on one TEST account whose bank money the stack's TEST partner
// bank holds (`testPartner.set({ custody: 'off' })`, the launch model, OWNER 226), funded there with TEST 100 USDT
// (`testPartner.fund`, the partner's figure, no ledger post). The ledger holds and posts nothing of it. The stack
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

const PARTNER_BANK = 'TEST partner bank';

/**
 * The journey's start at the TEST partner bank: the person's bank money held there (`custody: 'off'`) and TEST 100 USDT
 * paid in there under one fund id, the partner's figure and no ledger post. The TEST partner keeps its book in memory, so
 * a svc-bank restart empties it (svc-bank `partner/test-partner.ts`); #2 and #4 restart svc-bank before anything has
 * moved, and put this same start back after each restart. Within one svc-bank process the same fund id pays in once.
 */
async function atPartner(who) {
  const own = await bank(who);
  const held = await own.mutate('testPartner.set', { custody: 'off' });
  expect(held, JSON.stringify(held.body ?? {}).slice(0, 300)).toMatchObject({ ok: true });
  const funded = await own.mutate('testPartner.fund', { fundId: `jb01-${who.email}`.slice(0, 64), assetId: 'USDT', amount: '100' });
  expect(funded, JSON.stringify(funded.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { balance: '100' } });
  expect(main(await spaces(who))).toMatchObject({ balance: '100', ledgerAccount: null, heldAt: { label: PARTNER_BANK } });
}

/**
 * Runs `fn` with svc-bank restarted on one owner value blank (`LOCAL_STACK_BANK_<NAME>=off`,
 * tooling/scripts/local-stack-services/bank.mjs), and restarts it on the TEST value after, even when `fn` fails. After
 * each restart `who`'s start at the TEST partner is put back (`atPartner`).
 */
async function withBankValueBlank(key, who, fn) {
  const restart = (value) => {
    const before = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      tool('local-test-stack.mjs', 'restart', 'bank');
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  };
  restart('off');
  try {
    // REPLAY (#8392 0822ed95): the start is not put back by the test after the restart.
    return await fn();
  } finally {
    restart(undefined);
  }
}
const named = (rows, name) => rows.find((s) => s.kind === 'named' && s.name === name);
/** The spaces as facts: the partner's `asOf` says when it was asked, which every read changes, so it is left out. */
const withoutReadTime = (rows) =>
  rows.map(({ heldAt, ...space }) => ({
    ...space,
    heldAt: heldAt && { ...heldAt, asOf: undefined, figure: heldAt.figure && { ...heldAt.figure, asOf: undefined } },
  }));
/** The ledger's USDT figures for `who`, in units: their bank money is the partner's, so these never change. */
async function ledgerUsdt(who) {
  const row = (await (await api(who)).balances()).USDT;
  return row ? { free: toUnits(row.free), used: toUnits(row.used), total: toUnits(row.total) } : null;
}

test(`${J} #1 opens /bank and sees its own Overview with the Bank rooms`, async ({ page }) => {
  const who = await signUp(page, 'jbk');
  await verify(page, who);
  // The person's bank money is held at the TEST partner bank and paid in there: nothing is posted to the ledger.
  await atPartner(who);
  run.reset({ who, ledger: await ledgerUsdt(who) });

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

test(`${J} #2 reads the account panel: the published TEST terms, and with the owner's terms blank "terms not published" with its code and no fee-free claim`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  await signIn(page, who);
  await page.goto('/bank');
  const terms = page.getByTestId('account-terms');
  await expect(terms).toContainText('TEST base tier');
  await expect(terms).toContainText('Monthly fee');
  await expect(terms).toContainText('0 USDT');
  await expect(terms).toContainText('local-test-1');
  await expect(page.locator('main')).not.toContainText(/fee[- ]free/i);

  // With the owner's terms table blank: the bank refuses by its code, and the panel says the terms are not published,
  // shows that code, and claims no fee or fee-free account.
  await withBankValueBlank('LOCAL_STACK_BANK_ACCOUNT_TERMS', who, async () => {
    expect(await (await bank(who)).query('accounts.features', {})).toMatchObject({ ok: false, code: 'bank.account_terms_unset' });
    await page.goto('/bank');
    const unset = page.getByTestId('failure').filter({ hasText: 'Terms not published' });
    await expect(unset).toBeVisible();
    await expect(unset).toContainText('bank.account_terms_unset');
    await expect(page.getByTestId('account-terms')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/fee[- ]free|TEST base tier|Monthly fee/i);
  });
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

  // Where the partner has no currency accounts (the TEST partner switched to offer none): "not offered by the partner",
  // and no currency account is opened.
  await withPartner(who, { notOffered: ['currencies'] }, async () => {
    await page.reload();
    await page.getByLabel('Currency to add').selectOption('USDC');
    await page.getByRole('button', { name: 'Add currency' }).click();
    await expect(page.getByTestId('failure').filter({ hasText: /not offered by the partner/i })).toBeVisible();
    await expect(page.getByTestId('currency-USDC')).toHaveCount(0);
    expect(await (await bank(who)).mutate('currencies.add', { assetId: 'USDC' })).toMatchObject({
      ok: false,
      code: 'bank.not_offered_by_partner',
    });
    expect((await spaces(who)).filter((s) => s.kind === 'primary' && s.assetId === 'USDC')).toHaveLength(0);
  });
});

test(`${J} #4 creates a space, and at the TEST limit of ${LIMIT} the create is refused with the limit`, async ({ page }) => {
  test.setTimeout(240_000);
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

  // The at-limit create is settled before the bank restarts: the page holds no write whose outcome is unconfirmed, so a
  // check of it can't meet the bank mid-restart.
  const paused = page.getByRole('alert').filter({ hasText: 'Bank writes are paused' });
  await page.goto('/bank/spaces');
  await expect(page.getByRole('heading', { name: 'Spaces', level: 1 })).toBeVisible();
  await expect(paused).toHaveCount(0);

  // With the owner's space limit blank: the create is refused, saying the limit is not set, and no space is made.
  await withBankValueBlank('LOCAL_STACK_BANK_SPACE_LIMIT', who, async () => {
    const before = (await spaces(who)).length;
    expect(await (await bank(who)).mutate('spaces.create', { assetId: 'USDT', name: 'No limit TEST' })).toMatchObject({
      ok: false,
      code: 'bank.space_limit_unset',
    });
    await page.goto('/bank/spaces');
    await expect(page.getByRole('heading', { name: 'Spaces', level: 1 })).toBeVisible();
    await expect(paused).toHaveCount(0);
    await page.getByRole('button', { name: 'Create space' }).click();
    await dialog.getByLabel('Asset', { exact: true }).selectOption('USDT');
    await dialog.getByLabel('Space name').fill('No limit TEST');
    await dialog.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toContainText(/has not set how many spaces/i);
    await expect(dialog).not.toContainText('Confirmed by the service');
    const after = await spaces(who);
    expect(after).toHaveLength(before);
    expect(named(after, 'No limit TEST')).toBeUndefined();
  });
});

test(`${J} #5 moves TEST 20 from the main balance into the space, and a locked source is refused before any request`, async ({ page }) => {
  const who = person();
  const before = await spaces(who);
  const trip = named(before, SPACE);
  const ledgerBefore = await ledgerUsdt(who);
  expect(ledgerBefore, 'the ledger is where #1 left it').toEqual(run.read().ledger);
  await signIn(page, who);
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main(before).id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('To which of your accounts').selectOption(trip.id);
  await dialog.getByLabel(/Amount/).fill('20');
  await dialog.getByRole('button', { name: 'Review' }).click();
  const answered = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/api/bank/trpc/transfers.create'),
  );
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const reply = await answered;
  const asked = reply.request().postDataJSON();
  const made = (await reply.json()).result.data;
  // One partner move, keyed by the transfer id the app sent, and no ledger transaction.
  expect(made).toMatchObject({ ledgerTxId: null, amount: '20', partnerMove: { label: PARTNER_BANK } });
  await expect(dialog).toContainText('Partner bank move');
  await expect(dialog).toContainText(made.partnerMove.id);
  await expect(dialog).toContainText('None: the partner bank holds this money');

  const after = await spaces(who);
  expect(toUnits(main(before).balance) - toUnits(main(after).balance)).toBe(toUnits('20'));
  expect(toUnits(named(after, SPACE).balance) - toUnits(trip.balance)).toBe(toUnits('20'));
  for (const space of [main(after), named(after, SPACE)])
    expect(space).toMatchObject({ ledgerAccount: null, heldAt: { label: PARTNER_BANK } });
  // The spaces plus the main balance shown are the partner's total: the 100 it was paid in.
  const usdt = after.filter((s) => s.assetId === 'USDT' && !s.archivedAt);
  expect(usdt.reduce((sum, s) => sum + toUnits(s.balance), 0n)).toBe(toUnits('100'));
  // The same transfer id again is the same move, made once: the partner answers with it and nothing moves twice.
  const again = await (await bank(who)).mutate('transfers.create', asked);
  expect(again).toMatchObject({ ok: true, data: { ledgerTxId: null, partnerMove: { id: made.partnerMove.id } } });
  const twice = await spaces(who);
  expect(main(twice).balance).toBe(main(after).balance);
  expect(named(twice, SPACE).balance).toBe(named(after, SPACE).balance);
  // The ledger posted nothing.
  expect(await ledgerUsdt(who)).toEqual(ledgerBefore);

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

  // Where the partner has no spaces (the TEST partner switched to offer none): the move reads "not offered by the
  // partner", and both balances stay as the partner reports them.
  await withPartner(who, { notOffered: ['spaces'] }, async () => {
    await page.goto('/bank/transfers');
    await page.getByLabel('From your space').selectOption(main(after).id);
    await page.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByLabel('To which of your accounts').selectOption(trip.id);
    await dialog.getByLabel(/Amount/).fill('20');
    await dialog.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toContainText(/not offered by the partner/i);
    const refused = await (
      await bank(who)
    ).mutate('transfers.create', {
      transferId: `jb01-${randomUUID()}`,
      fromSpaceId: main(after).id,
      toSpaceId: trip.id,
      amount: '20',
    });
    expect(refused).toMatchObject({ ok: false, code: 'bank.not_offered_by_partner' });
    const held = await spaces(who);
    expect(main(held).balance).toBe(main(after).balance);
    expect(named(held, SPACE).balance).toBe(named(after, SPACE).balance);
  });
});

test(`${J} #6 opens account details: the TEST partner's details labelled TEST, and with no partner each currency needs one, rail.bank, and no number is shown`, async ({
  page,
}) => {
  const who = person();
  await signIn(page, who);
  // With no banking partner for account details (the TEST partner's default): the notice, rail.bank, no number.
  await page.goto('/bank');
  for (const currency of ['EUR', 'GBP', 'USD']) {
    const block = page.getByTestId(`account-details-${currency}`);
    await expect(block).toContainText('Needs a banking partner. It is switched off in this build.');
    await expect(block).toContainText('rail.bank');
    await expect(block.getByTestId('account-details-set')).toHaveCount(0);
  }
  await expect(page.locator('main')).not.toContainText(/IBAN|Sort code|Account number/);

  // On the TEST partner adapter, with details issued to this person: for each currency, exactly the partner's details as
  // its own answer gives them, labelled TEST, with no rail.bank notice.
  await withPartner(who, { accountDetails: 'issued' }, async () => {
    const answer = await (await bank(who)).query('accountDetails.list');
    expect(answer.ok, JSON.stringify(answer).slice(0, 300)).toBe(true);
    await page.goto('/bank');
    for (const currency of ['EUR', 'GBP', 'USD']) {
      const row = answer.data.currencies.find((c) => c.currency === currency);
      expect(row, `${currency} in the partner's answer`).toMatchObject({ state: 'done', blocker: null });
      expect(row.sets.length, `${currency}: the partner issued a set`).toBeGreaterThan(0);
      const block = page.getByTestId(`account-details-${currency}`);
      await expect(block).not.toContainText('rail.bank');
      const shown = block.getByTestId('account-details-set');
      await expect(shown).toHaveCount(row.sets.length);
      for (const [i, set] of row.sets.entries()) {
        expect(set.partnerBank, 'the issuing bank is the TEST partner').toMatch(/TEST/);
        expect(set.accountNumber, 'the number is labelled TEST').toMatch(/^TEST-/);
        await expect(shown.nth(i)).toContainText(set.accountNumber);
        await expect(shown.nth(i)).toContainText(set.partnerBank);
      }
    }
  });
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
  // Nothing on the account changed: every space and figure is the same, read apart from when the partner was asked.
  expect(withoutReadTime(await spaces(who))).toEqual(withoutReadTime(before));

  // Back to Personal: the account's own terms and money are there again.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-personal').click();
  await page.goto('/bank');
  await expect(page.getByTestId('account-profile')).toContainText('Your personal account');
  await expect(page.getByTestId('account-terms')).toContainText('TEST base tier');
  await expect(page.getByTestId('currency-USDT')).toContainText('80 USDT');
});
