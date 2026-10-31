import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api } from './stack.mjs';
import { signUp } from './desk.mjs';
import { userIdOf } from './copy.mjs';

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
  // The refusal is Publish's own answer, by its code, and the quiz stays a draft.
  const refusal = editor(page).getByTestId('course-desk-outcome');
  await expect(refusal).toHaveAttribute('data-code', 'academy.pass_mark_unset');
  await expect(refusal).toContainText('The pass mark is not set');
  await expect(refusal).toContainText('Nothing was published.');
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Draft');

  // A pass mark and two attempts with no scoring policy: refused naming the policy.
  await editor(page).getByLabel('Pass mark (points)').fill('1');
  await editor(page).getByLabel('Attempts allowed').fill('2');
  await saveDraft(page);
  await publish(page, `TEST ${J}: second try`);
  await expect(refusal).toHaveAttribute('data-code', 'academy.scoring_policy_unset');
  await expect(refusal).toContainText('No scoring policy for more than one attempt');
  await expect(refusal).toContainText('Nothing was published.');
  await expect(editor(page).getByTestId('quiz-facts')).toContainText('Draft');

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
  // Two attempts, and results only after the last: the first graded attempt is withheld from the learner.
  await editor(page).getByLabel('Attempts allowed').fill('2');
  await editor(page).getByLabel('Scoring policy').selectOption('highest');
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
  const [numeric, multi, essay] = read.body.result.data.questions;
  /** One attempt: inside the tolerance, one of two correct choices, an essay; it waits for the essay's score. */
  const attempt = async (number) => {
    const started = await learnerWrite(run.learner, 'startCourseQuiz', { itemId: run.mixedId, accessCode: null });
    expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
    expect(started.body.result.data.number).toBe(number);
    const attemptId = started.body.result.data.attemptId;
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
  };
  /** Staff see the attempt waiting under an alias and score its essay 3 of 4. */
  const scoreEssay = async (number) => {
    await quizPage(page, run.mixedId);
    await expect(editor(page).getByTestId('quiz-facts')).toContainText('Waiting for an essay score1');
    const reviews = editor(page).getByTestId('quiz-reviews');
    await expect(reviews).toContainText(`Learner 1, attempt ${number}`);
    await expect(reviews).toContainText('TEST The stop and the size fix the loss before the trade starts.');
    await reviews.getByLabel('Learner 1 essay 1 points (0 to 4)').fill('3');
    await reviews.getByRole('button', { name: 'Save scores for learner 1' }).click();
    await expect(editor(page).getByText('essays scored')).toBeVisible();
    await expect(reviews).toContainText('No attempt is waiting for an essay score.');
  };
  const mine = async () => (await (await api(run.learner)).get(trpc('courseQuizAttempt', { itemId: run.mixedId }))).body.result.data;

  // Attempt 1 is graded by staff, but it is not the last attempt, so the learner sees no score yet.
  await attempt(1);
  await scoreEssay(1);
  const withheld = await mine();
  expect(withheld.number).toBe(1);
  expect(withheld.result).toMatchObject({ state: 'withheld' });
  expect(withheld.result).not.toHaveProperty('score');

  // After the last attempt is graded the score shows: 2 + 1 (partial credit) + 3.
  await attempt(2);
  await scoreEssay(2);
  const graded = await mine();
  expect(graded.number).toBe(2);
  expect(graded.result).toMatchObject({ state: 'graded', score: 6, maxScore: 8, pass: true });

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
  // The reply carries no account id: the learner's real id, read from identity, is nowhere in it.
  const userId = (await (await api(run.learner)).get('/api/identity/trpc/rank.get')).body.result.data.userId;
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(sent.body)).not.toContain(userId);
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

// Steps 4 and 5 work on courses of their own: a published course's outline is not edited, and the first course was opened
// for learners in step 1.
const SLUG_B = `test-j12b-${RUN}`;
const SLUG_C = `test-j12c-${RUN}`;
const itemPage = (page, courseId, itemId) => page.goto(`/academy-ops/catalogue/courses/${courseId}/items/${itemId}`);

