import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, signOutBrowser } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrdersLoaded, followOnScreen, listLeader, openFollow, takeBest } from './copy.mjs';

// J-copy-bots-otc-04, in the running app (docs/roadmap/journeys.json): become a lead trader and place my first lead trade.
// One test per step, titled "J-copy-bots-otc-04 #<n>", run in order. The applicant is a verified TEST account with TEST
// 3000 USDT; a second TEST leader (listed by the stack's TEST founder) is the master the applicant first follows. The
// lead criteria, balance threshold, leading instrument list and lead limits are the stack's TEST copy-lead terms; the
// founders approve on the console. Lead orders are the applicant's own orders on the TEST book.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1, #2: the Copy room has no "Become a lead trader" door, so there is no application.
// - #3: no new-trader missions; #4: no lead account, level or lead trading screen.
// - #5 to #7: the order form has no lead-trade toggle, leading instrument list or lead limits.
// - #8: no lead trade views with counters and copiers.
const J = 'J-copy-bots-otc-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const applySheet = (page) => page.getByRole('dialog', { name: 'Apply to lead' });

async function openApply(page) {
  await page.goto('/trade/copy');
  await page.getByRole('button', { name: 'Become a lead trader' }).click(UNBUILT);
  await expect(applySheet(page)).toBeVisible();
}

/** The lead trading screen: the spot desk with the lead-trade switch on. */
async function leadDesk(page) {
  await page.goto('/trade/spot/BTC-USDT?lead=1');
  const toggle = page.getByRole('switch', { name: 'Lead trade' });
  await expect(toggle).toBeVisible(UNBUILT);
  return toggle;
}

test(`${J} #1 applies to lead while following another master: refused naming the master`, async ({ page }) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const master = await fundedTrader(page, 'jcm4', '10');
  const masterName = `Journey Master ${tag}`;
  const masterRef = await listLeader(master, masterName);
  const applicant = await fundedTrader(page, 'jca4', '3000');
  run.reset({ tag, master, masterName, masterRef, applicant });
  await signIn(page, applicant);
  await followOnScreen(page, applicant, masterRef, { perOrder: '20', total: '40', fixed: '10' });

  await openApply(page);
  await applySheet(page).getByLabel('Display name').fill(`TEST lead ${tag}`);
  await applySheet(page).getByRole('button', { name: 'Send application' }).click();
  await expect(applySheet(page).getByText(`You are following ${masterName}. Leave that leader before you apply to lead.`)).toBeVisible();
  // Leave the master so #2 can apply.
  await page.keyboard.press('Escape');
  const detail = await openFollow(page, masterRef);
  await detail.getByRole('button', { name: 'Leave leader', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Leave leader', exact: true }).click();
});

test(`${J} #2 submits a valid application: submitted, and a second submit with the same key returns the same row`, async ({ page }) => {
  const applicant = state('applicant');
  await signIn(page, applicant);
  await openApply(page);
  await applySheet(page)
    .getByLabel('Display name')
    .fill(`TEST lead ${state('tag')}`);
  const sent = page.waitForResponse((res) => res.url().includes('copy.applyToLead') && res.request().method() === 'POST');
  await applySheet(page).getByRole('button', { name: 'Send application' }).click();
  const answer = await sent;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const first = (await answer.json()).result.data;
  expect(first.state).toBe('submitted');
  const again = await (await api(applicant)).post('/api/trade/trpc/copy.applyToLead', answer.request().postDataJSON());
  expect(again.body.result.data.applicationId).toBe(first.applicationId);
  run.write({ applicationId: first.applicationId });
});

test(`${J} #3 completes a new-trader mission: its progress is shown`, async ({ page }) => {
  await signIn(page, state('applicant'));
  await page.goto('/trade/copy?tab=lead');
  const missions = page.getByRole('list', { name: 'New-trader missions' });
  await expect(missions).toBeVisible(UNBUILT);
  await expect(missions.getByRole('listitem').first()).toContainText(/\d+ of \d+/);
});

test(`${J} #4 after approval opens the lead account: the lead's level ("Not set" where blank) and the lead trading screen`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const applicationId = state('applicationId');
  for (const key of ['a', 'b']) {
    const founder = await (await browser.newContext()).newPage();
    await founderSignIn(founder, key);
    await founder.goto(`${ADMIN}/trade-ops/copy`);
    const row = founder.getByRole('row', { name: new RegExp(state('tag')) });
    await row.getByRole('button', { name: key === 'a' ? 'Approve' : 'Confirm approval' }).click(UNBUILT);
    if (key === 'a') await founder.getByRole('dialog', { name: 'Approve this lead' }).getByRole('button', { name: 'Approve' }).click();
    await founder.context().close();
  }
  await signIn(page, state('applicant'));
  await page.goto('/trade/copy?tab=lead');
  const account = page.getByRole('region', { name: 'Your lead account' });
  await expect(account).toContainText(applicationId.slice(0, 8));
  await expect(account).toContainText(/Level\s*(\w+|Not set)/);
  await leadDesk(page);
});

