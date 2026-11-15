// World: restart
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, restartWith } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { staffSignIn } from './staff.mjs';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';

// J-academy-18, in the running app (docs/roadmap/journeys.json): set the course team and keep the discussion clean. One
// test per step, titled "J-academy-18 #<n>", run in order. The stack's TEST founder A makes two free courses (X and Y)
// through Academy's admin door; two TEST learners enrol in both. Learner 1 posts three times in X and once in Y; learner 2
// reports two of learner 1's posts in X, the first from the Report control on the post. The moderator is the stack's TEST
// founder B, given the moderator role on X (founder A proposes it, founder B confirms: every role change is a two-founder
// change), and later the limited-staff role on Y the same way. The support agent is the stack's TEST support member, whose
// session may only read. Courses are kept on the stack, so each run's courses have addresses of their own.
const J = 'J-academy-18';
const RUN = Date.now().toString(36);
const X = { slug: `test-j18x-${RUN}`, title: `TEST J-academy-18 course X ${RUN}` };
const Y = { slug: `test-j18y-${RUN}`, title: `TEST J-academy-18 course Y ${RUN}` };
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

test.describe.configure({ mode: 'serial' });

/** What the steps before a step left behind (serial, one worker). */
const run = { x: null, y: null, l1: null, l2: null, l1Id: null, founderB: null, posts: {}, lessonY: null };

function needs(...keys) {
  for (const key of keys) if (!run[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to work on`);
}

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function learnerCall(who, procedure, input, method = 'post') {
  const client = await api(who);
  const res = method === 'get' ? await client.get(trpc(procedure, input)) : await client.post(trpc(procedure), input);
  return res;
}

async function write(who, procedure, input) {
  const res = await learnerCall(who, procedure, input);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Founder A through Academy's admin door, the same door the ops desk uses. */
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

/** One query on svc-academy's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function academyDb(read) {
  const ctx = await makeContext({ log: () => undefined });
  const postgres = createRequire(nodePath.join(REPO, 'services', 'svc-academy', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  const sql = postgres(`postgres://svc_academy:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await read(sql);
  } finally {
    await sql.end();
  }
}

/** A free course with one lesson, published, made by founder A. */
async function publishedCourse({ slug, title }) {
  let course = await staff('mutate', 'admin.createCourse', {
    slug,
    title,
    summary: 'TEST A course with a discussion to moderate.',
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
  });
  const outline = await staff('mutate', 'admin.saveOutline', {
    courseId: course.id,
    revision: course.revision,
    sections: [{ title: 'TEST Week one', items: [{ kind: 'lesson', title: 'TEST Sizing a trade', indent: 0, url: null }] }],
  });
  course = await staff('mutate', 'admin.setCourseState', {
    courseId: course.id,
    to: 'published',
    revision: outline.course.revision,
    reason: `TEST ${J}: open the course`,
  });
  return course;
}

async function learnerPage(browser, who) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  if (who) await signIn(page, who);
  return page;
}

/** A learner signs up in the browser and enrols on the free track of both courses through their own API. */
async function enrolledLearner(browser, prefix) {
  const page = await learnerPage(browser);
  const who = await signUp(page, prefix);
  await page.context().close();
  for (const c of [X, Y]) await write(who, 'enrolAuthoredCourse', { slug: c.slug, track: 'audit' });
  return who;
}

const post = (who, course, title, body) =>
  write(who, 'createDiscussionPost', {
    courseSlug: course.slug,
    topicSlug: 'general',
    kind: 'discussion',
    title,
    body,
    anonymous: false,
    image: null,
    clientRequestId: `post:${J}:${RUN}:${title}`,
  });

/** A founder on the console, in a context of its own. */
async function founderConsole(browser, key) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const founder = await founderSignIn(page, key);
  return { page, founder };
}

const queuePage = (courseId) => `/academy-ops/catalogue/moderation${courseId ? `?courseId=${courseId}` : ''}`;
const rolesPage = (courseId) => `/academy-ops/ambassadors/roles${courseId ? `?courseId=${courseId}` : ''}`;
const outcomeOf = (page) => page.getByTestId('course-desk-outcome');

