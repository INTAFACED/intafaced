// World: none
import { test, expect } from './journey.mjs';
import { ORIGIN, api } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-academy-19 "Join a live lobby, a specialist room or a crew session", in the running app (docs/roadmap/journeys.json).
// Only step 4 is live; steps 1, 2, 3, 5 and 6 are parked until after launch (OWNER 183 (2)), so they have no test here.
// One test per live step, titled "J-academy-19 #<n>". A fresh TEST host is raised to the rank that hosts rooms through
// svc-identity's one XP door (a TEST stand-in for activity elsewhere), and opens a futures room and a merchant clinic
// through Academy's own host doors, as an ambassador would: two lessons pinned and two sessions scheduled in the futures
// room, nothing in the clinic. A second fresh TEST learner opens both room pages in the app. The stack's room size ceiling
// is a LOCAL TEST owner value (tooling/scripts/local-stack-services/academy.mjs). Rooms are kept on the stack, so each
// run's rooms have addresses of their own.
const J = 'J-academy-19';
const RUN = Date.now().toString(36);
const FUTURES = { slug: `test-j19-futures-${RUN}`, name: `TEST J-academy-19 futures desk ${RUN}` };
const CLINIC = { slug: `test-j19-clinic-${RUN}`, name: `TEST J-academy-19 merchant clinic ${RUN}` };

