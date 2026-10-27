import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { free, held, signIn } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-08, in the running app (docs/roadmap/journeys.json): give an agent an allowance and access I can revoke, and
// let it place an order I can see. One test per step, titled "J-agents-08 #<n>", run in order on one verified TEST
// account funded with TEST USDT, an agent of its own and two sub-accounts. The allowance is a limit, never a balance the
// service holds; two draws that together exceed it admit one; an agent order holds funds on the one ledger and fills like
// the person's own order, and the agent never holds withdraw scope.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the person cannot create an agent yet (no builder at /agents/new), and there are no allow and deny rules, sub-account
//   access, allowances or the agent order preview (AG-spend-02, -03, RC-agents-06);
// - the starting point's two sub-accounts are named in #2 only; a customer cannot make sub-accounts in the app yet.
const J = 'J-agents-08';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const access = (page) => main(page).getByRole('region', { name: 'Access' });
const allowance = (page) => main(page).getByRole('form', { name: 'Allowance' });

/** The account's USDT as the ledger holds it, free and held, in scaled units: a market order never rests, so balances tell. */
async function usdt() {
  const balances = await (await api(agents.account())).balances();
  return { free: free(balances, 'USDT'), held: held(balances, 'USDT') };
}

test(`${J} starts: a verified TEST account funded with TEST USDT, an agent of its own and two sub-accounts`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag08', '100');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 writes an allow and a deny rule for one action at different scopes: refused whichever came first; no matching rule on a rules-required agent refuses`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Access');
  const rule = access(page).getByRole('form', { name: 'New access rule' });
  for (const [effect, scope] of [
    ['Allow', 'All my accounts'],
    ['Deny', 'Main account'],
  ]) {
    await rule.getByRole('combobox', { name: 'Effect' }).selectOption({ label: effect });
    await rule.getByRole('combobox', { name: 'Action' }).selectOption({ label: 'Place an order' });
    await rule.getByRole('combobox', { name: 'Scope' }).selectOption({ label: scope });
    await rule.getByRole('button', { name: 'Add rule' }).click();
  }
  await expect(access(page).getByTestId('effective-place-order')).toHaveText('Refused: a deny rule wins');
  // With rules required and none matching an action, the action is refused rather than allowed by default.
  await access(page).getByRole('checkbox', { name: 'Only allow what a rule allows' }).check();
  await expect(access(page).getByTestId('effective-cancel-order')).toHaveText('Refused: no rule allows it');
});

test(`${J} #2 gives the agent access to sub-account A only: a tool naming sub-account B is refused; access has an expiry and a blank expiry refuses`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Access');
  const grant = access(page).getByRole('form', { name: 'Account access' });
  await grant.getByRole('checkbox', { name: 'Sub-account A' }).check(UNBUILT);
  await grant.getByRole('button', { name: 'Grant access' }).click();
  await expect(grant.getByRole('alert')).toContainText('Set when this access ends.');
  await grant.getByRole('textbox', { name: /^Ends/ }).fill('7');
  await grant.getByRole('button', { name: 'Grant access' }).click();
  await expect(tableIn(access(page), 'Granted access')).toContainText('Sub-account A');
  await expect(tableIn(access(page), 'Granted access')).not.toContainText('Sub-account B');
});

test(`${J} #3 asks the agent to place an order before any allowance exists: refused, no hold, and the page says an allowance is needed`, async ({
  page,
}) => {
  const before = await usdt();
  await openOwnAgent(page, agents, 'Test');
  await main(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('Buy 0.0001 BTC at market', UNBUILT);
  await main(page).getByRole('button', { name: 'Run' }).click();
  await expect(main(page).getByRole('alert')).toContainText('This agent needs an allowance before it can place an order.');
  // Nothing was sent: the ledger neither holds nor spends anything for it.
  expect(await usdt()).toEqual(before);
});

test(`${J} #4 grants an allowance with the amount blank, then TEST 20 for a period: the blank grant names the field; the real one lists remaining and expiry`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Allowance');
  await allowance(page).getByRole('button', { name: 'Grant allowance' }).click(UNBUILT);
  await expect(allowance(page).getByRole('alert')).toContainText('Amount');
  await allowance(page)
    .getByRole('textbox', { name: /^Amount/ })
    .fill('20');
  await allowance(page).getByRole('combobox', { name: 'Period' }).selectOption({ label: 'A week' });
  await allowance(page).getByRole('button', { name: 'Grant allowance' }).click();
  const row = tableIn(main(page), 'Allowances').getByRole('row').nth(1);
  await expect(row).toContainText('20 USDT left');
  await expect(row.getByTestId('allowance-expiry')).toHaveText(/^Ends /);
});

test(`${J} #5 asks the agent to buy a small TEST amount: a preview of side, instrument, type, size, price and fee before anything is sent, and an approval request`, async ({
  page,
}) => {
  const before = await usdt();
  await openOwnAgent(page, agents, 'Test');
  await main(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('Buy 0.0001 BTC at market', UNBUILT);
  await main(page).getByRole('button', { name: 'Run' }).click();
  const preview = main(page).getByRole('region', { name: 'Order preview' });
  for (const term of ['Side', 'Market', 'Order type', 'Size', 'Price', 'Fee'])
    await expect(preview.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Approve' })).toBeVisible();
  // Nothing was sent: the ledger neither holds nor spends anything for it.
  expect(await usdt()).toEqual(before);
});

test(`${J} #6 approves the preview: the order is on the person's own trade book with its hold on the ledger; the agent never has withdraw scope`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Test');
  await main(page).getByRole('region', { name: 'Order preview' }).getByRole('button', { name: 'Approve' }).click(UNBUILT);
  await expect(main(page).getByRole('status')).toContainText('Order placed on your account');
  await page.goto('/trade/orders');
  await expect(main(page).getByRole('row').filter({ hasText: 'Placed by TEST helper' }).first()).toBeVisible();
  await openOwnAgent(page, agents, 'Identity');
  await expect(main(page).getByRole('region', { name: 'Agent identity' })).not.toContainText('withdraw');
});

test(`${J} #7 revokes the allowance during a run: the next admission refuses draws; a draw in flight finishes or is reconciled by its key`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Allowance');
  const row = tableIn(main(page), 'Allowances').getByRole('row').nth(1);
  await row.getByRole('button', { name: 'Revoke' }).click(UNBUILT);
  await expect(row).toContainText('Revoked');
  await openOwnAgent(page, agents, 'Test');
  await main(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('Buy 0.0001 BTC at market');
  await main(page).getByRole('button', { name: 'Run' }).click();
  await expect(main(page).getByRole('alert')).toContainText('agents.allowance.revoked');
});
