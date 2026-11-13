// World: stack, restart
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, restartWithSetting } from './stack.mjs';
import { signUp } from './desk.mjs';
import { userIdOf } from './copy.mjs';

// J-academy-16 "Read the Academy numbers and manage reports", in the founder console (docs/roadmap/journeys.json). One
// test per step, titled "J-academy-16 #<n>", run in order. The founder is the stack's LOCAL TEST founder A on the console's
// Academy numbers page (/academy-ops/catalogue/analytics) and reports centre (/academy-ops/catalogue/report-centre). A fresh TEST
// learner, signed up in the browser, enrols on the Foundations path, reads three lessons and completes one through
// Academy's own API, and founder A tags them with this run's tag through Academy's admin door, the one the console uses.
// The stack's TEST owner values (tooling/scripts/local-stack-services/academy.mjs): 50 summaries a page, reports of up to
// 1000 rows kept 1440 minutes (24 hours), and a report sweep every 30 seconds, so a requested report waits for one sweep,
// runs until the next, and can be seen and aborted. A blank value, or a one-minute retention to watch a file expire, is
// svc-academy restarted with that one setting changed, and put back after.
// The journeys run one at a time on a stack (workers: 1), so the day's counts move only by what this journey does.
const J = 'J-academy-16';
const RUN = Date.now().toString(36);
const TAG = `test-j16-${RUN}`;
const PATH = 'foundations';
/** The stack's TEST report sweep interval, in milliseconds. */
const SWEEP_MS = 30_000;

test.describe.configure({ mode: 'serial' });

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
const data = (res) => res.body?.result?.data;

/**
 * Staff act through Academy's admin door as founder A, the same door the console uses. The sign-in is made once; each call
 * mints its own operator token, which lives 300 seconds (local-test-gates.mjs mintOperatorToken), because #1 to #5 take
 * longer than that and a token kept from #1 was refused in #5 (#8183).
 */
let staffDoor;
async function staff(kind, procedure, input) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { ctx, founder: (await gates.approverSessions(ctx)).a };
  })();
  const { ctx, founder } = await staffDoor;
  const token = await founder.tradeOpsToken();
  const res =
    kind === 'query' ? await ctx.edge.query('academy', procedure, input, token) : await ctx.edge.mutate('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

const DAY_MS = 86_400_000;
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
/** The console's activity window: the last 14 whole UTC days, today last (apps/admin analytics-model.ts). */
const windowNow = () => ({ from: utcDay(Date.now() - 13 * DAY_MS), to: utcDay(Date.now()) });
const today = () => utcDay(Date.now());
const metricsToday = async () => (await staff('query', 'admin.opsMetrics', { from: today(), to: today() })).days[0];

async function console_(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  return page;
}

/** The learner of this run, made once: enrolled on Foundations, three lesson reads and one completion. */
let made;
function learner(browser) {
  made ??= (async () => {
    const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
    const who = await signUp(page, 'ja16');
    await page.context().close();
    const session = await api(who);
    const enrolled = await session.post(trpc('enrolCourse'), { slug: PATH, track: 'audit' });
    expect(enrolled.status, JSON.stringify(enrolled.body).slice(0, 300)).toBe(200);
    const lessons = data(await session.get(trpc('curriculum', { path: PATH, limit: 10 })));
    expect(lessons.length, 'Foundations has three items to read').toBeGreaterThanOrEqual(3);
    return { who, userId: await userIdOf(who), session, slugs: lessons.slice(0, 3).map((l) => l.slug) };
  })();
  return made;
}

const outcome = (page) => page.getByTestId('course-desk-outcome');
const taskRow = (page, id) => page.locator(`[data-report-task="${id}"]`);

/** Reads the reports list again until task `id` is in `state` (the sweep moves it), within `ms`. */
async function untilState(page, id, state, ms) {
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Read the list again' }).click();
        return taskRow(page, id)
          .getAttribute('data-state', { timeout: 5_000 })
          .catch(() => null);
      },
      { timeout: ms, intervals: [1_000] },
    )
    .toBe(state);
}

/** Presses Request with this run's tag and returns the task the service made, from the request's own answer. */
async function requestReport(page) {
  const form = page.getByRole('form', { name: 'Request a report' });
  await form.getByLabel('Learner tag').fill(TAG);
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/academy-report-centre') && r.request().method() === 'POST');
  await form.getByRole('button', { name: /^Request report \d+$/ }).click();
  const body = await (await answer).json();
  expect(body.ok, JSON.stringify(body).slice(0, 300)).toBe(true);
  return body.task;
}

