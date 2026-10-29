import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-more-catalogue-19, in the running app (docs/roadmap/journeys.json): join a crew and see my mentor matches. One test
// per step, titled "J-more-catalogue-19 #<n>", run in order on one TEST account with a Blueprint. Crews, mentor matches
// and the derived trading defaults are read back from svc-blueprint and svc-trade.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: no Blueprint can be made from the app (the guided session is switched off), so the account has none.
// - #1: /blueprint/crew reads a placement but has no way to ask for a crew match.
// - #3: the mentor shortlist only reads; there is no way to ask for mentors.
// - #4: there is no trading guardrails page with defaults from the Blueprint.
const J = 'J-more-catalogue-19';
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

const room = (page) => page.getByRole('main');

async function crew(page) {
  await signIn(page, state('who'));
  await page.goto('/blueprint/crew');
  await room(page).getByRole('button', { name: 'View own crew', exact: true }).click();
}

test(`${J} #1 asks to be matched to a crew: a matched crew and its room`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'jmcr');
  run.reset({ who });
  await page.goto('/blueprint');
  await room(page).getByRole('button', { name: 'Create your Blueprint' }).click(UNBUILT);
  await page.goto('/blueprint/crew');
  await room(page).getByRole('button', { name: 'Find me a crew' }).click();
  await room(page).getByRole('button', { name: 'View own crew', exact: true }).click();
  await expect(room(page).getByText('Recorded placement and member roles for your account.')).toBeVisible();
  run.write({ matched: true });
});

test(`${J} #2 opens the crew room: members, crew XP and the season`, async ({ page }) => {
  state('matched');
  await crew(page);
  await expect(room(page).getByText('Crew XP count')).toBeVisible();
  await expect(room(page).getByText('Season')).toBeVisible();
  await expect(room(page).getByRole('list', { name: 'Crew members' }).getByRole('listitem').first()).toBeVisible();
});

test(`${J} #3 asks for mentors: a shortlist built only from returned matches`, async ({ page }) => {
  await signIn(page, state('who'));
  await page.goto('/blueprint');
  const find = room(page).getByRole('button', { name: 'Find mentors' });
  await expect(find).toBeVisible(UNBUILT);
  const ask = page.waitForResponse((res) => res.url().includes('blueprint.matchMentors'));
  await find.click();
  const matches = (await (await ask).json()).result.data;
  const rows = room(page).getByRole('list', { name: 'Mentor shortlist' }).getByRole('listitem');
  await expect(rows).toHaveCount(matches.length);
});

test(`${J} #4 opens my trading guardrails: defaults derived from my Blueprint, editable`, async ({ page }) => {
  await signIn(page, state('who'));
  await page.goto('/trade/guardrails');
  await expect(page.getByRole('heading', { name: 'Trading guardrails', level: 1 })).toBeVisible(UNBUILT);
  await expect(room(page).getByText(/From your Blueprint/)).toBeVisible();
  await expect(room(page).getByRole('spinbutton').first()).toBeEditable();
});