/** The room list's button for one room: the word Open and the room's name. */
const openRoom = (room) => 'Open ' + room.name;

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function read(who, procedure, input) {
  const res = await (await api(who)).get(trpc(procedure, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
async function write(who, procedure, input) {
  const res = await (await api(who)).post(trpc(procedure), input);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** XP through svc-identity's one award door (`rank.awardXp`, service-signed), one key per person and rank. */
async function awardXp(ctx, userId, xpDelta, rank) {
  const raw = JSON.stringify({
    userId,
    sourceModule: 'local-test-stack',
    action: 'test.xp_elsewhere',
    xpDelta,
    idempotencyKey: `${J}:xp-elsewhere:${userId}:${rank}`,
  });
  const res = await fetch(`${ctx.url('identity')}/trpc/rank.awardXp`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
}

/** A fresh TEST account, signed up in the browser (which leaves it signed in); the page is closed. */
async function freshAccount(browser, prefix) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(page, prefix);
  await page.context().close();
  return who;
}

/** Climb the rank ladder one rung at a time until the perk table says this account hosts rooms (§4.1 lobbyHostRights). */
async function raiseToHost(who) {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const session = await api(who);
  for (let rung = 0; rung < 10; rung++) {
    const perks = (await session.get('/api/identity/trpc/rank.perks')).body.result.data;
    if (perks.lobbyHostRights === true) return;
    const rank = (await session.get('/api/identity/trpc/rank.get')).body.result.data;
    expect(rank.nextRankAt, `rank ${rank.rank} has a next rung but no host rights yet: ${JSON.stringify(rank)}`).not.toBeNull();
    await awardXp(ctx, rank.userId, Number(rank.nextRankAt), rank.rank);
  }
  throw new Error(`${J}: ten rungs climbed and the perk table still grants no host rights`);
}

/** A whole UTC hour this many days ahead, so the calendar's day and order are known. */
const daysAhead = (days, hour) => {
  const at = new Date(Date.now() + days * 86_400_000);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
};

test(`${J} #4 a specialist room page shows its pinned lessons in the host's order and its calendar by day`, async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await freshAccount(browser, 'ja19h');
  await raiseToHost(host);
  const futures = await write(host, 'createRoom', { ...FUTURES, kind: 'futures', access: 'free', capacity: 30 });
  const clinic = await write(host, 'createRoom', { ...CLINIC, kind: 'merchant_clinic', access: 'free', capacity: 30 });

  // Two lessons pinned, the catalogue's second before its first, so the page must follow the host's order, not the
  // catalogue's. A repeat pin keeps its first place.
  const [first, second] = await read(host, 'curriculum', { limit: 2 });
  for (const lesson of [second, first, second]) await write(host, 'pinLesson', { roomId: futures.id, itemSlug: lesson.slug });
  // Two sessions: the later one scheduled first, so the calendar must sort by start, not by when it was booked.
  const later = await write(host, 'scheduleSession', {
    roomId: futures.id,
    title: `TEST Funding and basis ${RUN}`,
    startsAt: daysAhead(3, 15),
  });
  const sooner = await write(host, 'scheduleSession', {
    roomId: futures.id,
    title: `TEST Reading the book ${RUN}`,
    startsAt: daysAhead(1, 9),
  });

  // Only the host pins, and only a lesson the catalogue has; neither refusal changes the room.
  const learner = await freshAccount(browser, 'ja19l');
  const notHost = await (await api(learner)).post(trpc('pinLesson'), { roomId: futures.id, itemSlug: first.slug });
  expect(notHost.status).toBe(403);
  expect(notHost.body?.error?.data?.cause?.code).toBe('academy.not_host');
  const unknown = await (await api(host)).post(trpc('pinLesson'), { roomId: futures.id, itemSlug: `no-such-lesson-${RUN}` });
  expect(unknown.status).toBe(404);
  expect(unknown.body?.error?.data?.cause?.code).toBe('academy.curriculum_not_found');
  const stored = await read(learner, 'room', { roomId: futures.id, limit: 50 });
  expect(stored.pinnedLessons.map((l) => l.slug)).toEqual([second.slug, first.slug]);

  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signIn(page, learner);
  await page.goto('/academy/rooms');
  // The learner narrows the list to futures rooms and opens this one.
  await page.getByLabel('Show rooms', { exact: true }).selectOption('futures');
  const card = page.locator('article.more-room-link', { hasText: FUTURES.name });
  await expect(card).toContainText('futures');
  await expect(page.locator('article.more-room-link', { hasText: CLINIC.name })).toHaveCount(0);
  await card.getByRole('button', { name: openRoom(FUTURES), exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: FUTURES.name, exact: true })).toBeVisible();

  // Pinned lessons: the host's two, in the host's order, each with its catalogue title and a link to the lesson.
  const pins = page.locator('[data-room-pinned-lessons]');
  await expect(pins.getByRole('heading', { name: 'Pinned lessons', exact: true })).toBeVisible();
  const lessons = pins.locator('[data-room-pinned-lesson]');
  await expect(lessons).toHaveCount(2);
  await expect(lessons.nth(0)).toHaveAttribute('data-room-pinned-lesson', second.slug);
  await expect(lessons.nth(1)).toHaveAttribute('data-room-pinned-lesson', first.slug);
  await expect(lessons.nth(0).locator('strong')).toHaveText(second.title);
  await expect(lessons.nth(1).locator('strong')).toHaveText(first.title);
  await expect(lessons.nth(0).getByRole('link', { name: `Open lesson: ${second.title}`, exact: true })).toHaveAttribute(
    'href',
    `/academy/${encodeURIComponent(second.slug)}`,
  );
  // A learner who is not the host has no pin controls.
  await expect(pins.getByRole('button', { name: 'Unpin' })).toHaveCount(0);
  await expect(pins.getByLabel('Lesson to pin')).toHaveCount(0);

  // Calendar: both sessions, by day, earliest first, each with its time, title and status.
  const calendar = page.locator('[data-room-calendar]');
  await expect(calendar.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
  const days = calendar.locator('[data-room-calendar-day]');
  await expect(days).toHaveCount(2);
  // The day headings are the browser's own day for each start; the stack's browser runs in UTC.
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const heading = (iso) => new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: zone }).format(new Date(iso));
  await expect(days.nth(0).locator('h4')).toHaveText(heading(sooner.startsAt));
  await expect(days.nth(1).locator('h4')).toHaveText(heading(later.startsAt));
  const soonerRow = days.nth(0).locator(`[data-room-calendar-session="${sooner.id}"]`);
  await expect(soonerRow).toContainText(sooner.title);
  await expect(soonerRow).toContainText('Scheduled');
  await expect(soonerRow.locator('time')).toHaveAttribute('datetime', sooner.startsAt);
  await expect(days.nth(1).locator(`[data-room-calendar-session="${later.id}"]`)).toContainText(later.title);

  // The pinned lesson opens.
  await lessons
    .nth(0)
    .getByRole('link', { name: `Open lesson: ${second.title}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/academy/${second.slug}$`));
  await expect(page.getByText(second.title, { exact: true }).first()).toBeVisible();

  // A specialist room with nothing pinned and nothing scheduled says so, with no sample lesson or session.
  await page.goto('/academy/rooms');
  await page.getByLabel('Show rooms', { exact: true }).selectOption('merchant_clinic');
  await page
    .locator('article.more-room-link', { hasText: CLINIC.name })
    .getByRole('button', { name: openRoom(CLINIC), exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: CLINIC.name, exact: true })).toBeVisible();
  await expect(page.locator('[data-room-pinned-empty]')).toHaveText('This room has no pinned lessons.');
  await expect(page.locator('[data-room-pinned-lesson]')).toHaveCount(0);
  await expect(page.locator('[data-room-calendar-empty]')).toHaveText(
    'Nothing is on this room’s calendar: no session is scheduled or live.',
  );
  await expect(page.locator('[data-room-calendar-session]')).toHaveCount(0);
  expect((await read(learner, 'room', { roomId: clinic.id, limit: 50 })).pinnedLessons).toEqual([]);
  await page.context().close();
});
