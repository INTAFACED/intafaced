import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api } from './stack.mjs';
import { signUp } from './desk.mjs';

// J-academy-12, in the running app (docs/roadmap/journeys.json): a founder adds a quiz and an assignment to a draft course,
// schedules release and sets the gradebook. One test per step, titled "J-academy-12 #<n>", run in order. The founder is the
// stack's LOCAL TEST founder A, on the founder console's course item pages. The draft course with its outline is made
// through Academy's own admin door first, as the journey starts from one. Courses are kept on the stack, so each run's
// course has an address of its own. Learners act through their own API, signed up in the browser.
const J = 'J-academy-12';
const RUN = Date.now().toString(36);
const SLUG = `test-j12-${RUN}`;
const TITLE = `TEST J-academy-12 course ${RUN}`;
const CODE = `TEST-${RUN}`;

test.describe.configure({ mode: 'serial' });

/** What the steps before a step left behind (serial, one worker). */
const run = { courseId: null, quizId: null, learner: null };

function needs(...keys) {
  for (const key of keys) if (!run[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to work on`);
}

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

/** A learner's write through their own API; answers the raw reply so a step can read a refusal. */
async function learnerWrite(who, procedure, input) {
  return (await api(who)).post(trpc(procedure), input);
}

/** Staff act through Academy's admin door with the stack's TEST founder A, the same door the ops desk uses. */
let staffDoor;
async function staff(kind, procedure, input) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await ctx.edge[kind]('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

/** Founder A on the console, in a context of its own. */
async function console_(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  return page;
}

/** A learner signs up in the browser (which leaves them signed in) and enrols on the free track through their own API. */
async function enrolledLearner(browser, prefix) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(page, prefix);
  await page.context().close();
  const res = await learnerWrite(who, 'enrolAuthoredCourse', { slug: SLUG, track: 'audit' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return who;
}

const quizPage = (page) => page.goto(`/academy-ops/catalogue/courses/${run.courseId}/items/${run.quizId}`);
const editor = (page) => page.getByTestId('quiz-editor');

async function saveDraft(page) {
  await editor(page).getByRole('button', { name: 'Save quiz draft' }).click();
  await expect(editor(page).getByText('quiz saved as a draft')).toBeVisible();
}

async function publish(page, reason) {
  await editor(page).getByLabel('Reason', { exact: true }).fill(reason);
  await editor(page).getByRole('button', { name: 'Publish quiz' }).click();
}

test(`${J} #1 publishing a quiz with no pass mark refuses by name; two attempts and no scoring policy refuses; a quiz with attempts stays published`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // The journey starts from a draft course with an outline: a lesson, a quiz and an assignment.
  const course = await staff('mutate', 'admin.createCourse', {
    slug: SLUG,
    title: TITLE,
    summary: 'TEST A course a founder adds graded work to.',
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
  });
  const outline = await staff('mutate', 'admin.saveOutline', {
    courseId: course.id,
    revision: course.revision,
    sections: [
      {
        title: 'TEST Week one',
        items: [
          { kind: 'lesson', title: 'TEST Sizing a trade', indent: 0, url: null },
          { kind: 'quiz', title: 'TEST Check yourself', indent: 0, url: null },
          { kind: 'assignment', title: 'TEST Write-up', indent: 0, url: null },
        ],
      },
    ],
  });
  run.courseId = course.id;
  run.quizId = outline.outline[0].items[1].id;

  const page = await console_(browser);
  await quizPage(page);
  await expect(editor(page)).toBeVisible();
  // Nothing saved yet: a draft with every blocker named, and no invented question.
  await expect(editor(page).getByTestId('quiz-blockers')).toContainText('No questions yet');
  await expect(editor(page).getByTestId('quiz-blockers')).toContainText('The pass mark is not set');
  await expect(editor(page).locator('[data-question]')).toHaveCount(0);

  // One question, no pass mark: saved as a draft, and Publish is refused naming the pass mark.
  await editor(page).getByRole('button', { name: 'Add question' }).click();
  await editor(page).getByLabel('Question 1', { exact: true }).fill('TEST What caps the loss on one trade?');
  await editor(page).getByLabel('Question 1 points').fill('2');
  await editor(page).getByLabel('Question 1 choices, one per line').fill('A stop order\nHope');
  await editor(page).getByLabel('Question 1 answer').selectOption({ label: 'A stop order' });
  await saveDraft(page);
  await publish(page, `TEST ${J}: first try`);
  await expect(editor(page).getByText('The pass mark is not set').first()).toBeVisible();
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Draft');

  // A pass mark and two attempts with no scoring policy: refused naming the policy.
  await editor(page).getByLabel('Pass mark (points)').fill('1');
  await editor(page).getByLabel('Attempts allowed').fill('2');
  await saveDraft(page);
  await publish(page, `TEST ${J}: second try`);
  await expect(editor(page).getByText('No scoring policy for more than one attempt')).toBeVisible();

  // With a scoring policy nothing blocks it, and it publishes.
  await editor(page).getByLabel('Scoring policy').selectOption('highest');
  await saveDraft(page);
  await expect(editor(page).getByText('Nothing stops Publish.')).toBeVisible();
  await publish(page, `TEST ${J}: ready`);
  await expect(editor(page).getByText('quiz published')).toBeVisible();
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Published');

  // The course opens, a learner starts the quiz, and the published quiz with an attempt cannot be taken back to draft.
  const current = await staff('query', 'admin.course', { courseId: run.courseId });
  await staff('mutate', 'admin.setCourseState', {
    courseId: run.courseId,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open the course`,
  });
  run.learner = await enrolledLearner(browser, 'ja12');
  const started = await learnerWrite(run.learner, 'startCourseQuiz', { itemId: run.quizId, accessCode: null });
  expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
  expect(started.body.result.data).toMatchObject({ slug: run.quizId, number: 1, result: null });

  await quizPage(page);
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Attempts by learners1');
  await expect(editor(page).getByText('Learners have attempts on this quiz, so its questions stay as they are.')).toBeVisible();
  await editor(page).getByLabel('Reason', { exact: true }).fill(`TEST ${J}: take it down`);
  await editor(page).getByRole('button', { name: 'Take back to draft' }).click();
  await expect(editor(page).getByText('Learners have taken this quiz')).toBeVisible();
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Published');
  await page.context().close();
});

test(`${J} #3 with an access code and an IP filter set, a start without the code refuses and an unreadable caller address refuses`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  needs('courseId', 'quizId');
  const page = await console_(browser);
  await quizPage(page);
  await editor(page).getByLabel('New access code').fill(CODE);
  await editor(page).getByLabel('IP filter, one address or range per line').fill('203.0.113.0/24');
  await saveDraft(page);
  // The code is kept as a hash and never shown back; the filter is.
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Set (never shown again)');
  await expect(editor(page).getByTestId('quiz-facts')).not.toContainText(CODE);
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('203.0.113.0/24');
  await page.context().close();

  const learner = await enrolledLearner(browser, 'ja12c');
  const read = await (await api(learner)).get(trpc('courseQuiz', { itemId: run.quizId }));
  expect(read.status).toBe(200);
  expect(read.body.result.data).toMatchObject({ accessCodeRequired: true, attemptsUsed: 0 });
  expect(JSON.stringify(read.body)).not.toContain('correctChoiceId');

  const noCode = await learnerWrite(learner, 'startCourseQuiz', { itemId: run.quizId, accessCode: null });
  expect(noCode.status).toBe(403);
  expect(noCode.body?.error?.data?.cause?.code).toBe('academy.access_code_invalid');
  const wrong = await learnerWrite(learner, 'startCourseQuiz', { itemId: run.quizId, accessCode: 'not-the-code' });
  expect(wrong.body?.error?.data?.cause?.code).toBe('academy.access_code_invalid');
  // The right code, but this deployment names no trusted proxy, so the caller's address cannot be read: refused, not let in.
  const unreadable = await learnerWrite(learner, 'startCourseQuiz', { itemId: run.quizId, accessCode: CODE });
  expect(unreadable.status).toBe(412);
  expect(unreadable.body?.error?.data?.cause?.code).toBe('academy.ip_unreadable');
});
