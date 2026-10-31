import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';

// J-more-catalogue-15, in the running app (docs/roadmap/journeys.json): read a prediction market and place a Yes or No
// order. One test per step, titled "J-more-catalogue-15 #<n>", run in order. Every step waits for a slice that is not
// built yet and fails by name, cheaply (no sign-in, a short timeout); each becomes a real check in the running app when
// its slice lands:
// - #1 is checked: /predict reads the empty catalogue and names its blocker. svc-trade's publish door refuses
//   owner.decision until the owner decides who determines a result (ENGINE E-1), so no market can exist yet.
// - MC-predict-01 (start, #2, #3): the stored catalogue, its filters and per-market rules, timeline and clarifications,
//   which wait for E-1 because no market can be published to prove them.
// - MC-predict-02 (#4): price as probability from decimal strings, the price history and the one order book's bid and
//   ask views.
// - MC-predict-03 (#5, #6): the order ticket through svc-trade and ledger-client recipes, full collateral held once per
//   client order id.
// - RC-more-catalogue-02 and -03 (#7): the share card, Scanner and Academy hooks, and categorical and scalar markets.
// Every market, price and amount the steps will use is TEST; no figure is invented for a blank price, fee or limit.
const J = 'J-more-catalogue-15';

test.describe.configure({ mode: 'default' });

/** A step whose slice is not built: fails at once, naming the slice and what is missing. */
function notBuilt(slice, missing) {
  return async () => {
    test.setTimeout(5_000);
    throw new Error(`${slice} is not built: ${missing}`);
  };
}

test(
  `${J} starts: signed in with TEST money; a published market with rules and a resolution source`,
  notBuilt('MC-predict-01', 'publishing refuses owner.decision until the owner decides who determines a result (E-1), so no market exists'),
);

test(`${J} #1 Opens /predict with no markets: the full layout, the honest empty state and the named blocker`, async ({ page }) => {
  await signUp(page, 'jp1');
  await page.goto('/predict');
  const catalogue = page.locator('.prediction-catalogue');
  await expect(catalogue.getByRole('heading', { name: 'Listed questions', level: 2 })).toBeVisible();
  // The honest empty state: no sample market, no invented row.
  await expect(catalogue.getByRole('heading', { name: 'No questions are listed', level: 3 })).toBeVisible();
  await expect(catalogue.locator('article')).toHaveCount(0);
  await expect(catalogue.getByRole('button', { name: 'Refresh questions' })).toBeEnabled();
  // The named blocker: publishing waits for the owner's decision on who determines a result (ENGINE E-1).
  const blocker = page.getByTestId('prediction-blocker').locator('[data-not-connected="owner.decision"]');
  await expect(blocker).toHaveText(
    'Publishing a prediction market needs an owner decision. It is switched off in this build. owner.decision',
  );
  await expect(page.getByTestId('prediction-blocker')).toContainText('an owner decision that has not been made');
  // The full layout: the ticket column is drawn beside the list, with its own blocker.
  await expect(page.locator('.prediction-room-review').getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page.locator('.prediction-ticket__blocker')).toBeVisible();
});

test(
  `${J} #2 Filters three published markets by category and trending: only matches, in trade-count order; a market that closes on an outcome says so and invents no time`,
  notBuilt('MC-predict-01', 'the catalogue has no category, trending order or outcome-close rule'),
);

test(
  `${J} #3 Opens a market: rules, resolution source, timeline and later clarifications (original text unchanged)`,
  notBuilt('MC-predict-01', 'a market has no stored rules, timeline or clarifications'),
);

test(
  `${J} #4 Reads price and book: price as probability from decimal strings; a Yes bid of 0.62 shows a No ask of 0.38; empty sides when no trades; an unregistered instrument is named`,
  notBuilt('MC-predict-02', 'no price-as-probability view or paired Yes and No book'),
);

test(
  `${J} #5 Presses Review on the ticket while the order path is not wired: the typed refusal with the Predict blocker; no intent row`,
  notBuilt('MC-predict-03', 'the ticket has no Review step through svc-trade'),
);

test(
  `${J} #6 Sends a buy of 10 twice with the same client order id: one hold and one order`,
  notBuilt('MC-predict-03', 'no Predict order path holds full collateral through the ledger'),
);

test(
  `${J} #7 Shares the market card, or opens it from a Scanner row, or proposes a categorical or scalar market: the share card, Scanner and Academy-league hooks; extra market kinds with creation fees`,
  notBuilt('RC-more-catalogue-02 and RC-more-catalogue-03', 'no share card, Scanner or Academy hook, and only Yes or No markets'),
);

test(
  `${J} ends: my order is held with full collateral, matched or resting, and the fee is shown on the ticket`,
  notBuilt('MC-predict-03', 'no Predict order can be placed'),
);
