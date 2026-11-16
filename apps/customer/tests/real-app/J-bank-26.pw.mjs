// World: restart, gates
import { createHash, randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, json, tool } from './stack.mjs';
import { signUp, verify } from './desk.mjs';

// J-bank-26, in the running app (docs/roadmap/journeys.json): I run the card programme (support and finance), on the founder
// console's bank desk. The card programme and its money are the partner's (OWNER 226); no partner is named, so the stack
// runs the TEST partner card adapter (card-sim) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON,
// CUSTODY-DELTA §4). Step 6 (BK-cops-05), opening programme funding. A TEST cardholder's USDC card first gets one open hold
// of 5 and one capture of 20 (through the bank's ops door, approved by two founders, as the simulator's stand-in needs),
// so the app's own figure for USDC moves by a known 25. The profile's TEST partner has said nothing about the funder, the
// reserve, its programme figures, the funding stablecoin or what funding it offers: each reads "not known", never zero, and
// so does the reconciliation's partner figure and difference, and fund, defund and auto reload are switched off with that
// reason. For one restart (LOCAL_STACK_BANK_CARD_PARTNER=reported) the same partner reports TEST answers: the funder and
// reserve; its figures for USDC (5 held, 20 captured) and BTC (0.0005 captured, which the app has no record of); USDC as
// the funding stablecoin; fund and defund offered and auto reload not. The desk reconciles each row (the difference is the
// partner's minus the app's, "matches" or "break"), converts each into USDC at the rate source's rate and time, and two
// founders send one Fund instruction, which the partner answers with a TEST reference and nothing posts.
//
// Steps 1 to 5, 7 and 8 run on the console's card programme desk (/bank-ops/cards). TEST card events come from the desk's
// own card event simulator (svc-bank `ops.cardProgrammeSimulate`, a dev or test stack only), through the same authorise
// and capture path an issuer's message takes; the TEST partner spends at most 30 USDC per person, so each step's
// cardholder is its own. A programme rule and the 3DS policy are programme-wide, so each step that sets one puts it back
// (`gates`). Founder B is made a Viewer in #7 and a Manager again after.
const J = 'J-bank-26';

