// World: stack
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api as ledgerApi, journeyState, json, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { signIn, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-23, in the running app (docs/roadmap/journeys.json): I keep my business books and idle cash in order. Tests
// titled "J-bank-23 #<n>" prove a step. #4 (business savings and treasury funds) is Later (OWNER 226: custody) and is not
// built here.
//
// Starts: a business admin (the business's owner), signed up as a business and verified, in Business mode on a EUR
// business account whose money is the TEST partner bank's (`custody: 'off'`), with a month of TEST activity: TEST 1000
// paid in (`testPartner.fundBusiness`) and four TEST card purchases, three at TESTSHOP shops and one at a cafe, on a card
// the owner holds. Every line is one line of the TEST partner's own record; the ledger posts nothing, which each step
// checks on the owner's ledger figures. Each step opens a business of its own.
const J = 'J-bank-23';
const RUN = Date.now().toString(36);
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PARTNER_BANK = 'TEST partner bank';
const ACTIVITY = [
  ['TESTSHOP Berlin', '12.5'],
  ['Corner Cafe', '4.2'],
  ['TESTSHOP Online', '30'],
  ['testshop kiosk', '7.3'],
];
const DAY = 24 * 60 * 60 * 1000;
const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
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
      fetch(`${EDGE}/api/bank/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

function ok(res) {
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 400)).toBe(true);
  return res.data;
}

async function person(page, prefix, options = {}) {
  const handle = `${prefix}${RUN}${randomBytes(2).toString('hex')}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who, options);
  await verify(page, who);
  return who;
}

/** The business owner, made once a run and kept in its run file, with their ledger figures before anything. */
async function owner(page) {
  const kept = run.read();
  if (kept.owner) return kept.owner;
  const made = await freshOwner(page, 'jb23o');
  run.write({ owner: made });
  return made;
}

/** A new business owner with their ledger figures before anything; #3 makes its own each time, since it adds an authenticator. */
async function freshOwner(page, prefix) {
  const who = await person(page, prefix, { accountType: 'business' });
  return { who, ledger: await (await ledgerApi(who)).balances() };
}

/** This month as the bank reads it: its first instant, and the next month's first (exclusive). */
function thisMonth(now = new Date()) {
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

/** A business of the step's own: TEST 1000 EUR at the TEST partner and a month of TEST card activity on the owner's card. */
async function business(o, tag) {
  const own = await bank(o.who);
  ok(await own.mutate('testPartner.set', { custody: 'off' }));
  const accountId = randomUUID();
  const name = `TEST Books ${tag} ${RUN}`;
  ok(await own.mutate('business.create', { accountId, name, assetId: 'EUR', spendThreshold: '500' }));
  const funded = ok(await own.mutate('testPartner.fundBusiness', { accountId, fundId: `jb23-${accountId}`.slice(0, 64), amount: '1000' }));
  expect(funded).toMatchObject({ label: PARTNER_BANK, assetId: 'EUR', balance: '1000' });
  const card = ok(
    await own.mutate('businessCards.issueCard', { accountId, cardId: randomUUID(), memberUserId: own.userId, perPurchaseLimit: '500' }),
  );
  const buy = async (merchant, amount) => {
    const p = ok(await own.mutate('businessCards.testPurchase', { cardId: card.id, purchaseId: randomUUID(), merchant, amount }));
    expect(p).toMatchObject({ status: 'captured', amount });
    return p;
  };
  for (const [merchant, amount] of ACTIVITY) await buy(merchant, amount);
  return { own, accountId, name, buy };
}

/** The TEST partner's own statement of the business's account for the period, straight from its book. */
async function partnerStatement(b, period) {
  return ok(await b.own.query('testPartner.businessStatement', { accountId: b.accountId, ...period }));
}

/** The business's lines as the bank lists them for the period. */
async function lines(b, period) {
  return ok(await b.own.query('businessBooks.lines', { accountId: b.accountId, ...period })).items;
}

/**
 * `who` signed in, in Business mode on `name`, at the books room. The pick is saved on the account's view record a
 * moment later (shared/view-sync.ts), and that record wins on the next load; so the room is read until it names the
 * business just picked, picking again if a load beat the save.
 */
async function inBusiness(page, who, name) {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/home');
  for (let attempt = 1; ; attempt++) {
    const saved = page
      .waitForResponse((r) => r.url().includes('/preferences.set') && r.request().method() === 'POST', { timeout: 5_000 })
      .catch(() => null);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByTestId('profile-business').filter({ hasText: name }).click();
    await page.waitForURL('**/pay/merchant');
    await saved;
    await page.goto('/bank/business/books');
    const shown = page.getByTestId('books-business');
    await expect(shown).toBeVisible();
    if ((await shown.textContent()) === name || attempt === 3) break;
  }
  await expect(page.getByTestId('books-business')).toHaveText(name);
}

async function ledgerUnchanged(o) {
  expect(await (await ledgerApi(o.who)).balances()).toEqual(o.ledger);
}

/** Presses a button that downloads a file and returns the file's text. */
async function download(page, button) {
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: file.suggestedFilename(), text: await readFile(await file.path(), 'utf8') };
}

