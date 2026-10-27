import path from 'node:path';
import { test, expect } from '@playwright/test';
import { UNBUILT, agentCard, agentsRun, tableIn } from './agents.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, signInWithCode, verifiedBusiness } from './merchant.mjs';
import { ROOT, toUnits } from './stack.mjs';

// J-agents-11, in the running app (docs/roadmap/journeys.json): run agents for my team: roles, a shared pool and
// per-project limits. One test per step, titled "J-agents-11 #<n>", run in order. The start is real: a TEST business
// owner with a verified business (the stack's founder pair approves it) and two TEST members who accepted the owner's
// invitations on the business's Team page. The pool total never exceeds its limit; a removed member's allocation stops
// at the next admission. Limit alerts by email or push show their vendor notice.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - there is no agents Team page, roles, business pool, allocations, project limits or usage by member
//   (AG-governance-01, AG-usage-02, -03, -04);
// - #5 needs a member's metered run, and opening a session is refused for a standard account ("agents:execute").
const J = 'J-agents-11';
const agents = agentsRun(J);
const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const members = (page) => tableIn(main(page), 'Members');
const ROLES = ['Creator', 'Runner', 'Approver', 'Log reader', 'Spend reader'];

/** A person kept in the run file (its authenticator secret is a TEST one), with its code generator put back. */
function person(key) {
  const who = agents.run.read()[key];
  if (!who) throw new Error(`${J} made no ${key}, so this step has no one to act as`);
  return { ...who, totp };
}

/** Signs `key` in with its authenticator's next code, landing on `destination`, and keeps the code step it used, so no
 * later step replays a code. */
async function signInAs(page, key, destination) {
  const who = person(key);
  await signInWithCode(page, who, destination);
  agents.run.write({ [key]: keep(who) });
}

/** Signs `key` in with its code and opens the agents Team page. */
async function openTeam(page, key = 'owner') {
  // Signed in on /agents, a route that exists today, then the Team page, so an unbuilt page fails at its heading.
  await signInAs(page, key, '/agents');
  await page.goto('/agents/team');
  await expect(main(page).getByRole('heading', { name: 'Team', level: 1 })).toBeVisible(UNBUILT);
}

