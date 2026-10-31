import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openFounderDesk, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { signOutBrowser } from './stack.mjs';

// J-agents-14, in the founder console (docs/roadmap/journeys.json): see and quarantine every agent on the platform. One
// test per step, titled "J-agents-14 #<n>", run in order. The operators are the stack's two LOCAL TEST founders on
// /more-ops/agents; the agent quarantined is a TEST customer's own agent that the start makes, so no shared agent of
// the stack is touched. #5 kills a whole kind and restores it (two founders) in the same step, in a finally, for the same
// reason. #5's "a restart does not re-enable it" is a service restart, which a browser cannot make: the step reads the
// kill again from a fresh console load.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /more-ops/agents answers "This operator route does not exist": there is no fleet registry, export, quarantine,
//   kind kill or reassign (AG-registry-01, AG-control-02); /more-ops shows only the agents task routes and prices;
// - the customer cannot create an agent yet (no builder at /agents/new), so the start has no agent to quarantine.
const J = 'J-agents-14';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const fleet = (page) => tableIn(page.getByRole('main'), 'Agents on the platform');
const ownRow = (page) => fleet(page).getByRole('row').filter({ hasText: OWN_AGENT }).filter({ hasText: agents.account().handle });
const openFleet = (page, key) => openFounderDesk(page, '/more-ops/agents', 'Agent fleet', key);

test(`${J} starts: a TEST customer with an agent of its own, and the founder console`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag14', '10');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 opens the registry: total, ownerless and unmanaged counts and a row per agent with owner, publisher, channels and risk signals`, async ({
  page,
}) => {
  await openFleet(page);
  for (const count of ['fleet-total', 'fleet-ownerless', 'fleet-unmanaged']) await expect(page.getByTestId(count)).toHaveText(/^\d+$/);
  for (const column of ['Agent', 'Owner', 'Publisher', 'Channels', 'Risk signals'])
    await expect(fleet(page).getByRole('columnheader', { name: column })).toBeVisible();
  // A field with no stored value reads "not set", never a blank or an invented value.
  await expect(fleet(page).getByRole('cell')).not.toHaveCount(0);
  await expect(fleet(page).getByRole('cell').filter({ hasNotText: /\S/ })).toHaveCount(0);
});

test(`${J} #2 filters by risk signal and exports: a CSV of the filtered rows over the full range and one audit row`, async ({ page }) => {
  await openFleet(page);
  await page.getByRole('combobox', { name: 'Risk signal' }).selectOption({ index: 1 }, UNBUILT);
  const shown = Number(await page.getByTestId('fleet-filtered').innerText());
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export CSV/ }).click();
  expect(
    readFileSync(await (await download).path(), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(shown + 1);
  await expect(page.getByRole('status')).toContainText('Export recorded in the audit log');
});

test(`${J} #3 quarantines one agent with a reason: new sessions refuse as disabled, a running run stops at its next boundary, an audit row names the operator`, async ({
  browser,
  page,
}) => {
  // The customer, in a browser of their own, has a background run of the agent going before the quarantine.
  const customer = await browser.newContext();
  try {
    const own = await customer.newPage();
    await openOwnAgent(own, agents, 'Test');
    const panel = own.getByRole('main').getByRole('region', { name: 'Test' });
    await panel.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: check every market one by one', UNBUILT);
    await panel.getByRole('checkbox', { name: 'Run in the background' }).check();
    await panel.getByRole('button', { name: 'Run a test' }).click();

    const founder = await openFleet(page);
    await ownRow(page).getByRole('button', { name: 'Quarantine' }).click(UNBUILT);
    const sheet = page.getByRole('dialog', { name: 'Quarantine agent' });
    await sheet.getByRole('textbox', { name: /^Reason/ }).fill('LOCAL TEST quarantine');
    await sheet.getByRole('button', { name: 'Quarantine' }).click();
    await expect(ownRow(page)).toContainText('Quarantined');
    await expect(ownRow(page).getByTestId('audit-operator')).toHaveText(founder.handle);

    // The run in flight stops at its next step, and a new session of the agent is refused as disabled.
    await openOwnAgent(own, agents, 'Runs');
    await expect(tableIn(own.getByRole('main'), 'Live runs').getByRole('row').nth(1)).toContainText('Stopped: agent quarantined');
    await own.getByRole('main').getByRole('button', { name: 'Open a session' }).click({ force: true });
    await expect(own.getByRole('main').getByRole('alert')).toContainText('agents.agent.disabled');
  } finally {
    await customer.close();
  }
});

