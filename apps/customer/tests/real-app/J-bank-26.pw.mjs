// World: restart
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tool } from './stack.mjs';

// J-bank-26, in the running app (docs/roadmap/journeys.json): I run the card programme (support and finance), on the founder
// console's bank desk. The card programme is the partner's (OWNER 226); no partner is named, so the stack runs the TEST
// partner card adapter (card-sim) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON, CUSTODY-DELTA §4).
// The profile's TEST partner has not said who funds the programme or what reserve it requires. Step 6 (BK-cops-05): the
// desk reads both as "not known", never as zero; for one restart (LOCAL_STACK_BANK_CARD_PARTNER=reported) the same partner
// reports TEST answers and the desk shows them as reported. Not yet built, and not asserted here: step 6's settlement
// reconciliation, the stablecoin conversion and fund, defund and auto reload; and steps 1 to 5, 7 and 8.
const J = 'J-bank-26';

/** The bank restarted with one LOCAL_STACK_ switch set for that restart only (unset puts the profile's TEST value back). */
function restartBank(key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

async function desk(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/bank-ops');
  return page;
}
const terms = (page) => page.getByTestId('read-bank.card-partner-terms');
const fact = (page, label) =>
  terms(page)
    .locator('.dk-kv-row')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');

test(`${J} #6 opens programme funding: who funds the programme and any reserve the partner requires, or "not known", never shown as zero`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // The TEST partner has answered neither: both read "not known", and no figure stands in for the unknown reserve.
  let page = await desk(browser);
  await expect(terms(page)).toBeVisible();
  await expect(fact(page, 'Card partner')).toHaveText('TEST partner card adapter');
  await expect(fact(page, 'Who funds the programme')).toHaveText('not known');
  await expect(fact(page, 'Reserve the partner requires')).toHaveText('not known');
  await expect(fact(page, 'Reserve the partner requires')).not.toContainText(/\d/);
  await page.context().close();

  // The same partner reporting its answers: the desk shows what the partner reported, so "not known" above is the
  // partner's silence read through, not a fixed label.
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', 'reported');
  try {
    page = await desk(browser);
    await expect(fact(page, 'Who funds the programme')).toHaveText('TEST: the programme pre-funds in USDC');
    await expect(fact(page, 'Reserve the partner requires')).toHaveText('25000.00 USDC, as the partner reports');
    await page.context().close();
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }
});