/** Sum of signed decimal strings, in hundredths of a cent, as a bigint. */
function units(s) {
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace(/^-/, '').split('.');
  const v = BigInt(i) * 10n ** 6n + BigInt((f + '000000').slice(0, 6));
  return neg ? -v : v;
}

test(`${J} #1 presses Connect accounting: the notice needs vendor.accounting, switched off in this build, and the connection record kept; bank feed import by file works`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const o = await owner(page);
  const b = await business(o, 'connect');
  await inBusiness(page, o.who, b.name);

  await expect(page.getByTestId('books-connection')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect accounting' }).click();
  await expect(page.getByTestId('books-notice')).toHaveText('Needs vendor.accounting, switched off in this build. Nothing was connected.');
  const record = page.getByTestId('books-connection');
  await expect(record).toHaveAttribute('data-status', 'switched_off');
  await expect(record).toHaveAttribute('data-needs', 'vendor.accounting');
  await expect(record).toContainText('Connection record kept: switched off, asked 1 times');
  // The record is the bank's, and it stays across a reload.
  const kept = ok(await b.own.query('businessBooks.overview', { accountId: b.accountId })).connection;
  expect(kept).toMatchObject({ status: 'switched_off', needs: 'vendor.accounting', requestedBy: b.own.userId, attempts: 1 });
  await page.reload();
  await expect(page.getByTestId('books-connection')).toHaveAttribute('data-status', 'switched_off');

  // The bank feed by file: one CSV with every line of the month by its id, and the partner's figures.
  const month = thisMonth();
  const listed = await lines(b, month);
  expect(listed).toHaveLength(ACTIVITY.length + 1);
  const feed = await download(page, page.getByRole('button', { name: 'Download bank feed file (CSV)' }));
  expect(feed.name).toMatch(/\.csv$/);
  await expect(page.getByTestId('books-notice')).toHaveText(`Bank feed file downloaded: ${listed.length} lines.`);
  const theirs = await partnerStatement(b, month);
  expect(feed.text).toContain(`Closing balance,${theirs.closing}`);
  expect(feed.text).toContain(`Line count,${theirs.lines}`);
  const rows = feed.text.split('\r\n');
  const header = rows.indexOf('Line id,Booked (UTC),Amount,Currency,Payee,Category,GL code');
  expect(header).toBeGreaterThan(0);
  const body = rows.slice(header + 1).filter(Boolean);
  expect(body).toHaveLength(listed.length);
  for (const l of listed) expect(body.some((r) => r.startsWith(`${l.id},`) && r.includes(l.payee))).toBe(true);
  await ledgerUnchanged(o);
});

