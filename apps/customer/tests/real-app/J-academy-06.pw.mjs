import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-academy-06, in the running app (docs/roadmap/journeys.json): follow a learning programme and earn the programme
// certificate. One test per step, titled "J-academy-06 #<n>", run in order. Staff make two TEST programmes through
// Academy's own admin door with the stack's TEST founders, as an operator would: one of three published courses and one
// with none. Programmes are kept on the stack, so each run's programmes have addresses of their own.
const J = 'J-academy-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const COURSES = ['markets', 'builder', 'sovereign'];
/** This run's programme, named by step 1 and read back by the later steps, so a retried step finds the same one. */
const programmeOf = () => state('programme').programme;
const titleOf = (slug) => `TEST J-academy-06 programme ${slug.slice('test-j06-'.length)}`;

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function read(who, procedure, input) {
  const res = await (await api(who)).get(trpc(procedure, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Staff act through Academy's admin door with the stack's TEST founders, the same door the ops desk uses. */
let staffDoor;
async function staff(procedure, input) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await ctx.edge.mutate('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res;
}

const counts = (completed, enrolled, notEnrolled) => `${completed} completed · ${enrolled} enrolled · ${notEnrolled} not enrolled`;
const programmePage = (page) => page.locator(`[data-programme-page="${programmeOf()}"]`);

/** From the programme page, Start on one course, enrol on its page, and see the enrolment. */
async function startCourse(page, course) {
  await page.goto(`/academy/programmes/${programmeOf()}`);
  const row = programmePage(page).locator(`[data-programme-course="${course}"]`);
  await expect(row).toHaveAttribute('data-state', 'not_enrolled');
  await row.getByRole('link', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/academy/learning/course/${course}$`));
  await page.locator('[data-academy-enrol]').getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(page.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
}

/** Every item of the course but the last through the learner's own API, then the last from its page. */
async function finishCourse(page, who, course) {
  const items = (await read(who, 'curriculum', { path: course, limit: 50 })).map((row) => row.slug);
  const session = await api(who);
  for (const itemSlug of items.slice(0, -1)) {
    const done = await session.post(trpc('markCurriculumComplete'), { itemSlug });
    expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  }
  const last = items.at(-1);
  await page.goto(`/academy/${last}`);
  await page.locator(`[data-item-completion="${last}"]`).getByRole('button', { name: 'Complete and continue', exact: true }).click();
  const outline = page.locator(`[data-academy-outline="${course}"]`);
  await expect(outline.getByTestId('course-complete')).toHaveText('Course complete: every item is recorded.');
}

test(`${J} #1 the Programmes tab shows each programme with its counts, and a programme with no published courses says so`, async ({
  page,
}) => {
  const RUN = Date.now().toString(36);
  const PROGRAMME = `test-j06-${RUN}`;
  const EMPTY = `test-j06-empty-${RUN}`;
  await staff('admin.saveProgramme', {
    slug: PROGRAMME,
    title: titleOf(PROGRAMME),
    summary: 'TEST Markets, then Builder, then Sovereign.',
    courseSlugs: COURSES,
    expectedRevision: null,
    reason: `TEST ${J}: a programme of three courses`,
  });
  await staff('admin.saveProgramme', {
    slug: EMPTY,
    title: `TEST J-academy-06 empty programme ${RUN}`,
    summary: 'TEST No course is in this programme.',
    courseSlugs: [],
    expectedRevision: null,
    reason: `TEST ${J}: a programme with no courses`,
  });
  const who = await signUp(page, 'ja6');
  run.reset({ learner: who, programme: PROGRAMME });

  await page.goto('/academy/programmes');
  const list = page.locator('[data-programmes="list"]');
  const card = list.locator(`[data-programme="${PROGRAMME}"]`);
  await expect(card).toContainText(titleOf(PROGRAMME));
  await expect(card.getByTestId('programme-counts')).toHaveText(counts(0, 0, 3));
  const empty = list.locator(`[data-programme="${EMPTY}"]`);
  await expect(empty.getByTestId('programme-empty')).toHaveText('This programme has no published courses, so there is nothing to start.');

  // Each programme has its own page: the course list in order, and the empty one names why there is nothing to start.
  await card.getByRole('link', { name: 'Open programme', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/academy/programmes/${PROGRAMME}$`));
  await expect(programmePage(page).getByTestId('programme-counts')).toHaveText(counts(0, 0, 3));
  await expect(programmePage(page).locator('[data-programme-course]')).toHaveCount(3);
  for (const [i, course] of COURSES.entries())
    await expect(programmePage(page).locator('[data-programme-course]').nth(i)).toHaveAttribute('data-programme-course', course);
  await page.goto(`/academy/programmes/${EMPTY}`);
  await expect(page.locator(`[data-programme-page="${EMPTY}"]`).getByTestId('programme-empty')).toHaveText(
    'This programme has no published courses, so there is nothing to start.',
  );
});

test(`${J} #2 Start on a course I am not enrolled in opens its page with Enrol; I enrol and begin`, async ({ page }) => {
  const { learner } = state('learner');
  await signIn(page, learner);
  await startCourse(page, COURSES[0]);
  await page.goto(`/academy/programmes/${programmeOf()}`);
  await expect(programmePage(page).getByTestId('programme-counts')).toHaveText(counts(0, 1, 2));
  await expect(programmePage(page).locator(`[data-programme-course="${COURSES[0]}"]`)).toHaveAttribute('data-state', 'enrolled');
});

test(`${J} #3 finishing each course in turn raises the programme count after each completion`, async ({ page }) => {
  test.setTimeout(300_000);
  const { learner } = state('learner');
  await signIn(page, learner);
  for (const [i, course] of COURSES.entries()) {
    if (i > 0) await startCourse(page, course);
    await finishCourse(page, learner, course);
    await page.goto(`/academy/programmes/${programmeOf()}`);
    await expect(programmePage(page).getByTestId('programme-counts')).toHaveText(counts(i + 1, 0, COURSES.length - i - 1));
    await expect(programmePage(page).locator(`[data-programme-course="${course}"]`)).toHaveAttribute('data-state', 'completed');
  }
  run.write({ finished: true });
});

test(`${J} #4 after the last course the programme certificate is in the Certificates tab, apart from course certificates`, async ({
  page,
}) => {
  const { learner, programme } = state('learner', 'finished');
  const CERT = `programme:${programme}`;
  await signIn(page, learner);
  // Issued once, as the last course completed.
  const grants = (await read(learner, 'myCerts', { limit: 50 })).filter((row) => row.certId === CERT);
  expect(grants).toHaveLength(1);

  await page.goto(`/academy/programmes/${programme}`);
  await expect(programmePage(page).getByTestId('programme-certificate')).toHaveAttribute('data-state', 'earned');
  await programmePage(page).getByRole('link', { name: 'See the programme certificate', exact: true }).click();
  await expect(page).toHaveURL(/\/academy\/certificates/);
  const programmes = page.locator('[data-certificates="programmes"]');
  const card = programmes.locator(`[data-certificate="${CERT}"]`);
  await expect(card).toHaveAttribute('data-state', 'earned');
  await expect(card).toContainText(titleOf(programme));
  await expect(card.getByTestId('programme-certificate-serial')).toHaveText(`Serial number ${grants[0].publicId}`);
  // The programme certificate is not one of the course certificates.
  await expect(page.locator('[data-certificates="courses"]').locator(`[data-certificate="${CERT}"]`)).toHaveCount(0);
});
