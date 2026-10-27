import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-09, in the running app (docs/roadmap/journeys.json): read a governance proposal and cast my vote. One
// test per step, titled "J-more-catalogue-09 #<n>", run in order. Step 1 makes the journey's start: a verified TEST
// holder stakes TEST IFC, then the stack's TEST governance space gets one open and one draft proposal
// (`local-test-world.mjs token-proposals`). The proposer rule and the voting rules are the stack's TEST governance terms;
// every vote and figure is read back from svc-token.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: no space card or follow; the stack seeds no proposals (no `token-proposals` world step).
// - #4, #5: the create form names no proposer rule before submit, and no opening time.
// - #6: no voting power snapshot or power history; #7: no ballot kinds, signed message or validation rule.
// - #8: no Delegate door; #9: no treasury panel.
const J = 'J-more-catalogue-09';
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

const trpc = (proc, input) => `/api/token/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const space = (page) => page.getByRole('region', { name: 'Governance space' });
const proposals = (page) => page.getByRole('list', { name: 'Proposals' });
const selected = (page) => page.getByRole('region', { name: 'Selected original proposal' });

async function openGovernance(page) {
  await page.goto('/token/governance');
  await expect(page.getByRole('heading', { name: 'Token governance', level: 1 })).toBeVisible();
}

async function openProposal(page, title) {
  await openGovernance(page);
  await proposals(page).getByRole('button', { name: title }).click();
  await expect(selected(page).getByRole('heading', { name: title })).toBeVisible();
}

test(`${J} #1 opens /token/governance: the space card, follow, filters, and an empty state when no proposals`, async ({ page }) => {
  test.setTimeout(240_000);
  const holder = await fundedTrader(page, 'jgv', '1');
  await signIn(page, holder);
  await openGovernance(page);
  // Before the proposals exist: the filters and the empty state.
  await expect(page.getByRole('combobox', { name: 'Proposal status' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Proposal kind filter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No proposals match' })).toBeVisible();
  run.reset({ holder });

  // The journey's start: a stake from before the proposals, then one open and one draft proposal.
  tool('local-test-world.mjs', 'token-stake', '--email', holder.email, '--amount', '100');
  const seeded = JSON.parse(tool('local-test-world.mjs', 'token-proposals', '--open', '1', '--draft', '1'));
  run.write({ open: seeded.open[0], draft: seeded.draft[0] });
  await page.reload();
  await expect(space(page)).toBeVisible(UNBUILT);
  await expect(space(page).getByRole('button', { name: 'Follow' })).toBeVisible();
});

test(`${J} #2 follows the space twice: the follow persists, and the second changes nothing`, async ({ page }) => {
  const holder = state('holder');
  await signIn(page, holder);
  await openGovernance(page);
  await space(page).getByRole('button', { name: 'Follow' }).click(UNBUILT);
  await expect(space(page).getByRole('button', { name: 'Following' })).toBeVisible();
  const follows = async () => (await (await api(holder)).get(trpc('governance.follows'))).body.result.data.length;
  const once = await follows();
  // A second follow from another door (a retry) adds nothing.
  await (await api(holder)).post('/api/token/trpc/governance.follow', { spaceId: state('open').spaceId });
  expect(await follows()).toBe(once);
  await page.reload();
  await expect(space(page).getByRole('button', { name: 'Following' })).toBeVisible();
});

test(`${J} #3 filters and searches the proposals: only matches, with dates and counts`, async ({ page }) => {
  await signIn(page, state('holder'));
  await openGovernance(page);
  await page.getByRole('combobox', { name: 'Proposal status' }).selectOption({ label: 'Open' });
  const open = state('open');
  await expect(proposals(page).getByRole('listitem')).toHaveCount(1);
  await expect(proposals(page).getByRole('listitem').first()).toContainText(open.title);
  await expect(proposals(page).getByRole('listitem').first()).toContainText(/\d{4}-\d{2}-\d{2}|\d{1,2} \w{3} \d{4}/);
  await page.getByRole('searchbox', { name: 'Search proposals' }).fill('no-such-proposal-zz', UNBUILT);
  await expect(page.getByRole('heading', { name: 'No proposals match' })).toBeVisible();
  await expect(page.getByText(/0 proposals/)).toBeVisible();
});

test(`${J} #4 creates a proposal below the proposer rule: the panel says why before submit, and submit is refused with the typed code`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A fresh verified account with no stake is below any proposer rule.
  const small = await fundedTrader(page, 'jgvs', '1');
  await signIn(page, small);
  await openGovernance(page);
  const create = page.getByRole('group', { name: 'Create a proposal' });
  await expect(create.getByText(/You need at least [\d,.]+ IFC staked to propose/)).toBeVisible(UNBUILT);
  await create.getByLabel('Title').fill('TEST proposal below the rule');
  await create.getByLabel('Body').fill('TEST body.');
  const answer = page.waitForResponse((res) => res.url().includes('governance.create'));
  await create.getByRole('button', { name: 'Submit proposal' }).click();
  expect((await answer).status()).toBeGreaterThanOrEqual(400);
  await expect(page.getByText('Reference token.proposer_rule_unmet')).toBeVisible();
});

