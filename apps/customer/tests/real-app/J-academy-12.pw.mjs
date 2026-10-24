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
const run = { courseId: null, quizId: null, mixedId: null, surveyId: null, learner: null };

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

const quizPage = (page, itemId = run.quizId) => page.goto(`/academy-ops/catalogue/courses/${run.courseId}/items/${itemId}`);
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
          { kind: 'quiz', title: 'TEST Size the trade', indent: 0, url: null },
          { kind: 'quiz', title: 'TEST Tell us', indent: 0, url: null },
          { kind: 'assignment', title: 'TEST Write-up', indent: 0, url: null },
        ],
      },
    ],
  });
  run.courseId = course.id;
  run.quizId = outline.outline[0].items[1].id;
  run.mixedId = outline.outline[0].items[2].id;
  run.surveyId = outline.outline[0].items[3].id;

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
  expect(started.body.result.data).toMatchObject({ itemId: run.quizId, number: 1, result: null });

  await quizPage(page);
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Attempts by learners1');
  await expect(editor(page).getByText('Learners have attempts on this quiz, so its questions stay as they are.')).toBeVisible();
  await editor(page).getByLabel('Reason', { exact: true }).fill(`TEST ${J}: take it down`);
  await editor(page).getByRole('button', { name: 'Take back to draft' }).click();
  await expect(editor(page).getByText('Learners have taken this quiz')).toBeVisible();
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Published');
  await page.context().close();
});

test(`${J} #2 numeric, multi-select, essay and survey questions: tolerance, partial credit and results visibility; an essay stays pending until graded; an anonymous survey keeps no account`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  needs('courseId', 'mixedId', 'surveyId', 'learner');
  const page = await console_(browser);
  await quizPage(page, run.mixedId);
  await expect(editor(page)).toBeVisible();
  const q = (n, what) => editor(page).getByLabel(`Question ${n} ${what}`, { exact: true });

  // A numeric question with a tolerance, a multi-select with partial credit and an essay.
  for (let i = 0; i < 3; i += 1) await editor(page).getByRole('button', { name: 'Add question' }).click();
  await q(1, 'kind').selectOption('numeric');
  await editor(page).getByLabel('Question 1', { exact: true }).fill('TEST Risking 2% of 1000, how much is at risk?');
  await q(1, 'points').fill('2');
  await q(1, 'numeric answer').fill('20');
  await q(1, 'tolerance').fill('0.5');
  await q(2, 'kind').selectOption('multi');
  await editor(page).getByLabel('Question 2', { exact: true }).fill('TEST Which of these cap a loss?');
  await q(2, 'points').fill('2');
  await q(2, 'choices, one per line').fill('A stop order\nPosition size\nHope');
  await editor(page).getByLabel('Question 2 correct: A stop order').check();
  await editor(page).getByLabel('Question 2 correct: Position size').check();
  await q(2, 'partial credit').check();
  await q(3, 'kind').selectOption('essay');
  await editor(page).getByLabel('Question 3', { exact: true }).fill('TEST Why size a trade before entering it?');
  await q(3, 'points').fill('4');
  await editor(page).getByLabel('Pass mark (points)').fill('5');
  await editor(page).getByLabel('Attempts allowed').fill('1');
  await editor(page).getByLabel('Results shown to learners').selectOption('after_last_attempt');
  await saveDraft(page);
  await publish(page, `TEST ${J}: mixed questions`);
  await expect(editor(page).getByText('quiz published')).toBeVisible();

  // The learner reads the questions without any key, and answers: inside the tolerance, one of two correct choices, an essay.
  const read = await (await api(run.learner)).get(trpc('courseQuiz', { itemId: run.mixedId }));
  expect(read.status).toBe(200);
  expect(read.body.result.data.questions.map((x) => x.kind)).toEqual(['numeric', 'multi', 'essay']);
  expect(read.body.result.data.resultsVisibility).toBe('after_last_attempt');
  expect(JSON.stringify(read.body)).not.toMatch(/correctChoiceIds|tolerance|"answer"/);
  const started = await learnerWrite(run.learner, 'startCourseQuiz', { itemId: run.mixedId, accessCode: null });
  expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
  const attemptId = started.body.result.data.attemptId;
  const [numeric, multi, essay] = read.body.result.data.questions;
  for (const [questionId, answer] of [
    [numeric.id, '20.4'],
    [multi.id, [multi.choices[0].id]],
    [essay.id, 'TEST The stop and the size fix the loss before the trade starts.'],
  ]) {
    const saved = await learnerWrite(run.learner, 'answerCourseQuiz', { attemptId, questionId, answer });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
  }
  const finished = await learnerWrite(run.learner, 'finishCourseQuiz', { attemptId });
  expect(finished.status).toBe(200);
  expect(finished.body.result.data.result).toMatchObject({ state: 'pending_review' });

  // Staff see it waiting under an alias, score the essay, and the attempt is graded: 2 + 1 (partial credit) + 3.
  await quizPage(page, run.mixedId);
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Waiting for an essay score1');
  const reviews = editor(page).getByTestId('quiz-reviews');
  await expect(reviews).toContainText('Learner 1, attempt 1');
  await expect(reviews).toContainText('TEST The stop and the size fix the loss before the trade starts.');
  await reviews.getByLabel('Learner 1 essay 1 points (0 to 4)').fill('3');
  await reviews.getByRole('button', { name: 'Save scores for learner 1' }).click();
  await expect(editor(page).getByText('essays scored')).toBeVisible();
  await expect(reviews).toContainText('No attempt is waiting for an essay score.');
  const graded = await (await api(run.learner)).get(trpc('courseQuizAttempt', { itemId: run.mixedId }));
  expect(graded.body.result.data.result).toMatchObject({ state: 'graded', score: 6, maxScore: 8, pass: true });

  // An anonymous survey: no pass mark, answered once per device, and the reply keeps no account.
  await quizPage(page, run.surveyId);
  await editor(page).getByLabel('Quiz kind').selectOption('survey');
  await editor(page)
    .getByLabel(/Anonymous survey/)
    .check();
  await editor(page).getByRole('button', { name: 'Add question' }).click();
  await q(1, 'kind').selectOption('essay');
  await editor(page).getByLabel('Question 1', { exact: true }).fill('TEST What would make this course better?');
  await saveDraft(page);
  await expect(editor(page).getByText('Nothing stops Publish.')).toBeVisible();
  await publish(page, `TEST ${J}: survey`);
  await expect(editor(page).getByText('quiz published')).toBeVisible();
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Anonymous survey');
  const survey = await (await api(run.learner)).get(trpc('courseQuiz', { itemId: run.surveyId }));
  expect(survey.body.result.data).toMatchObject({ kind: 'survey', anonymous: true, passMark: null });
  const token = `TEST-${RUN}-device-token`;
  const answers = { [survey.body.result.data.questions[0].id]: 'TEST More worked examples.' };
  const sent = await learnerWrite(run.learner, 'submitCourseSurvey', { itemId: run.surveyId, clientToken: token, answers });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  expect(sent.body.result.data).toMatchObject({ itemId: run.surveyId, anonymous: true });
  expect(JSON.stringify(sent.body)).not.toContain(run.learner.userId ?? '\u0000');
  const again = await learnerWrite(run.learner, 'submitCourseSurvey', { itemId: run.surveyId, clientToken: token, answers });
  expect(again.status).toBe(409);
  expect(again.body?.error?.data?.cause?.code).toBe('academy.survey_duplicate');
  await quizPage(page, run.surveyId);
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Survey responses1');
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