test(`${J} #2 writes a rule "payee contains TESTSHOP sets Supplies": a test run shows 3 matches before saving, a new matching line is coded automatically, GL codes and bulk coding work`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const o = await owner(page);
  const b = await business(o, 'rules');
  const month = thisMonth();
  await inBusiness(page, o.who, b.name);

  const form = page.getByRole('form', { name: 'Coding rules' });
  await form.getByLabel('Payee contains').fill('TESTSHOP');
  await form.getByLabel('Category').fill('Supplies');
  await form.getByLabel('GL code').fill('6100');
  await form.getByRole('button', { name: 'Test rule' }).click();
  await expect(page.getByTestId('books-notice')).toHaveText('Test run: 3 matches this month. Nothing is coded until you save.');
  const matches = page.getByTestId('books-rule-match');
  await expect(matches).toHaveCount(3);
  await expect(page.getByTestId('books-rule-matches')).toHaveAttribute('data-count', '3');
  // Before saving nothing is coded.
  expect((await lines(b, month)).filter((l) => l.category !== null || l.glCode !== null)).toEqual([]);

  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByTestId('books-notice')).toHaveText('Rule saved. Matching lines are coded now and as they arrive.');
  await expect(page.getByTestId('books-rule')).toContainText('Payee contains “TESTSHOP” sets Supplies (GL 6100)');
  const supplies = page.locator('[data-testid="books-line"][data-category="Supplies"][data-coded-by="rule"]');
  await expect(supplies).toHaveCount(3);
  await expect(supplies.first()).toHaveAttribute('data-gl', '6100');
  let now = await lines(b, month);
  expect(
    now
      .filter((l) => l.category === 'Supplies' && l.glCode === '6100' && l.codedBy === 'rule')
      .map((l) => l.payee)
      .sort(),
  ).toEqual(['TESTSHOP Berlin', 'TESTSHOP Online', 'testshop kiosk']);

  // A new matching line arrives and is coded on its own.
  await b.buy('TESTSHOP Airport', '9.99');
  await page.reload();
  const fresh = page.locator('[data-testid="books-line"][data-payee="TESTSHOP Airport"]');
  await expect(fresh).toHaveAttribute('data-category', 'Supplies');
  await expect(fresh).toHaveAttribute('data-coded-by', 'rule');
  await expect(fresh).toHaveAttribute('data-gl', '6100');

  // Bulk coding with a GL code: the pay-in and the cafe line at once.
  now = await lines(b, month);
  const pick = now.filter((l) => l.payee === 'Pay-in' || l.payee === 'Corner Cafe');
  expect(pick).toHaveLength(2);
  for (const l of pick) await page.getByLabel(`Select line ${l.id}`, { exact: true }).check();
  const bulk = page.getByRole('form', { name: 'Code the selected lines' });
  await bulk.getByLabel('Category').fill('Office');
  await bulk.getByLabel('GL code').fill('6200');
  await bulk.getByRole('button', { name: 'Code 2 selected' }).click();
  await expect(page.getByTestId('books-notice')).toHaveText('2 lines coded.');
  for (const l of pick) {
    const row = page.locator(`[data-testid="books-line"][data-line="${l.id}"]`);
    await expect(row).toHaveAttribute('data-category', 'Office');
    await expect(row).toHaveAttribute('data-gl', '6200');
    await expect(row).toHaveAttribute('data-coded-by', 'person');
  }
  const after = await lines(b, month);
  expect(
    after
      .filter((l) => l.codedBy === 'person')
      .map((l) => l.id)
      .sort(),
  ).toEqual(pick.map((l) => l.id).sort());
  expect(after.filter((l) => l.codedBy === 'rule')).toHaveLength(4);
  await ledgerUnchanged(o);
});