test(`${J} #1 the Academy desk's daily table shows each day's lesson reads and completions as recorded, and an unrecorded day says so`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const before = await metricsToday();
  const { session, slugs } = await learner(browser);
  for (const [i, slug] of slugs.entries()) {
    const read = await session.post(trpc('touchLesson'), { slug, secondsRead: 30, clientRequestId: `${J}:${RUN}:read:${i}` });
    expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  }
  const done = await session.post(trpc('markCurriculumComplete'), { itemSlug: slugs[0] });
  expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  const after = await metricsToday();
  expect(after.lessonsRead.value).toBe(before.lessonsRead.value + 3);
  expect(after.completions.value).toBe(before.completions.value + 1);

  const desk = await console_(browser);
  await desk.goto('/academy-ops/catalogue');
  await desk.getByRole('link', { name: 'Academy numbers' }).click();
  await expect(desk).toHaveURL(/\/academy-ops\/catalogue\/analytics$/);
  const table = desk.getByTestId('activity-by-day');
  await expect(table).toBeVisible();
  const service = await staff('query', 'admin.opsMetrics', windowNow());

  // Exactly the window's days, one row each, consecutive and ending today: no invented day, none after today.
  const rows = table.locator('tbody tr');
  const dates = await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-day')));
  const want = Array.from({ length: 14 }, (_, i) => utcDay(Date.now() - (13 - i) * DAY_MS));
  expect(dates).toEqual(want);
  expect(service.days.map((d) => d.date)).toEqual(want);

  // A day before svc-academy began recording reads "not recorded" in every column; every other day shows its count.
  const since = service.recordingSince;
  await expect(desk.getByTestId('recording-since')).toHaveAttribute('data-day', since);
  const unrecorded = service.days.filter((d) => d.date < since);
  expect(unrecorded.length, `the window holds a day before recording began (${since})`).toBeGreaterThan(0);
  for (const day of service.days) {
    const row = table.locator(`tr[data-day="${day.date}"]`);
    for (const metric of ['lessonsRead', 'completions', 'grants']) {
      const cell = row.locator(`td[data-metric="${metric}"]`);
      if (day.date < since) {
        expect(day[metric], `${day.date} ${metric}`).toEqual({ value: null, reason: 'metric_not_recorded' });
        await expect(cell).toHaveText('not recorded');
      } else await expect(cell).toHaveText(String(day[metric].value));
    }
  }
  // Today's row carries this learner's three reads and one completion.
  const todayRow = table.locator(`tr[data-day="${today()}"]`);
  await expect(todayRow.locator('td[data-metric="lessonsRead"]')).toHaveText(String(after.lessonsRead.value));
  await expect(todayRow.locator('td[data-metric="completions"]')).toHaveText(String(after.completions.value));
});

test(`${J} #2 per-learner summaries: empty when no learner matches, one row per learner, and a blank page size refuses by name`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { userId } = await learner(browser);
  const desk = await console_(browser);
  const open = () => desk.goto(`/academy-ops/catalogue/analytics?tag=${TAG}`);

  // No learner carries this run's tag yet: an honest empty state, no row.
  await open();
  await expect(desk.getByTestId('learner-summaries-empty')).toHaveText(`No learner with an open enrolment carries the tag ${TAG}.`);
  await expect(desk.getByTestId('learner-summaries')).toHaveCount(0);

  await staff('mutation', 'admin.tagLearners', { userIds: [userId], tag: TAG, reason: `TEST ${J}: the learner whose numbers are read` });
  await open();
  const table = desk.getByTestId('learner-summaries');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  const service = await staff('query', 'admin.learnerSummaries', { tag: TAG });
  expect(service.rows.map((r) => r.userId)).toEqual([userId]);
  const [mine] = service.rows;
  expect(mine.itemsCompleted).toBe(1);
  expect(mine.enrolments).toBeGreaterThanOrEqual(1);
  const row = table.locator(`tr[data-learner="${userId}"]`);
  await expect(row.locator('td[data-metric="enrolments"]')).toHaveText(String(mine.enrolments));
  await expect(row.locator('td[data-metric="itemsCompleted"]')).toHaveText('1');
  await expect(row.locator('td[data-metric="lastActive"]')).toHaveAttribute('data-at', mine.lastActiveAt);
  await expect(row).toContainText(TAG);

  // The owner's page size left blank: svc-academy lists no learner and says why, in the page's full layout.
  restartWithSetting('academy', 'LOCAL_STACK_ACADEMY_LEARNER_SUMMARIES', 'off');
  try {
    await open();
    const refused = desk.locator('[data-code="academy.learner_summaries_list_limit_unset"]');
    await expect(refused).toContainText('Could not read the learner summaries');
    await expect(refused).toContainText('ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE');
    await expect(desk.getByTestId('learner-summaries')).toHaveCount(0);
    await expect(desk.getByTestId('activity-by-day')).toBeVisible();
  } finally {
    restartWithSetting('academy', 'LOCAL_STACK_ACADEMY_LEARNER_SUMMARIES', null);
  }
});

