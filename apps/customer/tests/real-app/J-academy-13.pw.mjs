import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api } from './stack.mjs';
import { signUp } from './desk.mjs';
import { userIdOf } from './copy.mjs';

// J-academy-13, in the running app (docs/roadmap/journeys.json): a founder grades work, fixes a quiz and downloads the
// gradebook. One test per step, titled "J-academy-13 #<n>". Steps 1-6 (AC-assignments-02, AC-quizzes-04) join this file
// with their slices. The founder is the stack's LOCAL TEST founder A, on the founder console's gradebook page; the course
// is made through Academy's own admin door first. Learners act through their own API, signed up in the browser.
const J = 'J-academy-13';
const RUN = Date.now().toString(36);

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function learnerWrite(who, procedure, input) {
  return (await api(who)).post(trpc(procedure), input);
}

/** Staff act through Academy's admin door with the stack's TEST founder A, the same door the console uses. */
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

async function console_(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  return page;
}

async function learnerOn(browser, prefix, slug) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(page, prefix);
  await page.context().close();
  const res = await learnerWrite(who, 'enrolAuthoredCourse', { slug, track: 'audit' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return who;
}

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
