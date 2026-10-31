import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, tool } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { userIdOf } from './copy.mjs';

// J-academy-13, in the running app (docs/roadmap/journeys.json): a founder grades work, fixes a quiz and downloads the
// gradebook. One test per step, titled "J-academy-13 #<n>". The founder is the stack's LOCAL TEST founder A, on the founder console's gradebook page; the course
// is made through Academy's own admin door first. Learners act through their own API, signed up in the browser.
const J = 'J-academy-13';
const RUN = Date.now().toString(36);

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function learnerWrite(who, procedure, input) {
  return (await api(who)).post(trpc(procedure), input);
}

/** Staff act through Academy's admin door with the stack's TEST founders, the same door the console uses. */
let staffDoor;
async function door() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, a: await sessions.a.tradeOpsToken(), b: await sessions.b.tradeOpsToken() };
  })();
  return staffDoor;
}
/** One call through the door as founder `who`, answered as it came back. */
async function staffCall(kind, procedure, input, who = 'a') {
  const d = await door();
  return d.ctx.edge[kind]('academy', procedure, input, d[who]);
}
async function staff(kind, procedure, input) {
  const res = await staffCall(kind, procedure, input);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

async function console_(browser, key = 'a') {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await founderSignIn(page, key);
  return page;
}

/**
 * Steps 1-3 share one course: a published free course with one assignment worth 10 points, handed in by four learners,
 * each with their own text, so the console's rows (learners under aliases) can be told apart by what they handed in.
 */
let handIns;
function essays(browser) {
  handIns ??= (async () => {
    const slug = `test-j13g-${RUN}`;
    const course = await staff('mutate', 'admin.createCourse', {
      slug,
      title: `TEST J-academy-13 grading ${RUN}`,
      summary: 'TEST A course whose hand-ins a founder grades.',
      thumbnailUrl: null,
      pricing: 'free',
      price: null,
      priceAsset: null,
    });
    const outline = await staff('mutate', 'admin.saveOutline', {
      courseId: course.id,
      revision: course.revision,
      sections: [{ title: 'TEST Work', items: [{ kind: 'assignment', title: 'TEST Essay', indent: 0, url: null }] }],
    });
    const itemId = outline.outline[0].items[0].id;
    await staff('mutate', 'admin.saveAssignment', {
      itemId,
      revision: 0,
      instructions: 'TEST Explain how you size one trade.',
      points: '10',
      dueAt: null,
      text: 'required',
      file: 'off',
    });
    const current = await staff('query', 'admin.course', { courseId: course.id });
    await staff('mutate', 'admin.setCourseState', {
      courseId: course.id,
      to: 'published',
      revision: current.course.revision,
      reason: `TEST ${J}: open for hand-ins`,
    });
    const learners = {};
    for (const name of ['one', 'two', 'three', 'four']) {
      const who = await learnerOn(browser, `ja13${name.slice(0, 2)}`, slug);
      const sent = await learnerWrite(who, 'submitAssignment', { itemId, version: 1, text: `TEST Essay ${name}.`, fileId: null });
      expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
      learners[name] = who;
    }
    return { slug, itemId, learners, url: `/academy-ops/catalogue/assignments/${itemId}` };
  })();
  return handIns;
}

/** The console row of the hand-in whose text is `TEST Essay <name>.` */
const rowOf = (page, name) =>
  page
    .getByTestId('grading-queue')
    .locator('[data-grading-row]')
    .filter({ hasText: `TEST Essay ${name}.` });

/** Academy restarted with the grader hold time blank (`off`) or back on the stack's TEST value. */
function graderLease(on) {
  const before = process.env.LOCAL_STACK_ACADEMY_GRADER_LEASE;
  if (on) delete process.env.LOCAL_STACK_ACADEMY_GRADER_LEASE;
  else process.env.LOCAL_STACK_ACADEMY_GRADER_LEASE = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'academy');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_ACADEMY_GRADER_LEASE;
    else process.env.LOCAL_STACK_ACADEMY_GRADER_LEASE = before;
  }
}

