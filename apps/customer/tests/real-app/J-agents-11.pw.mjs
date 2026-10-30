import path from 'node:path';
import { test, expect } from '@playwright/test';
import { agentsRun, createOwnAgent, tableIn } from './agents.mjs';
import { fundedTrader } from './desk.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, signInWithCode } from './merchant.mjs';
import { api, fund, ORIGIN, ROOT, toUnits } from './stack.mjs';

// J-agents-11, in the running app (docs/roadmap/journeys.json): run agents for my team: roles, a shared pool and
// per-project limits. One test per step, titled "J-agents-11 #<n>", run in order. The start is real: a TEST owner sets up
// a business account at /bank/business and adds three TEST members as makers on its Team panel (BusinessPeople), each
// with an agent of their own. The agents Team page (/agents/team) reads that team from svc-bank at every call and keeps
// roles, the pool, project limits, team runs, held actions and usage in svc-agents. Members are told apart by their
// account ID, which the page shows beside each role. A pool is a limit, never a balance: every run is charged to the
// member who runs it, in TEST USDT, per usage window.
const J = 'J-agents-11';
const agents = agentsRun(J);
const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const members = (page) => tableIn(main(page), 'Members');
const ROLES = ['Creator', 'Runner', 'Approver', 'Log reader', 'Spend reader'];
const KEYS = ['owner', 'one', 'two', 'three'];
/** A member's row in a table, by the account ID the page shows on it. */
const rowOf = (table, key) => table.getByRole('row').filter({ hasText: person(key).userId });
/** A TEST account ID that is on no business team. */
const NOT_A_MEMBER = '00000000-0000-4000-8000-00000000a911';
const BUSINESS = 'TEST Agents Team';

/** A person kept in the run file (its authenticator secret, if any, is a TEST one), with its code generator put back. */
function person(key) {
  const who = agents.run.read()[key];
  if (!who) throw new Error(`${J} made no ${key}, so this step has no one to act as`);
  return { ...who, totp };
}

const keep = ({ email, password, handle, userId, secret, step }) => ({ email, password, handle, userId, secret, step });

/** Signs `key` in (with its authenticator's next code when it has one), landing on `destination`, and keeps the code
 * step it used, so no later step replays a code. */
async function signInAs(page, key, destination) {
  const who = person(key);
  await signInWithCode(page, who, destination);
  agents.run.write({ [key]: keep(who) });
}