/** Founder A proposes a role for founder B on a course; founder B confirms it from their own session. */
async function giveFounderB(browser, course, role, why) {
  const a = await founderConsole(browser, 'a');
  await a.page.goto(rolesPage(course.id));
  await a.page.getByLabel('Account id', { exact: true }).fill(run.founderB);
  await a.page.getByLabel('Role', { exact: true }).selectOption(role);
  await a.page.getByLabel('Why', { exact: true }).fill(why);
  await a.page.getByRole('button', { name: 'Propose the change' }).click();
  await expect(outcomeOf(a.page)).toContainText('Done: role change proposed; it waits for a second founder');
  const change = a.page.locator(`[data-change][data-holder="${run.founderB}"][data-role="${role}"]`);
  await expect(change).toHaveAttribute('data-state', 'pending');
  // Until it is confirmed, founder B holds nothing here; founder A cannot confirm their own proposal.
  await expect(a.page.locator(`[data-testid="team-holders"] [data-holder="${run.founderB}"]`)).toHaveCount(0);
  await change.getByRole('button', { name: 'Confirm' }).click();
  await expect(outcomeOf(a.page)).toHaveAttribute('data-code', 'academy.second_founder_required');
  await a.page.context().close();

  const b = await founderConsole(browser, 'b');
  await b.page.goto(rolesPage(course.id));
  await b.page
    .locator(`[data-change][data-holder="${run.founderB}"][data-role="${role}"]`)
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(outcomeOf(b.page)).toContainText('Done: role change confirmed');
  await expect(b.page.locator(`[data-testid="team-holders"] [data-holder="${run.founderB}"][data-role="${role}"]`)).toBeVisible();
  return b.page;
}

test(`${J} #1 the moderation queue lists reported posts, says "no reports" when there are none, and a support agent reads it with no delete`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  run.x = await publishedCourse(X);
  run.y = await publishedCourse(Y);
  run.l1 = await enrolledLearner(browser, 'ja18a');
  run.l2 = await enrolledLearner(browser, 'ja18b');
  run.posts.a = (await post(run.l1, X, `TEST Off-topic advert ${RUN}`, 'TEST Buy my signals, link in bio.')).id;
  run.posts.b = (await post(run.l1, X, `TEST Second advert ${RUN}`, 'TEST Still selling signals.')).id;
  run.posts.c = (await post(run.l1, X, `TEST Third post ${RUN}`, 'TEST One more from me.')).id;
  run.posts.d = (await post(run.l1, Y, `TEST A fair question in Y ${RUN}`, 'TEST How wide should a stop be?')).id;
  run.posts.e = (await post(run.l2, X, `TEST My own question ${RUN}`, 'TEST What is a position size?')).id;

  // Learner 2 reports the first post from its Report control, with a reason; reporting promises no takedown.
  const learner = await learnerPage(browser, run.l2);
  await learner.goto(`/academy/rooms/discussion/${X.slug}/${run.posts.a}`);
  await learner.getByRole('button', { name: 'Report this post' }).click();
  await learner.getByLabel('Why are you reporting it?').fill('TEST It is an advert, not a discussion.');
  await learner.getByRole('button', { name: 'Send report' }).click();
  await expect(learner.getByTestId('discussion-report-outcome')).toContainText(
    'Reported. A moderator reads every report; reporting does not promise the post is taken down.',
  );
  // The same report again changes nothing and says so.
  await learner.getByRole('button', { name: 'Send report' }).click();
  await expect(learner.getByTestId('discussion-report-outcome')).toContainText('You reported this post already.');
  await learner.context().close();
  await write(run.l2, 'reportDiscussionPost', { postId: run.posts.b, reason: 'TEST Another advert.' });

  // The support agent's session may only read.
  const page = await (await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } })).newPage();
  await staffSignIn(page, browser, 'support');
  await page.goto(queuePage(run.x.id));
  const desk = page.getByTestId('academy-moderation');
  await expect(desk.getByRole('heading', { level: 1, name: 'Academy: moderation' })).toBeVisible();
  const reports = desk.getByTestId('moderation-reports').locator('[data-report]');
  await expect(reports).toHaveCount(2);
  const first = desk.locator(`[data-report="${run.posts.a}"]`);
  await expect(first).toContainText(`TEST Off-topic advert ${RUN}`);
  await expect(first.getByTestId('report-count')).toContainText('Reported once');
  await expect(first.getByTestId('report-count')).toContainText('TEST It is an advert, not a discussion.');
  await expect(desk.locator(`[data-report="${run.posts.b}"]`)).toBeVisible();
  // Learner 2's own post was never reported, so it is not in the queue.
  await expect(desk.locator(`[data-report="${run.posts.e}"]`)).toHaveCount(0);
  run.l1Id = await first.getAttribute('data-author');
  expect(run.l1Id).toMatch(/^[0-9a-f-]{36}$/);
  // Readable, and no delete: not one delete control on the page.
  await expect(desk.getByTestId('moderation-read-only')).toHaveText('Read only: your role can read the queue but not delete anything.');
  await expect(desk.getByRole('button', { name: 'Delete post' })).toHaveCount(0);
  await expect(desk.getByRole('button', { name: 'Delete all their posts in this course' })).toHaveCount(0);
  // A direct delete from this session, past the page, is refused, and the post still shows to learners.
  const direct = await page.evaluate(async (postId) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/academy-moderation', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify({ op: 'deletePost', postId, reason: 'TEST read-only delete' }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, run.posts.a);
  expect(direct.status, JSON.stringify(direct.body)).toBe(403);
  expect(direct.body.ok).toBe(false);
  const stillThere = await learnerCall(run.l2, 'discussionThread', { postId: run.posts.a, limit: 20 }, 'get');
  expect(stillThere.status).toBe(200);

  // A course with no reports says so.
  await page.goto(queuePage(run.y.id));
  await expect(page.getByTestId('moderation-empty')).toHaveText('No reports.');
  await page.context().close();
});