/** The owner invites `member` to the business by account ID; the member accepts on its own Team page. */
async function invite(page, owner, member) {
  await signInWithCode(page, owner, '/pay/team');
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(member.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Finance' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  // The review dialog's confirm carries the action's own name.
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  await forgetSession(page);
  await signInWithCode(page, member, '/pay/team');
  const accept = page.getByRole('listitem').filter({ hasText: 'Finance' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept' }).click();
  await expect(accept).toHaveCount(0);
  await forgetSession(page);
}

const keep = ({ email, password, handle, userId, secret, step }) => ({ email, password, handle, userId, secret, step });

test(`${J} starts: a TEST business owner with a verified business and two members on its team`, async ({ page }) => {
  test.setTimeout(480_000);
  const one = await businessReadyPerson(page, 'ag11a', '/pay/merchant');
  await forgetSession(page);
  const two = await businessReadyPerson(page, 'ag11b', '/pay/merchant');
  await forgetSession(page);
  const owner = await businessReadyPerson(page, 'ag11o', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Agents Team Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await invite(page, owner, one);
  await invite(page, owner, two);
  // Kept after the invitations, with the code step each sign-in reached.
  agents.run.reset({ owner: keep(owner), one: keep(one), two: keep(two) });
});

test(`${J} #1 opens Team and grants the five roles: the roles listed per member; granting to a non-member is refused`, async ({ page }) => {
  await openTeam(page);
  const one = members(page)
    .getByRole('row')
    .filter({ hasText: person('one').handle });
  for (const role of ROLES) await one.getByRole('checkbox', { name: role }).check();
  await one.getByRole('button', { name: 'Save roles' }).click();
  for (const role of ROLES) await expect(one.getByRole('checkbox', { name: role })).toBeChecked();
  await main(page)
    .getByRole('textbox', { name: /^Grant to/ })
    .fill('ag11-not-a-member');
  await main(page).getByRole('button', { name: 'Grant' }).click();
  await expect(main(page).getByRole('alert')).toContainText('agents.team.not_a_member');
});

test(`${J} #2 gives a member allow runner and deny runner: the effective result is deny`, async ({ page }) => {
  await openTeam(page);
  const two = members(page)
    .getByRole('row')
    .filter({ hasText: person('two').handle });
  await two.getByRole('combobox', { name: 'Runner' }).selectOption({ label: 'Allow' }, UNBUILT);
  await two.getByRole('combobox', { name: 'Runner (business-wide)' }).selectOption({ label: 'Deny' });
  await two.getByRole('button', { name: 'Save roles' }).click();
  await expect(two.getByTestId('effective-runner')).toHaveText('Denied');
});

test(`${J} #3 a creator who also holds approver approves their own agent's action: the four-eyes rule refuses`, async ({ page }) => {
  await signInAs(page, 'one', '/agents');
  await page.goto('/agents/approvals');
  const own = tableIn(main(page), 'Approvals').getByRole('row').filter({ hasText: 'Your agent' }).first();
  await own.getByRole('button', { name: 'Approve' }).click(UNBUILT);
  await expect(main(page).getByRole('alert')).toContainText('agents.approval.four_eyes');
});

test(`${J} #4 creates a business pool and per-member allocations, one left blank: the blank allocation refused by name; the pool shows its limit`, async ({
  page,
}) => {
  await openTeam(page);
  const pool = main(page).getByRole('form', { name: 'Business pool' });
  await pool.getByRole('textbox', { name: /^Pool limit/ }).fill('5', UNBUILT);
  await pool.getByRole('textbox', { name: new RegExp(`^Allocation for ${person('one').handle}`) }).fill('2');
  await pool.getByRole('button', { name: 'Save pool' }).click();
  await expect(pool.getByRole('alert')).toContainText(`Allocation for ${person('two').handle}`);
  // Member two's allocation is a TEST hundredth, so one metered run in #5 spends past it.
  await pool.getByRole('textbox', { name: new RegExp(`^Allocation for ${person('two').handle}`) }).fill('0.01');
  await pool.getByRole('button', { name: 'Save pool' }).click();
  await expect(main(page).getByTestId('pool-limit')).toHaveText('5 USDT');
});

test(`${J} #5 a member spends past their allocation: the next run refuses and the pool total stays within its limit`, async ({ page }) => {
  await signInAs(page, 'two', '/agents');
  await expect(main(page).getByTestId('allocation-left')).toHaveText('0.01 USDT left', UNBUILT);
  // One metered Navigator run spends the hundredth; the run after it is refused.
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  for (const attempt of [1, 2]) {
    await agentCard(page, 'Navigator').getByRole('button', { name: 'Open a session' }).click();
    await main(page).getByRole('button', { name: 'Review session' }).click();
    await page.getByRole('dialog', { name: 'Review agent session' }).getByRole('button', { name: 'Open agent session' }).click();
    if (attempt === 2) break;
    await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: list the markets');
    await workspace.getByRole('button', { name: 'Run' }).click();
    await workspace.getByRole('button', { name: 'Close session' }).click();
    await page.goto('/agents');
  }
  await expect(main(page).getByRole('alert')).toContainText('agents.pool.allocation_spent');
  await openTeam(page);
  const used = toUnits((await main(page).getByTestId('pool-used').innerText()).replace(/[^\d.]/g, ''));
  expect(used <= toUnits('5')).toBe(true);
});

test(`${J} #6 sets a limit for one business project: members of that project are limited and others are not`, async ({ page }) => {
  await openTeam(page);
  const project = main(page).getByRole('form', { name: 'New project' });
  await project.getByRole('textbox', { name: /^Project name/ }).fill('TEST desk project', UNBUILT);
  await project.getByRole('checkbox', { name: person('one').handle }).check();
  await project.getByRole('textbox', { name: /^Project limit/ }).fill('1');
  await project.getByRole('button', { name: 'Create project' }).click();
  const limits = tableIn(main(page), 'Limits by member');
  await expect(limits.getByRole('row').filter({ hasText: person('one').handle })).toContainText('TEST desk project: 1 USDT');
  await expect(limits.getByRole('row').filter({ hasText: person('two').handle })).not.toContainText('TEST desk project');
});

test(`${J} #7 opens usage analytics by member and task: only members of the business, totals matching sealed windows`, async ({ page }) => {
  await openTeam(page);
  await main(page).getByRole('link', { name: 'Usage by member' }).click(UNBUILT);
  const usage = tableIn(main(page), 'Usage by member');
  const handles = await usage.getByRole('rowheader').allInnerTexts();
  expect(handles.sort()).toEqual([person('owner').handle, person('one').handle, person('two').handle].sort());
  await expect(main(page).getByTestId('usage-total')).toHaveText(await main(page).getByTestId('sealed-windows-total').innerText());
});

test(`${J} #8 removes a member: their allocation stops applying and their next request fails`, async ({ page }) => {
  await openTeam(page);
  await members(page)
    .getByRole('row')
    .filter({ hasText: person('two').handle })
    .getByRole('button', { name: 'Remove' })
    .click(UNBUILT);
  await expect(
    members(page)
      .getByRole('row')
      .filter({ hasText: person('two').handle }),
  ).toHaveCount(0);
  await forgetSession(page);
  await signInAs(page, 'two', '/agents');
  await page.goto('/agents/team');
  await expect(main(page).getByRole('alert')).toContainText('agents.team.not_a_member');
});
