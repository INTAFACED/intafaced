import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-academy-04, in the running app (docs/roadmap/journeys.json): a learner hands in an assignment and reads the feedback.
// One test per step, titled "J-academy-04 #<n>", run in order. The stack's LOCAL TEST founder A makes the course on the
// founder console (a back-end write path, as staff would), with two assignments: one the learner hands in and one they
// never try. Courses are kept on the stack, so each run's course has an address of its own.
const J = 'J-academy-04';
const RUN = Date.now().toString(36);
const SLUG = `test-j04-${RUN}`;
const TITLE = `TEST J-academy-04 course ${RUN}`;
const WORK = 'TEST Position-size write-up';
const UNTRIED = 'TEST Journal review';
const MY_TEXT = 'TEST I size each trade so a stop costs one percent of the account.';
/** A one-page PDF: what svc-academy checks is its leading bytes, so this is enough to be one. */
const PDF = {
  name: 'TEST-sizing.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
};

test.describe.configure({ mode: 'serial' });

/** What the steps before a step left behind (serial, one worker). */
const run = { courseUrl: null, workUrl: null, workItem: null, learnerUrl: null, me: null, classmates: [] };

/** Throws at once when an earlier step left nothing, so an unbuilt step stays cheap. */
function needs(...keys) {
  for (const key of keys) if (!run[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to work on`);
}

/** Founder A on the console, in a context of its own. */
async function console_(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  return page;
}

/** A learner's page on the customer app, in a context of its own. */
async function learnerPage(browser) {
  return (await browser.newContext({ baseURL: ORIGIN })).newPage();
}

/** A local date and time a day from now (or `days` from now), as a datetime-local field takes it. */
function tomorrow(days = 1) {
  const at = new Date(Date.now() + days * 24 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const trpc = (procedure) => `/api/academy/trpc/${procedure}`;

/** Founder A sets the course's late policy on its gradebook page, as staff would. */
async function setLatePolicy(browser, graceHours, deductionPerDay) {
  const desk = await console_(browser);
  await desk.goto(run.courseUrl.replace('/catalogue/courses/', '/catalogue/gradebook/'));
  await desk.waitForLoadState('networkidle');
  const form = desk.getByTestId('late-policy');
  await form.getByLabel('Grace hours', { exact: true }).fill(graceHours);
  await form.getByLabel('Deduction per day', { exact: true }).fill(deductionPerDay);
  await form.getByLabel('Late policy reason', { exact: true }).fill(`TEST ${J}: late hand-ins lose points`);
  await expect(form.getByLabel('Deduction per day', { exact: true })).toHaveValue(deductionPerDay);
  await form.getByRole('button', { name: 'Save late policy', exact: true }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toContainText('Done: late policy saved');
  await expect(desk.getByTestId('late-policy-now')).toContainText(
    `${graceHours} hours of grace after the due date, then ${deductionPerDay} of the points off for each started day late.`,
  );
  await desk.context().close();
}

/** Founder A moves the assignment's due date on the console, saving the brief as the next revision. */
async function setDue(browser, local) {
  const desk = await console_(browser);
  await desk.goto(run.workUrl);
  const editor = desk.getByTestId('assignment-editor');
  // The editor holds the brief in page state: wait until the page has settled, or a fill before it is live is lost.
  await desk.waitForLoadState('networkidle');
  const due = editor.getByLabel('Due', { exact: true });
  await due.fill(local);
  await expect(due).toHaveValue(local);
  await editor.getByRole('button', { name: 'Save assignment' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toContainText('Done: assignment saved');
  await desk.context().close();
  // The learner's own read carries the new due date (the datetime-local value is the console's local time).
  await expect.poll(async () => (await assignmentOf(run.me)).body.result.data.dueAt).toBe(new Date(local).toISOString());
}

/** The caller's own view of the assignment, read through the customer's API. */
async function assignmentOf(who) {
  const res = await (await api(who)).get(`${trpc('assignment')}?input=${encodeURIComponent(JSON.stringify({ itemId: run.workItem }))}`);
  return res;
}

/** A classmate signs up, enrols on the free track and hands in text and a file, all through the customer's own API. */
async function classmate(browser, prefix, text) {
  const page = await learnerPage(browser);
  const who = await signUp(page, prefix);
  await page.context().close();
  const session = await api(who);
  const enrol = await session.post(trpc('enrolAuthoredCourse'), { slug: SLUG, track: 'audit' });
  expect(enrol.status, JSON.stringify(enrol.body).slice(0, 300)).toBe(200);
  const view = (await assignmentOf(who)).body.result.data;
  // The assignment needs a file as well as text, so the classmate uploads one of their own first.
  const file = await session.post(trpc('uploadAssignmentFile'), {
    itemId: run.workItem,
    fileName: 'TEST-classmate.pdf',
    contentType: PDF.mimeType,
    contentBase64: PDF.buffer.toString('base64'),
  });
  expect(file.status, JSON.stringify(file.body).slice(0, 300)).toBe(200);
  const fileId = file.body.result.data.id;
  const sent = await session.post(trpc('submitAssignment'), { itemId: run.workItem, version: view.nextVersion, text, fileId });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  return who;
}

test(`${J} #1 the assignment shows its brief, due date, what to hand in and the course's late rule`, async ({ browser }) => {
  test.setTimeout(300_000);
  // Staff make a free course with two assignments and set the first one's brief: text and a file, both required.
  const desk = await console_(browser);
  await desk.goto('/academy-ops/catalogue/courses');
  await desk.getByLabel('Title', { exact: true }).fill(TITLE);
  await desk.getByLabel('Address', { exact: true }).fill(SLUG);
  await desk.getByRole('button', { name: 'Create draft' }).click();
  await desk.waitForURL(/\/academy-ops\/catalogue\/courses\/[0-9a-f-]{36}$/);
  run.courseUrl = new URL(desk.url()).pathname;
  await desk.getByLabel('New section', { exact: true }).fill('Work to hand in');
  await desk.getByRole('button', { name: 'Add section' }).click();
  for (const [n, title] of [WORK, UNTRIED].entries()) {
    await desk.getByRole('button', { name: 'Add item to section 1' }).click();
    await desk.getByRole('combobox', { name: `Section 1 item ${n + 1} type`, exact: true }).selectOption('assignment');
    await desk.getByLabel(`Section 1 item ${n + 1} title`, { exact: true }).fill(title);
  }
  await desk.getByRole('button', { name: 'Save outline' }).click();
  const outcome = desk.getByTestId('course-desk-outcome');
  await expect(outcome).toContainText('Done: outline saved');

  for (const [n, title] of [WORK, UNTRIED].entries()) {
    await desk.goto(run.courseUrl);
    await desk.getByRole('link', { name: `Write Section 1 item ${n + 1}`, exact: true }).click();
    await desk.waitForURL(/\/items\/[0-9a-f-]{36}$/);
    const editor = desk.getByTestId('assignment-editor');
    await expect(desk.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    await expect(editor.getByTestId('assignment-facts')).toContainText('Not set up yet: learners see it as not released');
    await editor.getByLabel('Instructions', { exact: true }).fill(`TEST ${title}: show how you size one trade, with your working.`);
    await editor.getByLabel('Points', { exact: true }).fill('10');
    await editor.getByLabel('Due', { exact: true }).fill(tomorrow());
    await editor.getByRole('combobox', { name: 'Text answer', exact: true }).selectOption('required');
    await editor.getByRole('combobox', { name: 'File answer', exact: true }).selectOption(n === 0 ? 'required' : 'off');
    await editor.getByRole('button', { name: 'Save assignment' }).click();
    await expect(outcome).toContainText('Done: assignment saved');
    await expect(editor.getByTestId('assignment-facts')).toContainText('Revision 1');
    if (n === 0) {
      run.workUrl = new URL(desk.url()).pathname;
      run.workItem = run.workUrl.split('/').pop();
    }
  }
  await desk.goto(run.courseUrl);
  await desk.getByLabel('Reason', { exact: true }).fill('TEST open for hand-ins');
  await desk.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(desk.getByTestId('course-history')).toContainText('moved to published');
  await desk.context().close();

  // The learner signs up, enrols on the free track and opens the assignment from the course page.
  const page = await learnerPage(browser);
  // Signing up leaves the learner signed in.
  run.me = await signUp(page, 'j04');
  await page.goto(`/academy/learning/course/${SLUG}`);
  await page.locator(`[data-academy-enrol="${SLUG}"]`).getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(page.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  await page.locator(`[data-academy-authored-course="${SLUG}"]`).getByRole('link', { name: WORK, exact: true }).click();
  await page.waitForURL(new RegExp(`/academy/learning/course/${SLUG}/assignment/${run.workItem}$`));
  run.learnerUrl = new URL(page.url()).pathname;
  const box = page.locator(`[data-academy-assignment="${run.workItem}"]`);
  await expect(box.getByRole('heading', { name: WORK })).toBeVisible();
  await expect(box).toContainText(`TEST ${WORK}: show how you size one trade, with your working.`);
  await expect(box.getByTestId('assignment-due')).toContainText(/^Due /);
  await expect(box.getByTestId('assignment-points')).toHaveText('Worth 10 points');
  const asks = box.getByTestId('assignment-asks');
  await expect(asks).toContainText('Text: required');
  await expect(asks).toContainText('File: required (application/pdf, image/png; up to 768 KiB)');
  // Before staff set one, the course has no late rule and the page says so in words.
  await expect(box.getByTestId('assignment-late-rule')).toHaveText('Late rule: this course has none.');
  // Staff give the course a late policy on its gradebook page (ENGINE GR-5); the learner's page states it in words.
  await setLatePolicy(browser, '24', '0.1');
  await page.reload();
  await expect(box.getByTestId('assignment-late-rule')).toHaveText(
    'Late rule: 24 hours of grace after the due date, then 10% of the points off for each started day late, never below 0.',
  );
  await expect(box.getByTestId('assignment-submissions')).toHaveText('Nothing handed in yet.');
  await page.context().close();
});

test(`${J} #2 text without the required file is refused as incomplete and nothing is recorded`, async ({ browser }) => {
  needs('learnerUrl', 'me');
  const page = await learnerPage(browser);
  await signIn(page, run.me);
  await page.goto(run.learnerUrl);
  const box = page.locator(`[data-academy-assignment="${run.workItem}"]`);
  await box.getByLabel('Your answer', { exact: true }).fill(MY_TEXT);
  await box.getByRole('button', { name: 'Hand in', exact: true }).click();
  const outcome = box.getByTestId('assignment-outcome');
  await expect(outcome).toHaveAttribute('data-code', 'academy.submission_incomplete');
  await expect(outcome).toContainText('This assignment also needs a file. Nothing was handed in.');
  // Nothing is stored: the page and svc-academy agree.
  await page.reload();
  await expect(box.getByTestId('assignment-submissions')).toHaveText('Nothing handed in yet.');
  const stored = (await assignmentOf(run.me)).body.result.data;
  expect(stored.submissions).toEqual([]);
  expect(stored.nextVersion).toBe(1);
  await page.context().close();
});

test(`${J} #3 text and a file handed in with the reply lost show one submission; the page reads it back`, async ({ browser }) => {
  needs('learnerUrl', 'me', 'workUrl', 'workItem');
  const page = await learnerPage(browser);
  await signIn(page, run.me);
  await page.goto(run.learnerUrl);
  const box = page.locator(`[data-academy-assignment="${run.workItem}"]`);
  await box.getByLabel('Your answer', { exact: true }).fill(MY_TEXT);
  await box.getByLabel('File', { exact: true }).setInputFiles(PDF);
  await expect(box.getByTestId('assignment-file')).toContainText('TEST-sizing.pdf');
  // svc-academy records the hand-in; the browser never sees the answer, as when a connection drops.
  const sent = [];
  await page.route('**/api/academy/trpc/submitAssignment**', async (route) => {
    sent.push(route.request().postData());
    await route.fetch();
    await route.abort('connectionreset');
  });
  await box.getByRole('button', { name: 'Hand in', exact: true }).click();
  await expect(box.getByTestId('assignment-outcome')).toContainText('The connection dropped before Academy answered');
  await page.unroute('**/api/academy/trpc/submitAssignment**');
  // The page reads the stored hand-in back instead of sending it again.
  const rows = box.getByTestId('assignment-submissions').locator('li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Version 1');
  await expect(rows.first()).toContainText('Submitted');
  await expect(rows.first()).toContainText('TEST-sizing.pdf');
  await expect(rows.first()).not.toContainText('Late');
  expect(sent).toHaveLength(1);
  // Sent again with the same key, svc-academy answers with the same record; nothing is recorded twice.
  const again = await (await api(run.me)).post(trpc('submitAssignment'), JSON.parse(sent[0]));
  expect(again.status).toBe(200);
  const stored = (await assignmentOf(run.me)).body.result.data;
  expect(stored.submissions).toHaveLength(1);
  expect(stored.submissions[0]).toMatchObject({ version: 1, state: 'submitted', text: MY_TEXT, late: false });
  expect(stored.submissions[0].file).toMatchObject({ fileName: 'TEST-sizing.pdf', contentType: 'application/pdf' });
  await page.reload();
  await expect(rows).toHaveCount(1);

  // Late is read against the due date: with the due date moved before the hand-in, the same version reads Late, and
  // moved back it does not. Nothing new is recorded either way.
  await setDue(browser, tomorrow(-1));
  try {
    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Late');
    expect((await assignmentOf(run.me)).body.result.data.submissions).toMatchObject([{ version: 1, late: true }]);
  } finally {
    // Put the due date back for the steps after this one, whatever happened above.
    await setDue(browser, tomorrow());
  }
  await page.reload();
  await expect(rows.first()).toContainText('On time');
  await expect(rows.first()).not.toContainText('Late');
  expect((await assignmentOf(run.me)).body.result.data.submissions).toMatchObject([{ version: 1, late: false }]);
  await page.context().close();
});

test(`${J} #4 a learner who is not enrolled is refused: enrolment is required`, async ({ browser }) => {
  needs('learnerUrl');
  const page = await learnerPage(browser);
  const outsider = await signUp(page, 'j04out');
  await page.goto(run.learnerUrl);
  const box = page.locator(`[data-academy-assignment="${run.workItem}"]`);
  const outcome = box.getByTestId('assignment-outcome');
  await expect(outcome).toHaveAttribute('data-code', 'academy.enrolment_required');
  await expect(outcome).toContainText('Enrol in this course to hand in work.');
  await expect(box.getByRole('link', { name: 'Open the course page to enrol' })).toHaveAttribute(
    'href',
    `/academy/learning/course/${SLUG}`,
  );
  // Sent straight to svc-academy, the hand-in is refused by name and nothing is stored.
  const sent = await (await api(outsider)).post(trpc('submitAssignment'), { itemId: run.workItem, version: 1, text: 'TEST', fileId: null });
  expect(sent.body?.error?.data?.cause?.code).toBe('academy.enrolment_required');
  await page.context().close();
});

test(`${J} #5 peer review: two classmates' work against the rubric, then my own; never my own work as a peer; a waiting list while too few others exist`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  needs('workUrl', 'me');
  // Staff turn on peer review (two reviews each, a two-criterion rubric) and a self review.
  const desk = await console_(browser);
  await desk.goto(run.workUrl);
  const steps = desk.getByTestId('assignment-review-steps');
  await expect(steps).toBeVisible({ timeout: 10_000 });
  await steps.getByLabel('Peer review', { exact: true }).check();
  await steps.getByLabel('Reviews each learner gives', { exact: true }).fill('2');
  await steps.getByLabel('Self review', { exact: true }).check();
  await steps.getByLabel('Criterion 1', { exact: true }).fill('TEST Sizing');
  await steps.getByLabel('Criterion 1 levels', { exact: true }).fill('0, 1, 2');
  await steps.getByRole('button', { name: 'Add criterion' }).click();
  await steps.getByLabel('Criterion 2', { exact: true }).fill('TEST Working shown');
  await steps.getByLabel('Criterion 2 levels', { exact: true }).fill('0, 1');
  await steps.getByRole('button', { name: 'Save review steps' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toContainText('Done: review steps saved');
  await desk.context().close();

  // One classmate has handed in so far.
  run.classmates.push(await classmate(browser, 'j04b', 'TEST Classmate B sizes by a fixed amount.'));
  const page = await learnerPage(browser);
  await signIn(page, run.me);
  await page.goto(run.learnerUrl);
  const review = page.locator(`[data-academy-assignment="${run.workItem}"]`).getByTestId('assignment-review');
  await expect(review.getByTestId('review-count')).toHaveText('Peer review: 0 of 2 done');
  const work = review.getByTestId('review-work');
  await expect(work).toContainText('TEST Classmate B');
  await expect(work).not.toContainText(MY_TEXT);
  await review.getByRole('radio', { name: 'TEST Sizing: 1' }).check();
  await review.getByRole('radio', { name: 'TEST Working shown: 1' }).check();
  await review.getByRole('button', { name: 'Send review' }).click();
  await expect(review.getByTestId('review-count')).toHaveText('Peer review: 1 of 2 done');
  // Nobody else has handed in: the learner waits, and is never handed their own work.
  await expect(review.getByTestId('review-waiting')).toContainText('Waiting for more classmates to hand in');
  await expect(review.getByTestId('review-work')).toHaveCount(0);

  run.classmates.push(await classmate(browser, 'j04c', 'TEST Classmate C sizes from the stop distance.'));
  await page.reload();
  await expect(work).toContainText('TEST Classmate C');
  await review.getByRole('radio', { name: 'TEST Sizing: 2' }).check();
  await review.getByRole('radio', { name: 'TEST Working shown: 1' }).check();
  await review.getByRole('button', { name: 'Send review' }).click();
  await expect(review.getByTestId('review-count')).toHaveText('Peer review: 2 of 2 done');

  // Then the self review, of the learner's own work.
  await expect(review.getByTestId('review-self')).toContainText(MY_TEXT);
  await review.getByRole('radio', { name: 'TEST Sizing: 2' }).check();
  await review.getByRole('radio', { name: 'TEST Working shown: 1' }).check();
  await review.getByRole('button', { name: 'Send self review' }).click();
  await expect(review.getByTestId('review-count')).toHaveText('Reviews done');
  await page.context().close();
});

test(`${J} #6 after grading, the grade and comment show once released, with no grader name on an anonymous grade`, async ({ browser }) => {
  test.setTimeout(240_000);
  needs('workUrl', 'me', 'learnerUrl', 'workItem');
  // Before staff grade, nothing is released: the learner's page shows no score and no comment.
  const before = await learnerPage(browser);
  await signIn(before, run.me);
  await before.goto(run.learnerUrl);
  const unreleased = before.locator(`[data-academy-assignment="${run.workItem}"]`).getByTestId('assignment-grade');
  await expect(unreleased).toHaveText('Ungraded: staff grade each hand-in after it arrives.');
  await before.context().close();

  const desk = await console_(browser);
  await desk.goto(run.workUrl);
  await desk.getByRole('link', { name: 'Grade hand-ins', exact: true }).click({ timeout: 10_000 });
  const queue = desk.getByTestId('grading-queue');
  // Anonymous grading: the grader sees an alias, never the learner's name.
  await expect(queue).not.toContainText(run.me.handle);
  const mine = queue.locator('[data-grading-row]').filter({ hasText: 'TEST-sizing.pdf' });
  await mine.getByRole('button', { name: 'Grade' }).click();
  const form = desk.getByTestId('grade-form');
  await form.getByLabel('Score', { exact: true }).fill('8');
  await form.getByLabel('Comment', { exact: true }).fill('TEST Clear sizing; show the stop distance next time.');
  await form.getByRole('button', { name: 'Save grade' }).click();
  await expect(desk.getByTestId('course-desk-outcome')).toContainText('Done: grade saved');
  await desk.context().close();

  const page = await learnerPage(browser);
  await signIn(page, run.me);
  await page.goto(run.learnerUrl);
  const grade = page.locator(`[data-academy-assignment="${run.workItem}"]`).getByTestId('assignment-grade');
  await expect(grade).toContainText('8 of 10 points');
  await expect(grade).toContainText('TEST Clear sizing; show the stop distance next time.');
  await expect(grade).not.toContainText(/founder|graded by/i);
  await grade.getByRole('button', { name: 'Mark as read' }).click();
  await expect(grade).toContainText('You read this feedback');
  await page.context().close();
});

test(`${J} #7 the grades page shows the grade with its type average, and "not attempted" (never zero) where I have not tried`, async ({
  browser,
}) => {
  needs('me');
  const page = await learnerPage(browser);
  await signIn(page, run.me);
  await page.goto('/academy/progress');
  const grades = page.locator(`[data-course-grades="${SLUG}"]`);
  await expect(grades).toBeVisible({ timeout: 10_000 });
  await expect(grades.locator('tr').filter({ hasText: WORK })).toContainText('8 / 10');
  await expect(grades.locator('tr').filter({ hasText: UNTRIED })).toContainText('Not attempted');
  await expect(grades.locator('tr').filter({ hasText: UNTRIED })).not.toContainText(/\b0 \/ 10\b/);
  await expect(grades.getByTestId('type-average-assignment')).toContainText('80%');
  await page.context().close();
});
