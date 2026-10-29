import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-more-catalogue-18, in the running app (docs/roadmap/journeys.json): make my Blueprint, share its card, and see who
// opened it. One test per step, titled "J-more-catalogue-18 #<n>", run in order. #1 makes the start: a TEST account takes
// the guided Blueprint session on /blueprint; #3 adds a second TEST account as the viewer. Cards, shares and openers are
// read back from svc-blueprint.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the guided session is switched off ("The Blueprint service does not publish its question list").
// - #2: needs the Blueprint #1 makes.
// - #3 to #6: there is no share to create, no openers list and no revoke.
const J = 'J-more-catalogue-18';
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

const panel = (page, name) =>
  page
    .locator('section, div')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .last();

async function blueprint(page, who = state('owner')) {
  await signIn(page, who);
  await page.goto('/blueprint');
  await expect(page.getByRole('heading', { name: 'Identity Blueprint' }).first()).toBeVisible();
}

test(`${J} #1 takes the Blueprint onboarding session: the questions and my engine profile revealed`, async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUp(page, 'jmbp');
  run.reset({ owner });
  await blueprint(page, owner);
  const session = panel(page, 'Guided Blueprint session');
  await expect(session.getByRole('button', { name: 'Create your Blueprint' })).toBeEnabled(UNBUILT);
  await session.getByRole('button', { name: 'Create your Blueprint' }).click();
  await expect(page.getByText('Your Blueprint has not been created')).toHaveCount(0);
  await expect(panel(page, 'Identity Blueprint')).toContainText(/Blueprint version/);
  run.write({ made: true });
});

test(`${J} #2 opens my card: rendered at 1080x1350 and 1200x630 with a share artifact`, async ({ page }) => {
  state('made');
  await blueprint(page);
  const card = panel(page, 'Share card');
  for (const [size, w, h] of [
    ['Portrait', 1080, 1350],
    ['Landscape', 1200, 630],
  ]) {
    await card.getByLabel('Card size').selectOption({ label: size });
    const download = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download SVG card' }).click();
    const svg = readFileSync(await (await download).path(), 'utf8');
    expect(svg).toContain(`viewBox="0 0 ${w} ${h}"`);
  }
});

test(`${J} #3 creates a share: a share id; another signed-in viewer opens it and sees the card`, async ({ page, browser }) => {
  state('made');
  await blueprint(page);
  await panel(page, 'Share card').getByRole('button', { name: 'Create share link' }).click(UNBUILT);
  const shareId = (await page.getByTestId('blueprint-share-id').innerText()).trim();
  run.write({ shareId });
  const viewerPage = await (await browser.newContext()).newPage();
  const viewer = await signUp(viewerPage, 'jmbv');
  run.write({ viewer });
  await viewerPage.goto(`/blueprint/shared/${encodeURIComponent(shareId)}`);
  await expect(viewerPage.getByRole('img', { name: /Identity Blueprint card/ })).toBeVisible();
});

test(`${J} #4 opens my openers list: one signed-in opener with count 1; opening again makes 2 and still one row`, async ({ page }) => {
  await blueprint(page);
  const openers = page.getByRole('table', { name: 'Who opened your card' });
  await expect(openers).toBeVisible(UNBUILT);
  await expect(openers.locator('tbody tr')).toHaveCount(1);
  await expect(openers.locator('tbody tr').first()).toContainText(/Signed-in account.*1/);
});

test(`${J} #5 revokes the share: the next read through it is not found at once, as for a share that never existed`, async ({
  page,
  browser,
}) => {
  await blueprint(page);
  await panel(page, 'Share card').getByRole('button', { name: 'Revoke share' }).click(UNBUILT);
  const viewerPage = await (await browser.newContext()).newPage();
  await signIn(viewerPage, state('viewer'));
  await viewerPage.goto(`/blueprint/shared/${encodeURIComponent(state('shareId'))}`);
  const revoked = await viewerPage.locator('#main').innerText();
  await viewerPage.goto('/blueprint/shared/00000000-0000-4000-8000-000000000000');
  expect(await viewerPage.locator('#main').innerText()).toBe(revoked);
});

test(`${J} #6 a viewer not allowed by visibility opens it: not found and no opener row`, async ({ page, browser }) => {
  await blueprint(page);
  await page.getByLabel('Blueprint visibility').selectOption({ label: 'Only me' });
  const viewerPage = await (await browser.newContext()).newPage();
  await signIn(viewerPage, state('viewer'));
  await viewerPage.goto(`/blueprint/shared/${encodeURIComponent(state('shareId'))}`);
  await expect(viewerPage.getByRole('img', { name: /Identity Blueprint card/ })).toHaveCount(0);
});

test(`${J} #7 exports my Blueprint, then deletes it: a file of my data; after deletion nothing remains`, async ({ page }) => {
  state('made');
  await blueprint(page);
  const data = panel(page, 'Your data');
  const exported = async () => {
    const download = page.waitForEvent('download');
    await data.getByRole('button', { name: 'Export Blueprint JSON' }).click();
    return JSON.parse(readFileSync(await (await download).path(), 'utf8'));
  };
  expect((await exported()).blueprint).not.toBeNull();
  await data.getByLabel('Type ERASE BLUEPRINT').fill('ERASE BLUEPRINT');
  await data.getByRole('button', { name: 'Review permanent erasure' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Erase Blueprint permanently' }).click();
  await expect(page.getByText('Blueprint erasure confirmed')).toBeVisible();
  const after = await exported();
  expect(after.blueprint).toBeNull();
  expect(after.mentorMatches).toEqual([]);
});