test(`${J} #4 restores it as one founder: refused until two distinct founders restore it`, async ({ browser, page }) => {
  await openFleet(page, 'a');
  await ownRow(page).getByRole('button', { name: 'Restore' }).click(UNBUILT);
  await expect(ownRow(page)).toContainText('Restore waiting for a second founder');
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    await openFleet(b, 'b');
    await tableIn(b.getByRole('main'), 'Agents on the platform')
      .getByRole('row')
      .filter({ hasText: OWN_AGENT })
      .filter({ hasText: agents.account().handle })
      .getByRole('button', { name: 'Confirm restore' })
      .click();
  } finally {
    await other.close();
  }
  await page.reload();
  await expect(ownRow(page)).toContainText('Active');
});

test(`${J} #5 kills a whole kind: every agent of the kind disabled in one audited action; a restart does not re-enable it`, async ({
  browser,
  page,
}) => {
  await openFleet(page, 'a');
  await page.getByRole('button', { name: 'Kill a kind' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Kill a kind' });
  await sheet.getByRole('combobox', { name: 'Kind' }).selectOption({ label: 'Customer-built' });
  await sheet.getByRole('textbox', { name: /^Reason/ }).fill('LOCAL TEST kind kill');
  try {
    await sheet.getByRole('button', { name: 'Kill every agent of this kind' }).click();
    await expect(ownRow(page)).toContainText('Disabled by kind');
    await expect(page.getByRole('status')).toContainText('1 audited action');
    await page.reload();
    await expect(ownRow(page)).toContainText('Disabled by kind');
  } finally {
    // Put the kind back with both founders, so the stack's other journeys meet it as before.
    await page.getByRole('button', { name: 'Restore a kind' }).click();
    const other = await browser.newContext();
    try {
      const b = await other.newPage();
      await openFleet(b, 'b');
      await b.getByRole('button', { name: 'Confirm restore of Customer-built' }).click();
    } finally {
      await other.close();
    }
  }
  await page.reload();
  await expect(ownRow(page)).not.toContainText('Disabled by kind');
});

test(`${J} #6 reassigns an ownerless agent: the owner column and counts update`, async ({ page }) => {
  await openFleet(page);
  const before = Number(await page.getByTestId('fleet-ownerless').innerText());
  const ownerless = fleet(page).getByRole('row').filter({ hasText: 'No owner' }).first();
  await ownerless.getByRole('button', { name: 'Reassign' }).click(UNBUILT);
  await page
    .getByRole('dialog', { name: 'Reassign agent' })
    .getByRole('textbox', { name: /^New owner/ })
    .fill(agents.account().handle);
  await page.getByRole('dialog', { name: 'Reassign agent' }).getByRole('button', { name: 'Reassign' }).click();
  await expect(page.getByTestId('fleet-ownerless')).toHaveText(String(before - 1));
});

test(`${J} #7 checks as the customer: the quarantined agent shows its disabled status and the open button off`, async ({ page }) => {
  // #4 restored it, so it is quarantined again first; the customer then sees it as a customer does.
  await openFleet(page);
  await ownRow(page).getByRole('button', { name: 'Quarantine' }).click(UNBUILT);
  await page
    .getByRole('dialog', { name: 'Quarantine agent' })
    .getByRole('textbox', { name: /^Reason/ })
    .fill('LOCAL TEST quarantine');
  await page.getByRole('dialog', { name: 'Quarantine agent' }).getByRole('button', { name: 'Quarantine' }).click();
  await expect(ownRow(page)).toContainText('Quarantined');
  await signOutBrowser(page.context());
  await openOwnAgent(page, agents);
  await expect(page.getByRole('main').getByTestId('agent-status')).toHaveText('Disabled', UNBUILT);
  await expect(page.getByRole('main').getByRole('button', { name: 'Open a session' })).toBeDisabled();
});