test(`${J} #3 exports a month in four formats: each file has the same closing balance and line count as the partner's statement, each line carries its id, history window and SCA apply`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const o = await freshOwner(page, 'jb23s');
  const b = await business(o, 'statements');
  const month = thisMonth();
  const theirs = await partnerStatement(b, month);
  expect(theirs).toMatchObject({ label: PARTNER_BANK, opening: '0', closing: '946', lines: ACTIVITY.length + 1 });
  const ids = (await lines(b, month)).map((l) => l.id);
  expect(ids).toHaveLength(theirs.lines);
  await inBusiness(page, o.who, b.name);
  await expect(page.getByTestId('books-window')).toHaveText(
    'TEST partner bank keeps 400 days of history. A month further back than 90 days needs a fresh confirmation.',
  );

  const files = {};
  for (const [format, label] of [
    ['csv', 'CSV'],
    ['mt940', 'MT940'],
    ['camt053', 'CAMT.053'],
    ['qif', 'QIF'],
  ]) {
    files[format] = await download(page, page.getByRole('button', { name: `Export ${label}` }));
    const shown = page.locator(`[data-testid="books-file"][data-format="${format}"]`);
    await expect(shown).toHaveAttribute('data-closing', theirs.closing);
    await expect(shown).toHaveAttribute('data-lines', String(theirs.lines));
    await expect(shown).toHaveAttribute('data-partner-closing', theirs.closing);
    for (const id of ids) expect(files[format].text, `${format} names line ${id}`).toContain(id);
  }
  // Each format states the partner's closing balance and line count in its own terms.
  expect(files.csv.text).toContain(`Closing balance,${theirs.closing}`);
  expect(files.csv.text).toContain(`Line count,${theirs.lines}`);
  expect(files.mt940.text).toMatch(
    new RegExp(`:62F:C\\d{6}EUR${theirs.closing.replace('.', ',')}${theirs.closing.includes('.') ? '' : ','}\\r\\n`),
  );
  expect(files.mt940.text.match(/^:61:/gm)).toHaveLength(theirs.lines);
  expect(files.camt053.text).toContain(`<Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${theirs.closing}</Amt><CdtDbtInd>CRDT</CdtDbtInd>`);
  expect(files.camt053.text).toContain(`<NbOfNtries>${theirs.lines}</NbOfNtries>`);
  expect((files.camt053.text.match(/<Ntry>/g) ?? []).length).toBe(theirs.lines);
  const qif = [...files.qif.text.matchAll(/^T(-?[\d.]+)\r$/gm)].map((m) => m[1]);
  expect(qif).toHaveLength(theirs.lines + 1); // the opening balance record, then one per line
  expect(qif.reduce((t, a) => t + units(a), 0n)).toBe(units(theirs.closing));

  // The history window: a period before the partner's 400 days is refused by name, and no file is made.
  const old = { from: new Date(Date.now() - 500 * DAY).toISOString(), to: new Date(Date.now() - 480 * DAY).toISOString() };
  expect(
    await b.own.mutate('businessBooks.exportStatement', { accountId: b.accountId, ...old, format: 'csv', exportId: randomUUID() }),
  ).toMatchObject({ ok: false, code: 'bank.statement_history_window' });

  // SCA: a month further back than 90 days needs a fresh confirmation. Without one the bank refuses and gives no file.
  const back = new Date(Date.now() - 130 * DAY);
  const backMonth = thisMonth(back);
  expect(
    await b.own.mutate('businessBooks.exportStatement', { accountId: b.accountId, ...backMonth, format: 'csv', exportId: randomUUID() }),
  ).toMatchObject({ ok: false, code: 'bank.step_up_required' });
  // Read before an authenticator is set up: it ends this person's other sessions, and a new one would need its code.
  const oldTheirs = await partnerStatement(b, backMonth);
  await ledgerUnchanged(o);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  await page.goto('/bank/business/books');
  await expect(page.getByTestId('books-business')).toHaveText(b.name);
  await page.getByLabel('Month').fill(backMonth.from.slice(0, 7));
  await expect(page.getByTestId('books-needs-sca')).toHaveText(
    'This month is further back than 90 days: confirm it’s you before exporting.',
  );
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  const confirm = page.getByTestId('step-up-confirm');
  await confirm.getByLabel('Authenticator code').fill((await nextCode(totp, secret, step)).code);
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('books-sca-done')).toBeVisible();
  const confirmed = await download(page, page.getByRole('button', { name: 'Export CSV' }));
  expect(confirmed.text).toContain(`Closing balance,${oldTheirs.closing}`);
  expect(confirmed.text).toContain(`Line count,${oldTheirs.lines}`);
  // The same confirmation covers that month's other formats.
  const confirmedQif = await download(page, page.getByRole('button', { name: 'Export QIF' }));
  expect(confirmedQif.text).toContain('POpening Balance');
  await expect(page.locator('[data-testid="books-file"][data-format="qif"]')).toHaveAttribute('data-closing', oldTheirs.closing);
});
