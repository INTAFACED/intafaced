import { test, expect } from '@playwright/test';
import { api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-more-catalogue-20, in the running app (docs/roadmap/journeys.json): understand and use IFC: stake, real yield,
// supply and burns. One test per step, titled "J-more-catalogue-20 #<n>", run in order. A TEST account holding TEST IFC
// opens the token rooms; each figure on screen is checked against the token service's own read, so no number is
// invented and a blank owner value must read "not set". Steps whose slice is not built fail by name, cheaply:
// - #1 has no slice: the room does not stake, because the staking asset is not published to the app.
// - RC-more-catalogue-09 (#5): no supply and distribution read.
// - RC-more-catalogue-04 (#6): no founding badge claim door.
// - RC-more-catalogue-08 (#7): no IFC gas charge on any internal action.
const J = 'J-more-catalogue-20';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;

test.describe.configure({ mode: 'default' });

/** A step whose slice is not built: fails at once, naming the slice and what is missing. */
function notBuilt(slice, missing) {
  return async () => {
    test.setTimeout(5_000);
    throw new Error(`${slice} is not built: ${missing}`);
  };
}

/** The holder from the start step, signed in on `page`, with a client for the token service's reads. */
async function holder(page) {
  const { who } = run.read();
  if (!who) throw new Error(`${J} starts did not leave a signed-up holder`);
  await signIn(page, who);
  return { who, client: await api(who) };
}

/** A token service read as the holder, or the step fails with its answer. */
async function read(client, procedure, input) {
  const res = await client.get(`/api/token/trpc/${procedure}${input ? trpcInput(input) : ''}`);
  const data = res.body?.result?.data;
  if (res.status !== 200 || data === undefined)
    throw new Error(`${procedure} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return data;
}

/** A decimal string as the app shows it: grouped thousands, the fraction as stored. */
const shown = (value) => {
  const [whole, fraction] = value.split('.');
  return `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
};

test(`${J} starts: signed in, holding TEST IFC`, async ({ page }) => {
  test.setTimeout(120_000);
  run.reset({});
  const who = await signUp(page, 'j20');
  await verify(page, who);
  expect(fund(who.email, 'IFC', '100').tx).toBeTruthy();
  run.write({ who });
  const { client } = await holder(page);
  const balances = await client.balances();
  expect(balances.IFC?.free, 'the TEST IFC the holder was funded with').toBe('100');
});

test(
  `${J} #1 Stakes IFC, then unstakes part: the stake pending then active; unstake closes after the ledger post`,
  notBuilt('NO-SLICE', 'the token room does not stake or unstake, because the staking asset is not published to the app'),
);

test(`${J} #2 Opens the yield view: the weekly real-yield share per window`, async ({ page }) => {
  test.setTimeout(60_000);
  const { client } = await holder(page);
  const served = await read(client, 'yieldHistory', { limit: 50 });
  await page.goto('/token/economy');
  const panel = page.getByRole('region', { name: 'Your real yield', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Each week the token service pays stakers a share of house fees')).toBeVisible();
  const rows = panel.getByRole('region', { name: 'Payouts by window' }).locator('tbody tr');
  await expect(rows).toHaveCount(served.items.length);
  if (served.items.length === 0) await expect(panel.getByText('No real-yield payout has been made to this account.')).toBeVisible();
  for (const [i, item] of served.items.entries()) {
    await expect(rows.nth(i)).toContainText(item.windowId);
    await expect(rows.nth(i)).toContainText(item.amount === null ? 'posting not readable' : shown(item.amount));
  }
});

test(`${J} #3 Opens the buyback and burn log: each run with its schedule and split`, async ({ page }) => {
  test.setTimeout(60_000);
  const { client } = await holder(page);
  const served = await read(client, 'buybackRuns', { limit: 50 });
  await page.goto('/token/burn');
  await expect(page.getByRole('heading', { name: 'Buyback runs' })).toBeVisible();
  const table = page.getByRole('region', { name: 'Buyback runs', exact: true });
  for (const header of ['Recorded', 'Revenue window', 'Bought', 'Burned', 'Sent to rewards'])
    await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(Math.min(served.runs.length, 50));
  if (served.runs.length === 0) await expect(page.getByText('No buyback run has settled.')).toBeVisible();
  await expect(page.getByTestId('buyback-job')).toHaveText(served.job === 'set' ? /^Job set/ : /^Job not set/);
  await expect(page.getByTestId('buyback-estimate')).toHaveText(
    served.rate ? new RegExp(`^Buyback rate: ${served.rate.buybackBps.toLocaleString('en-US')} basis points`) : /^No estimate/,
  );
});

test(`${J} #4 Opens the emission schedule: epochs, halvings and the minter rule; blank values read "not set"`, async ({ page }) => {
  test.setTimeout(60_000);
  const { client } = await holder(page);
  const served = await read(client, 'emissionSchedule', { count: 12 });
  const treasury = await read(client, 'treasury');
  await page.goto('/token/economy');
  const panel = page.getByRole('region', { name: 'Emission schedule', exact: true });
  await expect(panel).toBeVisible();
  const params = panel.getByTestId('emission-params');
  if (served.params === null) {
    expect(served.reason).toMatch(/^token\.params_/);
    const blank = served.reason === 'token.params_invalid' ? 'cannot be read' : 'not set';
    for (const label of ['Reward in the first epoch', 'Halving', 'Supply cap']) await expect(params).toContainText(`${label}${blank}`);
    expect(await params.innerText(), 'no figure for a blank schedule').not.toMatch(/\d/);
    await expect(panel.getByTestId('emission-blank')).toBeVisible();
    await expect(panel.getByText('No upcoming epoch reward can be shown.')).toBeVisible();
  } else {
    await expect(params).toContainText(shown(served.params.initialEpochReward));
    await expect(params).toContainText(`Every ${served.params.halvingIntervalEpochs.toLocaleString('en-US')} epochs`);
    await expect(params).toContainText(shown(served.params.maxSupply));
    const rows = panel.getByRole('region', { name: 'Next epochs' }).locator('tbody tr');
    await expect(rows).toHaveCount(served.epochs.length);
    for (const [i, epoch] of served.epochs.entries()) await expect(rows.nth(i)).toContainText(`${epoch.epoch}${shown(epoch.reward)}`);
  }
  await expect(panel.getByTestId('emission-minted')).toHaveText(
    treasury.minted === null ? 'Minted to date: no epoch mint has closed.' : `Minted to date: ${shown(treasury.minted)}.`,
  );
  await expect(panel.getByTestId('emission-minter')).toHaveText(/^Only the token service mints/);
});

test(
  `${J} #5 Opens the supply and distribution panel: supply and distribution from the service; missing figures "not reported"`,
  notBuilt('RC-more-catalogue-09', 'svc-token has no supply and distribution read, and the economy page has no such panel'),
);

test(
  `${J} #6 Claims the founding badge: the badge shown once`,
  notBuilt('RC-more-catalogue-04', 'svc-protocol has no badge eligibility read or claim door, and there is no /protocol/badges room'),
);

test(
  `${J} #7 Does an internal action that has a gas charge: the IFC gas fee charged once`,
  notBuilt('RC-more-catalogue-08', 'no internal action charges IFC gas, and svc-token holds no feeCharge grant'),
);
