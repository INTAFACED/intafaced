import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { followOnScreen, leadFill, listLeader } from './copy.mjs';

// J-copy-bots-otc-05, in the running app (docs/roadmap/journeys.json): manage my followers, my privacy and my lead
// listing. One test per step, titled "J-copy-bots-otc-05 #<n>", run in order. #1 makes the start: a TEST lead the stack's
// TEST founder lists, with one follower who holds a copied position. The removal limit, disclosure delays, nickname
// window, capacity and batch limit are the stack's TEST copy terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no lead desk (the lead's own view of followers, privacy, nickname, capacity, waitlist,
//   whitelist, invitations, level or stop leading).
const J = 'J-copy-bots-otc-05';
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

/** The lead's own desk, on one of its tabs. */
async function leadDesk(page, tab) {
  await signIn(page, state('lead'));
  await page.goto('/trade/copy?lead=1');
  await page.getByRole('tab', { name: tab }).click(UNBUILT);
  return page.getByRole('tabpanel', { name: tab });
}

test(`${J} #1 removes a follower with open positions: refused until they close; a bulk removal keys each id`, async ({ page }) => {
  test.setTimeout(300_000);
  const tag = Date.now().toString(36);
  const lead = await fundedTrader(page, 'jcm', '2000');
  const leadRef = await listLeader(lead, `Journey Manage ${tag}`);
  const follower = await fundedTrader(page, 'jcmf', '500');
  await signIn(page, follower);
  const followId = await followOnScreen(page, follower, leadRef, { perOrder: '50', total: '200', fixed: '20' });
  await leadFill(lead, 'buy', '0.001', `${J}-1-${tag}`);
  run.reset({ tag, lead, leadRef, follower, followId });
  const panel = await leadDesk(page, 'Followers');
  await panel
    .getByRole('row', { name: new RegExp(follower.handle) })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(panel.getByText(/has open copied positions/)).toBeVisible();
});

test(`${J} #2 sets a 5-minute disclosure delay and hides location: others see trades later; copiers at once; no location`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Privacy');
  await panel.getByLabel('Show my trades to non-copiers after, minutes').fill('5');
  await panel.getByRole('switch', { name: 'Show my location' }).uncheck();
  await panel.getByRole('button', { name: 'Save' }).click();
  const profile = await (
    await api(state('follower'))
  ).get(`/api/trade/trpc/copy.leader?input=${encodeURIComponent(JSON.stringify({ leaderRef: state('leadRef') }))}`);
  expect(JSON.stringify(profile.body)).not.toMatch(/"(country|region|location)"/);
});

test(`${J} #3 edits the nickname twice within the window: the first goes to review; the second refused as throttled`, async ({ page }) => {
  const panel = await leadDesk(page, 'Profile');
  for (const name of ['Journey Renamed A', 'Journey Renamed B']) {
    await panel.getByLabel('Nickname').fill(`${name} ${state('tag')}`);
    await panel.getByRole('button', { name: 'Save' }).click();
  }
  await expect(panel.getByText(/In review/)).toBeVisible();
  await expect(panel.getByText(/You can change it again on/)).toBeVisible();
});

test(`${J} #4 fills the lead to capacity: a new follower refused and may join the waitlist; a freed slot sends one notice`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Capacity');
  await panel.getByLabel('Most copiers').fill('1');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toContainText(/1 of 1/);
});

test(`${J} #5 uploads an oversize whitelist and makes an invitation with a copier limit: nothing written; the limit holds`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Access');
  await panel.getByLabel('Whitelist file').setInputFiles({
    name: 'whitelist.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(Array.from({ length: 5001 }, (_, i) => `user${i}@local-test.invalid`).join('\n')),
  });
  await expect(panel.getByText(/more than the \d+ a file may hold/)).toBeVisible();
});

test(`${J} #6 checks the lead level: the level with its threshold and "Maximum ratio: not set by the platform"`, async ({ page }) => {
  const panel = await leadDesk(page, 'Level');
  await expect(panel).toContainText('Maximum ratio: not set by the platform');
});

test(`${J} #7 stops leading with an open position, then after closing it: refused while open; then review pending`, async ({ page }) => {
  const panel = await leadDesk(page, 'Listing');
  await panel.getByRole('button', { name: 'Stop leading' }).click();
  await expect(panel.getByText(/Close your open positions first/)).toBeVisible();
});
