import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-more-catalogue-11, in the running app (docs/roadmap/journeys.json): browse a token launch and read its terms. One
// test per step, titled "J-more-catalogue-11 #<n>", run in order. #1 looks before any event exists; #2 seeds the
// journey's start, one open and one past TEST launch event (`local-test-world.mjs launch-events`), with an allocation by
// holdings and a snapshot that holds the person's TEST balance. Every figure is read back from the launch service.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /launch is the issuer journey; it has no list of launch events, no filters and no empty state for them.
// - #2 to #5: no launch event service, so no events, no /launch/<id> allocation or terms panels, no eligibility list
//   and no allocation basis; the stack has no `launch-events` world step.
const J = 'J-more-catalogue-11';
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

const events = (page) => page.getByRole('region', { name: 'Launch events' });

test(`${J} #1 opens /launch with no events: the full layout, filters and the empty state; no sample card`, async ({ page }) => {
  const visitor = await signUp(page, 'jln');
  run.reset({ visitor });
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launch', level: 1 })).toBeVisible();
  for (const name of ['Issuer journey', 'Pre-listing check', 'Requirements', 'My participation'])
    await expect(page.getByRole('group', { name: 'Launch sections' }).getByRole('button', { name })).toBeVisible();
  await expect(events(page)).toBeVisible(UNBUILT);
  await expect(events(page).getByRole('combobox', { name: 'State' })).toBeVisible();
  // Nothing listed, said in words, and no card stands in for one.
  await expect(events(page).getByRole('heading', { name: 'No launches are listed.' })).toBeVisible();
  await expect(events(page).getByRole('article')).toHaveCount(0);
});

test(`${J} #2 opens it with two events and filters by state: only matching cards, each with its issuer state`, async ({ page }) => {
  test.setTimeout(240_000);
  const holder = await fundedTrader(page, 'jlnh', '500');
  const seeded = JSON.parse(tool('local-test-world.mjs', 'launch-events', '--open', '1', '--past', '1', '--snapshot', holder.email));
  run.write({ holder, open: seeded.open[0], past: seeded.past[0] });
  await signIn(page, holder);
  await page.goto('/launch');
  await expect(events(page).getByRole('article')).toHaveCount(2);
  await events(page).getByRole('combobox', { name: 'State' }).selectOption({ label: 'Open' });
  const cards = events(page).getByRole('article');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(seeded.open[0].name);
  await expect(cards.first()).toContainText(/Issuer: (Verified|Not verified|In review)/);
});

test(`${J} #3 opens a launch at /launch/<id>: the allocation panel and the terms panel, "not set" where unset`, async ({ page }) => {
  const holder = state('holder');
  const open = state('open');
  await signIn(page, holder);
  await page.goto(`/launch/${encodeURIComponent(open.id)}`);
  const allocation = page.getByRole('region', { name: 'Allocation' });
  await expect(allocation).toBeVisible(UNBUILT);
  await expect(allocation).toContainText(/Method\s*(By holdings|Lottery|First come|not set)/);
  await expect(allocation).toContainText(/Cap\s*([\d.]+|not set)/);
  const terms = page.getByRole('region', { name: 'Terms' });
  await expect(terms).toContainText(/Price\s*([\d.]+ \w+|price not set)/);
  await expect(terms).toContainText(/Currency\s*(\w+|not set)/);
});

test(`${J} #4 checks eligibility: the requirements list with the unmet items`, async ({ page }) => {
  // The visitor from #1 is not verified, so identity verification is unmet.
  const visitor = state('visitor');
  await signIn(page, visitor);
  await page.goto(`/launch/${encodeURIComponent(state('open').id)}`);
  await page.getByRole('button', { name: 'Check my eligibility' }).click(UNBUILT);
  const list = page.getByRole('list', { name: 'Requirements' });
  await expect(list.getByRole('listitem').filter({ hasText: 'Identity verification' })).toContainText('Not met');
});

test(`${J} #5 reads the basis for an allocation by holdings: it equals the stored snapshot row, the cap as a decimal string`, async ({
  page,
}) => {
  const holder = state('holder');
  const open = state('open');
  await signIn(page, holder);
  await page.goto(`/launch/${encodeURIComponent(open.id)}`);
  const basis = page.getByRole('region', { name: 'Your allocation basis' });
  await expect(basis).toBeVisible(UNBUILT);
  const { status, body } = await (
    await api(holder)
  ).get(`/api/token/trpc/launch.myBasis?input=${encodeURIComponent(JSON.stringify({ launchId: open.id }))}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const row = body.result.data;
  expect(row.cap).toMatch(/^\d+(\.\d+)?$/);
  await expect(basis).toContainText(row.snapshotBalance);
  await expect(basis).toContainText(row.cap);
});
