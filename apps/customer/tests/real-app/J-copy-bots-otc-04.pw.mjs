// World: book, restart
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, signOutBrowser, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrdersLoaded, followOnScreen, leadVenueAccount, listLeader, openFollow, takeBest } from './copy.mjs';
import { venueForThisFile } from './venue.mjs';

// J-copy-bots-otc-04, in the running app (docs/roadmap/journeys.json): become a lead trader and place my first lead trade.
// One test per step, titled "J-copy-bots-otc-04 #<n>", run in order. The applicant is a verified TEST account with TEST
// 3000 USDT on the TEST book (to follow with) and a TEST wallet whose account on the stack's LOCAL TEST venue holds TEST
// 3000 USDC, made the applicant's own by one action their wallet signs through svc-trade's user-venue door, switched on
// for this file. A second TEST leader (listed by the stack's TEST founder) is the master the applicant first follows.
// The least venue balance to lead is the stack's TEST value (tooling/profiles/test-owner-values/trade.json), blanked for
// one restart of svc-trade in #1; the founders reject and approve on the console. Lead orders are the applicant's own.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #3: no new-trader missions; #4: no lead account, level or lead trading screen.
// - #5 to #7: the order form has no lead-trade toggle, leading instrument list or lead limits.
// - #8: no lead trade views with counters and copiers.
const J = 'J-copy-bots-otc-04';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const UNBUILT = { timeout: 5_000 };
const PROFILE = JSON.parse(
  readFileSync(new URL('../../../../tooling/profiles/test-owner-values/trade.json', import.meta.url), 'utf8'),
).values;
/** The owner's wait before a rejected applicant may apply again, as the stack's TEST profile sets it, in milliseconds. */
const REAPPLY_WAIT_MS = Number(PROFILE.TRADE_COPY_LEAD_REAPPLY_WAIT_SECONDS.value) * 1000;
/** The least venue USDC to lead, as the stack's TEST profile sets it. */
const THRESHOLD = PROFILE.TRADE_COPY_LEAD_MIN_VENUE_USDC.value;

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const codeOf = (body) => body?.error?.data?.cause?.code;

/** The applicant's own application, as svc-trade answers `copy.myLeadApplication`. */
async function mineOf(who) {
  const res = await (await api(who)).get('/api/trade/trpc/copy.myLeadApplication');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body?.result?.data ?? null;
}

/** svc-trade restarted with the user-venue door on and the least venue balance to lead blank or back on its TEST value. */
function leadBalance(value) {
  const saved = { door: process.env.LOCAL_STACK_USER_VENUE, balance: process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE };
  process.env.LOCAL_STACK_USER_VENUE = 'on';
  if (value === 'blank') process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE = 'blank';
  else delete process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    for (const [key, before] of [
      ['LOCAL_STACK_USER_VENUE', saved.door],
      ['LOCAL_STACK_TRADE_COPY_LEAD_BALANCE', saved.balance],
    ]) {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  }
}

const terms = (page) => page.getByRole('region', { name: 'What leading needs' });

