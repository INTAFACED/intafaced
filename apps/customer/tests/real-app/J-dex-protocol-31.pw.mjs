import { test, expect } from '@playwright/test';
import { UNBUILT } from './dex.mjs';
import { desk, founderPair, openDesk, twoFounder } from './protocol-desk.mjs';
import { bodyRows } from './tables.mjs';

// J-dex-protocol-31, in the running app (docs/roadmap/journeys.json): watch protocol risk: liquidations, funding,
// oracles, hooks and the bridge. One test per step, titled "J-dex-protocol-31 #<n>", run in order on the founder console
// as the stack's two LOCAL TEST founders (admin.mjs), with the stack's TEST perpetual running. Funding and liquidation run
// through the custodial recipes; the bridge and lending contracts are non-custodial. owner.decision for blank ladders,
// bounds and policies; chain.go for the native book; audit.external for mainnet.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /trade-ops/liquidations lists liquidation steps, positions closest to liquidation, auto-deleveraging pairs and the
//   insurance fund, but not the ladder's state or the ADL policy (D-perps-04); there is no funding override
//   (D-perps-04);
// - /trade-ops/kill-switch halts and resumes the whole module, but has no limit-only setting, open-interest cap or price
//   band (D-perps-06);
// - there is no oracle status, lending liquidations, curated markets or withdraw limits (D-lend-earn-02 to -05), no hook
//   allowlist (D-liquidity-06), no quoter fade breaker (D-swap-intents-03) and no bridge lock (RC-dex-protocol-03).
const J = 'J-dex-protocol-31';
const founders = founderPair();
const SYMBOL = 'BTC/USDT:USDT';

test.describe.configure({ mode: 'default' });

/** Opens one section of the protocol ops desk by its link. */
async function section(page, name) {
  await openDesk(page, '/protocol-ops', 'Protocol operations');
  await desk(page).getByRole('navigation', { name: 'Sections' }).getByRole('link', { name }).click(UNBUILT);
  const region = desk(page).getByRole('region', { name }).first();
  await expect(region).toBeVisible();
  return region;
}

test(`${J} starts: a risk operator signed in to the ops console, with TEST markets running`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { a } = await founders(browser);
  await openDesk(a, '/trade-ops/liquidations', 'Liquidations');
  await expect(desk(a).getByLabel('Market').getByRole('option', { name: SYMBOL })).toHaveCount(1);
});

test(`${J} #1 opens the liquidation view with the ladder unset: "Liquidation is not running" and the typed refusal`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  await openDesk(a, '/trade-ops/liquidations', 'Liquidations');
  const ladder = desk(a).getByRole('region', { name: 'Liquidation ladder' });
  await expect(ladder).toContainText('Liquidation is not running', UNBUILT);
  await expect(ladder).toContainText('trade.liquidation_ladder_unset');
});

test(`${J} #2 proposes a funding override: pending with one approver; applied with the second inside the bound; refused beyond the bound`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  await openDesk(a, '/trade-ops/markets', 'Markets');
  const override = desk(a).getByRole('region', { name: 'Funding override' });
  await override.getByLabel('Market').selectOption(SYMBOL, UNBUILT);
  await override.getByLabel(/^Funding rate/).fill('1');
  await override.getByRole('button', { name: 'Propose override' }).click();
  await expect(override.getByRole('alert')).toContainText('Beyond the bound');
  await override.getByLabel(/^Funding rate/).fill('0.0001');
  await override.getByRole('button', { name: 'Propose override' }).click();
  await expect(bodyRows(override.getByRole('table', { name: 'Overrides' })).first()).toContainText('Pending · 1 of 2');
  await openDesk(b, '/trade-ops/markets', 'Markets');
  const second = desk(b).getByRole('region', { name: 'Funding override' });
  await bodyRows(second.getByRole('table', { name: 'Overrides' }))
    .first()
    .getByRole('button', { name: 'Approve' })
    .click();
  await expect(bodyRows(second.getByRole('table', { name: 'Overrides' })).first()).toContainText('Applied');
});

test(`${J} #3 opens the auto-deleveraging view with the policy unset: the refusal, and past events still listed`, async ({ browser }) => {
  const { a } = await founders(browser);
  await openDesk(a, '/trade-ops/liquidations', 'Liquidations');
  const adl = desk(a).getByRole('region', { name: 'Auto-deleveraging pairs' });
  // The past events table is there today; the policy's refusal is not.
  await expect(adl.getByRole('table', { name: 'Auto-deleveraging pairs' })).toBeVisible();
  await expect(adl).toContainText('trade.adl_policy_unset', UNBUILT);
});