test(`${J} #2 a moderator deletes a reported post with a reason: it leaves the thread, the event is listed and the author is told in the tray`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  needs('x', 'l1', 'l2', 'l1Id');
  // Founder B's account id, read from their own console session.
  const b0 = await founderConsole(browser, 'b');
  run.founderB = b0.founder.userId;
  await b0.page.context().close();
  const page = await giveFounderB(browser, run.x, 'moderator', `TEST ${J}: moderates course X`);
  await expect(page.getByTestId('team-your-permissions')).toHaveText('Your roles here permit: discussion.moderate, discussion.endorse.');

  await page.goto(queuePage(run.x.id));
  const entry = page.locator(`[data-report="${run.posts.a}"]`);
  // A deletion keeps its reason: none is refused by name, and the post stays.
  await entry.getByRole('button', { name: 'Delete post' }).click();
  await expect(outcomeOf(page)).toHaveAttribute('data-code', 'academy.reason_required');
  await expect(entry).toBeVisible();
  await entry.getByLabel('Why delete it').fill('TEST Advertising is not allowed in this discussion.');
  await entry.getByRole('button', { name: 'Delete post' }).click();
  await expect(outcomeOf(page)).toContainText('Done: post deleted');
  await expect(page.locator(`[data-report="${run.posts.a}"]`)).toHaveCount(0);
  // The event is listed with who and why.
  const event = page.getByTestId('moderation-events').locator(`[data-event][data-post="${run.posts.a}"]`);
  await expect(event).toHaveAttribute('data-action', 'delete');
  await expect(event).toContainText('Deleted a post (1 post)');
  await expect(event).toContainText(run.founderB);
  await expect(event).toContainText('Reason: TEST Advertising is not allowed in this discussion.');
  await page.context().close();

  // It left the thread: the topic no longer lists it, and its page is gone for learners.
  const classmate = await learnerPage(browser, run.l2);
  await classmate.goto(`/academy/rooms/discussion/${X.slug}`);
  await expect(classmate.locator(`[data-discussion-post="${run.posts.b}"]`)).toBeVisible();
  await expect(classmate.locator(`[data-discussion-post="${run.posts.a}"]`)).toHaveCount(0);
  const gone = await learnerCall(run.l2, 'discussionThread', { postId: run.posts.a, limit: 20 }, 'get');
  expect(gone.status, JSON.stringify(gone.body).slice(0, 300)).toBe(404);
  await classmate.context().close();

  // The author is told in their notification tray, with the reason.
  const author = await learnerPage(browser, run.l1);
  await author.goto('/notifications');
  const notice = author.getByTestId('nf-row').filter({ hasText: 'A moderator deleted your post' }).first();
  await expect(notice).toContainText(`A moderator deleted 1 of your posts in the ${X.title} discussion.`, { timeout: 30_000 });
  await expect(notice).toContainText('The reason given: TEST Advertising is not allowed in this discussion.');
  await author.context().close();
});