/** The bank restarted with one LOCAL_STACK_ switch set for that restart only (unset puts the profile's TEST value back). */
function restartBank(key, value) {
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

let gatesCtx;
async function founders() {
  gatesCtx ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return gatesCtx;
}
/** One card-issuer event through the bank's ops door, approved by two founders as the simulator's stand-in requires. */
async function cardEvent(actionType, procedure, fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** svc-bank's programme funding read, as founder A's session sees it. */
async function fundingRead() {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.query('bank', 'ops.cardProgrammeFunding', undefined, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** A person's own svc-bank API through Edge. */
async function customerBank(who) {
  const { body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${JSON.stringify(login).slice(0, 300)}`);
  return (procedure, input) =>
    fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json);
}

async function desk(browser, key = 'a') {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, key);
  await page.goto('/bank-ops');
  return page;
}
const terms = (page) => page.getByTestId('read-bank.card-partner-terms');
const fact = (page, read, label) =>
  page
    .getByTestId(`read-${read}`)
    .locator('.dk-kv-row')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');
/** A list read's rows as the screen shows them, each keyed by its column heading. */
async function shownRows(page, read) {
  const list = page.getByTestId(`read-${read}`);
  await expect(list.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  return list.evaluate((el) => {
    const heads = [...el.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    return [...el.querySelectorAll('tbody tr')]
      .filter((tr) => !tr.querySelector('td[colspan]'))
      .map((tr) => Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [heads[i], td.textContent.trim()])));
  });
}
const SCALE = 10n ** 18n;
const units = (d) => {
  const negative = d.startsWith('-');
  const [whole, frac = ''] = (negative ? d.slice(1) : d).split('.');
  const v = BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return negative ? -v : v;
};
const decimal = (v) => {
  const negative = v < 0n;
  const a = negative ? -v : v;
  const frac = (a % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${a / SCALE}${frac ? `.${frac}` : ''}`;
};
/** The reconciliation holds on every row: the difference is the partner's figure minus the app's, and the word follows it. */
function expectReconciled(row) {
  if (row['Partner’s figure'] === 'not known') {
    expect(row).toMatchObject({ Difference: 'not known', Reconciliation: 'not known' });
    return;
  }
  // An asset the app holds no record of: its side is "missing", a break by name, never read as 0 (OWNER 288).
  if (row['Held plus captured (app)'] === 'missing') {
    expect(row).toMatchObject({ Difference: 'not known', Reconciliation: 'break: missing in this app’s records' });
    return;
  }
  const difference = units(row['Partner’s figure']) - units(row['Held plus captured (app)']);
  expect(row.Difference).toBe(decimal(difference));
  expect(row.Reconciliation).toBe(difference === 0n ? 'matches' : 'break');
}

// ── The card programme desk (steps 1 to 5, 7 and 8) ─────────────────────────────────────────────────────────────────

/** A card programme step through svc-bank as founder A (support:ops), as the desk's own route sends it. */
async function programme(procedure, input, method = 'mutate') {
  const { ctx, sessions } = await founders();
  // A read takes admin:read; a step takes the support permission (support:ops), as svc-bank checks them.
  const token = method === 'query' ? await sessions.a.tradeOpsToken() : await sessions.a.supportOpsToken();
  const res =
    method === 'query' ? await ctx.edge.query('bank', procedure, input, token) : await ctx.edge.mutate('bank', procedure, input, token);
  expect(res.status, res.text.slice(0, 400)).toBe(200);
  return res.json.result.data;
}
const simulate = (event) => programme('ops.cardProgrammeSimulate', event);

/** A verified person with a funded TEST USDC card (limit 50), once per key in this worker. */
const people = new Map();
function person(browser, key) {
  if (!people.has(key)) {
    people.set(
      key,
      (async () => {
        const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
        const who = await signUp(page, `jb26${key}`);
        await verify(page, who);
        expect(fund(who.email, 'USDC', '100').tx).toBeTruthy();
        const issued = await (
          await customerBank(who)
        )('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
        const card = issued?.body?.result?.data;
        expect(card?.id, JSON.stringify(issued).slice(0, 300)).toBeTruthy();
        await page.context().close();
        return { ...who, cardId: card.id, panTail: card.panTail };
      })(),
    );
  }
  return people.get(key);
}
/** The person as a verified individual cardholder of the programme, through svc-bank. */
async function cardholderOf(who) {
  return programme('ops.cardProgrammeCardholderCreate', {
    requestKey: `jb26-holder-${who.handle}`,
    kind: 'individual',
    name: `TEST ${who.handle}`,
    email: who.email,
    country: 'DE',
  });
}

async function programmeDesk(browser, key = 'a', query = '') {
  const page = await desk(browser, key);
  await page.goto(`/bank-ops/cards${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  await expect(page.getByTestId('card-programme-desk')).toBeVisible({ timeout: 30_000 });
  return page;
}
/** A desk table's rows as the screen shows them, each keyed by its column heading. */
async function tableRows(page, testId) {
  const table = page.getByTestId(testId);
  await expect(table).toBeVisible({ timeout: 30_000 });
  return table.evaluate((el) => {
    const heads = [...el.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    return [...el.querySelectorAll('tbody tr')].map((tr) =>
      Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [heads[i], td.textContent.trim()])),
    );
  });
}
const kv = (page, testId, label) =>
  page
    .getByTestId(testId)
    .locator('.dk-kv-row')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');
const answerOf = (page, section) => page.getByTestId(`cp-answer-${section}`);

test(`${J} #1 walks the set-up checklist and the programme, product and BIN configuration: the checklist, authorisation rules, cardholder fees; a shadow-mode rule shows how many of 100 past TEST authorisations it would decline before promotion`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const who = await person(browser, 'rules');
  // 100 past TEST authorisations, the last the programme decided: 7 in a category only this run uses.
  const category = `jb26-${randomUUID().slice(0, 8)}`;
  const past = [];
  for (let i = 0; i < 100; i++) {
    const a = await simulate({
      kind: 'authorize',
      cardId: who.cardId,
      authorizationRef: `jb26-past-${randomUUID()}`,
      amount: '0.01',
      merchantCategory: i % 14 === 0 ? category : 'groceries',
    });
    expect(a).toMatchObject({ test: true, decision: 'approved' });
    past.push({ id: a.authorizationId, mine: i % 14 === 0 });
  }
  expect(past.filter((p) => p.mine)).toHaveLength(8);

  const page = await programmeDesk(browser);
  // The checklist: each step read from what is stored; the issuer is the simulator, named as rail.card; no go-live step.
  const checklist = await tableRows(page, 'cp-checklist-items');
  expect(checklist.map((r) => r.Step)).toEqual([
    'Programme: consumer or commercial, currencies, fulfilment',
    'Card product',
    'BIN and network',
    'Card issuer',
    'Authorisation rules',
    'Cardholder fees',
    '3DS policy and SCA exemptions',
    'Staff roles',
  ]);
  expect(checklist.find((r) => r.Step === 'Card issuer')).toMatchObject({ Done: 'not done' });
  expect(checklist.find((r) => r.Step === 'Card issuer')['What is missing']).toContain('rail.card');
  await expect(page.getByRole('button', { name: /go live/i })).toHaveCount(0);

  // The programme, product and BIN, saved through the desk and shown as saved.
  const config = page.getByTestId('cp-config');
  await config.getByLabel('Programme type').selectOption('commercial');
  await config.getByLabel('Currencies').fill('USDC, USDT');
  await config.getByLabel('Fulfilment').selectOption('virtual_only');
  await config.getByRole('button', { name: 'Save programme' }).click();
  await expect(answerOf(page, 'config')).toContainText('The programme saved');
  await config.getByLabel('Product name').fill('TEST Business Virtual');
  await config.getByLabel('Per-payment limit').fill('500');
  await config.getByRole('button', { name: 'Save product' }).click();
  await expect(answerOf(page, 'config')).toContainText('The product saved');
  await config.getByLabel('BIN', { exact: true }).fill('49999901');
  await config.getByLabel('Network').fill('TEST network');
  await config.getByRole('button', { name: 'Save BIN' }).click();
  await expect(answerOf(page, 'config')).toContainText('The BIN saved');
  // Cardholder fees: an issuance fee, and a replacement fee left blank, which is "not set" (no fee line, none charged).
  await config.getByLabel('Issuance fee').fill('1.00');
  await config.getByLabel('Monthly fee').fill('0.50');
  await config.getByRole('button', { name: 'Save fees' }).click();
  await expect(answerOf(page, 'config')).toContainText('The cardholder fees saved');
  await page.reload();
  await expect(kv(page, 'cp-config-values', 'Programme')).toContainText('commercial, USDC USDT, virtual only');
  await expect(kv(page, 'cp-config-values', 'Product')).toContainText('TEST Business Virtual, virtual, limit 500 USDC');
  await expect(kv(page, 'cp-config-values', 'BIN')).toContainText('49999901 on TEST network, shared');
  await expect(kv(page, 'cp-config-values', 'Issuance fee')).toHaveText('1.00 USDC');
  await expect(kv(page, 'cp-config-values', 'Replacement fee')).toHaveText('not set');
  await expect(kv(page, 'cp-config-values', 'Monthly fee')).toHaveText('0.50 USDC');

  // A rule in shadow mode: run over the last 100 TEST authorisations, it would decline the 8 in its category.
  const ruleKey = `jb26-${randomUUID().slice(0, 8)}`;
  const rules = page.getByTestId('cp-rules');
  await rules.getByLabel('Rule key').fill(ruleKey);
  await rules.getByLabel('Rule name').fill(`TEST no ${category}`);
  await rules.getByLabel('Declines').selectOption('merchant_category');
  await rules.getByLabel('Category, channel or amount').fill(category);
  await rules.getByRole('button', { name: 'Run in shadow' }).click();
  await expect(answerOf(page, 'rules')).toContainText('decides nothing until promoted');
  await page.reload();
  const shadow = (await tableRows(page, 'cp-rule-list')).find((r) => r.Key === ruleKey);
  expect(shadow).toMatchObject({
    State: 'Shadow (decides nothing)',
    'Shadow run': 'would decline 8 of 100 past TEST authorisations',
    'What it does': `declines merchant category ${category}`,
  });
  // In shadow it decides nothing: a payment in the category is approved.
  expect(
    (
      await simulate({
        kind: 'authorize',
        cardId: who.cardId,
        authorizationRef: `jb26-${randomUUID()}`,
        amount: '0.01',
        merchantCategory: category,
      })
    ).decision,
  ).toBe('approved');
  try {
    await page
      .getByTestId('cp-rules')
      .getByRole('button', { name: `Promote ${ruleKey} v1` })
      .click();
    await expect(answerOf(page, 'rules')).toContainText('decides new authorisations from now');
    // Promoted, it declines new payments only; the 8 past ones stay approved.
    const after = await simulate({
      kind: 'authorize',
      cardId: who.cardId,
      authorizationRef: `jb26-${randomUUID()}`,
      amount: '0.01',
      merchantCategory: category,
    });
    expect(after).toMatchObject({ decision: 'declined', declineCode: 'bank.card_rule_declined' });
    for (const p of past.filter((x) => x.mine)) {
      expect((await programme('ops.cardProgrammeAuthorization', { id: p.id }, 'query')).decision).toBe('approved');
    }
    await page.reload();
    expect((await tableRows(page, 'cp-checklist-items')).find((r) => r.Step === 'Authorisation rules')).toMatchObject({ Done: 'done' });
    // Rolled back, the rule decides nothing again.
    await page
      .getByTestId('cp-rules')
      .getByRole('button', { name: `Roll back ${ruleKey}` })
      .click();
    await expect(answerOf(page, 'rules')).toContainText('Past decisions are unchanged');
    await page.reload();
    expect((await tableRows(page, 'cp-rule-list')).find((r) => r.Key === ruleKey).State).toBe('Retired');
  } finally {
    const left = (await programme('ops.cardProgrammeDesk', undefined, 'query')).rules.find(
      (r) => r.ruleKey === ruleKey && r.state === 'active',
    );
    if (left) await programme('ops.cardProgrammeRuleRollback', { ruleKey });
  }
  await page.context().close();
});

test(`${J} #2 creates a cardholder: the KYC and KYB gate: a business cardholder without a beneficial owner refuses bank.cardholder_unverified and lands in the review queue; directory search and screening`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const who = await person(browser, 'holder');
  const page = await programmeDesk(browser);
  const form = page.getByTestId('cp-cardholder-form');
  // A business with no beneficial owner on file: refused by the KYB gate, and queued for review with the gap named.
  const business = `TEST Shop ${randomUUID().slice(0, 6)}`;
  await form.getByLabel('Cardholder type').selectOption('business');
  await form.getByLabel('Cardholder name').fill(business);
  await form.getByRole('button', { name: 'Create cardholder' }).click();
  await expect(answerOf(page, 'cardholder')).toContainText('No beneficial owner on file');
  await expect(answerOf(page, 'cardholder')).toContainText('bank.cardholder_unverified');
  await page.reload();
  expect((await tableRows(page, 'cp-review-queue')).find((r) => r.Cardholder === business)).toMatchObject({
    Type: 'business',
    Code: 'bank.cardholder_unverified',
  });

  // A verified person passes the KYC gate and screening.
  const name = `TEST ${who.handle}`;
  await page.getByTestId('cp-cardholder-form').getByLabel('Cardholder type').selectOption('individual');
  await page.getByTestId('cp-cardholder-form').getByLabel('Cardholder name').fill(name);
  await page.getByTestId('cp-cardholder-form').getByLabel('Cardholder email').fill(who.email);
  await page.getByTestId('cp-cardholder-form').getByRole('button', { name: 'Create cardholder' }).click();
  await expect(answerOf(page, 'cardholder')).toContainText('passed the gate and screening');

  // Screening: a name on the (TEST) sanctions list is held for review, never created as verified.
  const listed = await person(browser, 'listed');
  await page.getByTestId('cp-cardholder-form').getByLabel('Cardholder name').fill('LOCAL TEST Sanctioned Cardholder');
  await page.getByTestId('cp-cardholder-form').getByLabel('Cardholder email').fill(listed.email);
  await page.getByTestId('cp-cardholder-form').getByRole('button', { name: 'Create cardholder' }).click();
  await expect(answerOf(page, 'cardholder')).toContainText('Screening match');
  await expect(answerOf(page, 'cardholder')).toContainText('bank.cardholder_under_review');

  // Directory search by the card's last four digits finds the person, verified and screened clear, with the card.
  await page.getByLabel('Directory search: name, email or last four digits').fill(who.panTail);
  await page.getByTestId('cp-directory-search').getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(new RegExp(`q=${who.panTail}`));
  const found = (await tableRows(page, 'cp-cardholder-list')).find((r) => r.Cardholder === name);
  expect(found).toMatchObject({ Type: 'Individual (KYC)', Status: 'verified', Screening: 'clear' });
  expect(found.Cards).toContain(`•••• ${who.panTail}`);
  const queue = await tableRows(page, 'cp-review-queue');
  expect(queue.find((r) => r.Cardholder === 'LOCAL TEST Sanctioned Cardholder' && r.Gap.includes('Screening match'))).toBeTruthy();
  await page.context().close();
});

test(`${J} #3 reads the real-time decision log and an authorisation detail: lifecycle, capture variance and the trace of why it was approved or declined`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const who = await person(browser, 'log');
  const ref = `jb26-cap-${randomUUID()}`;
  const approved = await simulate({ kind: 'authorize', cardId: who.cardId, authorizationRef: ref, amount: '25' });
  expect(approved.decision).toBe('approved');
  await simulate({ kind: 'capture', cardId: who.cardId, authorizationRef: ref, amount: '20' });
  const declined = await simulate({ kind: 'authorize', cardId: who.cardId, authorizationRef: `jb26-big-${randomUUID()}`, amount: '60' });
  expect(declined).toMatchObject({ decision: 'declined', declineCode: 'bank.card_limit_exceeded' });

  const page = await programmeDesk(browser);
  const log = await tableRows(page, 'cp-decisions');
  // Newest first: the decline, then the approval.
  expect(log[0]).toMatchObject({ Card: `•••• ${who.panTail}`, Amount: '60 USDC', Decision: 'declined', Code: 'bank.card_limit_exceeded' });
  expect(log[1]).toMatchObject({ Card: `•••• ${who.panTail}`, Amount: '25 USDC', Decision: 'approved', Code: '' });

  await page.getByTestId(`cp-open-${approved.authorizationId}`).click();
  await expect(page.getByTestId('cp-authorization')).toBeVisible();
  expect((await tableRows(page, 'cp-lifecycle')).map((r) => [r.Event, r.Amount])).toEqual([
    ['authorised', '25'],
    ['captured', '20'],
    ['given back', '5'],
  ]);
  await expect(kv(page, 'cp-variance', 'Authorised')).toHaveText('25');
  await expect(kv(page, 'cp-variance', 'Captured')).toHaveText('20');
  await expect(kv(page, 'cp-variance', 'Given back')).toHaveText('5');
  await expect(kv(page, 'cp-variance', 'Still held')).toHaveText('0');
  await expect(kv(page, 'cp-variance', 'Capture variance')).toHaveText('-5');
  const trace = await tableRows(page, 'cp-trace');
  expect(trace.every((t) => t.Answer !== 'declined')).toBe(true);
  expect(trace.find((t) => t.Check === 'Per-payment limit').Why).toContain('is within the card’s limit of 50 USDC.');
  expect(trace.find((t) => t.Check === 'Available balance').Answer).toBe('passed');
  expect(trace.at(-1)).toMatchObject({ Check: 'Hold', Answer: 'passed', Why: 'Approved: the amount is held.' });

  await page.goto(`/bank-ops/cards/authorizations/${declined.authorizationId}`);
  const why = await tableRows(page, 'cp-trace');
  expect(why.at(-1)).toMatchObject({ Check: 'Per-payment limit', Answer: 'declined' });
  await expect(page.getByText('A declined authorisation holds and captures nothing.')).toBeVisible();
  await page.context().close();
});

test(`${J} #4 sets 3DS policy and an SCA exemption: a payment of 25.00 under an exemption limit of 30.00 skips the challenge and the trace says why`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const who = await person(browser, 'threeds');
  const page = await programmeDesk(browser);
  const section = page.getByTestId('cp-threeds');
  await section.getByLabel('3DS policy').selectOption('challenge_all');
  await section.getByLabel('SCA exemption limit').fill('30.00');
  await section.getByLabel('Exemption asset').fill('USDC');
  await section.getByRole('button', { name: 'Save 3DS policy' }).click();
  try {
    await expect(answerOf(page, 'threeds')).toContainText('The 3DS policy is saved');
    await page.reload();
    await expect(kv(page, 'cp-threeds-values', '3DS policy')).toHaveText('challenge every online payment');
    await expect(kv(page, 'cp-threeds-values', 'Low-value exemption')).toHaveText('30.00 USDC');
    const before = Number(await kv(page, 'cp-threeds-values', 'Payments exempted').textContent());

    // 25.00 online, within the exemption: no challenge, approved, and the trace says why.
    const exempt = await simulate({
      kind: 'authorize',
      cardId: who.cardId,
      authorizationRef: `jb26-3ds-${randomUUID()}`,
      amount: '25.00',
      channel: 'online',
    });
    expect(exempt.decision).toBe('approved');
    // 26 online over it with no challenge passed: declined by the policy.
    const challenged = await simulate({
      kind: 'authorize',
      cardId: who.cardId,
      authorizationRef: `jb26-3ds-${randomUUID()}`,
      amount: '31',
      channel: 'online',
    });
    expect(challenged).toMatchObject({ decision: 'declined', declineCode: 'bank.card_3ds_required' });

    await page.goto(`/bank-ops/cards/authorizations/${exempt.authorizationId}`);
    const step = (await tableRows(page, 'cp-trace')).find((t) => t.Check === '3DS policy');
    expect(step).toEqual({
      Check: '3DS policy',
      Answer: 'skipped',
      Why: 'SCA low-value exemption: 25 USDC is under the exemption limit of 30.00 USDC, so the challenge was skipped.',
    });
    await page.goto(`/bank-ops/cards/authorizations/${challenged.authorizationId}`);
    expect((await tableRows(page, 'cp-trace')).find((t) => t.Check === '3DS policy')).toMatchObject({
      Answer: 'declined',
      Why: 'Challenge required (31 USDC is not under the exemption limit of 30.00 USDC); none was passed.',
    });
    await page.goto('/bank-ops/cards');
    await expect(kv(page, 'cp-threeds-values', 'Payments exempted')).toHaveText(String(before + 1));
  } finally {
    await programme('ops.cardProgrammeClearThreeDs', undefined);
  }
  await page.context().close();
});

test(`${J} #5 reads funding and balances: the programme's figures as the partner reports them; held plus captured equals the partner's figure`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const who = await person(browser, 'funds');
  // This person's bank money is held at the TEST partner (custody off), so the partner holds and reports the card's spend.
  const held = await (await customerBank(who))('testPartner.set', { custody: 'off' });
  expect(held.status, JSON.stringify(held.body).slice(0, 300)).toBe(200);
  // One hold of 5 left open, one of 25 captured at 20 (its 5 given back), through the TEST simulator.
  await simulate({ kind: 'authorize', cardId: who.cardId, authorizationRef: `jb26-open-${randomUUID()}`, amount: '5' });
  const ref = `jb26-cap-${randomUUID()}`;
  await simulate({ kind: 'authorize', cardId: who.cardId, authorizationRef: ref, amount: '25' });
  await simulate({ kind: 'capture', cardId: who.cardId, authorizationRef: ref, amount: '20' });
  const holder = await cardholderOf(who);

  const page = await desk(browser);
  await page.goto(`/bank-ops/cards/cardholders/${holder.id}`);
  await expect(page.getByTestId('cp-cardholder')).toBeVisible();
  const funds = (await tableRows(page, 'cp-funds')).find((r) => r.Asset === 'USDC');
  // Held plus captured in this app equals the partner's own figure for the cardholder: the difference is zero.
  expect(funds).toEqual({
    Asset: 'USDC',
    'Open holds (app)': '5',
    'Captured (app)': '20',
    'Held plus captured (app)': '25',
    'Partner’s figure': '25',
    Difference: '0',
    Reconciliation: 'matches',
  });
  // The programme's figures, as the partner reports them: this TEST partner has reported none, so "not known", never 0.
  await expect(page.getByTestId('cp-programme-figures-failed')).toHaveCount(0);
  if ((await page.getByTestId('cp-programme-figures-empty').count()) > 0) {
    await expect(page.getByTestId('cp-programme-figures-empty')).toHaveText('The partner reports no programme figure.');
  } else {
    for (const row of await tableRows(page, 'cp-programme-figures')) expect(row['Partner’s figure']).toBe('not known');
  }
  await page.context().close();
});

test(`${J} #6 opens programme funding: who funds the programme and any reserve the partner requires, or "not known", never shown as zero; the settlement reconciliation against the partner's figures and the stablecoin conversion shown; fund, defund and auto reload where the partner offers them`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  // A TEST cardholder with a USDC card: one hold of 5 left open, one of 25 captured at 20 (its 5 remainder returned).
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(customer, 'jb26');
  await verify(customer, who);
  expect(fund(who.email, 'USDC', '100').tx).toBeTruthy();
  const issued = await (await customerBank(who))('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
  const cardId = issued?.body?.result?.data?.id;
  expect(cardId, JSON.stringify(issued).slice(0, 300)).toBeTruthy();
  await customer.context().close();
  const before = (await fundingRead()).rows.find((r) => r.assetId === 'USDC') ?? { appHeld: '0', appCaptured: '0', appFigure: '0' };
  await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: `jb26-open-${randomUUID()}`, amount: '5' });
  const captureRef = `jb26-cap-${randomUUID()}`;
  await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: captureRef, amount: '25' });
  await cardEvent('bank.card_capture', 'ops.cardCapture', { cardId, authorizationRef: captureRef, amount: '20' });
  const after = (await fundingRead()).rows.find((r) => r.assetId === 'USDC');
  // The app's own figure moved by exactly what happened: 5 more held, 20 more captured.
  expect(units(after.appHeld) - units(before.appHeld)).toBe(units('5'));
  expect(units(after.appCaptured) - units(before.appCaptured)).toBe(units('20'));
  expect(units(after.appFigure) - units(before.appFigure)).toBe(units('25'));

  // The profile's TEST partner has answered nothing: every partner answer reads "not known", and no figure stands in.
  let page = await desk(browser);
  await expect(terms(page)).toBeVisible();
  await expect(fact(page, 'bank.card-partner-terms', 'Card partner')).toHaveText('TEST partner card adapter');
  await expect(fact(page, 'bank.card-partner-terms', 'Who funds the programme')).toHaveText('not known');
  await expect(fact(page, 'bank.card-partner-terms', 'Reserve the partner requires')).toHaveText('not known');
  await expect(fact(page, 'bank.card-partner-terms', 'Reserve the partner requires')).not.toContainText(/\d/);
  await expect(fact(page, 'bank.card-funding-offers', 'Funding stablecoin')).toHaveText('not known');
  for (const label of ['Fund', 'Defund', 'Auto reload']) {
    await expect(fact(page, 'bank.card-funding-offers', label)).toHaveText('not known');
  }
  const silentRow = (await shownRows(page, 'bank.card-funding-reconciliation')).find((r) => r.Asset === 'USDC');
  expect(silentRow).toMatchObject({
    'Open holds (app)': after.appHeld,
    'Captured (app)': after.appCaptured,
    'Held plus captured (app)': after.appFigure,
    'Partner’s figure': 'not known',
    Difference: 'not known',
    Reconciliation: 'not known',
    // No funding stablecoin reported, so no conversion: "not known", never 0.
    'Rate in the funding stablecoin': 'not known',
    'App figure in the funding stablecoin': 'not known',
  });
  const action = page.getByTestId('card-funding-action');
  for (const [id, label] of [
    ['fund', 'Fund'],
    ['defund', 'Defund'],
    ['autoReload', 'Auto reload'],
  ]) {
    await expect(action.getByTestId(`card-funding-${id}`).getByRole('button', { name: label, exact: true })).toBeDisabled();
    await expect(action.getByTestId(`card-funding-${id}`)).toContainText('Not known: the partner has not said whether it offers this.');
  }
  await page.context().close();

  // The same partner reporting its answers, for one restart.
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', 'reported');
  try {
    page = await desk(browser);
    await expect(fact(page, 'bank.card-partner-terms', 'Who funds the programme')).toHaveText('TEST: the programme pre-funds in USDC');
    await expect(fact(page, 'bank.card-partner-terms', 'Reserve the partner requires')).toHaveText('25000.00 USDC, as the partner reports');
    await expect(fact(page, 'bank.card-funding-offers', 'Funding stablecoin')).toHaveText('USDC');
    await expect(fact(page, 'bank.card-funding-offers', 'Fund')).toHaveText('offered by the partner');
    await expect(fact(page, 'bank.card-funding-offers', 'Defund')).toHaveText('offered by the partner');
    await expect(fact(page, 'bank.card-funding-offers', 'Auto reload')).toHaveText('not offered by the partner');

    // The settlement reconciliation against the partner's figures: each row's difference is the partner's minus the app's.
    const read = await fundingRead();
    const rows = await shownRows(page, 'bank.card-funding-reconciliation');
    for (const row of rows) expectReconciled(row);
    const usdc = rows.find((r) => r.Asset === 'USDC');
    const btc = rows.find((r) => r.Asset === 'BTC');
    expect(usdc['Partner’s figure']).toBe('25');
    expect(usdc['Held plus captured (app)']).toBe(read.rows.find((r) => r.assetId === 'USDC').appFigure);
    // A BTC capture the partner reports and the app has no record of: a break named "missing", never folded into a match
    // and never read as 0.
    expect(btc).toMatchObject({
      'Partner’s figure': '0.0005',
      'Held plus captured (app)': 'missing',
      Reconciliation: 'break: missing in this app’s records',
    });
    // The stablecoin conversion into USDC: USDC itself at 1, BTC at the TEST ticker's rate with its time.
    expect(usdc['Rate in the funding stablecoin']).toBe('1');
    expect(usdc['App figure in the funding stablecoin']).toBe(usdc['Held plus captured (app)']);
    const btcRead = read.rows.find((r) => r.assetId === 'BTC');
    expect(btcRead.fundingRate).toMatch(/^\d+(\.\d+)?$/);
    expect(units(btcRead.fundingRate)).toBeGreaterThan(0n);
    expect(Date.parse(btcRead.fundingRateAsOf)).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(btc['Rate in the funding stablecoin']).toMatch(/^\d+(\.\d+)?$/);
    // The rate the screen shows is the rate the service read, not any number.
    expect(units(btc['Rate in the funding stablecoin'])).toBe(units(btcRead.fundingRate));
    // The app has no BTC figure to convert, so its conversion is "not known", never 0.
    expect(btc['App figure in the funding stablecoin']).toBe('not known');

    // Fund and defund where the partner offers them; auto reload, which it does not, is switched off and says so.
    const action = page.getByTestId('card-funding-action');
    await expect(action.getByTestId('card-funding-fund').getByRole('button', { name: 'Fund', exact: true })).toBeEnabled();
    await expect(action.getByTestId('card-funding-defund').getByRole('button', { name: 'Defund', exact: true })).toBeEnabled();
    await expect(action.getByTestId('card-funding-autoReload').getByRole('button', { name: 'Auto reload', exact: true })).toBeDisabled();
    await expect(action.getByTestId('card-funding-autoReload')).toContainText('Not offered by the partner.');

    // Founder A asks to fund 1000 USDC; founder B approves that exact request on their own console; A runs it once.
    const amount = `${1000 + Math.floor(Math.random() * 1000)}`;
    const phrase = `FUND CARD PROGRAMME ${amount}`;
    await action.getByRole('button', { name: 'Fund', exact: true }).click();
    await action.getByLabel('Amount of the funding stablecoin').fill(amount);
    await action.getByLabel(/^Why \(kept with the instruction/).fill('LOCAL TEST programme top up for the month');
    await action.getByLabel(/to confirm$/).fill(phrase);
    await action.getByRole('button', { name: 'Ask the other founder to approve: fund the programme' }).click();
    await expect(action.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    const packet = (await action.getByLabel('Request packet').inputValue()).trim();
    const pageB = await desk(browser, 'b');
    const actionB = pageB.getByTestId('card-funding-action');
    await actionB.getByRole('button', { name: 'Fund', exact: true }).click();
    await actionB.getByLabel('Request packet').fill(packet);
    await actionB.getByLabel(/to approve or run it$/).fill(phrase);
    await actionB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(actionB.getByTestId('step-reply')).toContainText('Approved.');
    await pageB.context().close();
    await action.getByLabel(/to approve or run it$/).fill(phrase);
    await action.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(action.getByTestId('step-reply')).toContainText('the card partner took the instruction, reference TEST-card-sim-', {
      timeout: 60_000,
    });
    const sent = (await fundingRead()).requests.find((r) => r.amount === amount);
    expect(sent).toMatchObject({ kind: 'fund', assetId: 'USDC', threshold: null });
    expect(sent.partnerRef).toMatch(/^TEST-card-sim-[0-9a-f]{16}$/);
    await page.reload();
    const shown = (await shownRows(page, 'bank.card-funding-requests')).find((r) => r.Amount === amount);
    expect(shown).toMatchObject({ Instruction: 'Fund', Stablecoin: 'USDC', 'Partner reference': sent.partnerRef });
    // Nothing posted: the USDC app figures are the cardholder's holds and captures, unchanged by the instruction.
    expect((await fundingRead()).rows.find((r) => r.assetId === 'USDC').appFigure).toBe(
      read.rows.find((r) => r.assetId === 'USDC').appFigure,
    );
    await page.context().close();
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }
});

