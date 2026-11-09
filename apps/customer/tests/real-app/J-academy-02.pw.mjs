// World: none
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-02, in the running app (docs/roadmap/journeys.json): enrol in a free course and start learning. One test per
// step, titled "J-academy-02 #<n>", run in order. The learner is a verified TEST account signed up in the browser; the
// courses are what svc-academy publishes, nothing is seeded by hand.
// In #4 and #6 staff set a TEST course start and a TEST prerequisite through Academy's own admin door, as an operator
// would, and take them off again at the end.
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

  // Seats only when a cap exists, and a closed course says why in words. Staff set each condition on the third course
  // (nobody in this run is enrolled in it until #4) through Academy's admin door, one at a time, and take it off again.
  const third = (await courses())[2];
  expect(third, 'a third published course is needed for the cap and closed reasons').toBeTruthy();
  const terms = async () => {
    const res = await (
      await api(who)
    ).get(`/api/academy/trpc/courseEnrolment?input=${encodeURIComponent(JSON.stringify({ slug: third }))}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data;
  };
  const reason = `TEST ${J}`;
  const day = 24 * 3600_000;
  const page3 = async () => {
    await page.goto(`/academy/learning/course/${third}`);
    await expect(enrolBlock(page)).toHaveAttribute('data-academy-enrol', third);
    return enrolBlock(page);
  };
  const seats = (b) => b.locator('dt', { hasText: /^Seats$/ }).locator('xpath=following-sibling::dd[1]');
  try {
    // A cap: the remaining seats under it, as Academy counts them.
    await setSeatCap(third, 3, reason);
    const capped = await terms();
    expect(capped.seatCap).toBe(3);
    expect(capped.closed).toBeNull();
    await expect(seats(await page3())).toHaveText(`${capped.seatsRemaining} of 3 left`);

    // Full: a cap of the seats already taken (one other TEST learner enrols first), so none is left.
    const other = await (await page.context().browser().newContext()).newPage();
    const otherWho = await signUp(other, 'ja2o');
    await verify(other, otherWho);
    const enrolled = await (await api(otherWho)).post('/api/academy/trpc/enrolCourse', { slug: third, track: 'audit' });
    expect(enrolled.status, JSON.stringify(enrolled.body).slice(0, 300)).toBe(200);
    await other.context().close();
    const taken = capped.seatCap - capped.seatsRemaining + 1;
    await setSeatCap(third, taken, reason);
    expect(await terms()).toMatchObject({ seatCap: taken, seatsRemaining: 0, closed: 'full' });
    let closed = await page3();
    await expect(seats(closed)).toHaveText(`0 of ${taken} left`);
    await expect(closed.getByText('Every seat is taken, so the course is closed for enrolment.')).toBeVisible();
    await expect(closed.getByRole('button', { name: 'Enrol now', exact: true })).toBeDisabled();
    await setSeatCap(third, null, reason);

    // The enrolment window, not started and ended.
    for (const [window, why, words] of [
      [
        { opensAt: new Date(Date.now() + 7 * day).toISOString(), closesAt: null },
        'window_not_started',
        'The enrolment window has not started.',
      ],
      [
        { opensAt: new Date(Date.now() - 14 * day).toISOString(), closesAt: new Date(Date.now() - 7 * day).toISOString() },
        'window_ended',
        'The enrolment window has ended.',
      ],
    ]) {
      await setEnrolmentWindow(third, window, reason);
      expect((await terms()).closed).toBe(why);
      closed = await page3();
      await expect(closed.getByText(words)).toBeVisible();
      await expect(closed.getByRole('button', { name: 'Enrol now', exact: true })).toBeDisabled();
    }
    await setEnrolmentWindow(third, { opensAt: null, closesAt: null }, reason);

    // Hidden and unpublished.
    for (const [visibility, words] of [
      ['hidden', 'This course is hidden, so it is closed for enrolment.'],
      ['unpublished', 'This course is unpublished, so it is closed for enrolment.'],
    ]) {
      await setVisibility(third, visibility, reason);
      expect((await terms()).closed).toBe(visibility);
      closed = await page3();
      await expect(closed.getByText(words)).toBeVisible();
      await expect(closed.getByRole('button', { name: 'Enrol now', exact: true })).toBeDisabled();
    }
  } finally {
    await setVisibility(third, 'published', reason);
    await setEnrolmentWindow(third, { opensAt: null, closesAt: null }, reason);
    await setSeatCap(third, null, reason);
  }
  // With everything taken off, the third course is open again with no cap.
  expect(await terms()).toMatchObject({ seatCap: null, seatsRemaining: null, closed: null });
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
  // One receipt: the progress page holds exactly one free access record for the course.
  await page.goto('/academy/progress');
  await expect(page.locator(`[data-access-grant="${second}"]`)).toHaveCount(1);
  expect(sent).toHaveLength(1);
});

/** The course's items with their real types, in order, as its public course page lists them. */
async function syllabusRows(slug) {
  const res = await fetch(`${EDGE}/api/academy/trpc/publicCourse?input=${encodeURIComponent(JSON.stringify({ slug }))}`, {
    headers: { origin: ORIGIN },
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.syllabus.map((row) => ({ slug: row.slug, kind: row.kind }));
}
/** The courses' items, as their public course pages list them. */
const syllabus = async (slug) => (await syllabusRows(slug)).map((row) => row.slug);
const KIND_LABEL = { lesson: 'Lesson', quiz: 'Quiz', assignment: 'Assignment' };

const myCourse = (page, slug) => page.locator(`[data-my-learning-section] [data-my-course="${slug}"]`);

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

/** Staff act through Academy's admin door with the stack's TEST founder session, the same door the ops desk uses. */
let staffDoor;
async function staff(procedure, input) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const founders = await gates.approverSessions(ctx);
    return { ctx, token: await founders.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await ctx.edge.mutate('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
}

const setPrerequisites = (itemSlug, prerequisites) => staff('admin.setItemPrerequisites', { itemSlug, prerequisites });
const setCourseStart = (slug, startsAt) => staff('admin.setCourseStart', { slug, startsAt, reason: `TEST ${J}` });
// The staff doors #1 needs to set a seat cap, an enrolment window and a course's visibility (not in svc-academy yet).
const setSeatCap = (slug, seatCap, reason) => staff('admin.setCourseSeatCap', { slug, seatCap, reason });
const setEnrolmentWindow = (slug, window, reason) => staff('admin.setCourseEnrolmentWindow', { slug, ...window, reason });
const setVisibility = (slug, visibility, reason) => staff('admin.setCourseVisibility', { slug, visibility, reason });

test(`${J} #4 a course that starts next week takes the enrolment, shows its date, and holds its items until then`, async ({ page }) => {
  const { who } = state('who');
  const third = (await courses())[2];
  expect(third, 'a third published course is needed: #1 and #2 enrol the first two').toBeTruthy();
  const items = await syllabus(third);
  const startsAt = new Date(Date.now() + 7 * 24 * 3600_000);
  startsAt.setUTCSeconds(0, 0);
  await setCourseStart(third, startsAt.toISOString());
  try {
    await signIn(page, who);
    await page.goto(`/academy/learning/course/${third}`);
    const block = enrolBlock(page);
    await expect(block).toHaveAttribute('data-academy-enrol', third);
    await expect(block.locator(`time[datetime="${startsAt.toISOString()}"]`)).toHaveText(/^Opens on /);
    await block.getByRole('button', { name: 'Enrol now', exact: true }).click();
    await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();

    await page.goto('/academy/learning');
    const card = page.locator(`[data-my-learning-section="future_start"] [data-my-course="${third}"]`);
    await expect(card.getByText(/^Starts /)).toBeVisible();
    await expect(card.getByRole('link', { name: /Start course|Continue/ })).toHaveCount(0);

    await page.goto(`/academy/${items[0]}`);
    const outline = page.locator(`[data-academy-outline="${third}"]`);
    await expect(outline.locator('[data-outline-state="locked"]')).toHaveCount(items.length);
    await expect(outline.locator(`[data-outline-item="${items[0]}"]`)).toContainText(/Locked: opens /);
    await expect(outline.getByText('No item in this course can be opened now.')).toBeVisible();
    await expect(page.getByText('This item is closed right now: it opens on a later date, or its window has ended.')).toBeVisible();
  } finally {
    await setCourseStart(third, null);
  }
});

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

