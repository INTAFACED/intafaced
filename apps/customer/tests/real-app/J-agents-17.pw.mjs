import { test, expect } from '@playwright/test';
import { agentsRun } from './agents.mjs';
import { signIn } from './desk.mjs';
import { tool } from './stack.mjs';

// J-agents-17, in the running app (docs/roadmap/journeys.json): ask the Coach inside a lesson. One test per step,
// titled "J-agents-17 #<n>", run in order on one verified TEST account reading the Academy lesson "Risk first". The
// Coach cites only lessons the curriculum returns, never invents a citation, refuses advice, and is billed through the
// usual meter. On the stack the Coach route is the profile's TEST route on the mock engine at a published price of 0
// (tooling/profiles/test-owner-values/agents.json), so every answer is marked TEST and bills 0.
// Each step reads the service's own answer to coach.runSession back as well as the screen, so a typed code is checked
// exactly, not inferred from words. #4 restarts svc-agents with the Coach route unset and restores it in a finally.
const J = 'J-agents-17';
const agents = agentsRun(J);
const LESSON = '/academy/foundations-risk-first?path=foundations';
const SIZING = { slug: 'foundations-position-sizing', title: 'Position sizing without inventing numbers' };
const INVALIDATION = { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' };

test.describe.configure({ mode: 'default' });

const coach = (page) => page.getByRole('main').getByRole('region', { name: 'Coach', exact: true });

/** The tRPC answer's data, whether or not the transport wraps it. */
const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;

/** Opens the lesson, asks the Coach `question` in its panel, and returns the answer region with the service's answer. */
const COST_MISSING = 'The Coach has no route on this deployment, so every question is refused.';

/** Asks once the cost line has read the Coach route: its figures when routed, the missing-route line when not. */
async function ask(page, question, costLine = (panel) => panel.getByTestId('coach-cost')) {
  await signIn(page, agents.account());
  await page.goto(LESSON);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Risk first', level: 2 })).toBeVisible();
  const panel = coach(page);
  await expect(costLine(panel)).toBeVisible();
  await panel.getByRole('textbox', { name: /^Ask the Coach/ }).fill(question);
  const reply = page.waitForResponse((res) => res.url().includes('coach.runSession') && res.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Ask' }).click();
  const response = await reply;
  return { answer: panel.getByRole('region', { name: 'Coach answer' }), status: response.status(), body: await response.json() };
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
  const { answer, status, body } = await ask(page, 'TEST: why does position size matter more than entry?');
  expect(status).toBe(200);
  const data = dataOf(body);
  expect(data).toMatchObject({ status: 'answered', engine: 'sandbox', assetId: expect.any(String), replayed: false });
  expect(data.citations).toEqual([SIZING, INVALIDATION]);
  expect(data.charge).toEqual({ state: 'settled', billedAmount: '0' });
  expect(data.runKey).toMatch(new RegExp(`^agents:run:${data.sessionId}:coach:[0-9a-f]{32}$`));

  // The screen shows exactly the service's citations as lesson links, the TEST mark and the 0 bill.
  const cited = answer.getByRole('list', { name: 'Lessons cited' }).getByRole('link');
  await expect(cited).toHaveText([SIZING.title, INVALIDATION.title]);
  expect(await cited.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual([
    `/academy/${SIZING.slug}`,
    `/academy/${INVALIDATION.slug}`,
  ]);
  await expect(answer.getByTestId('coach-billed')).toContainText('0');
  await expect(answer.getByTestId('coach-billed')).toContainText('TEST');

  // Every link resolves to the curriculum lesson it names.
  for (const lesson of [SIZING, INVALIDATION]) {
    await page.goto(`/academy/${lesson.slug}`);
    await expect(page.getByRole('main').getByRole('heading', { name: lesson.title, level: 2 })).toBeVisible();
  }
});

test(`${J} #2 asks about something the curriculum does not cover: says it is not covered and gives no citation`, async ({ page }) => {
  const { answer, status, body } = await ask(page, 'TEST: what will the weather be on Mars next week?');
  expect(status).toBe(200);
  expect(dataOf(body)).toEqual({ status: 'not_covered', citations: [] });
  await expect(answer).toContainText('The curriculum does not cover this.');
  await expect(answer.getByRole('list', { name: 'Lessons cited' })).toHaveCount(0);
  await expect(answer.getByRole('link')).toHaveCount(0);
});

test(`${J} #3 asks for a return promise: refused as advice`, async ({ page }) => {
  const { answer, status, body } = await ask(page, 'TEST: promise me 20% a month if I follow this lesson');
  expect(status).toBe(200);
  expect(dataOf(body)).toEqual({ status: 'refused', code: 'agents.advice_forbidden' });
  const alert = coach(page).getByRole('alert');
  await expect(alert).toContainText('The Coach does not give financial advice.');
  await expect(alert).toHaveAttribute('data-refusal-code', 'agents.advice_forbidden');
  await expect(answer).toHaveCount(0);
});

/** svc-agents restarted with the Coach route unset, or back on the profile's TEST route. */
function coachRoute(published) {
  const before = process.env.LOCAL_STACK_AGENTS_COACH_ROUTE;
  if (published) delete process.env.LOCAL_STACK_AGENTS_COACH_ROUTE;
  else process.env.LOCAL_STACK_AGENTS_COACH_ROUTE = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'agents');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_AGENTS_COACH_ROUTE;
    else process.env.LOCAL_STACK_AGENTS_COACH_ROUTE = before;
  }
}

test(`${J} #4 runs the Coach with no model set: a refusal that the Coach engine is unavailable`, async ({ page }) => {
  test.setTimeout(240_000);
  try {
    coachRoute(false);
    const { answer, status, body } = await ask(page, 'TEST: explain drawdown', (panel) => panel.getByText(COST_MISSING));
    await expect(coach(page).getByText(COST_MISSING)).toBeVisible();
    await expect(coach(page).getByTestId('coach-cost')).toHaveCount(0);
    expect(status).toBe(200);
    expect(dataOf(body)).toEqual({ status: 'refused', code: 'agents.coach_engine_unavailable' });
    const alert = coach(page).getByRole('alert');
    await expect(alert).toContainText('The Coach engine is unavailable');
    await expect(alert).toHaveAttribute('data-refusal-code', 'agents.coach_engine_unavailable');
    await expect(answer).toHaveCount(0);
  } finally {
    coachRoute(true);
  }
});