/** Task ids made in #3 and #4, used by #4 and #5. */
const tasks = {};

test(`${J} #3 a requested report shows Requested, then Running; aborted while running it shows Aborted and no file is served`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await learner(browser);
  const desk = await console_(browser);
  await desk.goto('/academy-ops/catalogue');
  await desk.getByRole('link', { name: 'Reports centre', exact: true }).click();
  await expect(desk).toHaveURL(/\/academy-ops\/catalogue\/report-centre$/);

  const first = await requestReport(desk);
  tasks.aborted = first.id;
  expect(first).toMatchObject({ state: 'queued', kind: 'learners', tag: TAG });
  await expect(outcome(desk)).toContainText(`Done: report request ${first.n} taken`);
  const row = taskRow(desk, first.id);
  await expect(row.getByTestId('report-state')).toHaveText('Requested');
  await expect(row.getByRole('button', { name: `Abort report ${first.n}` })).toBeVisible();

  // The sweep starts it; it runs until the next sweep, and is aborted while it runs.
  await untilState(desk, first.id, 'running', SWEEP_MS + 15_000);
  await expect(row.getByTestId('report-state')).toHaveText('Running');
  await row.getByRole('button', { name: `Abort report ${first.n}` }).click();
  await expect(outcome(desk)).toContainText(`Done: report ${first.n} aborted; it will have no file`);
  await expect(row.getByTestId('report-state')).toHaveText('Aborted');
  await expect(row.getByRole('link', { name: /^Download report/ })).toHaveCount(0);
  await expect(row.getByTestId('report-made-at')).toHaveText('no file');

  // A second request, run by a later sweep, shows the sweep came round again: the aborted task stays aborted, fileless.
  const second = await requestReport(desk);
  tasks.done = second.id;
  expect(second.n).toBe(first.n + 1);
  await untilState(desk, second.id, 'running', SWEEP_MS + 15_000);
  await expect(taskRow(desk, first.id)).toHaveAttribute('data-state', 'aborted');
  const file = await desk.request.get(`/api/academy-report-centre?task=${first.id}`);
  expect(file.status()).toBe(409);
  expect((await file.json()).code).toBe('academy.report_not_ready');
  const held = (await staff('query', 'admin.reportCentreTasks', undefined)).tasks.find((t) => t.id === first.id);
  expect(held).toMatchObject({ state: 'aborted', sha256: null, rows: null });
});