test(`${J} #7 exports a report and assigns staff roles: a signed export with its freshness time whose totals equal the screen; a viewer role cannot change settings; the audit log lists each action`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const who = await person(browser, 'report');
  await simulate({ kind: 'authorize', cardId: who.cardId, authorizationRef: `jb26-rep-${randomUUID()}`, amount: '2' });
  const page = await programmeDesk(browser);
  const report = await tableRows(page, 'cp-report-table');
  const total = report.find((r) => r.Asset === 'total');
  await page.getByTestId('cp-report').getByRole('button', { name: 'Export signed report' }).click();
  await expect(page.getByTestId('cp-export')).toBeVisible();
  const text = await page.getByTestId('cp-export-file').textContent();
  const asOf = (await page.getByTestId('cp-export-asof').textContent()).trim();
  // Signed over its own text: the SHA-256 shown is the text's, with an HMAC signature beside it.
  expect((await page.getByTestId('cp-export-sha').textContent()).trim()).toBe(createHash('sha256').update(text).digest('hex'));
  expect((await page.getByTestId('cp-export-signature').textContent()).trim()).toMatch(/^[0-9a-f]{64}$/);
  // Its freshness time is in the file, and its totals equal the screen's (read just before; nothing decided between).
  expect(text).toContain(`As of (UTC): ${asOf}`);
  expect(Date.parse(asOf)).toBeGreaterThan(Date.now() - 10 * 60_000);
  expect(text).toContain(`total,${total.Approved},,${total.Declined}`);
  for (const row of report.filter((r) => r.Asset !== 'total')) {
    expect(text).toContain(`${row.Asset},${row.Approved},${row['Approved volume']},${row.Declined}`);
  }

  // Founder B made a Viewer: their console cannot change a setting.
  const { sessions } = await founders();
  const emailB = sessions.b.op.email;
  expect(emailB).toBeTruthy();
  const staff = page.getByTestId('cp-staff');
  await staff.getByLabel('Staff email').fill(emailB);
  await staff.getByLabel('Role', { exact: true }).selectOption('viewer');
  await staff.getByRole('button', { name: 'Give role' }).click();
  await expect(answerOf(page, 'staff')).toContainText('The role is given');
  try {
    const pageB = await programmeDesk(browser, 'b');
    const configB = pageB.getByTestId('cp-config');
    await configB.getByLabel('BIN', { exact: true }).fill('49999902');
    await configB.getByLabel('Network').fill('TEST network');
    await configB.getByRole('button', { name: 'Save BIN' }).click();
    await expect(answerOf(pageB, 'config')).toContainText('Viewer');
    await pageB.reload();
    await expect(kv(pageB, 'cp-config-values', 'BIN')).not.toContainText('49999902');
    await pageB.context().close();

    // The audit log lists each action: the export, the role and the settings, with who made them.
    await page.reload();
    const audit = await tableRows(page, 'cp-audit');
    const viewer = (await tableRows(page, 'cp-staff-list')).find(
      (m) => m.Role === 'viewer' && m.Email.toLowerCase() === emailB.toLowerCase(),
    );
    expect(viewer, JSON.stringify(await tableRows(page, 'cp-staff-list'))).toBeTruthy();
    const role = audit.find((e) => e.Action === 'staff.assign' && e.On === viewer.Email);
    expect(role?.After, JSON.stringify(audit.slice(0, 5))).toBe('{"role":"viewer"}');
    expect(audit.find((e) => e.Action === 'report.export')).toBeTruthy();
    expect(audit.some((e) => e.Action === 'setting.bin' && e.After.includes('49999902'))).toBe(false);
  } finally {
    await programme('ops.cardProgrammeStaffAssign', { email: emailB, role: 'manager' });
  }
  await page.context().close();
});