test(`${J} #5 places a post-only lead order: with the instrument list set it rests, and its fill is mirrored only after it fills`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const applicant = state('applicant');
  // A follower of the new lead, so a mirror can be seen.
  const follower = await fundedTrader(page, 'jcf4', '500');
  const leadRef = (await (await api(applicant)).get('/api/trade/trpc/copy.myLead')).body?.result?.data?.leaderRef;
  expect(leadRef, 'the applicant has a lead account').toBeTruthy();
  await signIn(page, follower);
  await followOnScreen(page, follower, leadRef, { perOrder: '20', total: '100', fixed: '10' });
  await signOutBrowser(page.context());

  await signIn(page, applicant);
  const toggle = await leadDesk(page);
  await toggle.check();
  await page.getByRole('checkbox', { name: 'Post only' }).check();
  await page.getByRole('textbox', { name: 'Price' }).first().fill('1000');
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  // Resting far under the book, it hasn't filled: nothing is mirrored yet.
  await signOutBrowser(page.context());
  await signIn(page, follower);
  const detail = await openFollow(page, leadRef);
  await expect(await copiedOrdersLoaded(detail)).toHaveCount(0);
  run.write({ follower, leadRef });
});

test(`${J} #6 places an iceberg order: not a lead trade; the toggle is forced off and the copy skipped with the reason`, async ({
  page,
}) => {
  await signIn(page, state('applicant'));
  const toggle = await leadDesk(page);
  await page.getByRole('tab', { name: 'Iceberg' }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(page.getByText('Iceberg orders are never lead trades, so followers don’t copy them.')).toBeVisible();
});

test(`${J} #7 reaches the lead's equity minimum or daily buy cap, or a pair with no holding limit: the lead order is refused by code`, async ({
  page,
}) => {
  await signIn(page, state('applicant'));
  const toggle = await leadDesk(page);
  await toggle.check();
  // ETH/USDT has no TEST holding limit for leads, so a lead order there is refused.
  await page.goto('/trade/spot/ETH-USDT?lead=1');
  await page.getByRole('switch', { name: 'Lead trade' }).check();
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.01');
  await page.getByRole('button', { name: 'Buy ETH' }).click();
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(page.getByText('Reference trade.copy_lead_holding_limit_unset')).toBeVisible();
  // A buy past the TEST daily buy cap.
  await takeBest(state('applicant'), 'buy', '0.001', `${J}-7-${state('tag')}`);
  await page.goto('/trade/spot/BTC-USDT?lead=1');
  await page.getByRole('switch', { name: 'Lead trade' }).check();
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('1');
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(page.getByText(/Reference trade\.copy_lead_(daily_buy_cap|equity_minimum)/)).toBeVisible();
});

test(`${J} #8 opens the lead trade views: counters for ongoing and history, and each copier's status`, async ({ page }) => {
  await signIn(page, state('applicant'));
  await page.goto('/trade/copy?tab=lead');
  const views = page.getByRole('region', { name: 'Lead trades' });
  await expect(views.getByRole('tab', { name: /^Ongoing \(\d+\)$/ })).toBeVisible(UNBUILT);
  await expect(views.getByRole('tab', { name: /^History \(\d+\)$/ })).toBeVisible();
  const copiers = page.getByRole('table', { name: 'Your copiers' });
  await expect(copiers.locator('tbody tr').first()).toContainText(/Active|Paused|Stopped/);
});