async function learnerOn(browser, prefix, slug) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(page, prefix);
  await page.context().close();
  const res = await learnerWrite(who, 'enrolAuthoredCourse', { slug, track: 'audit' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return who;
}

test(`${J} #1 a founder grades a hand-in with a comment: a graded event, and the learner sees the grade once released`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const run = await essays(browser);
  const desk = await console_(browser);
  await desk.goto(run.url);
  const row = rowOf(desk, 'one');
  await expect(row).toContainText('Not graded');
  await row.getByRole('button', { name: 'Grade', exact: true }).click();
  const form = desk.getByTestId('grade-form');
  await form.getByLabel('Score', { exact: true }).fill('7');
  await form.getByLabel('Comment', { exact: true }).fill('TEST Clear working; name your stop next time.');
  await form.getByRole('button', { name: 'Save grade' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toContainText('Done: grade saved');
  // The graded event is on the hand-in, as svc-academy holds it.
  await expect(row).toContainText(/Graded 7 on .* · TEST Clear working; name your stop next time\./);
  const stored = (await staff('query', 'admin.gradingQueue', { itemId: run.itemId })).rows.find((r) => r.text === 'TEST Essay one.');
  expect(stored.grade).toMatchObject({ score: '7', comment: 'TEST Clear working; name your stop next time.', overrides: 0 });
  await desk.context().close();

  // Released on save: the learner sees the score and comment, never who graded.
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signIn(page, run.learners.one);
  await page.goto(`/academy/learning/course/${run.slug}/assignment/${run.itemId}`);
  const grade = page.locator(`[data-academy-assignment="${run.itemId}"]`).getByTestId('assignment-grade');
  await expect(grade).toContainText('7 of 10 points');
  await expect(grade).toContainText('TEST Clear working; name your stop next time.');
  await expect(grade).not.toContainText(/founder|graded by/i);
  await page.context().close();
});

test(`${J} #2 a second grader is refused while the first holds the hand-in; a blank hold time refuses the first grade`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const run = await essays(browser);
  // Founder A opens Learner "two"'s hand-in: the hold is theirs.
  const first = await console_(browser, 'a');
  await first.goto(run.url);
  await rowOf(first, 'two').getByRole('button', { name: 'Grade', exact: true }).click();
  await expect(first.getByTestId('grade-form')).toBeVisible();

  // Founder B opens the same queue: the hand-in shows A's hold, its Grade is off, and opening it refuses by name.
  const second = await console_(browser, 'b');
  await second.goto(run.url);
  const held = rowOf(second, 'two');
  await expect(held).toContainText('Another grader holds it until');
  await expect(held.getByRole('button', { name: 'Grade', exact: true })).toBeDisabled();
  const row = (await staff('query', 'admin.gradingQueue', { itemId: run.itemId })).rows.find((r) => r.text === 'TEST Essay two.');
  const refused = await staffCall('mutate', 'admin.openGrading', { itemId: run.itemId, submissionId: row.submissionId }, 'b');
  expect(refused.status, refused.text.slice(0, 300)).toBe(409);
  expect(refused.text).toContain('academy.grader_locked');
  await second.context().close();
  await first.context().close();

  // With the owner's hold time blank, the first grade on a hand-in refuses by name and nothing is graded.
  graderLease(false);
  try {
    const desk = await console_(browser, 'a');
    await desk.goto(run.url);
    await expect(desk.getByTestId('grading-queue')).toContainText('Not set: the owner sets it, and nothing is graded until then');
    await rowOf(desk, 'three').getByRole('button', { name: 'Grade', exact: true }).click();
    const outcome = desk.getByTestId('course-desk-outcome');
    await expect(outcome).toHaveAttribute('data-code', 'academy.grader_lease_unset');
    await expect(outcome).toContainText('The grader hold time is not set');
    await expect(rowOf(desk, 'three')).toContainText('Not graded');
    await expect(desk.getByTestId('grade-form')).toHaveCount(0);
    await desk.context().close();
  } finally {
    graderLease(true);
  }
});

test(`${J} #3 graders see aliases, never names; a bulk file applies its good rows, lists the bad one, and again changes nothing`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const run = await essays(browser);
  const desk = await console_(browser);
  await desk.goto(run.url);
  const queue = desk.getByTestId('grading-queue');
  await expect(rowOf(desk, 'four')).toBeVisible();
  for (const who of Object.values(run.learners)) {
    await expect(queue).not.toContainText(who.handle);
    await expect(queue).not.toContainText(who.email);
    await expect(queue).not.toContainText(await userIdOf(who));
  }
  const aliasOf = async (name) => Number(/Learner (\d+) · version/.exec(await rowOf(desk, name).textContent())[1]);
  const three = await aliasOf('three');
  const four = await aliasOf('four');

  const csv = [
    'learner,score,comment,reason',
    `Learner ${three},6.5,"TEST Good, but show the stop.",`,
    `Learner ${four},9,TEST Strong.,`,
    'Learner 99,5,TEST Nobody.,',
    '',
  ].join('\r\n');
  const upload = async () => {
    await desk.getByLabel('Grade file (CSV)').setInputFiles({ name: 'TEST-grades.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await desk.getByTestId('bulk-grade').getByRole('button', { name: 'Upload grades' }).click();
  };
  await upload();
  const result = desk.getByTestId('bulk-grade-result');
  await expect(desk.getByTestId('course-desk-outcome')).toHaveText('Done: grade file read');
  await expect(result).toHaveAttribute('data-repeated', 'false');
  await expect(result).toContainText('TEST-grades.csv: 2 graded, 1 not applied');
  await expect(result.locator('tr[data-line="2"]')).toHaveAttribute('data-outcome', 'applied');
  await expect(result.locator('tr[data-line="3"]')).toHaveAttribute('data-outcome', 'applied');
  const bad = result.locator('tr[data-line="4"]');
  await expect(bad).toHaveAttribute('data-outcome', 'rejected');
  await expect(bad).toContainText('Not applied: no Learner 99 has handed in this assignment');
  await expect(rowOf(desk, 'three')).toContainText(/Graded 6\.5 on .* · TEST Good, but show the stop\./);
  await expect(rowOf(desk, 'four')).toContainText('Graded 9 on');
  const sha = await result.getAttribute('data-sha256');
  expect(sha).toBe(createHash('sha256').update(csv, 'utf8').digest('hex'));

  // The same file again: the stored result, and nothing changes.
  const before = await staff('query', 'admin.gradingQueue', { itemId: run.itemId });
  await upload();
  await expect(desk.getByTestId('course-desk-outcome')).toHaveText(
    'Done: grade file read: this file was uploaded before, so nothing changed',
  );
  await expect(result).toHaveAttribute('data-repeated', 'true');
  await expect(result).toHaveAttribute('data-sha256', sha);
  const after = await staff('query', 'admin.gradingQueue', { itemId: run.itemId });
  expect(after.rows.map((r) => [r.alias, r.grade, r.nextN])).toEqual(before.rows.map((r) => [r.alias, r.grade, r.nextN]));
  await desk.context().close();

  // The learner sees their bulk grade, with no grader name.
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signIn(page, run.learners.three);
  await page.goto(`/academy/learning/course/${run.slug}/assignment/${run.itemId}`);
  const grade = page.locator(`[data-academy-assignment="${run.itemId}"]`).getByTestId('assignment-grade');
  await expect(grade).toContainText('6.5 of 10 points');
  await expect(grade).not.toContainText(/founder|graded by/i);
  await page.context().close();
});

/**
 * A published course with one published quiz: Q1 single choice (2 points, key "A stop"), Q2 numeric (3 points, key 10
 * exactly); pass mark 3, one attempt each.
 */
async function publishedQuiz(tag) {
  const slug = `test-j13${tag}-${RUN}`;
  const course = await staff('mutate', 'admin.createCourse', {
    slug,
    title: `TEST J-academy-13 quiz ${tag} ${RUN}`,
    summary: 'TEST A quiz a founder regrades.',
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
  });
  const outline = await staff('mutate', 'admin.saveOutline', {
    courseId: course.id,
    revision: course.revision,
    sections: [{ title: 'TEST Check', items: [{ kind: 'quiz', title: 'TEST Sizing check', indent: 0, url: null }] }],
  });
  const quizId = outline.outline[0].items[0].id;
  await staff('mutate', 'admin.saveCourseQuiz', {
    itemId: quizId,
    revision: 0,
    kind: 'quiz',
    anonymous: false,
    resultsVisibility: 'always',
    passMark: 3,
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
        points: 2,
        choices: [
          { id: 'c1', text: 'A stop' },
          { id: 'c2', text: 'Hope' },
        ],
        correctChoiceId: 'c1',
      },
      { kind: 'numeric', id: 'n1', prompt: 'TEST Units for 100 at risk with a 10 stop?', points: 3, answer: '10', tolerance: '0' },
    ],
  });
  await staff('mutate', 'admin.setCourseQuizState', { itemId: quizId, state: 'published', reason: `TEST ${J}: open the quiz` });
  const current = await staff('query', 'admin.course', { courseId: course.id });
  await staff('mutate', 'admin.setCourseState', {
    courseId: course.id,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open the course`,
  });
  return { courseId: course.id, quizId, slug };
}

/** A new learner enrols and takes the quiz once: `choice` for Q1 and `size` for Q2. */
async function takeQuiz(browser, { quizId, slug }, prefix, choice, size) {
  const who = await learnerOn(browser, prefix, slug);
  const started = await learnerWrite(who, 'startCourseQuiz', { itemId: quizId, accessCode: null });
  expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
  const attemptId = started.body.result.data.attemptId;
  for (const [questionId, answer] of [
    ['q1', choice],
    ['n1', size],
  ])
    expect((await learnerWrite(who, 'answerCourseQuiz', { attemptId, questionId, answer })).status).toBe(200);
  expect((await learnerWrite(who, 'finishCourseQuiz', { attemptId })).status).toBe(200);
  return who;
}

/** The score a learner reads on their own attempt, through their own API (the customer app has no authored-quiz room). */
async function myQuizScore(who, itemId) {
  const res = await (await api(who)).get(trpc('courseQuizAttempt', { itemId }));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.result;
}

test(`${J} #4 an override and a rescore after a key fix are new events with the new total, the old kept; learners see the new score`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const quiz = await publishedQuiz('q');
  const { courseId, quizId } = quiz;
  // Learner 1 answers "Hope" and 10 (3 of 5); Learner 2 answers "A stop" and 12 (2 of 5).
  const takers = [await takeQuiz(browser, quiz, 'ja13qa', 'c2', '10'), await takeQuiz(browser, quiz, 'ja13qb', 'c1', '12')];
  const [first, second] = takers;
  expect(await myQuizScore(first, quizId)).toMatchObject({ state: 'graded', score: 3, pass: true });
  expect(await myQuizScore(second, quizId)).toMatchObject({ state: 'graded', score: 2, pass: false });

  const desk = await console_(browser);
  await desk.goto(`/academy-ops/catalogue/courses/${courseId}/items/${quizId}`);
  await desk.getByRole('link', { name: 'Attempts and score changes' }).click();
  const attempts = desk.getByTestId('quiz-attempts');
  const one = attempts.locator('li[data-alias="1"]');
  const two = attempts.locator('li[data-alias="2"]');
  await expect(one.getByTestId('attempt-score')).toHaveText('Score 3 of 5, passed');
  await expect(two.getByTestId('attempt-score')).toHaveText('Score 2 of 5, not passed');
  await expect(attempts).not.toContainText(first.handle);
  await expect(attempts).not.toContainText(second.handle);

  // An override of Q1 for Learner 1: a new event with the new total; the score as finished stays beside it.
  await one.getByRole('button', { name: 'Change a score' }).click();
  const form = desk.getByTestId('score-override');
  await form.getByLabel('Question').selectOption('q1');
  await form.getByLabel('Points').fill('2');
  await form.getByLabel('Comment').fill('TEST "Hope" named a stop in its working.');
  await form.getByLabel('Reason for the change').fill('TEST regraded by hand');
  await form.getByRole('button', { name: 'Save score change' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toHaveText('Done: score changed');
  await expect(one.getByTestId('attempt-score')).toHaveText('Score 5 of 5, passed · 3 as finished');
  await expect(one.getByTestId('score-trail').locator('li[data-event="1"]')).toContainText('Change 1: question q1 overridden, 3 → 5');
  expect(await myQuizScore(first, quizId)).toMatchObject({ score: 5, pass: true });

  // The key was wrong: Q2's answer is 12. The fix is a new revision; nobody's score moves until the rescore.
  const revision = Number(await desk.getByTestId('quiz-revision').textContent());
  const fix = desk.getByTestId('key-fix');
  await fix.getByLabel('Question').selectOption('n1');
  await fix.getByLabel('Answer').fill('12');
  await fix.getByLabel('Reason for the key fix').fill('TEST the answer is 12 units');
  await fix.getByRole('button', { name: 'Save key fix' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toContainText('Done: key fixed as a new revision');
  await expect(desk.getByTestId('quiz-revision')).toHaveText(String(revision + 1));
  await expect(two.getByTestId('attempt-score')).toHaveText('Score 2 of 5, not passed');

  const rescore = desk.getByTestId('rescore');
  await rescore.getByLabel('Reason for the rescore').fill('TEST key fixed');
  await rescore.getByRole('button', { name: 'Rescore attempts' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toHaveText('Done: 2 attempts rescored');
  await expect(desk.getByTestId('rescored')).toContainText('Learner 1, attempt 1: 5 → 2');
  await expect(desk.getByTestId('rescored')).toContainText('Learner 2, attempt 1: 2 → 5');
  await expect(two.getByTestId('attempt-score')).toHaveText('Score 5 of 5, passed · 2 as finished');
  await expect(two.getByTestId('score-trail').locator('li[data-event="1"]')).toContainText(
    `Change 1: rescored on revision ${revision + 1}, 2 → 5`,
  );
  // Learner 1's trail keeps the override and adds the rescore.
  await expect(one.getByTestId('score-trail').locator('li')).toHaveCount(2);
  await expect(one.getByTestId('score-trail').locator('li[data-event="2"]')).toContainText('5 → 2');
  expect(await myQuizScore(second, quizId)).toMatchObject({ score: 5, pass: true });
  expect(await myQuizScore(first, quizId)).toMatchObject({ score: 2, pass: false });

  // Rescoring again on the same revision changes nothing.
  await rescore.getByLabel('Reason for the rescore').fill('TEST again');
  await rescore.getByRole('button', { name: 'Rescore attempts' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toHaveText('Done: rescore run: no attempt changed');
  await expect(one.getByTestId('score-trail').locator('li')).toHaveCount(2);
  await desk.context().close();
});

test(`${J} #5 a curve file naming an unknown learner: the dry run lists it and nothing applies`, async ({ browser }) => {
  test.setTimeout(300_000);
  const quiz = await publishedQuiz('c');
  const learner = await takeQuiz(browser, quiz, 'ja13ca', 'c2', '10');
  const desk = await console_(browser);
  await desk.goto(`/academy-ops/catalogue/quizzes/${quiz.quizId}`);
  const one = desk.getByTestId('quiz-attempts').locator('li[data-alias="1"]');
  await expect(one.getByTestId('attempt-score')).toHaveText('Score 3 of 5, passed');

  const csv = ['learner,score', 'Learner 1,4', 'Learner 9,5', ''].join('\r\n');
  const curve = desk.getByTestId('curve');
  await curve.getByLabel('Curve file (CSV)').setInputFiles({ name: 'TEST-curve.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await curve.getByLabel('Reason for the curve').fill('TEST lift the curve');
  await curve.getByRole('button', { name: 'Dry run' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toHaveText('Done: dry run: 1 would change, 1 refused; nothing applied');
  const result = desk.getByTestId('curve-result');
  await expect(result).toHaveAttribute('data-dry-run', 'true');
  await expect(result.locator('tr[data-line="2"]')).toHaveAttribute('data-outcome', 'would-change');
  await expect(result.locator('tr[data-line="2"]')).toContainText('3 → 4');
  await expect(result.locator('tr[data-line="3"]')).toHaveAttribute('data-outcome', 'rejected');
  await expect(result.locator('tr[data-line="3"]')).toContainText('Refused: no Learner 9 took this quiz');
  await expect(one.getByTestId('attempt-score')).toHaveText('Score 3 of 5, passed');
  await expect(one.getByTestId('score-trail')).toHaveCount(0);

  // Applying the same file refuses whole while a row is refused: nothing applies.
  await curve.getByRole('button', { name: 'Apply curve' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toHaveAttribute('data-code', 'academy.bulk_file_invalid');
  await expect(one.getByTestId('attempt-score')).toHaveText('Score 3 of 5, passed');
  await expect(one.getByTestId('score-trail')).toHaveCount(0);
  const stored = await staff('query', 'admin.courseQuizAttempts', { itemId: quiz.quizId });
  expect(stored.attempts.map((a) => [a.score, a.events.length])).toEqual([[3, 0]]);
  expect(await myQuizScore(learner, quiz.quizId)).toMatchObject({ score: 3 });
  await desk.context().close();
});

test(`${J} #6 quiz analytics from real attempts, an empty state with none, and answer-level tables refused without the researcher role`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const quiz = await publishedQuiz('a');
  const desk = await console_(browser);
  await desk.goto(`/academy-ops/catalogue/quizzes/${quiz.quizId}`);
  const analytics = desk.getByTestId('quiz-analytics');
  await expect(analytics.getByTestId('analytics-empty')).toHaveText(
    'No graded attempt, so there is nothing to analyse and no score distribution is drawn.',
  );
  await expect(analytics.getByTestId('score-distribution')).toHaveCount(0);
  await expect(analytics.getByTestId('item-analysis')).toHaveCount(0);

  // Two learners: "Hope" and 10 (3 of 5), "A stop" and 12 (2 of 5).
  await takeQuiz(browser, quiz, 'ja13aa', 'c2', '10');
  await takeQuiz(browser, quiz, 'ja13ab', 'c1', '12');
  await desk.reload();
  await expect(analytics).toContainText('From 2 graded attempts by 2 learners');
  const items = analytics.getByTestId('item-analysis');
  await expect(items.locator('tr[data-question="q1"]')).toContainText('50.0%');
  await expect(items.locator('tr[data-question="q1"]')).toContainText('1.00 of 2');
  await expect(items.locator('tr[data-question="n1"]')).toContainText('1.50 of 3');
  const spread = analytics.getByTestId('score-distribution');
  await expect(spread.locator('tr')).toHaveCount(7);
  for (const [score, count] of [
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 1],
    [4, 0],
    [5, 0],
  ])
    await expect(spread.locator(`tr[data-score="${score}"] td`).nth(1)).toHaveText(String(count));

  // Answers learner by learner need the data researcher role: refused by name.
  await analytics.getByRole('button', { name: 'Show answers by learner' }).click();
  const outcome = desk.getByTestId('course-desk-outcome');
  await expect(outcome).toHaveAttribute('data-code', 'academy.permission_denied');
  await expect(outcome).toContainText('This needs a role you do not hold');
  await desk.context().close();
});

test(`${J} #7 the gradebook marks work not attempted, not zero; each download is its own stored snapshot with its own time and hash`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // A course with two graded assignments: one learner hands in the first and is graded 8 of 10, another does nothing.
  const slug = `test-j13-${RUN}`;
  const course = await staff('mutate', 'admin.createCourse', {
    slug,
    title: `TEST J-academy-13 course ${RUN}`,
    summary: 'TEST A course a founder grades.',
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
          { kind: 'assignment', title: 'TEST Sizing', indent: 0, url: null },
          { kind: 'assignment', title: 'TEST Journal', indent: 0, url: null },
        ],
      },
    ],
  });
  const [work, journal] = outline.outline[0].items.map((i) => i.id);
  for (const itemId of [work, journal])
    await staff('mutate', 'admin.saveAssignment', {
      itemId,
      revision: 0,
      instructions: 'TEST Size a trade.',
      points: '10',
      dueAt: null,
      text: 'required',
      file: 'off',
    });
  const current = await staff('query', 'admin.course', { courseId: course.id });
  await staff('mutate', 'admin.setCourseState', {
    courseId: course.id,
    to: 'published',
    revision: current.course.revision,
    reason: `TEST ${J}: open the course`,
  });
  await staff('mutate', 'admin.saveGradingPolicy', {
    courseId: course.id,
    revision: 0,
    types: [{ name: 'Homework', weight: '1', dropLowest: 0, itemIds: [work, journal] }],
    reason: `TEST ${J}: one type`,
  });

  const worker = await learnerOn(browser, 'ja13a', slug);
  const idle = await learnerOn(browser, 'ja13b', slug);
  const view = (await (await api(worker)).get(trpc('assignment', { itemId: work }))).body.result.data;
  const sent = await learnerWrite(worker, 'submitAssignment', {
    itemId: work,
    version: view.nextVersion,
    text: 'TEST My working.',
    fileId: null,
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  const row = (await staff('query', 'admin.gradingQueue', { itemId: work })).rows[0];
  await staff('mutate', 'admin.openGrading', { itemId: work, submissionId: row.submissionId });
  await staff('mutate', 'admin.gradeSubmission', {
    itemId: work,
    submissionId: row.submissionId,
    n: row.nextN,
    score: '8',
    comment: null,
    reason: null,
  });

  // The founder opens the gradebook: the idle learner's cells and total read "not attempted", never zero.
  const page = await console_(browser);
  await page.goto(`/academy-ops/catalogue/courses/${course.id}`);
  await page.getByRole('link', { name: 'Open the gradebook' }).click();
  const idleId = await userIdOf(idle);
  const idleRow = page.getByTestId('gradebook').locator(`tr[data-learner="${idleId}"]`);
  await expect(idleRow.locator('td[data-state="not_attempted"]')).toHaveCount(2);
  await expect(idleRow.getByTestId('gradebook-total')).toHaveText('not attempted');
  const workerRow = page.getByTestId('gradebook').locator(`tr[data-learner="${await userIdOf(worker)}"]`);
  await expect(workerRow.locator('td[data-state="not_attempted"]')).toHaveCount(1);
  await expect(workerRow.getByTestId('gradebook-total')).toHaveText('0.8');

  // Two reports, each downloaded: its own time and hash, and the file's bytes hash to the hash the desk shows.
  const reports = page.getByTestId('grade-reports');
  await expect(page.getByTestId('grade-reports-empty')).toBeVisible();
  const downloads = [];
  for (const n of [1, 2]) {
    await reports.getByRole('button', { name: `Make grade report ${n}` }).click();
    await expect(page.getByTestId('course-desk-outcome')).toContainText(`Done: grade report ${n} made at`);
    const line = reports.locator(`tr[data-report="${n}"]`);
    const [download] = await Promise.all([page.waitForEvent('download'), line.getByRole('link', { name: `Download report ${n}` }).click()]);
    downloads.push({
      csv: await readFile(await download.path(), 'utf8'),
      at: await line.getByTestId('report-made-at').getAttribute('data-at'),
      sha: (await line.getByTestId('report-sha256').textContent()).trim(),
    });
  }
  const [first, second] = downloads;
  expect(second.at).not.toBe(first.at);
  expect(second.sha).not.toBe(first.sha);
  const workerId = await userIdOf(worker);
  for (const d of downloads) {
    expect(createHash('sha256').update(d.csv, 'utf8').digest('hex')).toBe(d.sha);
    expect(d.csv).toContain(`made at,${d.at}`);
    const lines = d.csv.split('\r\n');
    // The stated rule: work not attempted is left out of an average, never counted as zero. The worker's Homework average
    // and total are their one graded score, 0.8; counting the untried journal as zero would make both 0.4.
    expect(lines.find((l) => l.startsWith(`${workerId},`))).toBe(`${workerId},0.8,not attempted,0.8,0.8`);
    expect(lines.find((l) => l.startsWith(`${idleId},`))).toBe(`${idleId},not attempted,not attempted,not attempted,not attempted`);
  }
  // Downloading report 1 again serves the same stored bytes, not a new reading.
  const [again] = await Promise.all([
    page.waitForEvent('download'),
    reports.locator('tr[data-report="1"]').getByRole('link', { name: 'Download report 1' }).click(),
  ]);
  expect(await readFile(await again.path(), 'utf8')).toBe(first.csv);
  await page.context().close();
});
