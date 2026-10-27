import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-17, in the running app (docs/roadmap/journeys.json): ask the AI Coach inside a lesson. One test per step,
// titled "J-agents-17 #<n>", run in order on one verified TEST account reading the Academy lesson "Risk first". The
// Coach cites only lessons the curriculum returns, never invents a citation, refuses advice, and is billed through the
// usual meter; a stub engine bills 0 and labels every answer TEST.
// What is built: the lesson reader, and the Agents room's Coach section ("Curriculum coach"), which today refuses with
// library_import_pending. Steps not built yet fail at their first missing part, quickly (UNBUILT):
// - the lesson reader has no Coach panel (RC-agents-02);
// - the stack's routing table names no Coach task, so #1 to #3 also need a TEST Coach route once the panel lands; #4 is
//   that state.
const J = 'J-agents-17';
const agents = agentsRun(J);
const LESSON = '/academy/foundations-risk-first?path=foundations';

test.describe.configure({ mode: 'default' });

const coach = (page) => page.getByRole('main').getByRole('region', { name: 'Coach' });

/** Opens the lesson, asks the Coach `question` in its panel, and returns the answer region. */
async function ask(page, question) {
  await signIn(page, agents.account());
  await page.goto(LESSON);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Risk first', level: 2 })).toBeVisible();
  await coach(page)
    .getByRole('textbox', { name: /^Ask the Coach/ })
    .fill(question, UNBUILT);
  await coach(page).getByRole('button', { name: 'Ask' }).click();
  return coach(page).getByRole('region', { name: 'Coach answer' });
}

test(`${J} starts: a verified TEST account reading a lesson in Academy`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag17', '10');
  await signIn(page, agents.account());
  await page.goto(LESSON);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Risk first', level: 2 })).toBeVisible();
});

test(`${J} #1 opens the Coach panel and asks about the lesson: an answer citing only curriculum lessons, with working links`, async ({
  page,
}) => {
  const answer = await ask(page, 'TEST: why does position size matter more than entry?');
  const cited = answer.getByRole('list', { name: 'Lessons cited' }).getByRole('link');
  await expect(cited.first()).toBeVisible();
  for (const href of await cited.evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
    expect(href).toMatch(/^\/academy\/[a-z0-9-]+/);
  await cited.first().click();
  await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
  await expect(page.getByRole('main').getByRole('heading', { name: 'This address is not available' })).toHaveCount(0);
});

test(`${J} #2 asks about something the curriculum does not cover: says it is not covered and gives no citation`, async ({ page }) => {
  const answer = await ask(page, 'TEST: what will the weather be on Mars next week?');
  await expect(answer).toContainText('The curriculum does not cover this.');
  await expect(answer.getByRole('list', { name: 'Lessons cited' })).toHaveCount(0);
});

test(`${J} #3 asks for a return promise: refused as advice`, async ({ page }) => {
  const answer = await ask(page, 'TEST: promise me 20% a month if I follow this lesson');
  await expect(coach(page).getByRole('alert')).toContainText('The Coach does not give financial advice.');
  await expect(answer).toHaveCount(0);
});

test(`${J} #4 runs the Coach with no model set: a refusal that the Coach engine is unavailable`, async ({ page }) => {
  await ask(page, 'TEST: explain drawdown');
  await expect(coach(page).getByRole('alert')).toContainText('The Coach engine is unavailable');
});
