import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { UNBUILT } from './dex.mjs';
import { desk, founderPair, openDesk, twoFounder } from './protocol-desk.mjs';
import { bodyRows } from './tables.mjs';

// J-dex-protocol-29, in the running app (docs/roadmap/journeys.json): run the protocol desk: metrics, labels, quoters,
// listings and pool control. One test per step, titled "J-dex-protocol-29 #<n>", run in order as the stack's two LOCAL
// TEST founders on the founder console (admin.mjs). The desk moves no money and never holds user funds; a priced express
// listing is charged to the requester once under its business key. chain.go for INTACHAIN execution; audit.external for
// mainnet; owner.decision for blank bounds.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /protocol-ops shows chain, audit, indexer and DEX status, the blockers per action and the two-founder pool and market
//   control (/protocol-ops/listing), but no metrics or label audit (D-order-controls-04 names both in its contract),
//   no contracts room (D-liquidity-03), no quoter registry or fade breaker (D-swap-intents-03, D-swap-08), no token
//   review queue or routing eligibility (D-launch-listing-03, -04), no INTACHAIN listing rooms (D-launch-listing-06), no
//   bridge recovery desk and no asset link review (D-bridge-chain-03, -04);
// - the stack runs no svc-indexer or svc-dex, so their reads say "Could not load", which #1 checks is never a zero.
const J = 'J-dex-protocol-29';
const founders = founderPair();
// A TEST pool address of this run, so a rerun never meets the last run's hide.
const POOL = `0x${Date.now().toString(16).padStart(40, '0')}`;

test.describe.configure({ mode: 'default' });

/** Opens one section of the protocol ops desk by its link in the desk's Sections list. */
async function section(page, name) {
  await openDesk(page, '/protocol-ops', 'Protocol operations');
  await desk(page).getByRole('navigation', { name: 'Sections' }).getByRole('link', { name }).click(UNBUILT);
  const region = desk(page).getByRole('region', { name }).first();
  await expect(region).toBeVisible();
  return region;
}

test(`${J} starts: a founder signed in to the ops console, opening Protocol ops`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { a } = await founders(browser);
  await openDesk(a, '/protocol-ops', 'Protocol operations');
  await expect(desk(a).getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

test(`${J} #1 opens the metrics: quote and refusal counts with the window and as-of time; a failing source reads "Could not load" with the time tried, never zero`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const metrics = await section(a, 'Metrics');
  for (const term of ['Quotes', 'Refusals', 'Window']) await expect(metrics.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(metrics.getByTestId('metrics-as-of')).toHaveText(/^As of \d{2}:\d{2}:\d{2} UTC/);
  // svc-dex does not run on the stack: its counts read "Could not load" with when they were tried, never a 0.
  await expect(metrics.getByTestId('metrics-quotes')).toHaveText(/^Could not load · tried \d{2}:\d{2}:\d{2} UTC$/);
});

test(`${J} #2 opens the label audit: chain-label strings and the audited flag from the service and both apps; PASS only when none says INTACHAIN mainnet or audited`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const audit = await section(a, 'Label audit');
  const sources = audit.getByRole('table', { name: 'Labels by source' });
  for (const source of ['svc-protocol', 'Customer app', 'Founder console'])
    await expect(bodyRows(sources).filter({ hasText: source })).toHaveCount(1);
  for (const row of await bodyRows(sources).all()) {
    await expect(row).not.toContainText(/INTACHAIN mainnet/i);
    await expect(row.getByTestId('audited-flag')).toHaveText('no');
  }
  await expect(audit.getByTestId('label-verdict')).toHaveText('PASS');
});

test(`${J} #3 opens the contracts room: every deployed contract with its address, network label and verification; a pool can be paused with a second approver`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { a, b } = await founders(browser);
  const contracts = await section(a, 'Contracts');
  const table = contracts.getByRole('table', { name: 'Deployed contracts' });
  for (const header of ['Contract', 'Address', 'Network', 'Verified'])
    await expect(table.getByRole('columnheader', { name: header })).toBeVisible();
  // The pause is the listing desk's two-founder hide: nothing on chain changes and one founder alone leaves it pending.
  const form = async (page) => {
    await page.goto(`${ADMIN}/protocol-ops/listing`);
    const region = desk(page).getByRole('region', { name: 'Pool and market control' });
    await expect(region).toBeVisible({ timeout: 30_000 });
    return region;
  };
  const formA = await form(a);
  await formA.getByLabel('What to do').selectOption({ label: 'Hide a pool' });
  await formA.getByLabel('Chain id').fill('84532');
  await formA.getByLabel('Pool address').fill(POOL);
  await formA.getByLabel('Reason code').selectOption('contract_defect');
  await formA.getByLabel(/^Reason: what the second founder reads/).fill(`LOCAL TEST ${J} pause a TEST pool`);
  // The console's phrase names the pool: HIDE POOL and the address's first 10 characters.
  const phrase = `HIDE POOL ${POOL.slice(0, 10)}`;
  await formA.getByLabel(/^Type HIDE POOL .* to confirm$/).fill(phrase);
  const reply = await twoFounder({
    formA,
    formB: await form(b),
    ask: 'Ask a second founder to approve this',
    phrase,
    summary: POOL,
  });
  expect(reply).toContain('Hidden by INTAFACED');
});