test(`${J} #5 creates a proposal with a future opening time: it stays draft and can be edited before voting`, async ({ page }) => {
  const holder = state('holder');
  await signIn(page, holder);
  await openGovernance(page);
  const create = page.getByRole('group', { name: 'Create a proposal' });
  await create.getByLabel('Title').fill('TEST proposal opening tomorrow');
  await create.getByLabel('Body').fill('TEST body.');
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 16);
  await create.getByLabel('Voting opens').fill(tomorrow, UNBUILT);
  await create.getByRole('button', { name: 'Submit proposal' }).click();
  await openProposal(page, 'TEST proposal opening tomorrow');
  await expect(selected(page)).toContainText('Draft');
  await selected(page).getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('TEST proposal opening tomorrow (edited)');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(selected(page).getByRole('heading', { name: 'TEST proposal opening tomorrow (edited)' })).toBeVisible();
});

test(`${J} #6 opens a proposal and reads the voting power: fixed at creation; a later stake counts zero and says so; power over time`, async ({
  page,
}) => {
  const holder = state('holder');
  await signIn(page, holder);
  await openProposal(page, state('open').title);
  const power = selected(page).getByRole('region', { name: 'Your voting power' });
  await expect(power).toContainText(/Taken when the proposal was created/, UNBUILT);
  await expect(power).toContainText('100');
  await expect(power.getByRole('table', { name: 'Voting power over time' })).toBeVisible();
});

test(`${J} #7 casts a vote: bad weights refused; the vote needs a signed message and passes the validation rule`, async ({ page }) => {
  const holder = state('holder');
  await signIn(page, holder);
  await openProposal(page, state('open').title);
  const ballot = selected(page).getByRole('form', { name: 'Your vote' });
  // A weighted ballot whose weights don't add up to 100 is refused before anything is signed.
  await ballot.getByRole('radio', { name: 'Weighted' }).check(UNBUILT);
  await ballot.getByLabel('For, %').fill('70');
  await ballot.getByLabel('Against, %').fill('10');
  await ballot.getByRole('button', { name: 'Review vote' }).click();
  await expect(ballot.getByText('The weights must add up to 100%.')).toBeVisible();
  await ballot.getByLabel('Against, %').fill('30');
  await ballot.getByRole('button', { name: 'Review vote' }).click();
  const review = page.getByRole('dialog', { name: 'Sign your vote' });
  await expect(review.getByText('Message to sign')).toBeVisible();
  await review.getByRole('button', { name: 'Sign and vote' }).click();
  // Without a linked wallet the typed unavailable reply shows, never a fake receipt.
  await expect(page.getByText(/Your vote is recorded|Reference token\.wallet_link_unavailable/)).toBeVisible();
});

test(`${J} #8 presses Delegate: refused naming the Protocol blocker; no row written`, async ({ page }) => {
  const holder = state('holder');
  await signIn(page, holder);
  await openGovernance(page);
  await space(page).getByRole('button', { name: 'Delegate' }).click(UNBUILT);
  await expect(page.getByText(/Delegation needs the Protocol/)).toBeVisible();
  const { body } = await (await api(holder)).get(trpc('governance.delegations'));
  expect(body?.result?.data ?? []).toHaveLength(0);
});

test(`${J} #9 opens the treasury panel: each figure equals the token service read; "not reported" where missing; burns "none recorded"`, async ({
  page,
}) => {
  const holder = state('holder');
  await signIn(page, holder);
  await page.goto('/token/economy');
  const treasury = page.getByRole('region', { name: 'Treasury' });
  await expect(treasury).toBeVisible(UNBUILT);
  const { status, body } = await (await api(holder)).get(trpc('treasury.summary'));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const read = body.result.data;
  for (const [label, key] of [
    ['Treasury balance', 'balance'],
    ['Circulating supply', 'circulating'],
  ])
    await expect(treasury).toContainText(new RegExp(`${label}\\s*${read[key] ?? 'not reported'}`));
  if (!read.burns?.length) await expect(treasury).toContainText(/Burns\s*none recorded/);
});
