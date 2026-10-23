import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-02, in the running app (docs/roadmap/journeys.json): enrol in a free course and start learning. One test per
// step, titled "J-academy-02 #<n>", run in order. The learner is a verified TEST account signed up in the browser; the
// courses are what svc-academy publishes, nothing is seeded by hand.
// Not here yet: #4 (a course that starts next week) and #6 (Start course and the outline sidebar); their slices come next.
const J = 'J-academy-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

/** The published courses, as the Learning tab reads them. */
async function courses() {
  const res = await fetch(`${EDGE}/api/academy/trpc/publicCourses`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.map((card) => card.slug);
}

/** The learner's own active enrolments, read from Academy with a session of their own. */
async function enrolments(who) {
  const res = await (await api(who)).get('/api/academy/trpc/myEnrollments');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const enrolBlock = (page) => page.locator('[data-academy-enrol]');

test(`${J} #1 a course page offers Enrol now on the free track, with the start date, seats not set and the paid track closed in words`, async ({
  page,
}) => {
  const [first, second] = await courses();
  expect(second, 'two published courses are needed: #1 enrols one, #2 the other').toBeTruthy();
  const who = await signUp(page, 'ja2');
  await verify(page, who);
  run.reset({ who, first, second });
  await signIn(page, who);

  await page.goto(`/academy/learning/course/${first}`);
  const block = enrolBlock(page);
  await expect(block).toHaveAttribute('data-academy-enrol', first);
  await expect(block.getByText('Self-paced: the course opens when you enrol.')).toBeVisible();
  await expect(block.locator('dd').nth(1)).toHaveText('Not set');
  await expect(block.getByRole('radio', { name: /Free track/ })).toBeChecked();
  await expect(block.getByRole('radio', { name: /Certificate track/ })).toBeDisabled();
  await expect(block.getByText('No price is set for this track, so it is closed for enrolment.')).toBeVisible();
  // Nothing is open to close the course: no cap, no window, published. A closed course would say why here instead.
  await expect(block.getByText(/closed for enrolment/)).toHaveCount(1);

  await block.getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  await expect(block.getByRole('button', { name: 'Enrol now', exact: true })).toHaveCount(0);
  expect((await enrolments(who)).filter((row) => row.pathSlug === first)).toHaveLength(1);
});

test(`${J} #2 pressing Enrol now twice with the reply lost sends one request, records one enrolment, and the page reads it back`, async ({
  page,
}) => {
  const { who, second } = state('who', 'second');
  await signIn(page, who);
  const sent = [];
  // The service gets the request and answers; the browser never sees the answer, as when a connection drops.
  await page.route('**/api/academy/trpc/enrolCourse**', async (route) => {
    sent.push(route.request().url());
    await route.fetch();
    await route.abort('connectionreset');
  });

  await page.goto(`/academy/learning/course/${second}`);
  const block = enrolBlock(page);
  await expect(block.getByRole('radio', { name: /Free track/ })).toBeChecked();
  await block.getByRole('button', { name: 'Enrol now', exact: true }).dblclick();
  await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  expect(sent).toHaveLength(1);
  expect((await enrolments(who)).filter((row) => row.pathSlug === second)).toHaveLength(1);

  // A reload reads the same stored enrolment; nothing new is sent.
  await page.reload();
  await expect(enrolBlock(page).getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  expect(sent).toHaveLength(1);
});

test(`${J} #8 with a mail address and no mail provider for Academy, enrolment works and the activation mail says it needs one`, async ({
  page,
}) => {
  const { who, first } = state('who', 'first');
  expect(who.email).toMatch(/@/);
  await signIn(page, who);
  await page.goto(`/academy/learning/course/${first}`);
  const block = enrolBlock(page);
  await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  await expect(block.locator('[data-not-connected="vendor.email"]')).toHaveText(
    'The activation mail needs an email delivery provider. It is switched off in this build. vendor.email',
  );
});

/** The courses' first items, as their public course pages list them. */
async function syllabus(slug) {
  const res = await fetch(`${EDGE}/api/academy/trpc/publicCourse?input=${encodeURIComponent(JSON.stringify({ slug }))}`, {
    headers: { origin: ORIGIN },
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.syllabus.map((row) => row.slug);
}

const myCourse = (page, slug) => page.locator(`[data-my-learning-section] [data-my-course="${slug}"]`);

test(`${J} #5 Learning shows My learning by state with real progress, and Start course until something is read`, async ({ page }) => {
  const { who, first, second } = state('who', 'first', 'second');
  await signIn(page, who);
  await page.goto('/academy/learning');
  const mine = page.locator('[data-academy-my-learning="true"]');
  await expect(mine.getByRole('heading', { name: 'In progress' })).toBeVisible();
  await expect(mine.getByRole('heading', { name: 'Completed' })).toBeVisible();
  await expect(mine.getByRole('heading', { name: 'Starts later' })).toBeVisible();
  await expect(mine.getByText('No course completed.')).toBeVisible();
  await expect(mine.getByText('No course with a later start date.')).toBeVisible();
  for (const slug of [first, second]) {
    const items = await syllabus(slug);
    const card = page.locator(`[data-my-learning-section="in_progress"] [data-my-course="${slug}"]`);
    await expect(card.getByText(`0 of ${items.length} items done`)).toBeVisible();
    await expect(card.getByText(/^Enrolled since /)).toBeVisible();
    await expect(card.getByRole('link', { name: 'Continue' })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Start course' })).toHaveAttribute('href', `/academy/${items[0]}`);
  }
});

test(`${J} #3 /academy/progress shows a free access record with no expiry for each enrolled course`, async ({ page }) => {
  const { who, first, second } = state('who', 'first', 'second');
  await signIn(page, who);
  await page.goto('/academy/progress');
  for (const slug of [first, second]) {
    const grant = page.locator(`[data-access-grant="${slug}"]`);
    await expect(grant).toBeVisible();
    await expect(grant.getByText('Free enrolment')).toBeVisible();
    await expect(grant.getByText('No expiry')).toBeVisible();
  }
  await expect(page.locator('[data-access-grant]')).toHaveCount(2);
});

test(`${J} #7 leaving a course keeps its progress, and enrolling again restores it`, async ({ page }) => {
  const { who, first } = state('who', 'first');
  const items = await syllabus(first);
  await signIn(page, who);

  // The learner completes the course's first item in the reader, as a person does.
  await page.goto(`/academy/${items[0]}`);
  await page.getByRole('button', { name: 'Review lesson completion' }).click();
  await page.getByRole('button', { name: 'Record completion' }).click();
  await expect(page.getByText('Lesson completion recorded.')).toBeVisible();
  await page.goto('/academy/learning');
  await expect(myCourse(page, first).getByText(`1 of ${items.length} items done`)).toBeVisible();
  await expect(myCourse(page, first).getByRole('link', { name: 'Continue' })).toBeVisible();

  await page.goto(`/academy/learning/course/${first}`);
  await enrolBlock(page).getByRole('button', { name: 'Leave course', exact: true }).click();
  await expect(enrolBlock(page).getByRole('button', { name: 'Enrol now', exact: true })).toBeVisible();
  await page.goto('/academy/learning');
  await expect(page.locator('[data-academy-my-learning="true"]')).toBeVisible();
  await expect(myCourse(page, first)).toHaveCount(0);
  expect((await enrolments(who)).filter((row) => row.pathSlug === first)).toHaveLength(0);

  await page.goto(`/academy/learning/course/${first}`);
  await enrolBlock(page).getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(enrolBlock(page).getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  await page.goto('/academy/learning');
  await expect(myCourse(page, first).getByText(`1 of ${items.length} items done`)).toBeVisible();
  await expect(myCourse(page, first).getByRole('link', { name: 'Continue' })).toBeVisible();
});
