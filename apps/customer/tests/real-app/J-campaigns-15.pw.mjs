// World: none
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn } from './desk.mjs';
import { ROOT, journeyState, signUpInBrowser } from './stack.mjs';
import { tableIn } from './tables.mjs';

// J-campaigns-15, in the running app (docs/roadmap/journeys.json): open the points programme. One test per step, titled
// "J-campaigns-15 #<n>", run in order. Whether INTAFACED runs a points programme whose points have value or convert to
// cash is an open owner question (OWNER 87), so svc-campaigns keeps no points: the customer's points area on
// /uc/promotion shows every part of the programme with no number, and each press names that blocker and stores nothing.
// #5 is the founder console's earning-rules builder (/more-ops/campaigns): founder A drafts this run's TEST points
// programme there and gives it a points rule and an incentive rule; evaluating them on a TEST event refuses the points
// effect alone. "Nothing stored" is read from svc-campaigns' own tables with its own database role on the stack.
const J = 'J-campaigns-15';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const QUESTION = 'Whether INTAFACED runs a points programme whose points have value or convert to cash.';
// A figure in the points area: any digit at all. The programme keeps none, so none may show.
const DIGIT = /\d/;

test.describe.configure({ mode: 'default' });

const person = (handle) => ({
  handle,
  email: `${handle}@local-test.invalid`,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

/** svc-campaigns' own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function campaignsDb() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const postgres = createRequire(path.join(ROOT, 'services', 'svc-campaigns', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_campaigns:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}

/** Every row svc-campaigns holds for one account, by table: what "nothing stored" is checked against. */
async function storedFor(account) {
  const sql = await campaignsDb();
  try {
    const [row] = await sql`
      SELECT
        (SELECT count(*)::int FROM campaigns.reward_intents WHERE lower(account_id) = lower(${account})) AS rewards,
        (SELECT count(*)::int FROM campaigns.participations WHERE lower(account_id) = lower(${account})) AS participations,
        (SELECT count(*)::int FROM campaigns.audit_log WHERE lower(actor) = lower(${account})) AS audit`;
    return row;
  } finally {
    await sql.end();
  }
}

/** Opens the points area from /uc/promotion by its tab, signed in as the run's customer. */
async function openPoints(page) {
  await page.goto('/uc/promotion');
  await page.getByRole('navigation', { name: 'Promotion sections' }).getByRole('link', { name: 'Points programme' }).click();
  await expect(page).toHaveURL(/\/uc\/promotion\/points$/);
  const area = page.getByTestId('points-programme');
  await expect(area).toHaveAttribute('data-state', 'ready');
  return area;
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #1 opens the points area in /uc/promotion: the wallet, members and lifecycle layout, with no numbers`, async ({ page }) => {
  test.setTimeout(120_000);
  run.reset({});
  const me = person(`jc15me${tag}`.slice(0, 20));
  await signUpInBrowser(page, me);
  await page.goto('/uc/promotion');
  const account = (await page.locator('.promotions__owner [lang="zxx"]').textContent())?.trim();
  expect(account, 'the promotions page names the signed-in account').toBeTruthy();
  run.write({ me, account });

  const area = await openPoints(page);
  await expect(
    page.getByRole('navigation', { name: 'Promotion sections' }).getByRole('link', { name: 'Points programme' }),
  ).toHaveAttribute('aria-current', 'page');
  // The blocker is named: the owner question, in plain words.
  await expect(area.getByTestId('points-blocker')).toHaveAttribute('data-code', 'owner.decision');
  await expect(area.getByTestId('points-question')).toContainText(QUESTION);

  // The wallet: available, pending and expiring, each "Not kept", never a figure.
  const wallet = area.getByTestId('points-wallet');
  await expect(wallet.getByRole('heading', { name: 'Your points wallet' })).toBeVisible();
  for (const [key, label] of [
    ['available', 'Available points'],
    ['pending', 'Pending points'],
    ['expiring', 'Points expiring soon'],
  ]) {
    const line = wallet.getByTestId(`points-wallet-${key}`);
    await expect(line).toContainText(label);
    await expect(line.locator('dd')).toHaveText('Not kept');
  }

  // Members: the count is not kept.
  const members = area.getByTestId('points-members');
  await expect(members.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(members.getByTestId('points-members-count')).toHaveText('Not kept');

  // The lifecycle: every stage, none current.
  const lifecycle = area.getByTestId('points-lifecycle');
  await expect(lifecycle.getByRole('list', { name: 'Programme lifecycle' }).getByRole('listitem')).toHaveText([
    'Draft',
    'Active',
    'Paused',
    'Ended',
  ]);
  await expect(lifecycle.locator('[aria-current]')).toHaveCount(0);
  await expect(lifecycle.getByTestId('points-lifecycle-current')).toContainText('at no stage yet');

  // No numbers: not one digit in the wallet, members or lifecycle.
  for (const part of [wallet, members, lifecycle]) expect(await part.innerText()).not.toMatch(DIGIT);
});

test(`${J} #2 opens the expiry mode and pending points: the expiry modes and the pending-points layout, empty, with no invented balance`, async ({
  page,
}) => {
  const { me } = state('me');
  await signIn(page, me);
  const area = await openPoints(page);
  const expiry = area.getByTestId('points-expiry');
  await expect(expiry.getByRole('heading', { name: 'Expiry mode' })).toBeVisible();
  await expect(expiry.getByTestId('points-expiry-current')).toHaveText('Not set');
  const modes = expiry.getByTestId('points-expiry-mode');
  await expect(modes).toHaveCount(4);
  await expect(modes.nth(0)).toContainText('Never');
  await expect(modes.nth(1)).toContainText('Rolling');
  await expect(modes.nth(2)).toContainText('Calendar');
  await expect(modes.nth(3)).toContainText('Inactivity');
  // A horizon is an owner value: blank reads "Not set" (never has none).
  for (const i of [1, 2, 3]) await expect(modes.nth(i).getByTestId('points-expiry-horizon')).toHaveText('Not set');

  const pending = area.getByTestId('points-pending');
  await expect(pending.getByRole('heading', { name: 'Pending points' })).toBeVisible();
  await expect(pending.getByTestId('points-pending-empty')).toContainText('No pending points');
  await expect(pending.getByTestId('points-pending-row')).toHaveCount(0);
  // No invented balance: the wallet's pending line stays "Not kept", and no digit shows in either part.
  await expect(area.getByTestId('points-wallet-pending').locator('dd')).toHaveText('Not kept');
  for (const part of [expiry, pending]) expect(await part.innerText()).not.toMatch(DIGIT);
});

test(`${J} #3 opens the rewards catalogue: benefits redeemable with points in full layout; a blank price or stock shows as not set`, async ({
  page,
}) => {
  const { me } = state('me');
  await signIn(page, me);
  const area = await openPoints(page);
  const catalogue = area.getByTestId('points-catalogue');
  await expect(catalogue.getByRole('heading', { name: 'Rewards catalogue' })).toBeVisible();
  const table = catalogue.getByRole('region', { name: 'Rewards catalogue' });
  for (const head of ['Benefit', 'Price in points', 'Stock', 'Per person', 'Action']) {
    await expect(table.getByRole('columnheader', { name: head })).toBeVisible();
  }
  const items = catalogue.getByTestId('points-catalogue-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Fee-saver coupon');
  await expect(items.nth(1)).toContainText('Voucher');
  await expect(items.nth(2)).toContainText('limited drop');
  for (let i = 0; i < 3; i++) {
    const item = items.nth(i);
    await expect(item.getByTestId('points-item-price')).toHaveText('Not set');
    await expect(item.getByTestId('points-item-stock')).toHaveText('Not set');
    await expect(item.getByTestId('points-item-limit')).toHaveText('Not set');
    await expect(item.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  }
  // The conversion's rate and minimum are blank owner values too, and Convert is there to press.
  const convert = area.getByTestId('points-convert');
  await expect(convert.getByTestId('points-convert-rate')).toHaveText('Not set');
  await expect(convert.getByTestId('points-convert-minimum')).toHaveText('Not set');
  await expect(convert.getByRole('button', { name: 'Convert' })).toBeEnabled();
  expect(await catalogue.innerText()).not.toMatch(DIGIT);
});

test(`${J} #4 presses Convert and Redeem a catalogue reward: the "waiting for an owner decision" refusal with the blocker named; nothing stored`, async ({
  page,
}) => {
  const { me, account } = state('me', 'account');
  await signIn(page, me);
  const before = await storedFor(account);
  const area = await openPoints(page);

  await area.getByTestId('points-convert').getByRole('button', { name: 'Convert' }).click();
  const converted = area.getByTestId('points-convert-refusal');
  await expect(converted).toHaveAttribute('data-code', 'owner.decision');
  await expect(converted).toContainText('Waiting for an owner decision');
  await expect(converted).toContainText(QUESTION);
  await expect(converted).toContainText('Nothing was stored');

  await area.getByRole('button', { name: 'Redeem Fee-saver coupon: part of our fee off your venue orders' }).click();
  const redeemed = area.getByTestId('points-redeem-refusal-fee_saver');
  await expect(redeemed).toHaveAttribute('data-code', 'owner.decision');
  await expect(redeemed).toContainText('Waiting for an owner decision');
  await expect(redeemed).toContainText(QUESTION);

  // The page read the programme again after each press: still no figure anywhere.
  await expect(area).toHaveAttribute('data-state', 'ready');
  await expect(area.getByTestId('points-wallet-available').locator('dd')).toHaveText('Not kept');
  await expect(area.getByTestId('points-pending-row')).toHaveCount(0);
  // Nothing stored: svc-campaigns holds no new row for this account in any of its tables a press could touch.
  expect(await storedFor(account)).toEqual(before);
  // And a reload shows the same: nothing the presses could have kept.
  await page.reload();
  await expect(page.getByTestId('points-programme')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('points-wallet-available').locator('dd')).toHaveText('Not kept');
});

test(`${J} #5 an operator opens the same programme in the earning-rules builder: a points effect saves, but its evaluation refuses with the owner-decision blocker for that effect only`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const NAME = `TEST points programme ${tag}`;
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/more-ops/campaigns`);
  await expect(page.getByRole('heading', { name: 'Campaigns', level: 1 })).toBeVisible();
  const builder = page.getByRole('form', { name: 'Campaign builder' });
  await page.getByRole('button', { name: 'New campaign' }).click();
  await builder.getByRole('textbox', { name: 'Name' }).fill(NAME);
  await builder.getByRole('radio', { name: /^Points programme/ }).check();
  await builder.getByRole('button', { name: 'Next' }).click();
  await page.goto(`${ADMIN}/more-ops/campaigns`);
  await tableIn(page, 'Campaigns').getByRole('link', { name: NAME, exact: true }).click();
  await expect(builder).toBeVisible();
  await builder.getByRole('tab', { name: 'Earning rules' }).click();

  const form = page.getByRole('form', { name: 'Earning rule' });
  const rules = page.getByRole('list', { name: 'Earning rules' });
  // A points effect: 50 points for each TEST deposit.
  await form.getByRole('textbox', { name: 'Earning rule name' }).fill('Deposit points');
  await form.getByRole('combobox', { name: 'Trigger' }).selectOption('pay.deposit_credit.posted');
  await form.getByRole('combobox', { name: 'Effect' }).selectOption('points');
  await expect(form.getByTestId('earn-effect-points-note')).toContainText('waits for an owner decision');
  await form.getByRole('textbox', { name: 'Incentive formula' }).fill('50');
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert')).toHaveCount(0);
  // An incentive rule beside it, on the same trigger.
  await form.getByRole('textbox', { name: 'Earning rule name' }).fill('Deposit reward');
  await form.getByRole('combobox', { name: 'Trigger' }).selectOption('pay.deposit_credit.posted');
  await form.getByRole('combobox', { name: 'Effect' }).selectOption('incentive');
  await form.getByRole('textbox', { name: 'Incentive formula' }).fill('amount / 100');
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert')).toHaveCount(0);

  // The points effect saved: it is on the draft after a reload.
  await page.reload();
  await builder.getByRole('tab', { name: 'Earning rules' }).click();
  await expect(rules.getByTestId('earning-rule')).toHaveCount(2);
  await expect(rules).toContainText('Deposit points: when a crypto deposit is credited, give 50 points (waits for an owner decision)');
  await expect(rules).toContainText('Deposit reward: when a crypto deposit is credited, give amount / 100');

  // Evaluate on a TEST deposit of 250: the incentive says what it would give; the points effect alone refuses.
  const evaluate = page.getByRole('form', { name: 'Evaluate on a TEST event' });
  await evaluate.getByRole('combobox', { name: 'TEST event' }).selectOption('pay.deposit_credit.posted');
  await evaluate.getByRole('textbox', { name: 'TEST amount' }).fill('250');
  await evaluate.getByRole('button', { name: 'Evaluate rules' }).click();
  await expect(evaluate.getByRole('alert')).toHaveCount(0);
  const answers = evaluate.getByRole('list', { name: 'Evaluation' }).getByTestId('earning-evaluation-rule');
  await expect(answers).toHaveCount(2);
  const points = evaluate.locator('[data-rule="Deposit points"]');
  await expect(points).toHaveAttribute('data-outcome', 'refused');
  await expect(points).toContainText('Waiting for an owner decision');
  await expect(points).toContainText(QUESTION);
  await expect(points).toContainText('owner.decision');
  const incentive = evaluate.locator('[data-rule="Deposit reward"]');
  await expect(incentive).toHaveAttribute('data-outcome', 'gives');
  await expect(incentive).toContainText('would give 2.5');

  // Evaluating stored nothing: no reward intent for this programme, and it is still a draft.
  const sql = await campaignsDb();
  try {
    const [row] = await sql`SELECT id, state FROM campaigns.campaigns WHERE name = ${NAME}`;
    expect(row?.state).toBe('draft');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM campaigns.reward_intents WHERE campaign_id = ${row.id}`;
    expect(n).toBe(0);
  } finally {
    await sql.end();
  }
});