test(`${J} #3 bulk-deleting one user's posts in this course takes only this course's posts`, async ({ browser }) => {
  test.setTimeout(240_000);
  needs('x', 'y', 'l1', 'l1Id', 'founderB');
  const { page } = await founderConsole(browser, 'b');
  await page.goto(queuePage(run.x.id));
  const entry = page.locator(`[data-report="${run.posts.b}"]`);
  await entry.getByLabel('Why delete it').fill('TEST This account only advertises.');
  await entry.getByRole('button', { name: 'Delete all their posts in this course' }).click();
  await expect(outcomeOf(page)).toContainText("Done: the author's posts in this course deleted");
  const event = page.getByTestId('moderation-events').locator(`[data-event][data-action="bulk_delete"][data-author="${run.l1Id}"]`);
  // Their two posts still showing in X go; the one deleted in #2 is not counted again.
  await expect(event).toContainText("Deleted an author's posts in the course (2 posts)");
  await expect(event).toContainText('Reason: TEST This account only advertises.');
  await page.context().close();

  // In X: none of learner 1's posts show; learner 2's post stays. In Y: learner 1's post stays.
  const listOf = async (course) =>
    (
      await learnerCall(run.l2, 'discussionPosts', { courseSlug: course.slug, topicSlug: 'general', limit: 200 }, 'get')
    ).body.result.data.map((p) => p.id);
  const inX = await listOf(X);
  expect(inX).toContain(run.posts.e);
  for (const id of [run.posts.a, run.posts.b, run.posts.c]) expect(inX).not.toContain(id);
  expect(await listOf(Y)).toContain(run.posts.d);
  // The rows are kept, deleted with who and why, and nothing else of learner 1 was touched.
  const rows = await academyDb(
    (sql) =>
      sql`SELECT id, course_id, removed_by, removed_reason FROM academy.discussion_posts WHERE author_id = ${run.l1Id} ORDER BY created_at`,
  );
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    if (row.id === run.posts.d) expect(row.removed_by).toBeNull();
    else expect(row.removed_by).toBe(run.founderB);
  }
});

test(`${J} #4 a moderator who tries to give someone the admin role is refused against escalation`, async ({ browser }) => {
  test.setTimeout(180_000);
  needs('x', 'l1Id', 'founderB');
  const { page } = await founderConsole(browser, 'b');
  await page.goto(rolesPage(run.x.id));
  await page.getByLabel('Account id', { exact: true }).fill(run.l1Id);
  await page.getByLabel('Role', { exact: true }).selectOption('admin');
  await page.getByLabel('Why', { exact: true }).fill('TEST a moderator reaching for admin');
  await page.getByRole('button', { name: 'Propose the change' }).click();
  const outcome = outcomeOf(page);
  await expect(outcome).toHaveAttribute('data-code', 'academy.role_escalation');
  await expect(outcome).toContainText('That would give more than you hold');
  // Nothing was proposed and nobody holds admin here.
  await expect(page.locator(`[data-change][data-role="admin"]`)).toHaveCount(0);
  await expect(page.locator(`[data-testid="team-holders"] [data-role="admin"]`)).toHaveCount(0);
  await page.context().close();
});