test(`${J} #8 issues cards in bulk and reassigns one, then runs the card event simulator: a file of 5 rows with one bad lists the bad row and issues nothing until fixed; issuing twice makes four cards once; the simulator is labelled TEST`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const [x, y, z] = [await person(browser, 'bulkx'), await person(browser, 'bulky'), await person(browser, 'bulkz')];
  const [hx, hy, hz] = [await cardholderOf(x), await cardholderOf(y), await cardholderOf(z)];
  const good = [`${hx.id},USDC,20`, `${hx.id},USDC,30`, `${hy.id},USDC,20`, `${hy.id},USDC,30`];
  const bad = randomUUID();
  const page = await programmeDesk(browser);
  const bulk = page.getByTestId('cp-bulk-form');
  await bulk
    .getByLabel(/^Bulk file/)
    .fill(['cardholder_id,asset,per_authorisation_limit', good[0], good[1], `${bad},USDC,20`, good[2], good[3]].join('\n'));
  await bulk.getByRole('button', { name: 'Check file' }).click();
  const checked = await tableRows(page, 'cp-bulk-rows');
  expect(checked).toHaveLength(5);
  expect(checked.filter((r) => r.Check !== 'ok')).toEqual([
    { Row: '3', Cardholder: bad, Check: 'No such cardholder (bank.cardholder_not_found)' },
  ]);
  // Issuing the file with its bad row issues nothing.
  await bulk.getByRole('button', { name: 'Issue cards' }).click();
  await expect(answerOf(page, 'bulk')).toContainText('Nothing was issued: row 3');
  const countOf = async (h) => (await programme('ops.cardProgrammeCardholder', { cardholderId: h.id }, 'query')).cards.length;
  expect(await countOf(hx)).toBe(1);
  expect(await countOf(hy)).toBe(1);

  // Fixed (the bad row gone), issued twice: four cards, once.
  await bulk.getByLabel(/^Bulk file/).fill(good.join('\n'));
  await bulk.getByRole('button', { name: 'Issue cards' }).click();
  await expect(page.getByTestId('cp-bulk-issued')).toContainText('4 cards in this file');
  const firstIssue = await page.getByTestId('cp-bulk-issued').textContent();
  await bulk.getByRole('button', { name: 'Issue cards' }).click();
  await expect(answerOf(page, 'bulk')).toContainText('The cards are issued');
  await expect(page.getByTestId('cp-bulk-issued')).toHaveText(firstIssue);
  expect(await countOf(hx)).toBe(3);
  expect(await countOf(hy)).toBe(3);

  // Reassign one of X's new cards to Z: it moves, nothing else changes.
  const xCards = (await programme('ops.cardProgrammeCardholder', { cardholderId: hx.id }, 'query')).cards.filter((c) => c.id !== x.cardId);
  const moving = xCards[0];
  const reassign = page.getByTestId('cp-issue');
  await reassign.getByLabel('Card id', { exact: true }).fill(moving.id);
  await reassign.getByLabel('To cardholder id').fill(hz.id);
  await reassign.getByRole('button', { name: 'Reassign card' }).click();
  await expect(answerOf(page, 'reassign')).toContainText('The card is reassigned. No money moved.');
  expect((await programme('ops.cardProgrammeCardholder', { cardholderId: hz.id }, 'query')).cards.map((c) => c.id)).toContain(moving.id);
  expect(await countOf(hx)).toBe(2);

  // The card event simulator, labelled TEST, on the moved card: an authorisation through the real path.
  const sim = page.getByTestId('cp-simulator');
  await expect(sim.getByRole('heading', { name: /TEST card event simulator/ })).toBeVisible();
  await expect(sim.locator('.dk-badge')).toHaveText('TEST');
  await sim.getByLabel('Simulated card id').fill(moving.id);
  await sim.getByLabel('Event amount').fill('3');
  await sim.getByRole('button', { name: 'Send TEST event' }).click();
  await expect(answerOf(page, 'simulator')).toHaveText('TEST: approved');
  await page.reload();
  const row = (await tableRows(page, 'cp-decisions'))[0];
  expect(row).toMatchObject({ Card: `•••• ${moving.panTail}`, Amount: '3 USDC', Decision: 'approved' });
  expect(row['']).toBe('Open (TEST)');
  await page.context().close();
});
