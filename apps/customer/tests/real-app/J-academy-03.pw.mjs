import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, journeyState, signOutBrowser } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-03, in the running app (docs/roadmap/journeys.json): work through a course. One test per step, titled
// "J-academy-03 #<n>", run in order. The learner is a verified TEST account signed up in the browser and enrolled from
// the course page; the course is what svc-academy publishes. Each test is its own browser context, so #10 is a second
// device by construction. Staff rules (a TEST prerequisite, a TEST quiz) go through Academy's own admin door and come off at the end.
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

/** A TEST quiz staff publish on one item for steps #6 and #7, and take down at the end. */
const testQuiz = (reviewMode) => ({
  passMark: 2,
  attemptLimit: 2,
  timeLimitSeconds: 600,
  reviewMode,
  questions: [
    {
      id: 'q1',
      prompt: 'TEST: what does a spot trade settle?',
      points: 1,
      choices: [
        { id: 'a', text: 'TEST: now' },
        { id: 'b', text: 'TEST: later' },
      ],
      correctChoiceId: 'a',
    },
    {
      id: 'q2',
      prompt: 'TEST: what does a limit order fix?',
      points: 1,
      choices: [
        { id: 'a', text: 'TEST: the worst price' },
        { id: 'b', text: 'TEST: the size of the book' },
      ],
      correctChoiceId: 'a',
    },
  ],
});
const setQuiz = (slug, quiz) => staff('admin.setQuiz', { slug, quiz, reason: `${J} TEST quiz` });

