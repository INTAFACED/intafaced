import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, tool } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { userIdOf } from './copy.mjs';

// J-academy-13, in the running app (docs/roadmap/journeys.json): a founder grades work, fixes a quiz and downloads the
// gradebook. One test per step, titled "J-academy-13 #<n>". Steps 4-6 (AC-quizzes-04) join this file with their slice. The founder is the stack's LOCAL TEST founder A, on the founder console's gradebook page; the course
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
    expect(lines.find((l) => l.startsWith(`${workerId},`))).toMatch(new RegExp(`^${workerId},0\\.8,not attempted,`));
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