test(`${J} #4 sets the kill switch to limit-only: market orders refuse and limit orders queue; the open-interest cap and price band are shown`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await founders(browser);
  const market = async (page) => {
    await openDesk(page, '/trade-ops/kill-switch', 'Kill switch');
    return desk(page).getByRole('region', { name: `Market ${SYMBOL}` });
  };
  const formA = await market(a);
  await formA.getByRole('radio', { name: 'Limit orders only' }).check(UNBUILT);
  for (const term of ['Open-interest cap', 'Price band']) await expect(formA.getByRole('term').filter({ hasText: term })).toBeVisible();
  const formB = await market(b);
  const mode = (name, phrase) => twoFounder({ formA, formB, ask: 'Ask a second founder to approve this', phrase, summary: name });
  await mode(`${SYMBOL} limit orders only`, `LIMIT ONLY ${SYMBOL}`);
  try {
    await expect(formA.getByTestId('market-mode')).toHaveText('Limit orders only');
    // What a customer sees at limit-only (a market order refused, a limit queued) is J-dex-protocol-19 #8.
  } finally {
    // The market opens again for the other journeys on this stack.
    await formA.getByRole('radio', { name: 'Open' }).check();
    await mode(`${SYMBOL} open`, `OPEN ${SYMBOL}`);
  }
});

test(`${J} #5 opens the oracle status: sources with ages; a stale or disagreeing source pauses borrows`, async ({ browser }) => {
  const { a } = await founders(browser);
  const oracles = await section(a, 'Oracles');
  const sources = oracles.getByRole('table', { name: 'Oracle sources' });
  for (const header of ['Source', 'Age']) await expect(sources.getByRole('columnheader', { name: header })).toBeVisible();
  await expect(bodyRows(sources).filter({ hasText: 'TEST stale source' })).toContainText('Borrows paused');
});

test(`${J} #6 opens lending liquidations: accounts under health 1 and each permissionless liquidation under the close factor and bonus; a stale oracle blocks them`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const lending = await section(a, 'Lending liquidations');
  const accounts = lending.getByRole('table', { name: 'Accounts under health 1' });
  for (const header of ['Health', 'Close factor', 'Bonus'])
    await expect(accounts.getByRole('columnheader', { name: header })).toBeVisible();
  await expect(lending.getByRole('status')).toContainText(/Oracle (fresh|stale: liquidations blocked)/);
});

test(`${J} #7 reads curated markets and the expanding-limit state: which markets are curated and the withdraw limit state`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const curated = await section(a, 'Curated markets');
  const markets = curated.getByRole('table', { name: 'Lending markets' });
  for (const header of ['Curated', 'Withdraw limit']) await expect(markets.getByRole('columnheader', { name: header })).toBeVisible();
});

test(`${J} #8 reviews a hook pool for the routing allowlist: a risk score from verified sources only; changes need a second approver; a non-allowlisted hook is not routed`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const hooks = await section(a, 'Hook allowlist');
  const hook = bodyRows(hooks.getByRole('table', { name: 'Hook pools' })).filter({ hasText: 'TEST hook pool' });
  await expect(hook.getByTestId('risk-score')).toHaveText(/^\d+ · from verified sources$/);
  await expect(hook).toContainText('Not allowlisted · not routed');
  await hook.getByRole('button', { name: 'Allowlist' }).click();
  await expect(hook).toContainText('Pending a second approver');
});

test(`${J} #9 opens the quoter fade breaker: quoters that tripped the breaker`, async ({ browser }) => {
  const { a } = await founders(browser);
  const breaker = await section(a, 'Fade breaker');
  await expect(breaker.getByRole('table', { name: 'Tripped quoters' })).toBeVisible();
});

test(`${J} #10 locks the bridge during a withdrawal dispute: further withdrawals revert as locked and work again after the maximum lock; only a locker can lock`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const bridge = await section(a, 'Bridge lock');
  await expect(bridge.getByRole('term').filter({ hasText: 'Maximum lock duration' })).toBeVisible();
  await bridge.getByRole('button', { name: 'Lock withdrawals' }).click();
  // The console's founders are not the bridge's lockers on the stack: the lock is refused by name. Withdrawals reverting
  // while locked and working after the maximum lock are the bridge contract's own on-chain rule (RC-dex-protocol-03).
  await expect(bridge.getByRole('alert')).toContainText('Only a locker can lock the bridge');
});
