// World: none
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-bank-27, in the running app (docs/roadmap/journeys.json): I handle card disputes (support), on the founder console's
// bank desk. The card and its disputes are the partner's (OWNER 226); no partner is named, so the stack runs the TEST
// partner card adapter (card-sim) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON, CUSTODY-DELTA §4),
// whose TEST partner has not said who bears a fraud or chargeback loss. Step 4 (BK-cdisp-03): the loss liability is
// recorded as the partner's answer, or "not known", and never assumed to be the partner. Not yet built, and not asserted
// here: the dispute case itself (closing it and the dispute cap) and steps 1 to 3; step 5 is deferred to launch prep.
// J-bank-26 #6 shows the same adapter's reported answers beside this unknown.
const J = 'J-bank-27';

test(`${J} #4 decides loss liability: who bears the fraud loss recorded under the partner's terms, or "not known"; it is never assumed to be the partner`, async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/bank-ops');
  const terms = page.getByTestId('read-bank.card-partner-terms');
  await expect(terms).toBeVisible();
  const liability = terms
    .locator('.dk-kv-row')
    .filter({ has: page.getByText('Who bears a fraud or chargeback loss', { exact: true }) })
    .locator('dd');
  await expect(liability).toHaveText('not known');
  await expect(liability).not.toContainText('partner');
  await context.close();
});