test(`${J} #4 opens the quoter registry and an application: "applied" answers no production quotes; three timed-out health checks disable it; promotion needs a second approver`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const registry = await section(a, 'Quoters');
  const applied = bodyRows(registry.getByRole('table', { name: 'Quoters' })).filter({ hasText: 'TEST applied quoter' });
  await expect(applied).toContainText('Applied · no production quotes');
  const failing = bodyRows(registry.getByRole('table', { name: 'Quoters' })).filter({ hasText: 'TEST timed-out quoter' });
  await expect(failing).toContainText('Disabled: 3 health checks timed out');
  await applied.getByRole('button', { name: 'Promote' }).click();
  await expect(registry.getByTestId('packet-made')).toBeVisible();
  await expect(applied).toContainText('Applied · no production quotes');
});

test(`${J} #5 opens the fade breaker for a quoter: the breaker state and the quotes it declined, with the owner-published thresholds or their absence`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const breaker = await section(a, 'Fade breaker');
  await expect(breaker.getByRole('table', { name: 'Declined quotes' })).toBeVisible();
  // The thresholds are an owner decision and blank on the stack.
  await expect(breaker.getByTestId('fade-thresholds')).toHaveText('Thresholds not set · owner.decision');
});

test(`${J} #6 opens the token review queue: pending express and ordinary requests with the ownership proof; a failed review refunds the express fee`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const queue = await section(a, 'Token reviews');
  const requests = queue.getByRole('table', { name: 'Pending reviews' });
  for (const header of ['Kind', 'Token', 'Ownership proof', 'Fee'])
    await expect(requests.getByRole('columnheader', { name: header })).toBeVisible();
  const failed = bodyRows(queue.getByRole('table', { name: 'Decided reviews' }))
    .filter({ hasText: 'Failed' })
    .filter({ hasText: 'Express' });
  await expect(failed).not.toHaveCount(0);
  for (const row of await failed.all()) await expect(row).toContainText('Fee refunded');
});

test(`${J} #7 opens routing eligibility for a token: a market failing the round-trip test leaves routing with the reason while the token stays visible`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const routing = await section(a, 'Routing eligibility');
  const failing = bodyRows(routing.getByRole('table', { name: 'Markets' })).filter({ hasText: 'Round-trip test failed' });
  await expect(failing).not.toHaveCount(0);
  await expect(failing.first()).toContainText('Not routed');
  await expect(failing.first()).toContainText('Token visible');
});

test(`${J} #8 opens the INTACHAIN listing rooms: quote assets, aligned assets, builder markets, deployer stake and the deployment auction, each with an empty state and its blocker`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const rooms = await section(a, 'INTACHAIN listing');
  for (const name of ['Quote assets', 'Aligned assets', 'Builder-deployed markets', 'Deployer stake', 'Deployment auction']) {
    const room = rooms.getByRole('region', { name });
    await expect(room).toBeVisible();
    await expect(room).toContainText('chain.go');
  }
});

test(`${J} #9 opens the bridge recovery desk: stuck transfers by state with the next action; a blank route table shows the owner-decision label`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const bridge = await section(a, 'Bridge recovery');
  const stuck = bridge.getByRole('table', { name: 'Stuck transfers' });
  for (const header of ['State', 'Next action']) await expect(stuck.getByRole('columnheader', { name: header })).toBeVisible();
  await expect(bridge.getByRole('region', { name: 'Routes' })).toContainText('owner.decision');
});

test(`${J} #10 reviews an asset link request: the decimals mismatch and the verdict; a link for a token with different decimals is refused`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const links = await section(a, 'Asset links');
  const mismatch = bodyRows(links.getByRole('table', { name: 'Link requests' })).filter({ hasText: 'TEST decimals mismatch' });
  await expect(mismatch).toContainText(/Decimals \d+ ≠ \d+/);
  await expect(mismatch).toContainText('Refused');
  await expect(mismatch.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});