/** The learner's open quiz attempt, read from Academy with a session of their own. */
async function openAttempt(who, slug) {
  const res = await (await api(who)).get(`/api/academy/trpc/assessment.current?input=${encodeURIComponent(JSON.stringify({ slug }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

async function attemptsOn(who, slug) {
  const res = await (await api(who)).get(`/api/academy/trpc/assessment.attempts?input=${encodeURIComponent(JSON.stringify({ slug }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const outline = (page, course) => page.locator(`[data-academy-outline="${course}"]`);
const completion = (page, slug) => page.locator(`[data-item-completion="${slug}"]`);
const myCourse = (page, slug) => page.locator(`[data-my-learning-section] [data-my-course="${slug}"]`);
const quizBox = (page, slug) => page.locator(`[data-quiz="${slug}"]`);
const secondsLeft = async (page, slug) => Number(await quizBox(page, slug).getByRole('timer').getAttribute('data-seconds-left'));

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

/** The spine video staff attach to the fifth item for #4 and #5, with two TEST caption tracks, all taken off at the end. */
const VIDEO = 'foundations-risk-first';
const cueEvery2s = (words) =>
  `WEBVTT\n\n${words.map((word, i) => `00:${String(i * 2).padStart(2, '0')}.000 --> 00:${String(i * 2 + 2).padStart(2, '0')}.000\nTEST: ${word}\n`).join('\n')}`;
const TRACKS = [
  { language: 'en', label: 'TEST English', vtt: cueEvery2s(['one', 'two', 'three', 'four', 'five', 'six']) },
  { language: 'es', label: 'TEST Español', vtt: cueEvery2s(['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis']) },
];
async function videoOn(item, tracks = TRACKS) {
  await staff('admin.setItemVideo', { itemSlug: item, videoSlug: VIDEO, reason: `${J} TEST video item` });
  await staff('admin.setVideoTracks', { videoSlug: VIDEO, tracks, reason: `${J} TEST captions` });
}
async function videoOff(item) {
  await staff('admin.setItemVideo', { itemSlug: item, videoSlug: null, reason: `${J} TEST video item off` });
  await staff('admin.setVideoTracks', { videoSlug: VIDEO, tracks: [], reason: `${J} TEST captions off` });
}
const player = (page) => page.locator(`[data-video-player="${VIDEO}"]`);
const media = (page) => player(page).locator('video');
const mediaTime = (page) => media(page).evaluate((video) => video.currentTime);
/** A menu's choices, as the select lists them. */
const choices = (select) => select.evaluate((menu) => [...menu.options].map((option) => option.textContent));
async function storedPosition(who) {
  const res = await (
    await api(who)
  ).get(`/api/academy/trpc/videoProgress.get?input=${encodeURIComponent(JSON.stringify({ videoSlug: VIDEO }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.positionSeconds;
}

test(`${J} #4 a video plays with our controls, captions by language with a transcript that follows, and resumes after leaving`, async ({
  page,
}) => {
  const { who, items } = state('who', 'items');
  const item = items[4];
  expect(item, 'the course needs a fifth item for the video').toBeTruthy();
  await videoOn(item, []);
  try {
    await signIn(page, who);
    await page.goto(`/academy/${item}`);
    // With no captions the menu says so, and no empty track is attached.
    await expect(player(page).locator('[data-video-captions="none"]')).toContainText('No captions for this video');
    await expect(player(page).locator('track')).toHaveCount(0);
    await expect(player(page).getByText('This video has no transcript.')).toBeVisible();
    // The item completes by watching, so its button says what it needs instead.
    await expect(completion(page, item).getByText('Watch this item’s video past the course threshold to complete it.')).toBeVisible();

    await videoOn(item);
    await page.reload();
    const captions = player(page).getByRole('combobox', { name: 'Captions', exact: true });
    expect(await choices(captions)).toEqual(['Off', 'TEST English', 'TEST Español']);
    await captions.selectOption('es');
    await expect
      .poll(() => media(page).evaluate((video) => [...video.textTracks].map((track) => `${track.language}:${track.mode}`)))
      .toEqual(['en:disabled', 'es:showing']);
    await expect(player(page).locator('[data-transcript="es"] li')).toHaveCount(6);
    // Speed and the one quality that exists.
    const speed = player(page).getByRole('combobox', { name: 'Speed', exact: true });
    await speed.selectOption('1.5');
    await expect.poll(() => media(page).evaluate((video) => video.playbackRate)).toBe(1.5);
    await speed.selectOption('1');
    expect(await choices(player(page).getByRole('combobox', { name: 'Quality', exact: true }))).toEqual(['Original file']);
    await expect(player(page).getByRole('button', { name: 'Full screen', exact: true })).toBeEnabled();

    // Play two seconds: the transcript follows; pausing stores the place, below the course threshold.
    await player(page).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => mediaTime(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(2.2);
    await player(page).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(player(page).locator('[data-transcript="es"] li[aria-current="true"]')).toContainText('TEST: dos');
    await expect(player(page).locator('[data-video-status="saved"]')).toBeVisible();
    const stored = await storedPosition(who);
    expect(stored).toBeGreaterThanOrEqual(2);
    expect(stored).toBeLessThan(4);

    // Leave and return: playback resumes at the stored place.
    await page.goto('/academy/learning');
    await page.goto(`/academy/${item}`);
    await expect(player(page).locator(`[data-video-resumed="${stored}"]`)).toBeVisible();
    expect(Math.floor(await mediaTime(page))).toBe(stored);
    expect((await completions(who)).some((row) => row.itemSlug === item)).toBe(false);
  } finally {
    await videoOff(item);
  }
});

test(`${J} #5 watching past the course threshold completes the video item without a button`, async ({ page }) => {
  const { who, course, items } = state('who', 'course', 'items');
  const item = items[4];
  await videoOn(item);
  try {
    await signIn(page, who);
    const pressed = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/academy/trpc/markCurriculumComplete')) pressed.push(request.url());
    });
    await page.goto(`/academy/${item}`);
    await expect(player(page).locator('[data-video-threshold="4"]')).toHaveText('Watching past 0:04 completes this item.');
    await player(page).getByRole('button', { name: 'Play', exact: true }).click();
    await expect(player(page).locator('[data-video-status="completed"]')).toHaveText(
      'You watched past the course threshold, so this item is complete.',
      { timeout: 20_000 },
    );
    await expect(outline(page, course).locator(`[data-outline-item="${item}"]`)).toHaveAttribute('data-outline-state', 'completed');
    await expect(completion(page, item).getByText(/^Completed on /)).toBeVisible();
    expect(pressed).toHaveLength(0);
    expect((await completions(who)).filter((row) => row.itemSlug === item)).toHaveLength(1);
    expect(await storedPosition(who)).toBeGreaterThanOrEqual(4);
  } finally {
    await videoOff(item);
  }
});

test(`${J} #6 a timed quiz keeps one attempt and its clock on the server: Start with the reply lost, autosave, refresh`, async ({
  page,
}) => {
  const { who, items } = state('who', 'items');
  const slug = items[1];
  await setQuiz(slug, testQuiz('answers'));
  try {
    await signIn(page, who);
    await page.goto(`/academy/${slug}`);
    // Step #1's course rule: with a quiz on the item, Complete and continue waits for a pass and says so.
    const control = completion(page, slug);
    await expect(control.getByText('Pass this item’s quiz to complete it.')).toBeVisible();
    await expect(control.getByRole('button', { name: 'Complete and continue', exact: true })).toBeDisabled();

    const box = quizBox(page, slug);
    await expect(box).toHaveAttribute('data-quiz-state', 'ready');
    await expect(box.getByText('Time limit: 10 min')).toBeVisible();
    await expect(box.getByText('Attempts allowed: 2')).toBeVisible();
    const starts = [];
    // Academy opens the attempt and answers; the browser never sees the answer, as when a connection drops.
    await page.route('**/api/academy/trpc/assessment.start**', async (route) => {
      starts.push(route.request().url());
      await route.fetch();
      await route.abort('connectionreset');
    });
    await box.getByRole('button', { name: 'Start quiz', exact: true }).dblclick();
    await expect(box).toHaveAttribute('data-quiz-state', 'open');
    expect(starts).toHaveLength(1);
    await page.unroute('**/api/academy/trpc/assessment.start**');
    const opened = await openAttempt(who, slug);
    expect(opened.number).toBe(1);
    await expect(box.getByText('Attempt 1', { exact: true })).toBeVisible();

    // One question at a time; the choice is saved without a button.
    await expect(box.locator('[data-quiz-question]')).toHaveCount(1);
    await expect(box.locator('[data-quiz-question]')).toHaveAttribute('data-quiz-question', 'q1');
    await expect(box.getByText('TEST: what does a limit order fix?')).toHaveCount(0);
    const saved = page.waitForResponse((r) => r.url().includes('/api/academy/trpc/assessment.answer') && r.ok());
    await box.getByRole('radio', { name: 'TEST: now' }).check();
    await saved;
    await expect(box.getByText('Answer saved.')).toBeVisible();
    expect((await openAttempt(who, slug)).answers).toEqual({ q1: 'a' });

    // A refresh comes back to the same attempt, the same deadline, and the time left the server counts.
    await page.reload();
    await expect(box).toHaveAttribute('data-quiz-state', 'open');
    await expect(box.getByText(/^Your attempt is still open/)).toBeVisible();
    const after = await openAttempt(who, slug);
    expect(after.attemptId).toBe(opened.attemptId);
    expect(after.deadlineAt).toBe(opened.deadlineAt);
    const shown = await secondsLeft(page, slug);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(600);
    expect(Math.abs(shown - after.secondsLeft)).toBeLessThanOrEqual(3);
    // It opens on the first unanswered question; the saved answer is there going back.
    await expect(box.locator('[data-quiz-question]')).toHaveAttribute('data-quiz-question', 'q2');
    await box.getByRole('button', { name: 'Previous question', exact: true }).click();
    await expect(box.getByRole('radio', { name: 'TEST: now' })).toBeChecked();
    run.write({ quizSlug: slug, quizAttempt: opened.attemptId });
  } catch (error) {
    await setQuiz(slug, null);
    throw error;
  }
});

test(`${J} #7 finishing twice scores once, the review shows my own answers or the score only, and the limit refuses Start`, async ({
  page,
}) => {
  const { who, items, quizSlug, quizAttempt } = state('who', 'items', 'quizSlug', 'quizAttempt');
  try {
    await signIn(page, who);
    await page.goto(`/academy/${quizSlug}`);
    const box = quizBox(page, quizSlug);
    await expect(box).toHaveAttribute('data-quiz-state', 'open');
    await expect(box.locator('[data-quiz-question]')).toHaveAttribute('data-quiz-question', 'q2');
    const saved = page.waitForResponse((r) => r.url().includes('/api/academy/trpc/assessment.answer') && r.ok());
    await box.getByRole('radio', { name: 'TEST: the worst price' }).check();
    await saved;

    const finishes = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/academy/trpc/assessment.finish')) finishes.push(request.url());
    });
    await box.getByRole('button', { name: 'Finish and submit', exact: true }).dblclick();
    const result = box.locator(`[data-quiz-result="${quizAttempt}"]`);
    await expect(result.getByText('You scored 2 of 2 points.')).toBeVisible();
    await expect(result.getByText('Passed', { exact: true })).toBeVisible();
    expect(finishes).toHaveLength(1);
    // A second Finish, as from another tab, returns the same score and records nothing new.
    const again = await (await api(who)).post('/api/academy/trpc/assessment.finish', { attemptId: quizAttempt });
    expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
    expect(again.body.result.data.result).toMatchObject({ score: 2, maxScore: 2, pass: true });
    expect(await attemptsOn(who, quizSlug)).toHaveLength(1);

    // The review is this learner's own attempt, answer by answer.
    const review = result.locator('[data-quiz-review="answers"]');
    await expect(review.locator('[data-review-question]')).toHaveCount(2);
    await expect(review.getByText('Your answer: TEST: now')).toBeVisible();
    await expect(review.getByText('Your answer: TEST: the worst price')).toBeVisible();
    // The course rule is met now: Complete and continue is on.
    await expect(completion(page, quizSlug).getByRole('button', { name: 'Complete and continue', exact: true })).toBeEnabled();

    // Staff switch the quiz to score only; the second (and last) attempt shows the score and no answers.
    await setQuiz(quizSlug, testQuiz('score_only'));
    await page.reload();
    await expect(box).toHaveAttribute('data-quiz-state', 'ready');
    await box.getByRole('button', { name: 'Start quiz', exact: true }).click();
    await expect(box.getByText('Attempt 2', { exact: true })).toBeVisible();
    await box.getByRole('button', { name: 'Finish and submit', exact: true }).click();
    await expect(box.getByText('You scored 0 of 2 points.')).toBeVisible();
    await expect(box.locator('[data-quiz-review="score_only"]')).toHaveText('This quiz shows your score only, not the answers.');
    await expect(box.locator('[data-review-question]')).toHaveCount(0);

    // At the limit, Start refuses with its reason in words.
    await box.getByRole('button', { name: 'Start another attempt', exact: true }).click();
    await expect(box.getByText('You have used every attempt this assessment allows.')).toBeVisible();
    await expect(box).not.toHaveAttribute('data-quiz-state', 'open');
    expect(await openAttempt(who, quizSlug)).toBeNull();
    expect(await attemptsOn(who, quizSlug)).toHaveLength(2);
  } finally {
    await setQuiz(quizSlug ?? items[1], null);
  }
});

test(`${J} #8 /academy/progress shows percent complete with check marks, the grade chart and average, a pending banner, and an empty state`, async ({
  page,
}) => {
  const { who, course, items } = state('who', 'course', 'items');
  // A learner with no attempts sees the grades say so in words, never a zero chart.
  const fresh = await signUp(page, 'ja3e');
  await verify(page, fresh);
  await signIn(page, fresh);
  await page.goto('/academy/progress');
  await expect(page.getByText(/^No quiz attempts on your account\./)).toBeVisible();
  await expect(page.locator('[data-grade-chart]')).toHaveCount(0);
  await signOutBrowser(page.context());

  // Staff hide the results of a TEST quiz on the third item until next week; the learner takes it.
  const hiddenUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await setQuiz(items[2], { ...testQuiz('answers'), timeLimitSeconds: null, attemptLimit: null, resultsHiddenUntil: hiddenUntil });
  try {
    const learner = await api(who);
    const started = await learner.post('/api/academy/trpc/assessment.start', { slug: items[2] });
    expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
    const finished = await learner.post('/api/academy/trpc/assessment.finish', { attemptId: started.body.result.data.attemptId });
    expect(finished.body.result.data.result).toMatchObject({ hidden: true, hiddenUntil });

    await signIn(page, who);
    await page.goto('/academy/progress');
    const done = new Set((await completions(who)).map((row) => row.itemSlug));
    const completed = items.filter((slug) => done.has(slug)).length;
    const card = page.locator(`[data-course-progress="${course}"]`);
    // The percent is completed items over the items I can see, to one decimal place, rounded half up.
    const tenths = Math.floor((completed * 2000 + items.length) / (2 * items.length));
    const percent = `${Math.floor(tenths / 10)}.${tenths % 10}`;
    await expect(card).toHaveAttribute('data-percent', percent);
    await expect(card.getByText(`${percent}% complete: ${completed} of ${items.length} items`, { exact: true })).toBeVisible();
    await expect(card.locator(`[data-progress-item="${items[0]}"]`)).toHaveAttribute('data-completed', 'true');
    await expect(card.locator(`[data-progress-item="${items[3]}"]`)).toHaveAttribute('data-completed', 'false');

    const chart = page.locator('[data-grade-chart]');
    await expect(chart.locator(`[data-grade-row="${items[1]}"]`).getByText('2 of 2 points (100.0%)')).toBeVisible();
    await expect(page.locator('[data-grade-average="quiz"]')).toHaveText(/^Quiz average: 100\.0% from one quiz/);
    await expect(page.locator('[data-grades-pending="1"]')).toHaveText(/^One result is hidden until its release date\./);
    const pending = chart.locator(`[data-grade-row="${items[2]}"]`);
    await expect(pending).toHaveAttribute('data-grade-state', 'pending');
    await expect(pending).not.toContainText('points');
  } finally {
    await setQuiz(items[2], null);
  }
});

test(`${J} #9 a to-do shows on another device; saving the goal works and sending its reminder shows the email notice`, async ({
  page,
  browser,
}) => {
  const { who } = state('who');
  const text = `TEST: revisit the order types quiz ${Date.now()}`;
  const first = await browser.newContext({ baseURL: ORIGIN });
  try {
    const desk = await first.newPage();
    await signIn(desk, who);
    await desk.goto('/academy/progress');
    const planner = desk.locator('[data-planner]');
    await planner.getByLabel('New to-do item').fill(text);
    await planner.getByRole('button', { name: 'Add to-do', exact: true }).click();
    const row = planner.locator('[data-todo]').filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await row.getByRole('checkbox').check();
    await expect(row).toHaveAttribute('data-todo-done', 'true');
  } finally {
    await first.close();
  }

  // This page is a second device: the item and its done mark come from Academy.
  await signIn(page, who);
  await page.goto('/academy/progress');
  const planner = page.locator('[data-planner]');
  const row = planner.locator('[data-todo]').filter({ hasText: text });
  await expect(row).toHaveAttribute('data-todo-done', 'true');
  await expect(row.getByRole('checkbox')).toBeChecked();

  await planner.getByLabel('Items to complete each week').fill('3');
  await planner.getByLabel('Email me a reminder for this goal').check();
  await planner.getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(planner.getByText('Goal saved.')).toBeVisible();
  await page.reload();
  await expect(planner.locator('[data-goal="3"]')).toContainText('Goal: 3 items a week.');
  await expect(planner.locator('[data-goal="3"]')).toContainText('Email reminder on.');
  await planner.getByRole('button', { name: 'Send reminder now', exact: true }).click();
  await expect(planner.locator('[data-not-connected="vendor.email"]')).toContainText(
    'The goal reminder email needs an email delivery provider.',
  );
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