/** Signs `key` in and opens the agents Team page on the business. */
async function openTeam(page, key = 'owner') {
  await signInAs(page, key, '/agents');
  await page.goto('/agents/team');
  await expect(main(page).getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  await expect(members(page)).toBeVisible();
}

/** Ticks one checkbox and waits for the change to be saved and read back. */
async function tick(page, box) {
  await box.check();
  await expect(main(page).getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(box).toBeEnabled();
  await expect(box).toBeChecked();
}

/** A decimal shown as "<amount> USDT", in units. */
const unitsOf = async (locator) => toUnits((await locator.innerText()).replace(/\s*USDT$/, ''));
/** The person's TEST USDT total on the ledger, in units. */
const ledgerTotal = async (key) => toUnits((await (await api(person(key))).balances()).USDT?.total ?? '0');

/** Confirms one bank action dialog (the money room's review, then its submit) and waits for the service's answer. */
async function confirmDialog(page, submit) {
  const dialog = page.getByRole('dialog');
  const review = dialog.getByRole('button', { name: 'Review', exact: true });
  if (await review.isVisible()) await review.click();
  await dialog.getByRole('button', { name: submit, exact: true }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
}

/** The owner's business account card on /bank/business, with its Team panel open. */
async function businessTeam(page) {
  const card = main(page)
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: BUSINESS, exact: true }) });
  // The card reloads after each confirmed action and its Team panel folds, so open it whenever it is folded.
  const toggle = card.getByRole('button', { name: 'Team', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return card;
}

/** The Team runs panel of the signed-in member. */
const runs = (page) => main(page).getByRole('region', { name: 'Team runs', exact: true });

/** Opens a team run of the member's own agent. */
async function openRun(page) {
  await runs(page).getByRole('button', { name: 'Open a team run' }).click();
  await expect(runs(page).getByTestId('run-session')).toBeVisible();
}

/** Asks one run: the reply's cost, or the refusal code the page shows. */
async function ask(page, text) {
  const panel = runs(page);
  await panel.getByRole('textbox', { name: /^Ask/ }).fill(text);
  const answered = page.waitForResponse((r) => r.url().includes('team.runs.run') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await answered;
  await expect(panel.getByTestId('run-cost').or(panel.getByRole('alert'))).toBeVisible();
  if (await panel.getByTestId('run-cost').isVisible()) return { cost: await panel.getByTestId('run-cost').innerText() };
  return { refused: await panel.getByRole('alert').locator('code').innerText() };
}

/** Closes the open team run, so its window is settled and sealed. */
async function closeRun(page) {
  await runs(page).getByRole('button', { name: 'Close the run' }).click();
  await expect(runs(page).getByRole('status')).toHaveText('The run is closed.');
}

test(`${J} starts: a business owner with team members`, async ({ page }) => {
  test.setTimeout(600_000);
  const made = {};
  for (const key of ['one', 'two', 'three']) {
    made[key] = await fundedTrader(page, `ag11${key[0]}${key.at(-1)}`, '1');
    await signInWithCode(page, made[key], '/agents');
    await createOwnAgent(page);
    await forgetSession(page);
  }
  const owner = await businessReadyPerson(page, 'ag11o', '/agents');
  expect(fund(owner.email, 'USDT', '5').tx).toBeTruthy();
  await createOwnAgent(page);
  // The business account: the owner becomes its admin; the threshold is a TEST figure.
  await page.goto('/bank/business');
  await main(page).getByRole('button', { name: 'Set up approvals' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name for these approval rules' }).fill(BUSINESS);
  await dialog.getByRole('combobox', { name: 'Currency' }).selectOption('USDT');
  await dialog.getByRole('textbox', { name: 'Payments from this amount need a second person' }).fill('100');
  await confirmDialog(page, 'Set up approvals');
  // Each member joins on the business's Team panel, found by @handle, as a maker.
  const card = await businessTeam(page);
  for (const key of ['one', 'two', 'three']) {
    await card.getByRole('textbox', { name: 'Who are you paying?' }).fill(`@${made[key].handle}`);
    await card.getByRole('button', { name: 'Find', exact: true }).click();
    await card.getByRole('button', { name: 'Add a teammate', exact: true }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: 'Role' }).selectOption({ label: 'Maker: proposes payments' });
    await confirmDialog(page, 'Add teammate');
    await businessTeam(page);
    await expect(card.getByText(`@${made[key].handle}`, { exact: true })).toBeVisible();
    // The card reloads after the add, so its finder is empty again for the next teammate.
    await expect(card.getByRole('textbox', { name: 'Who are you paying?' })).toHaveValue('');
  }
  agents.run.reset({ owner: keep(owner), one: keep(made.one), two: keep(made.two), three: keep(made.three) });
});

test(`${J} #1 opens Team and grants creator, runner, approver, log reader and spend reader roles: the roles listed per member; granting to a non-member is refused`, async ({
  page,
}) => {
  await openTeam(page);
  // Every member of the business is listed once, by account ID.
  const ids = await members(page).getByRole('row').locator('td code').allInnerTexts();
  expect(ids.sort()).toEqual(KEYS.map((key) => person(key).userId).sort());
  for (const role of ROLES) await tick(page, rowOf(members(page), 'one').getByRole('checkbox', { name: `Allow ${role}` }));
  // Read again from the service: the five roles are listed on member one's row, and on no one else's.
  await page.reload();
  await expect(rowOf(members(page), 'one').getByTestId('effective-roles')).toHaveText(ROLES.join(', '));
  for (const key of ['owner', 'two', 'three']) await expect(rowOf(members(page), key).getByTestId('effective-roles')).toHaveText('None');
  const grant = main(page).getByRole('form', { name: 'Grant a role to an account' });
  await grant.getByRole('textbox', { name: /^Grant to/ }).fill(NOT_A_MEMBER);
  await grant.getByRole('button', { name: 'Grant' }).click();
  await expect(main(page).getByRole('alert').locator('code')).toHaveText('agents.role_not_member');
  await page.reload();
  await expect(members(page).getByRole('row').filter({ hasText: NOT_A_MEMBER })).toHaveCount(0);
  expect((await members(page).getByRole('row').locator('td code').allInnerTexts()).sort()).toEqual(ids.sort());
  await expect(rowOf(members(page), 'one').getByTestId('effective-roles')).toHaveText(ROLES.join(', '));
});

test(`${J} #2 gives a member allow runner and deny runner: the effective result is deny`, async ({ page }) => {
  await openTeam(page);
  await tick(page, rowOf(members(page), 'two').getByRole('checkbox', { name: 'Allow Runner' }));
  await tick(page, rowOf(members(page), 'two').getByRole('checkbox', { name: 'Deny Runner' }));
  await page.reload();
  const two = rowOf(members(page), 'two');
  await expect(two.getByRole('checkbox', { name: 'Allow Runner' })).toBeChecked();
  await expect(two.getByRole('checkbox', { name: 'Deny Runner' })).toBeChecked();
  await expect(two.getByTestId('effective-runner')).toHaveText('Denied');
  await expect(two.getByTestId('effective-roles')).toHaveText('None');
  // Deny is what the service applies: member two's run is refused for the runner role.
  await forgetSession(page);
  await openTeam(page, 'two');
  await runs(page).getByRole('button', { name: 'Open a team run' }).click();
  await expect(runs(page).getByRole('alert').locator('code')).toHaveText('agents.team_role_required');
  await expect(runs(page).getByTestId('run-session')).toHaveCount(0);
});

test(`${J} #3 has a creator who also holds approver approve their own agent's action: the four-eyes rule refuses`, async ({ page }) => {
  await openTeam(page, 'one');
  const approvals = main(page).getByRole('region', { name: 'Approvals', exact: true });
  const propose = approvals.getByRole('form', { name: 'Hold an action for approval' });
  await propose.getByRole('button', { name: 'Hold for approval' }).click();
  await expect(approvals.getByRole('status')).toHaveText('The action is waiting for an approver.');
  const held = tableIn(approvals, 'Held actions');
  const row = held.getByRole('row').filter({ hasText: person('one').userId });
  await expect(held.getByRole('row')).toHaveCount(2);
  await expect(row.getByTestId('held-status')).toHaveText('Waiting for approval');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(approvals.getByRole('alert').locator('code')).toHaveText('agents.team_four_eyes');
  // Read again: the action still waits, approved by no one.
  await page.reload();
  await expect(row.getByTestId('held-status')).toHaveText('Waiting for approval');
  await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible();
});

test(`${J} #4 creates a business pool and per-member allocations, one left blank: the blank allocation is refused by name; the pool shows its limit`, async ({
  page,
}) => {
  await openTeam(page);
  const pool = main(page).getByRole('form', { name: 'Business pool' });
  const allocation = (key) => pool.getByRole('textbox', { name: new RegExp(`^Allocation for .*\\(${person(key).userId}\\)`) });
  await pool.getByRole('textbox', { name: /^Pool limit/ }).fill('5');
  await allocation('owner').fill('1');
  await allocation('one').fill('2');
  await allocation('two').fill('0.01');
  await pool.getByRole('button', { name: 'Save pool' }).click();
  const refused = pool.getByRole('alert');
  await expect(refused.locator('code')).toHaveText('agents.pool_allocation_unset');
  await expect(refused).toContainText(`(${person('three').userId}) is blank`);
  for (const key of ['owner', 'one', 'two']) await expect(refused).not.toContainText(person(key).userId);
  // Nothing was kept: the business still has no pool.
  await page.reload();
  await expect(main(page).getByTestId('pool-limit')).toHaveCount(0);
  await pool.getByRole('textbox', { name: /^Pool limit/ }).fill('5');
  await allocation('owner').fill('1');
  await allocation('one').fill('2');
  await allocation('two').fill('0.01');
  // Member three's allocation is a TEST figure about one run's worst-case hold.
  await allocation('three').fill('0.011');
  await pool.getByRole('button', { name: 'Save pool' }).click();
  await expect(pool.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(main(page).getByTestId('pool-limit')).toHaveText('5 USDT');
  await expect(main(page).getByTestId('pool-allocated')).toHaveText('3.021 USDT');
  await expect(rowOf(tableIn(main(page), 'Limits by member'), 'three')).toContainText('0.011 USDT');
});

test(`${J} #5 a member spends past their allocation: the next run refuses and the pool total stays within its limit`, async ({ page }) => {
  test.setTimeout(180_000);
  await openTeam(page);
  await tick(page, rowOf(members(page), 'three').getByRole('checkbox', { name: 'Allow Runner' }));
  await forgetSession(page);
  agents.run.write({ threeLedgerBefore: String(await ledgerTotal('three')) });
  await openTeam(page, 'three');
  await openRun(page);
  const asked = [];
  for (let n = 1; n <= 6; n++) {
    const answer = await ask(page, `TEST question ${n}`);
    asked.push(answer);
    if (answer.refused) break;
  }
  // At least one run was admitted and charged, and the run after the allocation was spent is refused by its code.
  expect(asked[0].cost, JSON.stringify(asked)).toMatch(/^\d+(\.\d+)? USDT$/);
  expect(asked.at(-1).refused, JSON.stringify(asked)).toBe('agents.team.allocation_exceeded');
  const limits = tableIn(main(page), 'Limits by member');
  const usedAtRefusal = await unitsOf(rowOf(limits, 'three').getByTestId('member-used'));
  await closeRun(page);
  // Read from the service again: member three stayed within 0.011, the pool within 5, and the refusal took nothing.
  await page.reload();
  const used = await unitsOf(rowOf(tableIn(main(page), 'Limits by member'), 'three').getByTestId('member-used'));
  expect(used > 0n).toBe(true);
  expect(used <= toUnits('0.011')).toBe(true);
  expect(used <= usedAtRefusal).toBe(true);
  const poolUsed = await unitsOf(main(page).getByTestId('pool-used'));
  expect(poolUsed).toBe(used);
  expect(poolUsed <= toUnits('5')).toBe(true);
});

test(`${J} #6 sets a limit for one business project: members of that project are limited and others are not`, async ({ page }) => {
  test.setTimeout(180_000);
  await openTeam(page);
  const project = main(page).getByRole('form', { name: 'New project' });
  await project.getByRole('textbox', { name: /^Project name/ }).fill('TEST desk project');
  await project.getByRole('checkbox', { name: new RegExp(`\\(${person('one').userId}\\)$`) }).check();
  // A TEST limit below one run's hold.
  await project.getByRole('textbox', { name: /^Project limit/ }).fill('0.001');
  await project.getByRole('button', { name: 'Create project' }).click();
  await expect(project.getByRole('status')).toHaveText('Saved.');
  await tick(page, rowOf(members(page), 'owner').getByRole('checkbox', { name: 'Allow Runner' }));
  await page.reload();
  const limits = tableIn(main(page), 'Limits by member');
  await expect(rowOf(limits, 'one')).toContainText('TEST desk project: 0.001 USDT');
  for (const key of ['owner', 'two', 'three']) await expect(rowOf(limits, key)).toContainText('No project limit');

  // The owner is not on the project: their run is admitted within their allocation.
  agents.run.write({ ownerLedgerBefore: String(await ledgerTotal('owner')) });
  await openRun(page);
  const owners = await ask(page, 'TEST question owner');
  expect(owners.cost, JSON.stringify(owners)).toMatch(/^\d+(\.\d+)? USDT$/);
  await closeRun(page);

  // Member one is on the project: the run is refused by the project limit, and nothing is held against them.
  await forgetSession(page);
  await openTeam(page, 'one');
  await openRun(page);
  const ones = await ask(page, 'TEST question one');
  expect(ones.refused, JSON.stringify(ones)).toBe('agents.team.project_limit_exceeded');
  await closeRun(page);
  await page.reload();
  await expect(rowOf(tableIn(main(page), 'Limits by member'), 'one').getByTestId('member-used')).toHaveText('0 USDT');
});

test(`${J} #7 opens usage analytics by member and task: only members of the business, totals matching sealed windows`, async ({ page }) => {
  await openTeam(page);
  const usagePanel = main(page).getByRole('region', { name: 'Usage by member', exact: true });
  const usage = tableIn(usagePanel, 'Usage by member');
  // Only the business's members, each once.
  const heads = await usage.getByRole('rowheader').allInnerTexts();
  expect(heads.length).toBe(KEYS.length);
  for (const key of KEYS) expect(heads.filter((h) => h.includes(person(key).userId))).toHaveLength(1);
  const total = async (key) => unitsOf(rowOf(usage, key).getByTestId('usage-member-total'));
  // Each member's sealed total is what their sealed windows charged their own account on the ledger.
  const run = agents.run.read();
  const threeTotal = await total('three');
  const ownerTotal = await total('owner');
  expect(threeTotal > 0n).toBe(true);
  expect(ownerTotal > 0n).toBe(true);
  expect(BigInt(run.threeLedgerBefore) - (await ledgerTotal('three'))).toBe(threeTotal);
  expect(BigInt(run.ownerLedgerBefore) - (await ledgerTotal('owner'))).toBe(ownerTotal);
  expect(await total('one')).toBe(0n);
  expect(await total('two')).toBe(0n);
  // Usage is by task, and the team total is the sum of the members' sealed totals.
  await expect(rowOf(usage, 'three').getByRole('cell').nth(1)).not.toHaveText('No sealed run');
  expect(await unitsOf(usagePanel.getByTestId('usage-total'))).toBe(threeTotal + ownerTotal);
});

test(`${J} #8 removes a member: their allocation stops applying and their next request fails`, async ({ page, browser }) => {
  // Member two has the Team page open in their own browser.
  const theirs = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await openTeam(theirs, 'two');
  // Removal is the business's own: the owner removes member two on the business account's Team panel.
  await signInAs(page, 'owner', '/bank/business');
  const card = await businessTeam(page);
  await card
    .getByRole('group', { name: `Actions for @${person('two').handle}` })
    .getByRole('button', { name: 'Remove' })
    .click();
  await confirmDialog(page, 'Remove from team');
  await businessTeam(page);
  // The list is drawn (member one is still on it) and member two is not.
  await expect(card.getByText(`@${person('one').handle}`, { exact: true })).toBeVisible();
  await expect(card.getByText(`@${person('two').handle}`, { exact: true })).toHaveCount(0);
  await page.goto('/agents/team');
  await expect(members(page)).toBeVisible();
  await expect(
    members(page)
      .getByRole('row')
      .filter({ hasText: person('two').userId }),
  ).toHaveCount(0);
  await expect(
    tableIn(main(page), 'Limits by member')
      .getByRole('row')
      .filter({ hasText: person('two').userId }),
  ).toHaveCount(0);
  // Two's 0.01 no longer counts towards the pool: 1 + 2 + 0.011.
  await expect(main(page).getByTestId('pool-allocated')).toHaveText('3.011 USDT');
  // Member two's next request, from the page they still have open, is refused: they are no longer on the business.
  await runs(theirs).getByRole('button', { name: 'Open a team run' }).click();
  await expect(runs(theirs).getByRole('alert').locator('code')).toHaveText('agents.team_not_member');
  await expect(runs(theirs).getByTestId('run-session')).toHaveCount(0);
  await theirs.context().close();
});
