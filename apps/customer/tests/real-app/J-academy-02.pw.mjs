import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-02, in the running app (docs/roadmap/journeys.json): enrol in a free course and start learning. One test per
// step, titled "J-academy-02 #<n>", run in order. The learner is a verified TEST account signed up in the browser; the
// courses are what svc-academy publishes, nothing is seeded by hand.
// Not here yet: #3 (the grant on /academy/progress), #4 (a course that starts next week), #5 (My learning sections),
// #6 (Start course and the outline) and #7 (leave and re-enrol from the course page); their slices come next.
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
