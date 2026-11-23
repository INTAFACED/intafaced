// World: none
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { api, fund, journeyState, stepAccount } from './stack.mjs';
import { trpcError } from './answers.mjs';
import { pictureFromTop, signIn, signUp, verify } from './desk.mjs';

// J-bank-12, in the running app (docs/roadmap/journeys.json): I look at overdraft, personal loans and the credit card
// (labelled previews). One test per step, titled "J-bank-12 #<n>", run in order on one fresh, verified TEST account that
// holds TEST 10 USDT, so "no money moved" is read against a real ledger balance. None of these credit engines exists (each
// needs a licence we do not hold): every page sits at its own route with the kit's "Preview · sample data" notice, its
// engine panels marked as sample data with a text alternative, and every figure is a TEST fixture svc-bank serves. Every engine action
// is refused by svc-bank with the platform's typed Preview refusal (packages/contracts/src/preview-refusal.ts: code
// `preview.engine_not_built`, kind `preview`, HTTP 412). No application is stored and no money moves.
const J = 'J-bank-12';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const LABEL = 'Preview · sample data';
const CODE = 'preview.engine_not_built';

test.describe.configure({ mode: 'default' });

/** The account step 1 made: every later step signs in as it. */
const who = () => stepAccount(run, J);

/** A bank read through the person's own session at Edge: the tRPC data, after a 200. */
async function bankRead(session, procedure, input) {
  const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const { status, body } = await session.get(`/api/bank/trpc/${procedure}${q}`);
  expect(status, `${procedure}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.result?.data?.json ?? body.result?.data;
}

/** What the bank holds for the person: the ledger's balances and their loans. A preview action must change neither. */
async function holdings() {
  const session = await api(who());
  return { balances: await session.balances(), loans: await bankRead(session, 'loans.list', { limit: 50 }) };
}

/** A preview room's shell: its title, the kit's preview notice, its sample-data engine panels and its TEST figures. */
async function previewRoom(page, path, title, room) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(page.locator('[data-region="notices"]')).toContainText(LABEL);
  const root = page.getByTestId('credit-preview');
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute('data-room', room);
  const engines = page.getByTestId('preview-engine');
  expect(await engines.count(), `${room} has engine panels`).toBeGreaterThan(0);
  for (const panel of await engines.all()) {
    await expect(panel).toHaveAttribute('data-sample', 'true');
    await expect(panel).toHaveAttribute('aria-label', /sample data, not an offer/);
    await expect(panel).toContainText('TEST');
  }
}

/** Every figure in the sample-data panels (an amount or a rate) is followed by its TEST label. */
/** Picks the room's `index`th choice in the kit's choice group named `group` (with its words, when given) and sees it chosen. */
async function choose(page, group, index, words) {
  expect(index, `${group}: the choice is one the bank offers`).toBeGreaterThanOrEqual(0);
  const choice = page.getByRole('group', { name: group, exact: true }).getByRole('button').nth(index);
  if (words) await expect(choice).toHaveText(words);
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
}

async function everyFigureTest(page) {
  for (const panel of await page.getByTestId('preview-engine').all()) {
    const text = (await panel.innerText()).replace(/\s+/g, ' ');
    const figures = text.match(/\d[\d.,]*(?:%| [A-Z]{3})?/g) ?? [];
    for (const f of figures) {
      const at = text.indexOf(f);
      // A figure is an amount or a rate; a count ("12 months", "Repayment 3 of 12") is not a money figure.
      if (!/%| [A-Z]{3}$/.test(f)) continue;
      expect(text.slice(at, at + f.length + 6), `figure "${f}" says TEST`).toMatch(/TEST/);
    }
  }
}

/**
 * Presses `button` and checks the refusal end to end: one POST to `procedure` naming `action`, answered 412 with the typed
 * Preview refusal for `engine`, and the room's alert saying "<Action> is a preview in this build" with the same code.
 */
async function refused(page, button, { procedure, engine, action }) {
  const reply = page.waitForResponse((r) => r.url().includes(`/trpc/${procedure}`) && r.request().method() === 'POST');
  await button.click();
  const res = await reply;
  expect(res.status(), `${action} answers 412`).toBe(412);
  const preview = trpcError(await res.json())?.data?.preview;
  expect(preview, `${action} carries error.data.preview`).toEqual({ kind: 'preview', code: CODE, engine, action, label: LABEL });
  const alert = page.getByTestId('preview-refusal');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toHaveAttribute('data-code', CODE);
  await expect(alert).toHaveAttribute('data-kind', 'preview');
  await expect(alert).toHaveAttribute('data-engine', engine);
  await expect(alert).toContainText('is a preview in this build');
  await expect(alert).toContainText('Nothing was stored and no money moved.');
  return alert;
}

test(`${J} #1 opens the overdraft, personal loan and business term loan pages: sample numbers from the bank, labelled Preview and TEST`, async ({
  page,
}) => {
  const person = await signUp(page, 'jbl');
  run.reset({ who: person });
  // The bank rooms are for a verified person (the journey starts signed in, as any bank customer is).
  await verify(page, person);
  await fund(person.email, 'USDT', '10', `${J}-${person.handle}`);
  await signIn(page, person);
  const view = await bankRead(await api(person), 'creditPreviews.overview');
  expect(view).toMatchObject({ label: LABEL, preview: true, blurred: true, currency: 'EUR' });

  // Overdraft: the limit, rate and the cost of a month at each limit are the bank's sample figures.
  await previewRoom(page, '/bank/loans/overdraft', 'Overdraft', 'overdraft');
  const od = page.getByTestId('preview-engine').filter({ hasText: 'Interest rate a year' });
  await expect(od).toContainText(`${view.overdraft.rate}% TEST`);
  await expect(od).toContainText(`${view.overdraft.limits[0]} EUR TEST`);
  const last = view.overdraft.monthlyCost.at(-1);
  await choose(page, 'Overdraft limit', view.overdraft.limits.indexOf(last.limit));
  await expect(od).toContainText(`${last.cost} EUR TEST`);
  await expect(od).toContainText(`${view.overdraft.repaymentWindowMonths} months TEST`);
  await expect(page.getByRole('region', { name: 'Credit bureau reporting', exact: true })).toContainText('TEST');
  await everyFigureTest(page);

  // Personal loan: the calculator moves with the term, on the bank's sample table; the name stays on the page.
  await previewRoom(page, '/bank/loans/personal', 'Personal loan', 'personal_loan');
  const calc = page.getByTestId('preview-engine');
  await expect(calc).toContainText(`${view.personalLoan.amount} EUR TEST`);
  await expect(calc).toContainText(`${view.personalLoan.rate}% TEST`);
  for (const [i, t] of view.personalLoan.terms.entries()) {
    await choose(page, 'Term', i, `${t.termMonths} months`);
    await expect(calc).toContainText(`${t.monthly} EUR TEST`);
    await expect(calc).toContainText(`${t.totalInterest} EUR TEST`);
  }
  await page.getByLabel('Name this loan', { exact: true }).fill('TEST new bike');
  await expect(page.locator('dl[aria-label="TEST new bike"]')).toBeVisible();
  await everyFigureTest(page);

  // Business term loan: the fee and the weekly payment for each term.
  await previewRoom(page, '/bank/business/loan', 'Business term loan', 'business_term_loan');
  const biz = page.getByTestId('preview-engine');
  for (const [i, t] of view.businessTermLoan.terms.entries()) {
    await choose(page, 'Term', i, `${t.weeks} weeks`);
    await expect(biz).toContainText(`${t.weekly} EUR TEST`);
    await expect(biz).toContainText(`${t.fee} EUR TEST`);
  }
  await expect(biz).toContainText(`${view.businessTermLoan.flatFee}% TEST`);
  await everyFigureTest(page);
});

