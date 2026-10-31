import { test, expect } from './journey.mjs';
import { UNBUILT, oneAmount } from './dex.mjs';
import { desk, founderPair, openDesk, twoFounder } from './protocol-desk.mjs';
import { tool } from './stack.mjs';
import { bodyRows } from './tables.mjs';

// J-dex-protocol-32, in the running app (docs/roadmap/journeys.json): account for protocol revenue, rebates and the IFC
// buyback. One test per step, titled "J-dex-protocol-32 #<n>", run in order on the founder console as the stack's two
// LOCAL TEST founders (admin.mjs). Fees and rebates post through the existing recipes once under business keys such as
// `rebate:<accountId>:<period>`; pools carry no third share. owner.decision for every unpublished rate;
// vendor.accounting while no accounting export is connected.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the console has no Protocol finance desk (/protocol-ops, Sections "Protocol finance"): no fee schedule versions
//   (D-fees-governance-01), maker rebate programme (D-fees-governance-02), integrator accounts and builder codes
//   (D-fees-governance-03), protocol fee policy or distribution list (D-fees-governance-04), revenue page
//   (D-developer-compliance-02), listing fee revenue (D-launch-listing-03), buyback runs (RC-dex-protocol-13) or stake
//   plans and access ladder (RC-dex-protocol-20);
// - #2's crash between the post and the status update needs a stack fault switch (`local-test-gates.mjs fault
//   rebate-after-post`, proposed); #6 and #8 read TEST pools and buyback runs the stack will seed when the desk is built.
const J = 'J-dex-protocol-32';
const founders = founderPair();

test.describe.configure({ mode: 'default' });

/** Opens one tab of the Protocol finance desk. */
async function finance(page, tab) {
  await openDesk(page, '/protocol-ops', 'Protocol operations');
  await desk(page).getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Protocol finance' }).click(UNBUILT);
  await desk(page).getByRole('tab', { name: tab }).click();
  const panel = desk(page).getByRole('tabpanel', { name: tab });
  await expect(panel).toBeVisible();
  return panel;
}

const rows = (panel, table) => bodyRows(panel.getByRole('table', { name: table }));

test(`${J} starts: a finance operator signed in to the ops console`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { a } = await founders(browser);
  await openDesk(a, '/protocol-ops', 'Protocol operations');
});

test(`${J} #1 publishes a fee schedule: a new version with an effective time; the blank schedule keeps refusing until published`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const fees = await finance(a, 'Fee schedule');
  await expect(fees.getByRole('status')).toContainText('fee schedule not set');
  const before = await rows(fees, 'Versions').count();
  await fees.getByRole('button', { name: 'Publish a new version' }).click();
  await fees.getByLabel('Effective from').fill('2030-01-01T00:00');
  await fees.getByLabel(/^Type PUBLISH FEES/).fill('PUBLISH FEES');
  // One founder's request publishes nothing: the schedule still refuses until the second approves.
  await fees.getByRole('button', { name: 'Ask a second founder to approve this' }).click();
  await expect(fees.getByTestId('packet-made')).toBeVisible();
  await expect(rows(fees, 'Versions')).toHaveCount(before);
  await expect(fees.getByRole('status')).toContainText('fee schedule not set');
  await twoFounder({
    formA: fees,
    formB: await finance(b, 'Fee schedule'),
    ask: null,
    phrase: 'PUBLISH FEES',
    summary: 'Publish fee schedule',
  });
  await expect(rows(fees, 'Versions')).toHaveCount(before + 1);
  await expect(rows(fees, 'Versions').last()).toContainText('Effective from 1 Jan 2030, 00:00 UTC');
});

test(`${J} #2 publishes a maker rebate programme: a payout equals tier rate × the period's maker volume, posted once; a crash between post and status does not repost`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const rebates = await finance(a, 'Maker rebates');
  const payouts = rows(rebates, 'Payouts');
  await expect(payouts).not.toHaveCount(0);
  for (const row of await payouts.all()) {
    const rate = oneAmount(await row.getByTestId('rebate-rate').innerText());
    const volume = oneAmount(await row.getByTestId('maker-volume').innerText());
    // The rate is shown in percent.
    expect(oneAmount(await row.getByTestId('payout').innerText())).toBe((rate * volume) / (100n * 10n ** 18n));
    await expect(row.getByTestId('business-key')).toHaveText(/^rebate:[\w-]+:\d{4}-\d{2}$/);
  }
  // The run crashes once between posting a payout and marking it paid; the rerun finds the posting by its business key.
  tool('local-test-gates.mjs', 'fault', 'rebate-after-post', 'once');
  try {
    await rebates.getByRole('button', { name: 'Run this period' }).click();
    await expect(rebates.getByRole('status')).toContainText('Run stopped after posting', { timeout: 30_000 });
  } finally {
    tool('local-test-gates.mjs', 'fault', 'rebate-after-post', 'off');
  }
  await rebates.getByRole('button', { name: 'Run this period' }).click();
  await expect(rebates.getByRole('status')).toContainText('Run finished', { timeout: 30_000 });
  const keys = await payouts.getByTestId('business-key').allInnerTexts();
  expect(new Set(keys).size, 'one payout per account and period').toBe(keys.length);
});