/** A local date and time a day from now, as a datetime-local field takes it. */
function tomorrow() {
  const at = new Date(Date.now() + 24 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A draft course with one assignment, made through Academy's admin door; answers the course and the assignment's ids. */
async function draftWithAssignment(slug, title) {
  const course = await staff('mutate', 'admin.createCourse', {
    slug,
    title,
    summary: 'TEST A course a founder adds graded work to.',
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
  });
  const outline = await staff('mutate', 'admin.saveOutline', {
    courseId: course.id,
    revision: course.revision,
    sections: [{ title: 'TEST Hand in', items: [{ kind: 'assignment', title: 'TEST Size write-up', indent: 0, url: null }] }],
  });
  return { courseId: course.id, itemId: outline.outline[0].items[0].id };
}

/** A learner signs up and enrols on a course's free track through their own API. */
async function learnerOn(browser, prefix, slug) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(page, prefix);
  await page.context().close();
  const res = await learnerWrite(who, 'enrolAuthoredCourse', { slug, track: 'audit' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return who;
}

const assignmentOf = async (who, itemId) => (await api(who)).get(trpc('assignment', { itemId }));

/** Hands in text as the learner's next version. */
async function handIn(who, itemId, text) {
  const view = (await assignmentOf(who, itemId)).body.result.data;
  const sent = await learnerWrite(who, 'submitAssignment', { itemId, version: view.nextVersion, text, fileId: null });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
}

test(`${J} #4 an assignment with a due date is duplicated and both exist; deleting one with hand-ins keeps them readable`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { courseId, itemId } = await draftWithAssignment(SLUG_B, `TEST J-academy-12 course B ${RUN}`);
  const page = await console_(browser);
  await itemPage(page, courseId, itemId);
  const editor = page.getByTestId('assignment-editor');
  await editor.getByLabel('Instructions', { exact: true }).fill('TEST Size one trade so a stop costs one percent, with your working.');
  await editor.getByLabel('Points', { exact: true }).fill('10');
  await editor.getByLabel('Due', { exact: true }).fill(tomorrow());
  await editor.getByRole('combobox', { name: 'Text answer', exact: true }).selectOption('required');
  await editor.getByRole('combobox', { name: 'File answer', exact: true }).selectOption('off');
  await editor.getByRole('button', { name: 'Save assignment' }).click();
  await expect(page.getByTestId('course-desk-outcome')).toContainText('Done: assignment saved');

  // Duplicate: the copy comes right after it, with the same brief and due date, and both are in the outline.
  await page.getByRole('button', { name: 'Duplicate this item' }).click();
  await expect.poll(async () => (await staff('query', 'admin.course', { courseId })).outline[0].items.length, { timeout: 15_000 }).toBe(2);
  const [original, copy] = (await staff('query', 'admin.course', { courseId })).outline[0].items;
  expect(original.id).toBe(itemId);
  expect(copy).toMatchObject({ kind: 'assignment', title: 'TEST Size write-up' });
  const [first, second] = [
    await staff('query', 'admin.assignment', { itemId }),
    await staff('query', 'admin.assignment', { itemId: copy.id }),
  ];
  expect(second.brief).toEqual(first.brief);
  expect(second.brief.dueAt).not.toBeNull();

  // The course opens; a learner hands in to the copy; staff delete (withdraw) the copy, and the hand-in stays readable.
  const current = await staff('query', 'admin.course', { courseId });
  await staff('mutate', 'admin.setCourseState', {
    courseId,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open course B`,
  });
  const learner = await learnerOn(browser, 'ja12d', SLUG_B);
  await handIn(learner, copy.id, 'TEST I risk ten on a thousand with the stop one percent away.');
  await itemPage(page, courseId, copy.id);
  await editor.getByLabel('Reason to withdraw', { exact: true }).fill(`TEST ${J}: delete the copy`);
  await editor.getByRole('button', { name: 'Withdraw assignment' }).click();
  await expect(editor.getByText(/Withdrawn/).first()).toBeVisible();
  const kept = await assignmentOf(learner, copy.id);
  expect(kept.status, JSON.stringify(kept.body).slice(0, 300)).toBe(200);
  expect(JSON.stringify(kept.body.result.data)).toContain('TEST I risk ten on a thousand with the stop one percent away.');
  // The original is untouched and still takes hand-ins.
  expect((await staff('query', 'admin.assignment', { itemId })).withdrawnAt).toBeNull();
  run.courseB = courseId;
  run.workB = itemId;
  run.learnerB = learner;
  await page.context().close();
});

test(`${J} #5 a rubric totals the chosen levels as a decimal string; a peer step with no review count refuses to publish`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  needs('courseB', 'workB', 'learnerB');
  const page = await console_(browser);

  // A draft course whose assignment has peer review on and no review count is not published.
  const c = await draftWithAssignment(SLUG_C, `TEST J-academy-12 course C ${RUN}`);
  await staff('mutate', 'admin.saveAssignment', {
    itemId: c.itemId,
    revision: 0,
    instructions: 'TEST Explain your stop.',
    points: '10',
    dueAt: null,
    text: 'required',
    file: 'off',
  });
  await itemPage(page, c.courseId, c.itemId);
  const steps = page.getByTestId('assignment-review-steps');
  await steps.getByLabel('Peer review', { exact: true }).check();
  await steps.getByLabel('Reviews each learner gives', { exact: true }).fill('');
  await steps.getByLabel('Criterion 1', { exact: true }).fill('TEST Sizing');
  await steps.getByLabel('Criterion 1 levels', { exact: true }).fill('0, 0.5, 1.5');
  await steps.getByRole('button', { name: 'Save review steps' }).click();
  await expect(page.getByTestId('course-desk-outcome')).toContainText('Done: review steps saved');
  await page.goto(`/academy-ops/catalogue/courses/${c.courseId}`);
  await page.getByLabel('Reason', { exact: true }).fill(`TEST ${J}: try to open course C`);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByTestId('course-desk-outcome')).toContainText('Peer review has no review count');
  expect((await staff('query', 'admin.course', { courseId: c.courseId })).course.state).toBe('draft');

  // On course B, a two-criterion rubric with decimal levels and one peer review each.
  await itemPage(page, run.courseB, run.workB);
  await steps.getByLabel('Peer review', { exact: true }).check();
  await steps.getByLabel('Reviews each learner gives', { exact: true }).fill('1');
  await steps.getByLabel('Criterion 1', { exact: true }).fill('TEST Sizing');
  await steps.getByLabel('Criterion 1 levels', { exact: true }).fill('0, 0.5, 1.5');
  await steps.getByRole('button', { name: 'Add criterion' }).click();
  await steps.getByLabel('Criterion 2', { exact: true }).fill('TEST Working shown');
  await steps.getByLabel('Criterion 2 levels', { exact: true }).fill('0, 1');
  await steps.getByRole('button', { name: 'Save review steps' }).click();
  await expect(page.getByTestId('course-desk-outcome')).toContainText('Done: review steps saved');

  // Two learners hand in and review each other: 1.5 + 1 and 0.5 + 0.
  const other = await learnerOn(browser, 'ja12e', SLUG_B);
  await handIn(run.learnerB, run.workB, 'TEST B sizes from the stop distance.');
  await handIn(other, run.workB, 'TEST E sizes by a fixed amount.');
  for (const [who, marks] of [
    [run.learnerB, ['1.5', '1']],
    [other, ['0.5', '0']],
  ]) {
    const state = await learnerWrite(who, 'peerReview', { itemId: run.workB });
    expect(state.status, JSON.stringify(state.body).slice(0, 300)).toBe(200);
    const task = state.body.result.data.task;
    expect(task).toMatchObject({ kind: 'peer' });
    const sent = await learnerWrite(who, 'submitPeerReview', { itemId: run.workB, taskId: task.id, marks });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  }

  // The grader sees each hand-in's rubric total as a decimal string, exactly.
  await itemPage(page, run.courseB, run.workB);
  await page.getByRole('link', { name: 'Grade hand-ins', exact: true }).click({ timeout: 10_000 });
  const queue = page.getByTestId('grading-queue');
  await expect(queue.locator('[data-grading-row]').filter({ hasText: 'TEST E sizes' })).toContainText('mean rubric total 2.5');
  await expect(queue.locator('[data-grading-row]').filter({ hasText: 'TEST B sizes' })).toContainText('mean rubric total 0.5');
  await page.context().close();
});

const SLUG_D = `test-j12d-${RUN}`;
const DAY_MS = 24 * 3600_000;

test(`${J} #6 a section released 7 days after enrolment, with pacing: the learner sees a clock and the local release time; changing pacing after start refuses`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // A draft course: an opening section with a reading, and a second week whose assignment has its brief.
  const course = await staff('mutate', 'admin.createCourse', {
    slug: SLUG_D,
    title: `TEST J-academy-12 course D ${RUN}`,
    summary: 'TEST A course that opens a week at a time.',
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
  });
  const outline = await staff('mutate', 'admin.saveOutline', {
    courseId: course.id,
    revision: course.revision,
    sections: [
      { title: 'TEST Week one', items: [{ kind: 'link', title: 'TEST Reading', indent: 0, url: 'https://example.com/reading' }] },
      { title: 'TEST Week two', items: [{ kind: 'assignment', title: 'TEST Week two write-up', indent: 0, url: null }] },
    ],
  });
  const weekTwo = outline.outline[1].items[0].id;
  await staff('mutate', 'admin.saveAssignment', {
    itemId: weekTwo,
    revision: 0,
    instructions: 'TEST Size a trade from the stop.',
    points: '10',
    dueAt: null,
    text: 'required',
    file: 'off',
  });

  // On the console: pacing, then week two opens 7 days after each learner enrols.
  const page = await console_(browser);
  await page.goto(`/academy-ops/catalogue/courses/${course.id}`);
  const release = page.getByTestId('course-release');
  await release.getByRole('combobox', { name: 'Pacing', exact: true }).selectOption('self_paced');
  await release.getByLabel('Pacing reason', { exact: true }).fill(`TEST ${J}: learners go at their own speed`);
  await release.getByRole('button', { name: 'Save pacing' }).click();
  await expect(release.getByTestId('course-desk-outcome')).toContainText('Done: pacing saved');
  const week = release.locator('[data-testid="release-section"][data-section="TEST Week two"]');
  await week.getByRole('combobox', { name: 'Release of TEST Week two' }).selectOption('after_enrolment');
  await week.getByLabel('Days after enrolment, TEST Week two').fill('7');
  await week.getByLabel('Release reason, TEST Week two').fill(`TEST ${J}: drip week two`);
  await week.getByRole('button', { name: 'Save release' }).click();
  await expect(release.getByTestId('course-desk-outcome')).toContainText('Done: section release saved');
  await expect(week.getByTestId('release-rule')).toContainText('Opens 7 days after each learner enrols');

  const current = await staff('query', 'admin.course', { courseId: course.id });
  await staff('mutate', 'admin.setCourseState', {
    courseId: course.id,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open course D`,
  });

  // A learner enrols; week two is scheduled, with a clock and the time it opens in the learner's own time zone.
  const learnerPage = await (await browser.newContext({ baseURL: ORIGIN, timezoneId: 'Asia/Tokyo' })).newPage();
  const learner = await signUp(learnerPage, 'ja12f');
  const enrolled = await learnerWrite(learner, 'enrolAuthoredCourse', { slug: SLUG_D, track: 'audit' });
  expect(enrolled.status, JSON.stringify(enrolled.body).slice(0, 300)).toBe(200);
  const enrolledAt = Date.now();
  await learnerPage.goto(`/academy/learning/course/${SLUG_D}`);
  await expect(learnerPage.getByText('Self-paced: go at your own speed')).toBeVisible({ timeout: 20_000 });
  const clock = learnerPage.getByTestId('section-release');
  await expect(clock).toHaveCount(1);
  await expect(clock).toHaveAttribute('data-open', 'no');
  await expect(clock).toContainText('🕒');
  await expect(clock).toContainText('(your time)');
  const opensAt = Date.parse((await clock.locator('time').getAttribute('datetime')) ?? '');
  expect(Math.abs(opensAt - (enrolledAt + 7 * DAY_MS))).toBeLessThan(5 * 60_000);
  // The text is that instant in Tokyo time, as the learner's browser formats it.
  const local = await learnerPage.evaluate(
    (iso) => new Intl.DateTimeFormat(navigator.language, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso)),
    new Date(opensAt).toISOString(),
  );
  await expect(clock.locator('time')).toHaveText(`Opens ${local} (your time)`);
  await expect(learnerPage.locator('li[data-lock="scheduled"]')).toContainText('TEST Week two write-up');
  await expect(learnerPage.locator('li[data-lock="none"]')).toContainText('TEST Reading');
  const closed = await assignmentOf(learner, weekTwo);
  expect(JSON.stringify(closed.body)).toContain('academy.not_released_yet');
  await learnerPage.context().close();

  // With a learner enrolled, a pacing change refuses by name and the pacing stays.
  await page.reload();
  await expect(release.getByTestId('pacing-locked')).toBeVisible();
  await release.getByRole('combobox', { name: 'Pacing', exact: true }).selectOption('instructor_paced');
  await release.getByLabel('Pacing reason', { exact: true }).fill(`TEST ${J}: try to change pacing after start`);
  await release.getByRole('button', { name: 'Save pacing' }).click();
  await expect(release.getByTestId('course-desk-outcome')).toContainText('Pacing is fixed');
  await expect(release.getByTestId('course-desk-outcome')).toHaveAttribute('data-code', 'academy.pacing_locked');
  expect((await staff('query', 'admin.courseRelease', { courseId: course.id })).pacing).toBe('self_paced');
  await page.context().close();
});

const SLUG_E = `test-j12e-${RUN}`;

test(`${J} #7 item B requiring A and then A requiring B refuses the cycle; a due date extension for one learner shows who granted it and why`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // A draft course with an assignment (due tomorrow) and a published quiz.
  const course = await staff('mutate', 'admin.createCourse', {
    slug: SLUG_E,
    title: `TEST J-academy-12 course E ${RUN}`,
    summary: 'TEST A course whose quiz needs the write-up first.',
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
          { kind: 'assignment', title: 'TEST Item A write-up', indent: 0, url: null },
          { kind: 'quiz', title: 'TEST Item B check', indent: 0, url: null },
        ],
      },
    ],
  });
  const [a, b] = outline.outline[0].items.map((i) => i.id);
  const due = new Date(Date.now() + DAY_MS);
  await staff('mutate', 'admin.saveAssignment', {
    itemId: a,
    revision: 0,
    instructions: 'TEST Size a trade from the stop.',
    points: '10',
    dueAt: due.toISOString(),
    text: 'required',
    file: 'off',
  });
  await staff('mutate', 'admin.saveCourseQuiz', {
    itemId: b,
    revision: 0,
    kind: 'quiz',
    anonymous: false,
    resultsVisibility: 'always',
    passMark: 1,
    attemptLimit: 1,
    scoringPolicy: null,
    timeLimitSeconds: null,
    reviewMode: 'score_only',
    ipAllow: null,
    questions: [
      {
        kind: 'single',
        id: 'q1',
        prompt: 'TEST What caps the loss?',
        points: 1,
        choices: [
          { id: 'c1', text: 'A stop' },
          { id: 'c2', text: 'Hope' },
        ],
        correctChoiceId: 'c1',
      },
    ],
  });
  await staff('mutate', 'admin.setCourseQuizState', { itemId: b, state: 'published', reason: `TEST ${J}: open quiz B` });

  // On the console: B requires A saves; A requires B is refused as a loop and nothing changes.
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const founder = await founderSignIn(page, 'a');
  await page.goto(`/academy-ops/catalogue/courses/${course.id}`);
  const rules = page.getByTestId('course-item-rules');
  const itemB = rules.locator('[data-testid="item-prerequisites"][data-item="TEST Item B check"]');
  await itemB.getByLabel('TEST Item B check requires TEST Item A write-up').check();
  await itemB.getByLabel('Prerequisites reason, TEST Item B check').fill(`TEST ${J}: write up before the check`);
  await itemB.getByRole('button', { name: 'Save prerequisites' }).click();
  await expect(rules.getByTestId('course-desk-outcome')).toContainText('Done: prerequisites saved');
  await expect(itemB.getByTestId('prerequisites-now')).toContainText('Requires TEST Item A write-up');
  const itemA = rules.locator('[data-testid="item-prerequisites"][data-item="TEST Item A write-up"]');
  await itemA.getByLabel('TEST Item A write-up requires TEST Item B check').check();
  await itemA.getByLabel('Prerequisites reason, TEST Item A write-up').fill(`TEST ${J}: try a loop`);
  await itemA.getByRole('button', { name: 'Save prerequisites' }).click();
  await expect(rules.getByTestId('course-desk-outcome')).toContainText('That would make a loop');
  await expect(rules.getByTestId('course-desk-outcome')).toHaveAttribute('data-code', 'academy.prerequisite_cycle');
  await expect(itemA.getByTestId('prerequisites-now')).toContainText('Requires nothing');

  const current = await staff('query', 'admin.course', { courseId: course.id });
  await staff('mutate', 'admin.setCourseState', {
    courseId: course.id,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open course E`,
  });

  // A learner enrols: quiz B stays closed until A is handed in.
  const learner = await learnerOn(browser, 'ja12g', SLUG_E);
  const closed = await (await api(learner)).get(trpc('courseQuiz', { itemId: b }));
  expect(JSON.stringify(closed.body)).toContain('academy.prerequisite_unmet');

  // The founder moves this one learner's due date two days later, with a reason; the list shows who and why.
  const learnerId = await userIdOf(learner);
  const later = new Date(Date.now() + 3 * DAY_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
  const form = rules.getByTestId('extension-form');
  await form.getByRole('combobox', { name: 'Extension assignment' }).selectOption({ label: 'TEST Item A write-up' });
  await form.getByLabel('Learner account id', { exact: true }).fill(learnerId);
  await form.getByLabel('New due date', { exact: true }).fill(local);
  await form.getByLabel('Extension reason', { exact: true }).fill(`TEST ${J}: travelling this week`);
  await form.getByRole('button', { name: 'Move the due date' }).click();
  await expect(rules.getByTestId('course-desk-outcome')).toContainText('Done: due date moved for the learner');
  const row = rules.getByTestId('extensions').locator(`tr[data-learner="${learnerId}"]`);
  await expect(row).toContainText('TEST Item A write-up');
  await expect(row).toContainText(founder.userId);
  await expect(row).toContainText(`TEST ${J}: travelling this week`);

  // The learner reads their own due date and the reason; the hand-in opens quiz B.
  const view = (await assignmentOf(learner, a)).body.result.data;
  expect(view.extension).toMatchObject({ reason: `TEST ${J}: travelling this week` });
  expect(Math.abs(Date.parse(view.extension.dueAt) - later.getTime())).toBeLessThan(60_000);
  await handIn(learner, a, 'TEST I size from the stop distance.');
  const open = await (await api(learner)).get(trpc('courseQuiz', { itemId: b }));
  expect(open.status, JSON.stringify(open.body).slice(0, 300)).toBe(200);
  await context.close();
});

const SLUG_G = `test-j12g-${RUN}`;

test(`${J} #8 gradebook weights that add up wrongly refuse and the right set saves; dropped lowest is applied before averaging`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // A course with three graded assignments and a one-question quiz.
  const course = await staff('mutate', 'admin.createCourse', {
    slug: SLUG_G,
    title: `TEST J-academy-12 course G ${RUN}`,
    summary: 'TEST A course with homework and a quiz.',
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
        title: 'TEST Work',
        items: [
          { kind: 'assignment', title: 'TEST One', indent: 0, url: null },
          { kind: 'assignment', title: 'TEST Two', indent: 0, url: null },
          { kind: 'assignment', title: 'TEST Three', indent: 0, url: null },
          { kind: 'quiz', title: 'TEST Quiz', indent: 0, url: null },
        ],
      },
    ],
  });
  const [one, two, three, quiz] = outline.outline[0].items.map((i) => i.id);
  for (const itemId of [one, two, three])
    await staff('mutate', 'admin.saveAssignment', {
      itemId,
      revision: 0,
      instructions: 'TEST Size a trade.',
      points: '10',
      dueAt: null,
      text: 'required',
      file: 'off',
    });
  await staff('mutate', 'admin.saveCourseQuiz', {
    itemId: quiz,
    revision: 0,
    kind: 'quiz',
    anonymous: false,
    resultsVisibility: 'always',
    passMark: 1,
    attemptLimit: 1,
    scoringPolicy: null,
    timeLimitSeconds: null,
    reviewMode: 'score_only',
    ipAllow: null,
    questions: [
      {
        kind: 'single',
        id: 'q1',
        prompt: 'TEST What caps the loss?',
        points: 1,
        choices: [
          { id: 'c1', text: 'A stop' },
          { id: 'c2', text: 'Hope' },
        ],
        correctChoiceId: 'c1',
      },
    ],
  });
  await staff('mutate', 'admin.setCourseQuizState', { itemId: quiz, state: 'published', reason: `TEST ${J}: open the quiz` });
  const current = await staff('query', 'admin.course', { courseId: course.id });
  await staff('mutate', 'admin.setCourseState', {
    courseId: course.id,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open course G`,
  });

  // A learner hands in all three, graded 10, 5 and 8 of 10, and gets the quiz right.
  const learner = await learnerOn(browser, 'ja12h', SLUG_G);
  for (const [itemId, score] of [
    [one, '10'],
    [two, '5'],
    [three, '8'],
  ]) {
    await handIn(learner, itemId, 'TEST My working.');
    const queue = await staff('query', 'admin.gradingQueue', { itemId });
    const row = queue.rows[0];
    await staff('mutate', 'admin.openGrading', { itemId, submissionId: row.submissionId });
    await staff('mutate', 'admin.gradeSubmission', {
      itemId,
      submissionId: row.submissionId,
      n: row.nextN,
      score,
      comment: null,
      reason: null,
    });
  }
  const started = await learnerWrite(learner, 'startCourseQuiz', { itemId: quiz, accessCode: null });
  expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
  const attemptId = started.body.result.data.attemptId;
  expect((await learnerWrite(learner, 'answerCourseQuiz', { attemptId, questionId: 'q1', answer: 'c1' })).status).toBe(200);
  expect((await learnerWrite(learner, 'finishCourseQuiz', { attemptId })).status).toBe(200);

  // On the console gradebook: 0.7 and 0.4 refuse; 0.6 and 0.4 save.
  const page = await console_(browser);
  await page.goto(`/academy-ops/catalogue/courses/${course.id}`);
  await page.getByRole('link', { name: 'Open the gradebook' }).click();
  const policy = page.getByTestId('grading-policy');
  await policy.getByLabel('Type 1 name', { exact: true }).fill('Homework');
  await policy.getByLabel('Type 1 weight', { exact: true }).fill('0.7');
  await policy.getByLabel('Type 1 drop lowest', { exact: true }).fill('1');
  for (const title of ['TEST One', 'TEST Two', 'TEST Three']) await policy.getByLabel(`Type 1 holds ${title}`, { exact: true }).check();
  await policy.getByRole('button', { name: 'Add type' }).click();
  await policy.getByLabel('Type 2 name', { exact: true }).fill('Quizzes');
  await policy.getByLabel('Type 2 weight', { exact: true }).fill('0.4');
  await policy.getByLabel('Type 2 holds TEST Quiz', { exact: true }).check();
  await policy.getByLabel('Policy reason', { exact: true }).fill(`TEST ${J}: homework and quizzes`);
  await policy.getByRole('button', { name: 'Save grading policy' }).click();
  await expect(page.getByTestId('course-desk-outcome')).toContainText('The weights do not add up to 1');
  await expect(page.getByTestId('course-desk-outcome')).toHaveAttribute('data-code', 'academy.weights_invalid');
  await expect(page.getByTestId('policy-now')).toContainText('No policy yet');

  // The form keeps what was typed: the founder corrects the first weight only.
  await policy.getByLabel('Type 1 weight', { exact: true }).fill('0.6');
  await policy.getByRole('button', { name: 'Save grading policy' }).click();
  await expect(page.getByTestId('course-desk-outcome')).toContainText('Done: grading policy saved');
  await expect(page.getByTestId('policy-now')).toContainText('Revision 1');

  // Homework drops the 5 before averaging: (1 + 0.8) / 2 = 0.9; total 0.6 × 0.9 + 0.4 × 1 = 0.94.
  const learnerId = await userIdOf(learner);
  const row = page.getByTestId('gradebook').locator(`tr[data-learner="${learnerId}"]`);
  await expect(row.locator('td[data-type="Homework"]')).toContainText('0.9');
  await expect(row.locator('td[data-type="Homework"]')).toContainText('dropped TEST Two');
  await expect(row.locator('td[data-type="Quizzes"]')).toHaveText('1');
  await expect(row.getByTestId('gradebook-total')).toHaveText('0.94');
  await page.context().close();
});