test(`${J} #2 presses Apply: the typed Preview refusal, no record stored and no money moved`, async ({ page }) => {
  await signIn(page, who());
  const before = await holdings();
  expect(before.balances.USDT?.total, 'the TEST 10 USDT is on the ledger').toBeTruthy();

  for (const [path, title, room, product] of [
    ['/bank/loans/overdraft', 'Overdraft', 'overdraft', 'overdraft'],
    ['/bank/loans/personal', 'Personal loan', 'personal_loan', 'personal_loan'],
    ['/bank/business/loan', 'Business term loan', 'business_term_loan', 'business_term_loan'],
  ]) {
    await previewRoom(page, path, title, room);
    const alert = await refused(page, page.getByRole('button', { name: 'Apply', exact: true }), {
      procedure: 'creditPreviews.act',
      engine: `bank.${product}`,
      action: 'apply',
    });
    await expect(alert).toContainText('Apply is a preview in this build');
  }

  // A direct call is refused by the bank itself, not only by the page.
  const direct = await (await api(who())).post('/api/bank/trpc/creditPreviews.act', { product: 'personal_loan', action: 'apply' });
  expect(direct.status).toBe(412);
  expect(trpcError(direct.body)?.data?.preview).toMatchObject({ kind: 'preview', code: CODE, engine: 'bank.personal_loan' });

  expect(await holdings(), 'no loan stored and no balance changed').toEqual(before);
});