test(`${J} #5 a limited-staff member's content edit is refused as not permitted while reading progress still works`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  needs('y', 'founderB');
  const [lesson] = await academyDb((sql) => sql`SELECT id FROM academy.course_items WHERE course_id = ${run.y.id} AND kind = 'lesson'`);
  const page = await giveFounderB(browser, run.y, 'limited_staff', `TEST ${J}: reads course Y's progress only`);
  await expect(page.getByTestId('team-your-permissions')).toHaveText('Your roles here permit: reports.');

  // An edit-content action on Y's lesson: refused as not permitted, and no lesson revision is written.
  const before = await academyDb((sql) => sql`SELECT count(*)::int AS n FROM academy.lesson_revisions WHERE item_id = ${lesson.id}`);
  await page.goto(`/academy-ops/catalogue/courses/${run.y.id}/items/${lesson.id}`);
  await page.getByRole('button', { name: 'Add block' }).click();
  await page.getByLabel('Block 1 text', { exact: true }).fill('TEST An edit limited staff may not make.');
  await page.getByRole('button', { name: 'Save lesson' }).click();
  await expect(outcomeOf(page)).toHaveAttribute('data-code', 'academy.permission_denied');
  await expect(outcomeOf(page)).toContainText('This needs a role you do not hold');
  const after = await academyDb((sql) => sql`SELECT count(*)::int AS n FROM academy.lesson_revisions WHERE item_id = ${lesson.id}`);
  expect(after[0].n).toBe(before[0].n);

  // Reading progress still works: the gradebook lists both learners enrolled in Y.
  await page.goto(`/academy-ops/catalogue/gradebook/${run.y.id}`);
  await expect(page.getByTestId('gradebook').locator('tr[data-learner]')).toHaveCount(2);
  await page.context().close();
});

test(`${J} #6 a custom role with the role limit blank is refused by name; with the limit set it saves and can be switched off`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const name = `test_reviewer_${RUN}`.replace(/[^a-z0-9_]/g, '');
  const fill = async (page) => {
    await page.getByLabel('Role name', { exact: true }).fill(name);
    await page.getByLabel('reports', { exact: true }).check();
    await page.getByLabel('comments', { exact: true }).check();
    await page.getByLabel('Why this role', { exact: true }).fill('TEST reviewers read reports and comment');
  };
  restartWith('academy', 'LOCAL_STACK_ACADEMY_ROLE_LIMIT', false);
  try {
    const { page } = await founderConsole(browser, 'a');
    await page.goto(rolesPage(null));
    await expect(page.getByTestId('team-role-limit')).toContainText('Custom role limit: not set.');
    await fill(page);
    await page.getByRole('button', { name: 'Save role' }).click();
    await expect(outcomeOf(page)).toHaveAttribute('data-code', 'academy.role_limit_unset');
    await expect(outcomeOf(page)).toContainText('The custom role limit is not set');
    await expect(page.locator(`[data-role-name="${name}"]`)).toHaveCount(0);
    await page.context().close();
  } finally {
    restartWith('academy', 'LOCAL_STACK_ACADEMY_ROLE_LIMIT', true);
  }

  const { page } = await founderConsole(browser, 'a');
  await page.goto(rolesPage(null));
  await expect(page.getByTestId('team-role-limit')).toContainText('Custom role limit: ');
  await expect(page.getByTestId('team-role-limit')).toContainText(' of 50 used.');
  await fill(page);
  await page.getByRole('button', { name: 'Save role' }).click();
  await expect(outcomeOf(page)).toContainText('Done: custom role saved');
  const role = page.locator(`[data-role-name="${name}"]`);
  await expect(role).toHaveAttribute('data-active', 'true');
  await expect(role).toContainText(`${name} (custom, on): reports, comments.`);
  await role.getByLabel(`Why switch ${name} off`).fill('TEST not needed this term');
  await role.getByRole('button', { name: `Switch ${name} off` }).click();
  await expect(outcomeOf(page)).toContainText('Done: custom role switched off');
  await expect(role).toHaveAttribute('data-active', 'false');
  await expect(role).toContainText(`${name} (custom, switched off)`);
  await page.reload();
  await expect(page.locator(`[data-role-name="${name}"]`)).toHaveAttribute('data-active', 'false');
  await page.context().close();
});