test(`${J} #6 Start course opens the first open item with the outline: typed items, a locked one with its reason, Next skipping it`, async ({
  page,
}) => {
  const { who, second } = state('who', 'second');
  const rows = await syllabusRows(second);
  const items = rows.map((row) => row.slug);
  expect(items.length, 'the course needs four items to lock the third').toBeGreaterThanOrEqual(4);
  await setPrerequisites(items[2], [items[1]]);
  try {
    await signIn(page, who);
    await page.goto('/academy/learning');
    await myCourse(page, second).getByRole('link', { name: 'Start course' }).click();
    await expect(page).toHaveURL(`/academy/${items[0]}`);
    const outline = page.locator(`[data-academy-outline="${second}"]`);
    await expect(outline.locator('[data-outline-item]')).toHaveCount(items.length);
    await expect(outline.locator(`[data-outline-item="${items[0]}"] a`)).toHaveAttribute('aria-current', 'page');
    // Each item is typed as a lesson, a quiz or an assignment, as Academy holds it, and the course has each of the three.
    expect([...new Set(rows.map((row) => row.kind))].sort()).toEqual(['assignment', 'lesson', 'quiz']);
    for (const { slug, kind } of rows)
      await expect(outline.locator(`[data-outline-item="${slug}"] [data-testid="academy-lms-meta"]`)).toContainText(KIND_LABEL[kind]);
    const locked = outline.locator(`[data-outline-item="${items[2]}"]`);
    await expect(locked).toHaveAttribute('data-outline-state', 'locked');
    await expect(locked.getByRole('link')).toHaveCount(0);
    const before = await outline.locator(`[data-outline-item="${items[1]}"] a`).innerText();
    await expect(locked).toContainText(`Locked: complete ${before} first.`);
    await expect(outline.getByText('This is the first item you can open.')).toBeVisible();

    await outline.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(page).toHaveURL(`/academy/${items[1]}`);
    await expect(outline.getByText('Locked items skipped: 1')).toBeVisible();
    await outline.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(page).toHaveURL(`/academy/${items[3]}`);
    await expect(outline.getByText('Locked items skipped: 1')).toBeVisible();
    await outline.getByRole('link', { name: 'Previous', exact: true }).click();
    await expect(page).toHaveURL(`/academy/${items[1]}`);
    // Previous skipped the locked item too, and says so.
    await expect(outline.getByText('Locked items skipped: 1')).toBeVisible();
  } finally {
    await setPrerequisites(items[2], []);
  }
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
  await expect(enrolBlock(page).getByText('Your progress is kept if you enrol again.')).toBeVisible();
  await enrolBlock(page).getByRole('button', { name: 'Confirm leave', exact: true }).click();
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

test(`${J} #8 with a mail address and no mail provider for Academy, enrolment works and the activation mail says it needs one`, async ({
  page,
}) => {
  const { who, first } = state('who', 'first');
  expect(who.email).toMatch(/@/);
  // Academy's own answer names the missing mail provider: it has no mail sender of its own.
  const terms = await (
    await api(who)
  ).get(`/api/academy/trpc/courseEnrolment?input=${encodeURIComponent(JSON.stringify({ slug: first }))}`);
  expect(terms.status, JSON.stringify(terms.body).slice(0, 300)).toBe(200);
  expect(terms.body.result.data.activationMail).toBe('vendor.email');

  // The enrolment is made in this step: leave the course, then enrol again from its page.
  await signIn(page, who);
  await page.goto(`/academy/learning/course/${first}`);
  const block = enrolBlock(page);
  await block.getByRole('button', { name: 'Leave course', exact: true }).click();
  await block.getByRole('button', { name: 'Confirm leave', exact: true }).click();
  await block.getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  expect((await enrolments(who)).filter((row) => row.pathSlug === first)).toHaveLength(1);
  await expect(block.locator('[data-not-connected="vendor.email"]')).toHaveText(
    'The activation mail needs an email delivery provider. It is switched off in this build. vendor.email',
  );
});