/** Opens Apply to lead, fills the display name and presses Apply; returns svc-trade's answer to the submit. */
async function applyOnScreen(page, displayName) {
  await page.goto('/copy/lead/apply');
  await page.getByRole('textbox', { name: 'Display name' }).fill(displayName);
  const sent = page.waitForResponse((res) => res.url().includes('copy.applyToLead') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Apply to lead' }).click();
  const answer = await sent;
  return { status: answer.status(), body: await answer.json(), request: answer.request().postDataJSON() };
}

async function openDesk(page, founder = 'a') {
  await founderSignIn(page, founder);
  await page.goto(`${ADMIN}/trade-ops/copy`);
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible();
}

test(`${J} #1 applies to lead while following another master: refused naming the master; with the balance threshold blank, refused naming the threshold`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const tag = Date.now().toString(36);
  const master = await fundedTrader(page, 'jcm4', '10');
  const masterName = `Journey Master ${tag}`;
  const masterRef = await listLeader(master, masterName);
  const applicant = await fundedTrader(page, 'jca4', '3000');
  const owner = await leadVenueAccount(applicant, `${J} ${RUN} ${tag} applicant`, '3000');
  const displayName = `TEST lead ${tag}`;
  run.reset({ tag, master, masterName, masterRef, applicant, owner, displayName });
  await signIn(page, applicant);
  await followOnScreen(page, applicant, masterRef, { perOrder: '20', total: '40', fixed: '10' });

  // Following the master: the room says whom, and the application is refused naming them. Nothing is written.
  const following = await applyOnScreen(page, displayName);
  expect([following.status, codeOf(following.body)], JSON.stringify(following.body).slice(0, 300)).toEqual([
    400,
    'trade.copy_lead_following',
  ]);
  await expect(page.getByText(`You are following ${masterName}. Leave that leader before you apply to lead.`)).toBeVisible();
  await expect(terms(page)).toContainText(`You are following ${masterName}`);
  // The venue balance the room shows is the venue's own figure for the wallet's account, labelled TEST.
  await expect(terms(page)).toContainText('3,000 USDC TEST');
  expect(await mineOf(applicant), 'a refused application writes nothing').toBeNull();

  // Leave the master on screen.
  const detail = await openFollow(page, masterRef);
  await detail.getByRole('button', { name: 'Leave leader', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Leave leader', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  // With the least venue balance to lead blank, the application is refused naming the threshold, which reads Not set.
  leadBalance('blank');
  try {
    const blank = await applyOnScreen(page, displayName);
    expect([blank.status, codeOf(blank.body)], JSON.stringify(blank.body).slice(0, 300)).toEqual([
      400,
      'trade.copy_lead_balance_threshold_unset',
    ]);
    await expect(page.getByText('The least venue balance to lead is not set by the platform')).toBeVisible();
    await expect(terms(page)).toContainText('No leader');
    await expect(terms(page)).toContainText(/Least venue balance\s*Not set/);
    expect(await mineOf(applicant), 'a refused application writes nothing').toBeNull();
  } finally {
    leadBalance('test');
  }
});

test(`${J} #2 submits a valid application: submitted, the same submit again returns the same row; a rejected one shows its reason and may be resubmitted after the owner's wait`, async ({
  page,
  browser,
}) => {
  test.setTimeout(REAPPLY_WAIT_MS + 300_000);
  const applicant = state('applicant');
  const displayName = state('displayName');
  await signIn(page, applicant);
  // Following no one, with the TEST threshold set and the venue's figure above it.
  await page.goto('/copy/lead/apply');
  await expect(terms(page)).toContainText('No leader');
  await expect(terms(page)).toContainText(`${Number(THRESHOLD).toLocaleString('en-US')} USDC`);
  const answer = await applyOnScreen(page, displayName);
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(200);
  const first = answer.body.result.data;
  expect(first).toMatchObject({ state: 'submitted', displayName });
  await expect(page.getByRole('status').filter({ hasText: 'Application sent' })).toBeVisible();
  // The same submit again (the same person and name: the application's key) answers with the same row.
  const again = await (await api(applicant)).post('/api/trade/trpc/copy.applyToLead', answer.request);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data).toEqual(first);
  expect(await mineOf(applicant)).toEqual(first);

  // A founder rejects it with a reason on the console.
  const reason = `TEST: track record not shown ${state('tag')}`;
  const founder = await (await browser.newContext()).newPage();
  await openDesk(founder);
  const row = founder.getByRole('table', { name: 'Lead applications' }).locator('tbody tr').filter({ hasText: displayName });
  await row.getByRole('button', { name: 'Reject' }).click();
  await founder.getByRole('dialog').getByRole('textbox', { name: 'Reason' }).fill(reason);
  await founder.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await expect(founder.getByRole('status').filter({ hasText: 'Rejected' })).toBeVisible();
  await founder.context().close();

  // The applicant sees the reason and when the owner's wait ends, and no application is offered while it runs.
  const decided = await mineOf(applicant);
  expect(decided).toMatchObject({ applicationId: first.applicationId, state: 'disapproved', reason });
  await page.goto('/copy/lead/apply');
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByTestId('reapply-after')).toHaveAttribute('datetime', decided.reapplyAfter);
  await expect(page.getByRole('button', { name: 'Apply to lead' })).toHaveCount(0);
  // After the wait, on the real clock, the room offers the application again and a new one is submitted.
  const left = Date.parse(decided.reapplyAfter) - Date.now();
  if (left > 0) await page.waitForTimeout(left + 1_000);
  await page.reload();
  await expect(page.getByText('The waiting period has ended')).toBeVisible();
  const resubmit = await applyOnScreen(page, displayName);
  expect(resubmit.status, JSON.stringify(resubmit.body).slice(0, 300)).toBe(200);
  const second = resubmit.body.result.data;
  expect(second).toMatchObject({ state: 'submitted', displayName, reason: null });
  expect(second.applicationId).not.toBe(first.applicationId);
  run.write({ applicationId: second.applicationId });
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
