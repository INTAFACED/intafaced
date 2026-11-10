// World: stack
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { staffSignIn } from './staff.mjs';

// J-academy-14 "Help a learner who is stuck", in the running app and the founder console (docs/roadmap/journeys.json).
// One test per step, titled "J-academy-14 #<n>", run in order. The support agent is founder B in the console (the stack's
// TEST desk agent, as in J-cex-spot-18); staff set-up goes through Academy's own admin door as founder A. The learner is a
// fresh TEST account signed up in the browser, enrolled in the Sovereign course, who completed and then undid its first
// item, failed the quiz on the second item of the Builder course they also take (one attempt allowed), and whose time-limited TEST staff access to the course has
// ended, so the course's lessons no longer open: the starting point the journey names. A second TEST learner is enrolled
// beside them, so the extension (#5) and the tag report (#7) can be seen to leave others alone.
// #8 signs in the stack's TEST support staff member (identity's TEST roster: admin:read, no admin:write; staff.mjs).
//
// The quiz on the second item and the due date on the third are staff settings on shared course items, so they are set
// here and taken off again after the last step (the journeys run one at a time on a stack, workers: 1).
const J = 'J-academy-14';
const PATH = 'sovereign';
/** The learner's second course, free and open, where the quiz they failed sits (an ended record closes quizzes too). */
const QUIZ_PATH = 'builder';
const run = journeyState(J);

test.describe.configure({ mode: 'serial' });

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function learnerRead(who, procedure, input) {
  return (await api(who)).get(trpc(procedure, input));
}
async function learnerWrite(who, procedure, input) {
  return (await api(who)).post(trpc(procedure), input);
}
const data = (res) => res.body?.result?.data;
const codeOf = (res) => JSON.stringify(res.body).match(/academy\.[a-z_]+/)?.[0] ?? null;

/** Staff act through Academy's admin door as founder A, the same door the console uses. */
let staffDoor;
async function staff(kind, procedure, input) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res =
    kind === 'query' ? await ctx.edge.query('academy', procedure, input, token) : await ctx.edge.mutate('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

const QUIZ = {
  passMark: 2,
  attemptLimit: 1,
  timeLimitSeconds: 600,
  reviewMode: 'score_only',
  questions: [
    {
      id: 'q1',
      prompt: 'TEST: who holds the keys in self-custody?',
      points: 1,
      choices: [
        { id: 'a', text: 'TEST: you' },
        { id: 'b', text: 'TEST: the exchange' },
      ],
      correctChoiceId: 'a',
    },
    {
      id: 'q2',
      prompt: 'TEST: what proves a withdrawal address?',
      points: 1,
      choices: [
        { id: 'a', text: 'TEST: a test send' },
        { id: 'b', text: 'TEST: a guess' },
      ],
      correctChoiceId: 'a',
    },
  ],
};

const DAY = 86_400_000;
/** The learner app's own date line (formatDay: dateStyle long, UTC), in either English the browser may choose. */
const dayText = (ms) =>
  ['en-US', 'en-GB'].map((locale) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(ms)));
