import { test, expect } from '@playwright/test';
import { ORIGIN, api, restartWith } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-academy-08, in the running app (docs/roadmap/journeys.json): ask a question in the course discussion and message the
// course team. One test per step, titled "J-academy-08 #<n>", run in order. The stack's TEST founder A is the course team:
// it makes a free course through Academy's own admin door, with two topics beside the course's default General one, and
// answers the learner's message the same way. Courses are kept on the stack, so each run's course has an address of its
// own and its General topic starts empty. A blank post length refuses by name (academy.post_limit_unset): #2 restarts Academy
// with the stack's post limits blank, posts, and puts them back; a blank message length (academy.message_limit_unset) is
// proved by svc-academy's messages tests.
const J = 'J-academy-08';
const RUN = Date.now().toString(36);
const SLUG = `test-j08-${RUN}`;
const TITLE = `TEST J-academy-08 course ${RUN}`;
const QUESTION = `TEST How do I size a first trade? ${RUN}`;
const ANON = `TEST A worry I would rather not sign ${RUN}`;
const MESSAGE = `TEST Is there a session on position sizing this week? ${RUN}`;
const STAFF_REPLY = `TEST Yes, on Thursday. ${RUN}`;
/** A one-pixel PNG. */
const PNG = {
  name: 'TEST-chart.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
};
const PDF = { name: 'TEST-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') };

test.describe.configure({ mode: 'serial' });

/** What the steps before a step left behind (serial, one worker). */
const run = { courseId: null, me: null, classmate: null, question: null, replies: [], anon: null, conversation: null };

