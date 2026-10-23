import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-03, in the running app (docs/roadmap/journeys.json): work through a course. One test per step, titled
// "J-academy-03 #<n>", run in order. The learner is a verified TEST account signed up in the browser and enrolled from
// the course page; the course is what svc-academy publishes. Each test is its own browser context, so #10 is a second
// device by construction. Staff rules (a TEST prerequisite) go through Academy's own admin door and come off at the end.
const J = 'J-academy-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

async function publicRead(procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(`${EDGE}/api/academy/trpc/${procedure}${query}`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** The published course's items in order, as its public course page lists them. */
const syllabus = async (slug) => (await publicRead('publicCourse', { slug })).syllabus.map((row) => row.slug);

/** The learner's own current completions, read from Academy with a session of their own. */
async function completions(who) {
  const res = await (await api(who)).get(`/api/academy/trpc/myCompletions?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items;
}

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

const outline = (page, course) => page.locator(`[data-academy-outline="${course}"]`);
const completion = (page, slug) => page.locator(`[data-item-completion="${slug}"]`);
const myCourse = (page, slug) => page.locator(`[data-my-learning-section] [data-my-course="${slug}"]`);

test(`${J} #1 Complete and continue records the completion once, pressed twice, and opens the next item`, async ({ page }) => {
  const course = (await publicRead('publicCourses')).find((card) => card.slug);
  expect(course, 'a published course is needed').toBeTruthy();
  const items = await syllabus(course.slug);
  expect(items.length, 'the course needs four items: #3 locks the third behind the second').toBeGreaterThanOrEqual(4);
  const who = await signUp(page, 'ja3');
  await verify(page, who);
  run.reset({ who, course: course.slug, items });
  await signIn(page, who);
  await page.goto(`/academy/learning/course/${course.slug}`);
  await page.locator('[data-academy-enrol]').getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(page.getByText(/^You are enrolled on the Free track since /)).toBeVisible();

  const sent = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/academy/trpc/markCurriculumComplete')) sent.push(request.url());
  });
  await page.goto(`/academy/${items[0]}`);
  const control = completion(page, items[0]);
  await expect(control).toHaveAttribute('data-item-state', /unlocked|started/);
  await control.getByRole('button', { name: 'Complete and continue', exact: true }).dblclick();
  await expect(page).toHaveURL(`/academy/${items[1]}`);
  await expect(outline(page, course.slug).locator(`[data-outline-item="${items[0]}"]`)).toHaveAttribute('data-outline-state', 'completed');
  await expect(outline(page, course.slug).locator(`[data-outline-item="${items[1]}"] a`)).toHaveAttribute('aria-current', 'page');
  expect(sent).toHaveLength(1);
  const recorded = (await completions(who)).filter((row) => row.itemSlug === items[0]);
  expect(recorded).toHaveLength(1);
  run.write({ firstCompletedAt: recorded[0].completedAt });
});

test(`${J} #2 Undo drops the progress, and completing again records a new completion`, async ({ page }) => {
  const { who, course, items, firstCompletedAt } = state('who', 'course', 'items', 'firstCompletedAt');
  await signIn(page, who);
  await page.goto('/academy/learning');
  await expect(myCourse(page, course).getByText(`1 of ${items.length} items done`)).toBeVisible();

  await page.goto(`/academy/${items[0]}`);
  const control = completion(page, items[0]);
  await expect(control.getByText(/^Completed on /)).toBeVisible();
  await control.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(control.getByText('Completion undone. Course progress no longer counts this item.')).toBeVisible();
  await expect(outline(page, course).locator(`[data-outline-item="${items[0]}"]`)).not.toHaveAttribute('data-outline-state', 'completed');
  expect((await completions(who)).filter((row) => row.itemSlug === items[0])).toHaveLength(0);
  await page.goto('/academy/learning');
  await expect(myCourse(page, course).getByText(`0 of ${items.length} items done`)).toBeVisible();

  await page.goto(`/academy/${items[0]}`);
  await completion(page, items[0]).getByRole('button', { name: 'Complete and continue', exact: true }).click();
  await expect(page).toHaveURL(`/academy/${items[1]}`);
  const again = (await completions(who)).filter((row) => row.itemSlug === items[0]);
  expect(again).toHaveLength(1);
  expect(Date.parse(again[0].completedAt)).toBeGreaterThan(Date.parse(firstCompletedAt));
  await page.goto('/academy/learning');
  await expect(myCourse(page, course).getByText(`1 of ${items.length} items done`)).toBeVisible();
});

test(`${J} #3 an item that needs an earlier one is locked with a link to it, and its body is never sent`, async ({ page }) => {
  const { who, items } = state('who', 'items');
  await setPrerequisites(items[2], [items[1]]);
  try {
    await signIn(page, who);
    const reads = [];
    page.on('response', async (response) => {
      if (response.url().includes('/api/academy/trpc/curriculumItemLocalized')) reads.push(await response.text());
    });
    await page.goto(`/academy/${items[2]}`);
    const notice = page.locator('[data-locked-item="prerequisite"]');
    await expect(notice.getByText('This item is locked')).toBeVisible();
    const link = notice.getByRole('link');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', `/academy/${items[1]}`);
    expect(reads.length).toBeGreaterThan(0);
    for (const body of reads) {
      expect(body).toContain('academy.prerequisite_unmet');
      expect(body).not.toContain('"body"');
    }
    await link.click();
    await expect(page).toHaveURL(`/academy/${items[1]}`);
    await expect(completion(page, items[1]).getByRole('button', { name: 'Complete and continue', exact: true })).toBeVisible();
  } finally {
    await setPrerequisites(items[2], []);
  }
});

test(`${J} #10 Continue on another device opens the item last read`, async ({ page, browser }) => {
  const { who, course, items } = state('who', 'course', 'items');
  // The first device reads the fourth item.
  const first = await browser.newContext({ baseURL: ORIGIN });
  try {
    const desk = await first.newPage();
    await signIn(desk, who);
    const touched = desk.waitForResponse((r) => r.url().includes('/api/academy/trpc/touchLesson') && r.ok());
    await desk.goto(`/academy/${items[3]}`);
    await expect(completion(desk, items[3])).toBeVisible();
    await touched;
  } finally {
    await first.close();
  }
  // This page is a second device: nothing local carries over.
  await signIn(page, who);
  await page.goto('/academy/learning');
  const resume = myCourse(page, course).getByRole('link', { name: 'Continue' });
  await expect(resume).toHaveAttribute('href', `/academy/${items[3]}`);
  await resume.click();
  await expect(page).toHaveURL(`/academy/${items[3]}`);
});