const anyOf = (texts) => new RegExp(texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

/** A datetime-local value for instant `ms` in the browser's own time zone, as an operator would type it. */
const localInput = (page, ms) =>
  page.evaluate((at) => {
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, ms);

const learnerPage = (page) => page.getByTestId('learner-desk');
const itemRow = (page, slug) => page.locator(`[data-item="${slug}"]`);
const outcome = (page) => page.getByTestId('course-desk-outcome');

async function openLearner(page, userId) {
  await page.goto(`${ADMIN}/academy-ops/programmes/learners/${userId}`);
  await expect(learnerPage(page).getByRole('heading', { name: 'Learner', level: 2 })).toBeVisible();
}

test.afterAll(async () => {
  const { items } = run.read();
  if (!items) return;
  // Take the shared item settings off again, so no later journey meets them.
  await staff('mutation', 'admin.setQuiz', { slug: items.quiz, quiz: null, reason: `${J} TEST quiz off` });
  await staff('mutation', 'admin.setItemWindow', { itemSlug: items.due, availableFrom: null, availableUntil: null, dueAt: null });
});

test(`${J} #1 a support agent finds the stuck learner and opens their page: profile, access, enrolments, sign-in statistics and internal notes, and the note never reaches the learner`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  // The learner and a second learner, each signed up in their own browser and enrolled in the course.
  const learnerContext = await browser.newContext();
  const learnerTab = await learnerContext.newPage();
  const learner = await signUp(learnerTab, 'j14l');
  const otherContext = await browser.newContext();
  const other = await signUp(await otherContext.newPage(), 'j14o');
  await otherContext.close();
  for (const who of [learner, other]) {
    for (const slug of [PATH, QUIZ_PATH]) {
      const enrolled = await learnerWrite(who, 'enrolCourse', { slug, track: 'audit' });
      expect(enrolled.status, JSON.stringify(enrolled.body).slice(0, 300)).toBe(200);
    }
  }
  const learnerId = (await api(learner)).userId;
  const otherId = (await api(other)).userId;
  const list = data(await learnerRead(learner, 'curriculum', { path: PATH, limit: 50 }));
  expect(list.length, JSON.stringify(list).slice(0, 300)).toBeGreaterThanOrEqual(4);
  const quizList = data(await learnerRead(learner, 'curriculum', { path: QUIZ_PATH, limit: 50 }));
  expect(quizList.length, JSON.stringify(quizList).slice(0, 300)).toBeGreaterThanOrEqual(2);
  const items = { undone: list[0].slug, quiz: quizList[1].slug, due: list[2].slug, mark: list[3].slug, all: list.map((row) => row.slug) };
  const dueAt = Date.now() + 3 * DAY;
  run.reset({ learner, other, learnerId, otherId, items, dueAt });

  // What the learner did: completed the first item and undid it, and failed the one attempt the second item's quiz allows.
  const done = await learnerWrite(learner, 'markCurriculumComplete', { itemSlug: items.undone });
  expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  const undo = await learnerWrite(learner, 'undoCurriculumComplete', {
    itemSlug: items.undone,
    completedAt: data(done).completedAt,
    clientRequestId: `${J}:undo:${learnerId}`,
  });
  expect(data(undo)?.undoneAt, JSON.stringify(undo.body).slice(0, 300)).toBeTruthy();
  await staff('mutation', 'admin.setQuiz', { slug: items.quiz, quiz: QUIZ, reason: `${J} TEST quiz, one attempt` });
  await staff('mutation', 'admin.setItemWindow', {
    itemSlug: items.due,
    availableFrom: new Date(Date.now() - DAY).toISOString(),
    availableUntil: new Date(Date.now() + 30 * DAY).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
  });
  const started = await learnerWrite(learner, 'assessment.start', { slug: items.quiz });
  expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
  const finished = await learnerWrite(learner, 'assessment.finish', { attemptId: data(started).attemptId });
  expect(finished.status, JSON.stringify(finished.body).slice(0, 300)).toBe(200);
  const again = await learnerWrite(learner, 'assessment.start', { slug: items.quiz });
  expect(codeOf(again), JSON.stringify(again.body).slice(0, 300)).toBe('academy.attempt_limit');

  // Their access to the course was a time-limited TEST staff grant, and it has ended: the lesson no longer opens.
  await staff('mutation', 'admin.grantAccess', {
    userId: learnerId,
    pathSlug: PATH,
    reason: `${J} TEST access for a limited time`,
    expiresAt: new Date(Date.now() + 4_000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const closed = await learnerRead(learner, 'curriculumItem', { slug: items.mark });
  expect(codeOf(closed), JSON.stringify(closed.body).slice(0, 300)).toBe('academy.grant_expired');
  await learnerTab.goto(`/academy/${items.mark}`);
  await expect(
    learnerTab.getByText('Your access to this course has ended, so its items do not open. Ask support to reinstate it.'),
  ).toBeVisible();

  // The support agent searches for the learner by their email and lands on their page.
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/academy-ops/programmes/learners`);
  await page.getByRole('search', { name: 'Find a learner' }).getByLabel('Learner email or handle').fill(learner.email);
  await page.getByRole('button', { name: 'Find learner' }).click();
  await expect(page).toHaveURL(new RegExp(`/academy-ops/programmes/learners/${learnerId}$`));
  const desk = learnerPage(page);
  // Profile and sign-in statistics, from identity.
  await expect(desk.getByTestId('learner-handle')).toHaveText(learner.handle);
  await expect(desk.getByTestId('learner-profile')).toContainText(`id ${learnerId}`);
  await expect(desk.getByTestId('learner-login-stats')).toContainText(/\d+ in all, \d+ in the last 30 days, last /);
  // Access: the course's staff grant, ended.
  const access = desk.locator(`[data-grant="${PATH}"]`);
  await expect(access).toHaveAttribute('data-grant-state', 'expired');
  await expect(access).toContainText('Sovereign: Ended');
  await expect(access).toContainText(`${J} TEST access for a limited time`);
  // Enrolments.
  await expect(desk.getByTestId('learner-enrolments').locator(`[data-enrolment="${PATH}"]`)).toContainText('Sovereign: enrolled');
  // Internal notes: empty, then one written here, kept for staff.
  const notes = desk.getByTestId('learner-notes');
  await expect(notes.getByText('Staff only: the learner never sees these.')).toBeVisible();
  const note = `TEST ${J} internal: learner says lessons stopped opening ${learnerId.slice(0, 8)}`;
  await notes.getByLabel('Internal note', { exact: true }).fill(note);
  await notes.getByRole('button', { name: 'Save note' }).click();
  await expect(outcome(page)).toContainText('Done: internal note saved');
  await expect(notes.locator('[data-note="1"]')).toContainText(note);

  // The note never reaches the learner: not in any of their own Academy reads, nor on their pages.
  for (const [procedure, input] of [
    ['myLearning', undefined],
    ['myAccessGrants', undefined],
    ['myProgress', undefined],
    ['myEnrollments', undefined],
    ['courseOutline', { itemSlug: items.undone }],
  ]) {
    const res = await learnerRead(learner, procedure, input);
    expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(note);
  }
  for (const path of ['/academy/progress', `/academy/${items.undone}`]) {
    await learnerTab.goto(path);
    await expect(learnerTab.locator('main')).toBeVisible();
    await expect(learnerTab.getByText(note)).toHaveCount(0);
  }
  await learnerContext.close();
});

test(`${J} #2 their progress lists every item with its status and attempts, the undone item's tombstone included`, async ({ page }) => {
  const { learnerId, items, learner } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  // The learner's two courses as Academy lists them: the console must show each, every item in order.
  const quizCourse = data(await learnerRead(learner, 'curriculum', { path: QUIZ_PATH, limit: 50 })).map((row) => row.slug);
  expect(quizCourse).toContain(items.quiz);
  await founderSignIn(page, 'b');
  await openLearner(page, learnerId);
  const progress = learnerPage(page).getByTestId('learner-progress');
  // What #1's learner did, item by item: completed then undid the first Sovereign item, failed the one attempt on the
  // Builder quiz, and touched nothing else. Every item carries exactly that status, history and attempts.
  const expected = (slug) =>
    slug === items.undone
      ? { status: 'undone', text: 'Undone', history: ['completed', 'undone'], attempts: [] }
      : slug === items.quiz
        ? { status: 'not_started', text: 'Not started', history: [], attempts: [['counted', '0 of 2, not passed']] }
        : { status: 'not_started', text: 'Not started', history: [], attempts: [] };
  for (const [path, slugs] of [
    [PATH, items.all],
    [QUIZ_PATH, quizCourse],
  ]) {
    const course = progress.locator(`[data-course="${path}"]`);
    await expect(course.locator('[data-item]')).toHaveCount(slugs.length);
    for (const [i, slug] of slugs.entries()) {
      const row = course.locator('[data-item]').nth(i);
      await expect(row, `${path} item ${i}`).toHaveAttribute('data-item', slug);
      const want = expected(slug);
      await expect(row, slug).toHaveAttribute('data-item-status', want.status);
      await expect(row.getByTestId('item-status'), slug).toHaveText(want.text);
      const history = row.locator('[data-testid="item-history"] [data-history]');
      await expect(history, slug).toHaveCount(want.history.length);
      for (const [h, event] of want.history.entries()) await expect(history.nth(h), slug).toHaveAttribute('data-history', event);
      const attempts = row.locator('[data-attempt]');
      await expect(attempts, slug).toHaveCount(want.attempts.length);
      for (const [a, [state, words]] of want.attempts.entries()) {
        await expect(attempts.nth(a), slug).toHaveAttribute('data-attempt-state', state);
        await expect(attempts.nth(a), slug).toContainText(words);
      }
      // An item with a quiz says how many attempts counted; one with none tried says so.
      if (await row.getByTestId('item-quiz').count()) {
        if (want.attempts.length === 0) await expect(row.getByTestId('item-quiz').getByText('No attempt yet.'), slug).toBeVisible();
      } else expect(slug, 'the quiz item shows its quiz').not.toBe(items.quiz);
    }
  }
  await expect(itemRow(page, items.quiz).getByTestId('quiz-counted')).toHaveText('1 of 1 attempts used');
});

test(`${J} #3 Mark complete with no reason is refused by name; with a reason the item is complete and the event is listed`, async ({
  page,
}) => {
  const { learnerId, items, learner } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  await founderSignIn(page, 'b');
  await openLearner(page, learnerId);
  const row = itemRow(page, items.mark);
  const form = row.getByRole('form', { name: /^Mark .+ complete$/ });
  await form.getByRole('button', { name: 'Mark complete' }).click();
  await expect(outcome(page)).toHaveAttribute('data-code', 'academy.reason_required');
  await expect(outcome(page)).toContainText('A reason is required');
  await expect(itemRow(page, items.mark)).toHaveAttribute('data-item-status', 'not_started');
  await expect(learnerPage(page).getByTestId('learner-audit').locator('[data-audit="marked_complete"]')).toHaveCount(0);

  const reason = `TEST ${J}: finished offline, confirmed by support`;
  await itemRow(page, items.mark)
    .getByRole('form', { name: /^Mark .+ complete$/ })
    .getByLabel(/^Reason: Mark/)
    .fill(reason);
  await itemRow(page, items.mark)
    .getByRole('form', { name: /^Mark .+ complete$/ })
    .getByRole('button', { name: 'Mark complete' })
    .click();
  await expect(outcome(page)).toContainText('Done: item marked complete for the learner');
  await expect(itemRow(page, items.mark)).toHaveAttribute('data-item-status', 'completed');
  const event = learnerPage(page).getByTestId('learner-audit').locator('[data-audit="marked_complete"]');
  await expect(event).toHaveCount(1);
  await expect(event).toContainText('marked complete for the learner');
  await expect(event).toContainText(reason);
  // It is the learner's own completion now.
  const progress = data(await learnerRead(learner, 'myProgress'));
  const course = progress.courses.find((row) => row.slug === PATH);
  expect(course.items.find((row) => row.slug === items.mark)?.completedAt, JSON.stringify(course).slice(0, 400)).toBeTruthy();
});

test(`${J} #4 resetting a quiz attempt shows it voided, and the learner can retake within the rules that remain`, async ({ page }) => {
  const { learnerId, items, learner } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  await founderSignIn(page, 'b');
  await openLearner(page, learnerId);
  const quiz = itemRow(page, items.quiz);
  const attempt = quiz.locator('[data-attempt]').first();
  const reason = `TEST ${J}: the quiz page failed to load mid-attempt`;
  await attempt.getByLabel(/^Reason: Reset quiz attempt/).fill(reason);
  await attempt.getByRole('button', { name: 'Reset this attempt' }).click();
  await expect(outcome(page)).toContainText('Done: quiz attempt voided');
  await expect(itemRow(page, items.quiz).locator('[data-attempt]').first()).toHaveAttribute('data-attempt-state', 'voided');
  await expect(itemRow(page, items.quiz).locator('[data-attempt]').first()).toContainText(`Voided `);
  await expect(itemRow(page, items.quiz).locator('[data-attempt]').first()).toContainText(reason);
  await expect(itemRow(page, items.quiz).getByTestId('quiz-counted')).toHaveText('0 of 1 attempts used');
  const event = learnerPage(page).getByTestId('learner-audit').locator('[data-audit="quiz_attempt_voided"]');
  await expect(event).toContainText(reason);

  // The learner retakes: the one attempt allowed is free again, and only that one.
  const retake = await learnerWrite(learner, 'assessment.start', { slug: items.quiz });
  expect(retake.status, JSON.stringify(retake.body).slice(0, 300)).toBe(200);
  expect(data(retake).number).toBe(2);
  const finished = await learnerWrite(learner, 'assessment.finish', { attemptId: data(retake).attemptId });
  expect(finished.status, JSON.stringify(finished.body).slice(0, 300)).toBe(200);
  const third = await learnerWrite(learner, 'assessment.start', { slug: items.quiz });
  expect(codeOf(third), JSON.stringify(third.body).slice(0, 300)).toBe('academy.attempt_limit');
  await page.reload();
  await expect(itemRow(page, items.quiz).locator('[data-attempt]')).toHaveCount(2);
  await expect(itemRow(page, items.quiz).getByTestId('quiz-counted')).toHaveText('1 of 1 attempts used');
});

test(`${J} #5 an extension for this learner: they see the extended date, others see the original, and it shows who and why`, async ({
  page,
  browser,
}) => {
  const { learnerId, items, learner, other, dueAt } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  const agent = await founderSignIn(page, 'b');
  await openLearner(page, learnerId);
  const until = dueAt + 7 * DAY;
  const reason = `TEST ${J}: off sick for a week`;
  const row = itemRow(page, items.due);
  await expect(row.getByTestId('item-due')).toHaveText(/^Due for everyone /);
  const form = row.getByRole('form', { name: /^Extend .+ for this learner$/ });
  await form.getByLabel(/^New due date/).fill(await localInput(page, until));
  await form.getByLabel(/^Reason: Extend/).fill(reason);
  await form.getByRole('button', { name: 'Grant extension' }).click();
  await expect(outcome(page)).toContainText('Done: due date moved for this learner');
  // Who and why, on the learner's page and in the audit.
  await expect(itemRow(page, items.due).getByTestId('item-due')).toContainText(`moved by ${agent.userId}`);
  await expect(itemRow(page, items.due).getByTestId('item-due')).toContainText(reason);
  const event = learnerPage(page).getByTestId('learner-audit').locator('[data-audit="extension_granted"]');
  await expect(event).toContainText(reason);
  await expect(event).toContainText(`by ${agent.userId}`);

  // The learner sees their own date; the other learner sees the original. Neither sees who or why.
  const look = async (who) => {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await signIn(tab, who);
    // The first item opens for both, and its outline lists the due item with its date.
    await tab.goto(`/academy/${items.undone}`);
    const due = tab.locator(`[data-outline-item="${items.due}"]`).getByTestId('outline-due');
    await expect(due).toBeVisible();
    const seen = {
      extended: await due.getAttribute('data-due-extended'),
      text: await due.textContent(),
      page: await tab.locator('main').textContent(),
    };
    await context.close();
    return seen;
  };
  const mine = await look(learner);
  expect(mine.extended).toBe('true');
  expect(mine.text).toMatch(anyOf(dayText(until).map((d) => `Due ${d}, moved for you`)));
  expect(mine.page).not.toContain(reason);
  const theirs = await look(other);
  expect(theirs.extended).toBe('false');
  expect(theirs.text).toMatch(anyOf(dayText(dueAt).map((d) => `Due ${d}`)));
});

test(`${J} #6 reinstating the ended access grants the same record again, and its events show each move`, async ({ page }) => {
  const { learnerId, items, learner } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  const before = (await staff('query', 'admin.learner', { userId: learnerId })).access.find((g) => g.pathSlug === PATH);
  expect(before?.state, JSON.stringify(before)).toBe('expired');
  await founderSignIn(page, 'b');
  await openLearner(page, learnerId);
  const access = learnerPage(page).locator(`[data-grant="${PATH}"]`);
  const reason = `TEST ${J}: access ended while the learner was mid-course`;
  await access.getByLabel(/^Reason: Reinstate/).fill(reason);
  await access.getByRole('button', { name: 'Reinstate access' }).click();
  await expect(outcome(page)).toContainText('Done: access reinstated');
  const now = learnerPage(page).locator(`[data-grant="${PATH}"]`);
  await expect(now).toHaveAttribute('data-grant-state', 'granted');
  const events = now.getByTestId('grant-events').locator('[data-grant-event]');
  await expect(events).toHaveCount(3);
  await expect(events.nth(0)).toHaveAttribute('data-grant-event', 'granted');
  await expect(events.nth(1)).toHaveAttribute('data-grant-event', 'expired');
  await expect(events.nth(2)).toHaveAttribute('data-grant-event', 'reinstated');
  await expect(events.nth(2)).toContainText(reason);
  // The same row: one record for the course, with the same id, granted again.
  const after = (await staff('query', 'admin.learner', { userId: learnerId })).access.filter((g) => g.pathSlug === PATH);
  expect(after, JSON.stringify(after)).toHaveLength(1);
  expect(after[0].id).toBe(before.id);
  expect(after[0].state).toBe('granted');
  expect(after[0].events.map((e) => e.kind)).toEqual(['granted', 'expired', 'reinstated']);
  // The learner's lessons open again.
  const open = await learnerRead(learner, 'curriculumItem', { slug: items.mark });
  expect(open.status, JSON.stringify(open.body).slice(0, 300)).toBe(200);
  await expect(learnerPage(page).getByTestId('learner-audit').locator('[data-audit="grant_reinstated"]')).toContainText(reason);
});

test(`${J} #7 a tag added to the learner appears, and the learners report filtered by it lists only tagged learners`, async ({ page }) => {
  const { learnerId, otherId } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  const tag = `test-j14-${learnerId.slice(0, 8)}`;
  await founderSignIn(page, 'b');
  await openLearner(page, learnerId);
  const tags = learnerPage(page).getByTestId('learner-tags');
  const add = tags.getByRole('form', { name: 'Add a tag' });
  await add.getByLabel('Tag', { exact: true }).fill(tag);
  await add.getByLabel('Reason: Add a tag').fill(`TEST ${J}: needs a check-in next week`);
  await add.getByRole('button', { name: 'Add tag' }).click();
  await expect(outcome(page)).toContainText('Done: tag added');
  await expect(learnerPage(page).getByTestId('learner-tags').locator(`[data-tag="${tag}"]`)).toBeVisible();
  await expect(learnerPage(page).getByTestId('learner-audit').locator('[data-audit="tag_added"]')).toContainText(`Tag ${tag} added`);

  await learnerPage(page).getByTestId('learner-tags').getByRole('link', { name: tag }).click();
  await expect(page).toHaveURL(new RegExp(`/academy-ops/programmes/learners\\?tag=${tag}$`));
  const report = page.getByTestId('learners-report');
  await expect(report).toHaveAttribute('data-tag', tag);
  await expect(report.locator('[data-learner]')).toHaveCount(1);
  await expect(report.locator(`[data-learner="${learnerId}"]`)).toContainText(tag);
  // The other learner, enrolled in the same course and untagged, is a learner of the report too, but not under this tag.
  await expect(report.locator(`[data-learner="${otherId}"]`)).toHaveCount(0);
  expect((await staff('query', 'admin.learners', { tag })).rows.map((row) => row.userId)).toEqual([learnerId]);
  expect((await staff('query', 'admin.learner', { userId: otherId })).enrolments.map((row) => row.pathSlug)).toContain(PATH);
});

test(`${J} #8 a read-only support agent reads the page with no unenrol or override control, and a direct change is refused as not permitted`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { learnerId, items } = run.read();
  if (!learnerId) throw new Error(`${J} #1 left no learner`);
  await staffSignIn(page, browser, 'support');
  await openLearner(page, learnerId);
  const desk = learnerPage(page);
  // Readable: the same page, every part of it.
  await expect(desk.getByTestId('learner-read-only')).toHaveText('Read only: your role can read this learner but not change anything.');
  await expect(desk.getByTestId('learner-profile')).toContainText(`id ${learnerId}`);
  await expect(desk.getByTestId('learner-login-stats')).toContainText(' in all, ');
  await expect(desk.locator(`[data-grant="${PATH}"]`)).toHaveAttribute('data-grant-state', 'granted');
  await expect(desk.getByTestId('learner-notes').locator('[data-note="1"]')).toBeVisible();
  await expect(desk.getByTestId('learner-progress').locator(`[data-course="${PATH}"] [data-item]`)).toHaveCount(items.all.length);
  await expect(itemRow(page, items.quiz).locator('[data-attempt]')).toHaveCount(2);
  await expect(desk.getByTestId('learner-audit').locator('[data-audit]').first()).toBeVisible();
  // No unenrol and no override: not a single change control on the page.
  for (const name of [
    /unenrol/i,
    'Mark complete',
    'Reset this attempt',
    'Grant extension',
    'Reinstate access',
    'Grant access',
    'Save note',
    'Add tag',
    'Remove tag',
  ])
    await expect(desk.getByRole('button', { name })).toHaveCount(0);
  await expect(desk.locator('form')).toHaveCount(0);

  // A direct call from this session, past the page, is refused as not permitted, and nothing changes.
  // Every item of every course the learner takes, by slug: the quiz sits in the second course.
  const itemsNow = async () => (await staff('query', 'admin.learnerProgress', { userId: learnerId })).courses.flatMap((c) => c.items);
  const attemptId = (await itemsNow()).find((i) => i.slug === items.quiz).quiz.attempts.find((a) => a.voided === null).attemptId;
  const direct = await page.evaluate(
    async ({ userId, itemSlug, attemptId }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const send = async (body) => {
        const res = await fetch('/api/academy-learners', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
          body: JSON.stringify({ userId, ...body }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      return [
        await send({ op: 'markComplete', itemSlug, reason: 'TEST read-only override', key: `override:${userId}:${itemSlug}:ro` }),
        await send({ op: 'voidAttempt', attemptId, reason: 'TEST read-only reset' }),
      ];
    },
    { userId: learnerId, itemSlug: items.undone, attemptId },
  );
  for (const answer of direct) {
    expect(answer.status, JSON.stringify(answer.body)).toBe(403);
    expect(answer.body).toMatchObject({ ok: false, code: 'academy.permission_denied', title: 'Not permitted: this session may only read' });
  }
  const after = await itemsNow();
  expect(after.find((i) => i.slug === items.undone).status).toBe('undone');
  expect(after.find((i) => i.slug === items.quiz).quiz.attempts.find((a) => a.attemptId === attemptId).voided).toBeNull();
});