test(`${J} #3 opens integrator accounts and builder codes: the accounts with their fee earnings and codes; a customer referral code is separate`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const integrators = await finance(a, 'Integrators');
  const table = integrators.getByRole('table', { name: 'Integrator accounts' });
  for (const header of ['Account', 'Builder code', 'Fee earnings'])
    await expect(table.getByRole('columnheader', { name: header })).toBeVisible();
  await expect(integrators.getByRole('note')).toContainText('Customer referral codes are separate');
});

test(`${J} #4 reads the protocol fee on pools with the policy blank: "Fee policy not set" and no collection`, async ({ browser }) => {
  const { a } = await founders(browser);
  const protocolFee = await finance(a, 'Protocol fee');
  await expect(protocolFee.getByRole('status')).toContainText('Fee policy not set · owner.decision');
  await expect(protocolFee.getByRole('button', { name: 'Collect' })).toHaveCount(0);
});

test(`${J} #5 reads a distribution list: every row has source, amount and recipient and the insider check runs; a blank list shows its refusal`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const distribution = await finance(a, 'Distribution');
  // The list is blank on the stack.
  await expect(distribution.getByRole('status')).toContainText('Distribution list not set · owner.decision');
  for (const header of ['Source', 'Amount', 'Recipient', 'Insider check'])
    await expect(distribution.getByRole('table', { name: 'Distribution list' }).getByRole('columnheader', { name: header })).toBeVisible();
});

test(`${J} #6 opens the revenue page: it equals the fee fields read from the pool`, async ({ browser }) => {
  const { a } = await founders(browser);
  const revenue = await finance(a, 'Revenue');
  const pools = rows(revenue, 'Revenue by pool');
  await expect(pools).not.toHaveCount(0);
  for (const pool of await pools.all())
    expect(oneAmount(await pool.getByTestId('revenue').innerText())).toBe(oneAmount(await pool.getByTestId('pool-fee-field').innerText()));
});

test(`${J} #7 reads listing fee revenue: express fees charged once per request, a failed review refunded`, async ({ browser }) => {
  const { a } = await founders(browser);
  const listing = await finance(a, 'Listing fees');
  const charges = rows(listing, 'Express listing fees');
  const requests = await charges.getByTestId('request-id').allInnerTexts();
  expect(new Set(requests).size, 'one charge per request').toBe(requests.length);
  for (const failed of await charges.filter({ hasText: 'Review failed' }).all()) await expect(failed).toContainText('Refunded');
});

test(`${J} #8 opens the buyback runs: two stored runs where burned plus rewards equals tokens bought; "job not set" or "empty book" as real readings`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const buyback = await finance(a, 'Buyback');
  const runs = rows(buyback, 'Buyback runs');
  await expect(runs).not.toHaveCount(0);
  let stored = 0;
  for (const run of await runs.all()) {
    if (await run.getByTestId('bought').count()) {
      stored += 1;
      const bought = oneAmount(await run.getByTestId('bought').innerText());
      expect(oneAmount(await run.getByTestId('burned').innerText()) + oneAmount(await run.getByTestId('rewards').innerText())).toBe(bought);
    } else await expect(run).toContainText(/Job not set|Empty book/);
  }
  expect(stored, 'two stored runs').toBe(2);
});

test(`${J} #9 publishes staking plans and the access ladder: an existing stake keeps its old multiplier; a blank ladder shows "tier not set"`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const staking = await finance(a, 'Staking plans');
  await expect(staking.getByRole('region', { name: 'Access ladder' })).toContainText('tier not set');
  const existing = rows(staking, 'Existing stakes').filter({ hasText: 'TEST stake' });
  const before = await existing.getByTestId('multiplier').innerText();
  const plans = await rows(staking, 'Plans').count();
  await staking.getByRole('button', { name: 'Publish a new plan' }).click();
  await staking.getByLabel(/^Lock \(days\)/).fill('90');
  await staking.getByLabel(/^Multiplier/).fill('1.5');
  await staking.getByLabel(/^Type PUBLISH PLAN/).fill('PUBLISH PLAN');
  await twoFounder({
    formA: staking,
    formB: await finance(b, 'Staking plans'),
    ask: 'Ask a second founder to approve this',
    phrase: 'PUBLISH PLAN',
    summary: 'Publish stake plan',
  });
  await expect(rows(staking, 'Plans')).toHaveCount(plans + 1);
  await expect(existing.getByTestId('multiplier')).toHaveText(before);
});