test(`${J} #3 opens the unsecured loan schedule and changes the repayment date: the Preview refusal, and the missed-payment policy reads "not set"`, async ({
  page,
  stepPicture,
}) => {
  await signIn(page, who());
  const before = await holdings();
  const schedule = await bankRead(await api(who()), 'creditPreviews.schedule');
  await previewRoom(page, '/bank/loans/schedule', 'Unsecured loan schedule', 'loan_schedule');
  const table = page.getByTestId('preview-engine').locator('table');
  await expect(table.locator('tbody tr')).toHaveCount(schedule.termMonths);
  await expect(table.locator('tbody tr').first()).toContainText(`${schedule.rows[0].amount} EUR TEST`);
  await everyFigureTest(page);

  // The policy is the owner's; blank, each value reads "not set", as the bank answers it.
  expect(await bankRead(await api(who()), 'loans.missedPaymentPolicy')).toEqual({ status: 'not_set' });
  const policy = page.getByTestId('missed-payment-policy');
  await expect(policy).toHaveAttribute('data-status', 'not_set');
  for (const label of ['Grace days', 'Days to catch up', 'Late fee']) {
    await expect(policy.locator('div').filter({ hasText: label }).locator('dd')).toHaveText('not set');
  }

  const button = page.getByRole('button', { name: 'Change repayment date', exact: true });
  await expect(button, 'no date chosen, nothing to send').toBeDisabled();
  await page.getByLabel('New repayment date', { exact: true }).fill('2027-01-15');
  await refused(page, button, { procedure: 'loans.changeRepaymentDate', engine: 'bank.loan_schedule', action: 'change_repayment_date' });
  await pictureFromTop(page, stepPicture);
  expect(await holdings(), 'nothing stored and no balance changed').toEqual(before);
});

test(`${J} #4 opens the credit-card application and rules: Submit shows the Preview refusal, and every figure is labelled TEST`, async ({
  page,
}) => {
  await signIn(page, who());
  const before = await holdings();
  const card = await bankRead(await api(who()), 'creditCard.preview');
  await previewRoom(page, '/bank/cards/credit-card', 'Credit card', 'credit_card');

  const rows = page.getByTestId('credit-card-row');
  await expect(rows).toHaveCount(card.rows.length);
  for (const row of await rows.all()) await expect(row).toContainText('TEST');
  const rules = page.getByTestId('credit-card-rules');
  for (const heading of ['Application', 'Credit limit', 'Repayment', 'Usage rules and fees', 'Statements'])
    await expect(rules.getByRole('heading', { name: heading })).toBeVisible();
  await expect(rules).toContainText('foreign transaction');
  await expect(rules).toContainText('gambling');
  await everyFigureTest(page);

  await choose(page, 'Card', 1, 'Charge card');
  await page.getByLabel('Yearly income', { exact: true }).fill('40000');
  const alert = await refused(page, page.getByRole('button', { name: 'Submit', exact: true }), {
    procedure: 'creditCard.application',
    engine: 'bank.credit_card',
    action: 'apply',
  });
  await expect(alert).toContainText('Submit is a preview in this build');
  expect(await holdings(), 'no application stored and no balance changed').toEqual(before);
});

test(`${J} #5 opens the revolving credit page over test data: a labelled preview, and the fraud-score page on the ops side says the same`, async ({
  page,
  stepPicture,
  founders,
}) => {
  await signIn(page, who());
  const before = await holdings();
  const view = await bankRead(await api(who()), 'creditPreviews.revolving');
  await previewRoom(page, '/bank/cards/credit', 'Revolving credit', 'revolving_credit');
  for (const name of ['Credit limit', 'Statements', 'Interest tiers', 'Repayments', 'Bureau reporting', 'Collections'])
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();

  // The statement opens behind the preview: its figures sample data, each labelled TEST.
  const statements = page.getByRole('region', { name: 'Statements', exact: true });
  await expect(statements.getByTestId('preview-engine')).toHaveCount(0);
  await statements.getByRole('button', { name: 'Open the statement', exact: true }).click();
  const statement = statements.getByTestId('preview-engine');
  await expect(statement).toHaveAttribute('data-sample', 'true');
  const balance = view.rows.find((r) => r.item === 'statement_balance');
  await expect(statement).toContainText(`${balance.figure} EUR TEST`);
  await everyFigureTest(page);

  await refused(page, page.getByRole('button', { name: 'Borrow', exact: true }), {
    procedure: 'creditPreviews.act',
    engine: 'bank.revolving_credit',
    action: 'borrow',
  });
  await pictureFromTop(page, stepPicture);
  expect(await holdings(), 'no credit line and no balance changed').toEqual(before);

  // The ops side: the card fraud risk page is the same labelled preview over TEST rows.
  const { page: desk } = await founders.console('a');
  await desk.goto(`${ADMIN}/bank-ops/cards/fraud`);
  const fraud = desk.getByTestId('fraud-preview');
  await expect(fraud.getByRole('heading', { name: 'Card fraud risk', exact: true, level: 1 })).toBeVisible();
  await expect(desk.getByTestId('fraud-preview-label')).toHaveText(LABEL);
  const scores = fraud.getByTestId('preview-engine');
  await expect(scores).toHaveAttribute('data-blurred', 'true');
  const rows = scores.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toContainText(/TEST-AUTH-\d+ TEST/);
  await expect(fraud).toContainText('Automatic blocking: unavailable');
});