function needs(...keys) {
  for (const key of keys) if (!run[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to work on`);
}

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

/** Academy restarted with the stack's TEST post and message limits blank (`off`), or back on them. */
const academyPostLimits = (on) => restartWith('academy', 'LOCAL_STACK_ACADEMY_POST_LIMITS', on);

async function learnerPage(browser, who) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  if (who) await signIn(page, who);
  return page;
}

/** A learner signs up in the browser (which leaves them signed in) and enrols on the free track through their own API. */
async function enrolledLearner(browser, prefix) {
  const page = await learnerPage(browser);
  const who = await signUp(page, prefix);
  await page.context().close();
  await write(who, 'enrolAuthoredCourse', { slug: SLUG, track: 'audit' });
  return who;
}

const discussion = (page) => page.locator(`[data-discussion="${SLUG}"]`);
const threadOf = (page, postId) => page.locator(`[data-discussion-thread="${postId}"]`);

test(`${J} #1 the Rooms tab opens my course's Discussion: General is empty with no sample post, and a pinned topic stays first`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // The course team makes a free course with one lesson and publishes it, then adds two topics: one pinned, one not.
  let course = await staff('mutate', 'admin.createCourse', {
    slug: SLUG,
    title: TITLE,
    summary: 'TEST A course with a discussion and a course team.',
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
  run.courseId = course.id;
  // The pinned topic has the highest position, so only the pin can put it first.
  await staff('mutate', 'admin.saveDiscussionTopic', {
    courseId: course.id,
    slug: 'week-one',
    title: 'TEST Week one questions',
    pinned: false,
    position: 1,
    reason: `TEST ${J}: a topic for week one`,
  });
  await staff('mutate', 'admin.saveDiscussionTopic', {
    courseId: course.id,
    slug: 'read-first',
    title: 'TEST Read this first',
    pinned: true,
    position: 9,
    reason: `TEST ${J}: a pinned topic`,
  });

  run.me = await enrolledLearner(browser, 'ja8');
  const page = await learnerPage(browser, run.me);
  await page.goto('/academy/rooms');
  const courses = page.locator('[data-discussion-courses]');
  await courses.locator(`[data-discussion-course="${SLUG}"]`).getByRole('link', { name: 'Open discussion', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/academy/rooms/discussion/${SLUG}$`));
  const topics = discussion(page).locator('[data-discussion-topic]');
  await expect(topics).toHaveCount(3);
  await expect(topics.nth(0)).toHaveAttribute('data-discussion-topic', 'read-first');
  await expect(topics.nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(topics.nth(1)).toHaveAttribute('data-discussion-topic', 'general');
  await expect(topics.nth(2)).toHaveAttribute('data-discussion-topic', 'week-one');
  // General is open by default and empty: an honest empty state, no sample post.
  await expect(discussion(page).getByTestId('discussion-open-topic')).toHaveAttribute('data-topic', 'general');
  await expect(discussion(page).getByTestId('discussion-empty')).toHaveText('No posts in this topic yet. Ask the first question.');
  await expect(discussion(page).locator('[data-discussion-post]')).toHaveCount(0);
  expect(await read(run.me, 'discussionPosts', { courseSlug: SLUG, topicSlug: 'general', limit: 50 })).toEqual([]);

  // Moving the unpinned topic's position does not move the pinned one off the top.
  await staff('mutate', 'admin.saveDiscussionTopic', {
    courseId: course.id,
    slug: 'week-one',
    title: 'TEST Week one questions',
    pinned: false,
    position: 0,
    reason: `TEST ${J}: week one before General`,
  });
  await page.reload();
  await expect(topics.nth(0)).toHaveAttribute('data-discussion-topic', 'read-first');
  await page.context().close();
});

test(`${J} #2 a question pressed twice is one post; a non-image file refuses by type; a blank post length refuses by name`, async ({
  browser,
}) => {
  needs('me');
  // Two Academy restarts (limits blank, then back) can take most of a minute each.
  test.setTimeout(300_000);
  const page = await learnerPage(browser, run.me);
  await page.goto(`/academy/rooms/discussion/${SLUG}`);
  const form = discussion(page).getByTestId('discussion-new-post');
  const outcome = form.getByTestId('discussion-outcome');
  // While the owner's post length is blank, a post refuses by that name and nothing is posted.
  academyPostLimits(false);
  try {
    await form.getByLabel('Title', { exact: true }).fill(QUESTION);
    await form.getByLabel('Your post', { exact: true }).fill('TEST A post while no length is set.');
    await form.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(outcome).toHaveAttribute('data-code', 'academy.post_limit_unset');
    await expect(outcome).toContainText('Posting is off: Academy has not set how long a post may be. Nothing was posted.');
    expect(await read(run.me, 'discussionPosts', { courseSlug: SLUG, topicSlug: 'general', limit: 50 })).toEqual([]);
  } finally {
    academyPostLimits(true);
  }
  await page.reload();
  await form.getByRole('combobox', { name: 'Kind of post', exact: true }).selectOption('question');
  await form.getByLabel('Title', { exact: true }).fill(QUESTION);
  await form.getByLabel('Your post', { exact: true }).fill('TEST I have 1,000 TEST units. How much should one trade risk?');
  // A file that is not an image is refused by its type, and nothing is posted.
  await form.getByLabel('Image (optional)', { exact: true }).setInputFiles(PDF);
  await form.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(outcome).toHaveAttribute('data-code', 'academy.attachment_type_refused');
  await expect(outcome).toContainText('Only an image can be attached to a post. Nothing was posted.');
  expect(await read(run.me, 'discussionPosts', { courseSlug: SLUG, topicSlug: 'general', limit: 50 })).toEqual([]);

  // With an image it posts, and pressing twice makes one post.
  await form.getByLabel('Image (optional)', { exact: true }).setInputFiles(PNG);
  await form.getByRole('button', { name: 'Post', exact: true }).dblclick();
  await expect(outcome).toHaveAttribute('data-code', 'ok');
  const posts = discussion(page).locator('[data-discussion-post]');
  await expect(posts).toHaveCount(1);
  await expect(posts.first()).toContainText(QUESTION);
  await expect(posts.first()).toHaveAttribute('data-kind', 'question');
  const stored = await read(run.me, 'discussionPosts', { courseSlug: SLUG, topicSlug: 'general', limit: 50 });
  expect(stored.map((p) => p.title)).toEqual([QUESTION]);
  run.question = stored[0].id;
  await posts.first().getByRole('link', { name: QUESTION, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/academy/rooms/discussion/${SLUG}/${run.question}$`));
  await expect(threadOf(page, run.question).locator('img[data-post-image]')).toBeVisible();
  await page.context().close();
});

test(`${J} #3 a classmate replies; the reply I accept is on top, a second accept moves the mark; follow and like work once`, async ({
  browser,
}) => {
  needs('me', 'question');
  run.classmate = await enrolledLearner(browser, 'ja8c');
  for (const [n, body] of ['TEST Risk one percent of the account.', 'TEST Size so the stop costs a fixed amount.'].entries()) {
    const reply = await write(run.classmate, 'replyDiscussionPost', {
      postId: run.question,
      body,
      anonymous: false,
      clientRequestId: `reply:${J}:${RUN}:${n}`,
    });
    run.replies.push(reply.id);
  }
  // The classmate is not the asker, so cannot mark an answer.
  const refused = await (await api(run.classmate)).post(trpc('acceptDiscussionReply'), { postId: run.question, replyId: run.replies[0] });
  expect(refused.status).toBe(403);
  expect(JSON.stringify(refused.body)).toContain('academy.permission_denied');

  const page = await learnerPage(browser, run.me);
  await page.goto(`/academy/rooms/discussion/${SLUG}/${run.question}`);
  const thread = threadOf(page, run.question);
  const replies = thread.locator('[data-discussion-reply]');
  await expect(replies).toHaveCount(2);
  // Accept the second reply: it moves to the top.
  await thread.locator(`[data-discussion-reply="${run.replies[1]}"]`).getByRole('button', { name: 'Mark as accepted answer' }).click();
  await expect(replies.nth(0)).toHaveAttribute('data-discussion-reply', run.replies[1]);
  await expect(replies.nth(0)).toHaveAttribute('data-accepted', 'true');
  await expect(replies.nth(0).getByTestId('reply-accepted')).toHaveText('Accepted answer');
  // Accepting the other one moves the mark: one accepted reply at a time.
  await thread.locator(`[data-discussion-reply="${run.replies[0]}"]`).getByRole('button', { name: 'Mark as accepted answer' }).click();
  await expect(replies.nth(0)).toHaveAttribute('data-discussion-reply', run.replies[0]);
  await expect(replies.nth(0)).toHaveAttribute('data-accepted', 'true');
  await expect(replies.nth(1)).toHaveAttribute('data-accepted', 'false');
  await expect(thread.locator('[data-accepted="true"]')).toHaveCount(1);

  // Follow and like are set once: a repeat changes nothing.
  await thread.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(thread.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
  const liked = thread.locator(`[data-discussion-reply="${run.replies[0]}"]`);
  await liked.getByRole('button', { name: 'Like', exact: true }).click();
  await expect(liked.getByTestId('reply-likes')).toHaveText('1 like');
  await write(run.me, 'likeDiscussionPost', { postId: run.replies[0], on: true });
  await write(run.me, 'followDiscussionPost', { postId: run.question, on: true });
  const view = await read(run.me, 'discussionThread', { postId: run.question, limit: 50 });
  expect(view.post.following).toBe(true);
  expect(view.post.acceptedReplyId).toBe(run.replies[0]);
  expect(view.replies.find((r) => r.id === run.replies[0]).likes).toBe(1);
  await page.reload();
  await expect(liked.getByTestId('reply-likes')).toHaveText('1 like');
  await expect(thread.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
  await page.context().close();
});

test(`${J} #4 an anonymous post shows classmates no name, and staff see who wrote it`, async ({ browser }) => {
  needs('me', 'classmate', 'courseId');
  const page = await learnerPage(browser, run.me);
  await page.goto(`/academy/rooms/discussion/${SLUG}`);
  const form = discussion(page).getByTestId('discussion-new-post');
  await form.getByRole('combobox', { name: 'Kind of post', exact: true }).selectOption('discussion');
  await form.getByLabel('Title', { exact: true }).fill(ANON);
  await form.getByLabel('Your post', { exact: true }).fill('TEST I lost more than I meant to on one trade.');
  await form.getByLabel('Post anonymously', { exact: true }).check();
  await form.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(form.getByTestId('discussion-outcome')).toHaveAttribute('data-code', 'ok');
  const mine = discussion(page).locator('[data-discussion-post]').filter({ hasText: ANON });
  await expect(mine.getByTestId('post-author')).toHaveText('You, posted anonymously');
  await page.context().close();

  // The classmate's page and the classmate's own read carry no name and no account id for it.
  const posts = await read(run.classmate, 'discussionPosts', { courseSlug: SLUG, topicSlug: 'general', limit: 50 });
  const anon = posts.find((p) => p.title === ANON);
  run.anon = anon.id;
  expect(anon.author).toEqual({ kind: 'anonymous' });
  expect(JSON.stringify(anon)).not.toContain((await api(run.me)).userId);
  const named = posts.find((p) => p.title === QUESTION);
  expect(named.author.kind).toBe('learner');
  const peer = await learnerPage(browser, run.classmate);
  await peer.goto(`/academy/rooms/discussion/${SLUG}`);
  const seen = discussion(peer).locator(`[data-discussion-post="${run.anon}"]`);
  await expect(seen.getByTestId('post-author')).toHaveText('Anonymous');
  await peer.context().close();

  // Staff see the account behind it.
  const staffView = await staff('query', 'admin.discussionThread', { postId: run.anon, limit: 50 });
  expect(staffView.post.anonymous).toBe(true);
  expect(staffView.post.authorId).toBe((await api(run.me)).userId);
});

test(`${J} #5 a message to the course team is in my inbox; with no mail provider it is stored and the email notice shows`, async ({
  browser,
}) => {
  needs('me', 'courseId');
  const page = await learnerPage(browser, run.me);
  await page.goto(`/academy/learning/course/${SLUG}`);
  const form = page.getByTestId('course-team-contact');
  await form.getByLabel('Message to the course team', { exact: true }).fill(MESSAGE);
  await form.getByRole('button', { name: 'Send to the course team', exact: true }).click();
  await expect(form.getByTestId('course-team-outcome')).toHaveAttribute('data-code', 'ok');
  // The message is stored; the mail copy is the one thing switched off, and the page says so.
  await expect(form.locator('[data-not-connected="vendor.email"]')).toBeVisible();
  await form.getByRole('link', { name: 'Open the conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/academy\/rooms\/messages\/[0-9a-f-]{36}$/);
  run.conversation = page.url().split('/').pop();
  const conversation = page.locator(`[data-course-conversation="${run.conversation}"]`);
  await expect(conversation.locator('[data-course-message]')).toHaveCount(1);
  await expect(conversation.locator('[data-course-message]').first()).toContainText(MESSAGE);
  await page.goto('/academy/rooms/messages');
  await expect(page.locator(`[data-course-inbox-row="${run.conversation}"]`)).toContainText(TITLE);
  await page.context().close();

  // The course team's inbox has it, unread on their side.
  const inbox = await staff('query', 'admin.courseInbox', { limit: 200 });
  const row = inbox.find((c) => c.id === run.conversation);
  expect(row.staffUnread).toBe(true);
  expect(row.learnerId).toBe((await api(run.me)).userId);
});

test(`${J} #6 staff reply: I see it and the unread marker clears on read; a learner who is not enrolled is refused`, async ({
  browser,
}) => {
  needs('me', 'conversation');
  await staff('mutate', 'admin.replyCourseMessage', {
    conversationId: run.conversation,
    body: STAFF_REPLY,
    clientRequestId: `reply:${J}:${RUN}`,
  });
  const page = await learnerPage(browser, run.me);
  await page.goto('/academy/rooms/messages');
  const row = page.locator(`[data-course-inbox-row="${run.conversation}"]`);
  await expect(row).toHaveAttribute('data-unread', 'true');
  await row.getByRole('link').first().click();
  const conversation = page.locator(`[data-course-conversation="${run.conversation}"]`);
  await expect(conversation.locator('[data-course-message]')).toHaveCount(2);
  await expect(conversation.locator('[data-course-message][data-from="staff"]')).toContainText(STAFF_REPLY);
  await page.goto('/academy/rooms/messages');
  await expect(row).toHaveAttribute('data-unread', 'false');
  await page.context().close();

  // Someone not enrolled in the course is refused by the form, and nothing is sent.
  const stranger = await learnerPage(browser);
  await signUp(stranger, 'ja8x');
  await stranger.goto(`/academy/learning/course/${SLUG}`);
  const form = stranger.getByTestId('course-team-contact');
  await form.getByLabel('Message to the course team', { exact: true }).fill('TEST I am not enrolled.');
  await form.getByRole('button', { name: 'Send to the course team', exact: true }).click();
  await expect(form.getByTestId('course-team-outcome')).toHaveAttribute('data-code', 'academy.enrolment_required');
  await expect(form.getByTestId('course-team-outcome')).toContainText('Enrol in this course to message its course team.');
  await stranger.context().close();
});