test(`${J} #4 a finished report downloads with its time and hash; once expired it says expired; a blank retention refuses the request`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { userId } = await learner(browser);
  const desk = await console_(browser);
  await desk.goto('/academy-ops/catalogue/report-centre');
  await untilState(desk, tasks.done, 'done', 2 * SWEEP_MS + 15_000);
  const row = taskRow(desk, tasks.done);
  await expect(row.getByTestId('report-state')).toHaveText('Finished');
  const held = (await staff('query', 'admin.reportCentreTasks', undefined)).tasks.find((t) => t.id === tasks.done);
  await expect(row.getByTestId('report-made-at')).toHaveAttribute('data-at', held.finishedAt);
  await expect(row.getByTestId('report-sha256')).toHaveText(held.sha256);

  // The file: its first line names the time it was made, its bytes hash to the shown SHA-256, and it holds only the
  // learners carrying the tag, with the summaries' columns.
  const download = desk.waitForEvent('download');
  await row.getByRole('link', { name: `Download report ${held.n}` }).click();
  const bytes = await readFile(await (await download).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(held.sha256);
  const lines = bytes.toString('utf8').trimEnd().split('\r\n');
  expect(lines[0]).toBe(`learners report,${held.n},made at,${held.finishedAt},tag,${TAG}`);
  expect(lines[1]).toBe('learner,enrolments,items completed,last active,tags');
  expect(lines.slice(2).map((l) => l.split(',')[0])).toEqual([userId]);
  expect(lines.slice(2)[0].split(',')[2]).toBe('1');

  // The file is kept for the owner's retention, 1440 minutes on the stack.
  expect(Date.parse(held.expiresAt) - Date.parse(held.finishedAt)).toBe(24 * 3_600_000);
  expect(held.expired).toBe(false);

  // Later: with svc-academy keeping a file one minute, a report made then runs out on its own. The list says Expired and
  // the file is refused.
  restartWithSetting('academy', 'LOCAL_STACK_ACADEMY_REPORT_CENTRE_RETENTION', '1');
  try {
    await desk.reload();
    const short = await requestReport(desk);
    tasks.lapsed = short.id;
    await untilState(desk, short.id, 'done', 2 * SWEEP_MS + 15_000);
    const made = (await staff('query', 'admin.reportCentreTasks', undefined)).tasks.find((t) => t.id === short.id);
    expect(made).toMatchObject({ state: 'done', expired: false });
    expect(Date.parse(made.expiresAt) - Date.parse(made.finishedAt)).toBe(60_000);
    const lapsedRow = taskRow(desk, short.id);
    await expect(lapsedRow.getByTestId('report-sha256')).toHaveText(made.sha256);

    await untilState(desk, short.id, 'expired', 90_000);
    await expect(lapsedRow.getByTestId('report-state')).toHaveText('Expired');
    await expect(lapsedRow.getByTestId('report-expires-at')).toContainText('Expired');
    const lapsed = (await staff('query', 'admin.reportCentreTasks', undefined)).tasks.find((t) => t.id === short.id);
    expect(lapsed).toMatchObject({ state: 'done', expired: true, sha256: made.sha256, expiresAt: made.expiresAt });
    expect(Date.parse(lapsed.expiresAt)).toBeLessThan(Date.now());
    const gone = await desk.request.get(`/api/academy-report-centre?task=${short.id}`);
    expect(gone.status()).toBe(412);
    const body = await gone.json();
    expect(body.code).toBe('academy.report_expired');
    expect(body.title).toBe('This report file has expired');
  } finally {
    restartWithSetting('academy', 'LOCAL_STACK_ACADEMY_REPORT_CENTRE_RETENTION', null);
  }

  // The owner's retention left blank: a request is refused by name and no task is made.
  restartWithSetting('academy', 'LOCAL_STACK_ACADEMY_REPORT_CENTRE_RETENTION', 'off');
  try {
    await desk.reload();
    const count = await desk.locator('[data-report-task]').count();
    await desk
      .getByRole('form', { name: 'Request a report' })
      .getByRole('button', { name: /^Request report \d+$/ })
      .click();
    await expect(outcome(desk)).toHaveAttribute('data-code', 'academy.report_retention_unset');
    await expect(outcome(desk)).toContainText('The report retention is not set');
    await expect(desk.locator('[data-report-task]')).toHaveCount(count);
  } finally {
    restartWithSetting('academy', 'LOCAL_STACK_ACADEMY_REPORT_CENTRE_RETENTION', null);
  }
});

test(`${J} #5 deleting a report task takes it and its file off the list`, async ({ browser }) => {
  test.setTimeout(180_000);
  const desk = await console_(browser);
  await desk.goto('/academy-ops/catalogue/report-centre');
  for (const id of [tasks.done, tasks.aborted, tasks.lapsed]) {
    const row = taskRow(desk, id);
    await expect(row).toHaveCount(1);
    const n = await row.locator('td').first().textContent();
    await row.getByRole('button', { name: `Delete report ${n}` }).click();
    await expect(outcome(desk)).toContainText('Done: report deleted with its file');
    await expect(taskRow(desk, id)).toHaveCount(0);
    await desk.reload();
    await expect(taskRow(desk, id)).toHaveCount(0);
    const file = await desk.request.get(`/api/academy-report-centre?task=${id}`);
    expect(file.status()).toBe(404);
    expect((await file.json()).code).toBe('academy.report_not_found');
  }
  const left = (await staff('query', 'admin.reportCentreTasks', undefined)).tasks.map((t) => t.id);
  expect(left).not.toContain(tasks.done);
  expect(left).not.toContain(tasks.aborted);
  expect(left).not.toContain(tasks.lapsed);
});
