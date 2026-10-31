import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { EDGE, ORIGIN, restartWith } from './stack.mjs';

// J-academy-01, in the running app (docs/roadmap/journeys.json): look around the Academy and open a lesson before I
// have an account. Tests titled "J-academy-01 #<n>" prove a whole step. Every step runs signed out, in a fresh browser
// context, against what the service publishes; nothing is seeded by hand.
const J = 'J-academy-01';
const TABS = [
  ['Learning', 'learning'],
  ['Certificates', 'certificates'],
  ['Rooms', 'rooms'],
  ['Videos', 'videos'],
  ['Programmes', 'programmes'],
];

/** What a signed-out door answers, read straight from Edge as the page would. */
async function door(procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(`${EDGE}/api/academy/trpc/${procedure}${query}`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}
const published = (input) => door('publicCurriculum', input);

/** Founder A on the console, in a context of its own: staff choose what the hub features. */
async function console_(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  return page;
}

/** The panel under a level-2 heading: the section the heading titles. */
const panelOf = (scope, title) => scope.getByRole('heading', { name: title, level: 2, exact: true }).locator('xpath=ancestor::section[1]');
const tabStrip = (page) => page.getByRole('group', { name: /academy sections/i }).getByRole('button');
const pressed = (page, name) => tabStrip(page).filter({ hasText: name });

test(`${J} #1 /academy is a hub with exactly the five tabs, none hidden; the featured slot shows only what staff chose`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await page.goto('/academy');
  await expect(tabStrip(page)).toHaveText(TABS.map(([name]) => name));
  // None hidden: every control in the strip, hidden ones included, is one of the five, and each of them is visible.
  const every = page.getByRole('group', { name: /academy sections/i }).locator('button, a, [role="tab"]');
  await expect(every).toHaveCount(TABS.length);
  for (let i = 0; i < TABS.length; i += 1) await expect(every.nth(i)).toBeVisible();

  const hub = page.locator('[data-academy-hub="true"]');
  const featuredPanel = panelOf(hub, 'Featured');
  const desk = await console_(browser);
  const outcome = desk.getByTestId('course-desk-outcome');
  const slot = desk.getByTestId('hub-featured');
  await desk.goto('/academy-ops/catalogue/featured');
  await desk.waitForLoadState('networkidle');
  // What staff had chosen before this step, so it is put back afterwards: a curriculum article or a course lesson.
  const before = await door('publicHub');
  const lessonHref = before.lesson ? await slot.getByRole('link').first().getAttribute('href') : null;
  try {
    // Staff choose nothing: the slot says so and holds no article, sample or otherwise.
    if (before.featured || before.lesson) {
      await desk.getByLabel('Why clear it', { exact: true }).fill(`TEST ${J}: an empty slot first`);
      await desk.getByRole('button', { name: 'Clear the featured slot' }).click();
      await expect(outcome).toContainText('Done: nothing is featured');
    }
    await expect(slot).toHaveText('Nothing is featured. Feature a lesson learners can read from that lesson’s page.');
    expect(await door('publicHub')).toMatchObject({ featured: null, lesson: null });
    await page.reload();
    await expect(featuredPanel.getByText('Nothing is featured yet.')).toBeVisible();
    await expect(featuredPanel.locator('article')).toHaveCount(0);
    await expect(featuredPanel.getByRole('link')).toHaveCount(0);

    // Staff choose an article: the slot shows exactly that one, and no other.
    const [first] = await published({ limit: 1 });
    await desk.getByLabel('Article address', { exact: true }).fill(first.slug);
    await desk.getByLabel('Why feature the article', { exact: true }).fill(`TEST ${J}: the first article for visitors`);
    await expect(desk.getByLabel('Article address', { exact: true })).toHaveValue(first.slug);
    await desk.getByRole('button', { name: 'Feature the article' }).click();
    await expect(outcome).toContainText('Done: featured on the Learn hub');
    await expect(slot).toContainText(first.title);
    await page.reload();
    await expect(featuredPanel.locator('article')).toHaveCount(1);
    await expect(featuredPanel.getByRole('link')).toHaveText([first.title]);
    await expect(featuredPanel.getByRole('link')).toHaveAttribute('href', `/academy/${encodeURIComponent(first.slug)}`);
    await expect(featuredPanel.getByText('Nothing is featured yet.')).toHaveCount(0);
  } finally {
    // Put back what staff had chosen: the same article, the same lesson, or nothing.
    await desk.goto('/academy-ops/catalogue/featured');
    await desk.waitForLoadState('networkidle');
    if (before.featured) {
      await desk.getByLabel('Article address', { exact: true }).fill(before.featured.slug);
      await desk.getByLabel('Why feature the article', { exact: true }).fill(`TEST ${J}: put back as it was`);
      await desk.getByRole('button', { name: 'Feature the article' }).click();
      await expect(outcome).toContainText('Done: featured on the Learn hub');
    } else {
      await desk.getByLabel('Why clear it', { exact: true }).fill(`TEST ${J}: put back as it was`);
      await desk.getByRole('button', { name: 'Clear the featured slot' }).click();
      await expect(outcome).toContainText('Done: nothing is featured');
      if (lessonHref) {
        await desk.goto(lessonHref);
        await desk.waitForLoadState('networkidle');
        await desk.getByLabel('Why feature it', { exact: true }).fill(`TEST ${J}: put back as it was`);
        await desk.getByRole('button', { name: 'Feature on the Learn hub' }).click();
        await expect(outcome).toContainText('Done: featured on the Learn hub');
      }
    }
    await desk.context().close();
  }
});

test(`${J} #2 the news block says it needs a news data feed and is switched off, with the allowlist code`, async ({ page }) => {
  await page.goto('/academy');
  const notice = page.locator('[data-academy-hub="true"] [data-not-connected="feed.news"]');
  await expect(notice).toHaveText('The Academy news block needs a news data feed. It is switched off in this build. feed.news');
  await expect(page.locator('[data-academy-hub="true"]').getByRole('heading', { name: 'News' })).toBeVisible();
  // No invented headline: the news block holds the notice and nothing else, no item, link or article.
  const news = panelOf(page.locator('[data-academy-hub="true"]'), 'News');
  await expect(news).toHaveText(/^News\s*The Academy news block needs a news data feed\. It is switched off in this build\. feed\.news$/);
  await expect(news.getByRole('listitem')).toHaveCount(0);
  await expect(news.getByRole('link')).toHaveCount(0);
  await expect(news.locator('article')).toHaveCount(0);
});

test(`${J} #3 each tab is its own address, Back returns to the previous tab, an old ?section= link lands on its tab`, async ({ page }) => {
  await page.goto('/academy');
  await expect(page.locator('[data-academy-visitor="true"]')).toBeVisible();
  await expect(tabStrip(page)).toHaveText(TABS.map(([name]) => name));
  for (const [name, slug] of [...TABS.slice(1), TABS[0]]) {
    await pressed(page, name).click();
    await expect(page).toHaveURL(`/academy/${slug}`);
    await expect(pressed(page, name)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.goBack();
  await expect(page).toHaveURL('/academy/programmes');
  await expect(pressed(page, 'Programmes')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/academy?section=videos');
  await expect(page).toHaveURL('/academy/videos');
  await expect(pressed(page, 'Videos')).toHaveAttribute('aria-pressed', 'true');
});

test(`${J} #4 signed out, Learning shows the published catalogue with no progress; typing part of a title keeps only matching cards, in the chosen sort`, async ({
  page,
}) => {
  const all = await published({ limit: 50 });
  expect(all.length).toBeGreaterThan(1);
  await page.goto('/academy/learning');
  const cards = page.getByRole('list', { name: 'Published courses' }).getByRole('listitem');
  await expect(cards).toHaveCount(all.length);
  await expect(cards.first().getByRole('link')).toHaveText(all[0].title);
  await expect(page.getByRole('progressbar')).toHaveCount(0);

  const part = all[0].title
    .split(/\s+/)
    .find((word) => word.length > 3)
    .toLowerCase();
  const matching = await published({ q: part, sort: 'name_asc', limit: 50 });
  await page.getByLabel('Search courses').fill(part);
  await page.getByLabel('Sort').selectOption({ label: 'Name, A to Z' });
  await expect(cards).toHaveCount(matching.length);
  await expect(cards.getByRole('link')).toHaveText(matching.map((row) => row.title));
  for (const row of matching) expect(`${row.title} ${row.summary}`.toLowerCase()).toContain(part);

  await page.getByLabel('Search courses').fill('zz no such course zz');
  await expect(page.getByText('No course matches “zz no such course zz”.')).toBeVisible();
});

test(`${J} #6 a lesson opens in the reader by its address, with related items; a tab name opens the tab, never a lesson`, async ({
  page,
}) => {
  const [first] = await published({ limit: 1 });
  await page.goto(`/academy/${first.slug}`);
  await expect(page.getByRole('heading', { name: first.title, level: 2 })).toBeVisible();
  await expect(page.locator('article[data-testid="more-body"]')).not.toBeEmpty();
  await expect(pressed(page, 'Learning')).toHaveAttribute('aria-pressed', 'true');
  // Lessons carry no published or updated date in this build, so no date is shown.
  await expect(page.locator('article[data-testid="more-body"] time')).toHaveCount(0);
  // Related items are the ones the service names for this lesson, each a link to its own address; none means no block.
  const named = await door('publicCurriculumRelated', { slug: first.slug, limit: 5 });
  const related = panelOf(page, 'Related');
  if (named.length === 0) await expect(related).toHaveCount(0);
  else {
    await expect(related.getByRole('link')).toHaveText(named.map((row) => row.title));
    for (const [i, row] of named.entries())
      await expect(related.getByRole('link').nth(i)).toHaveAttribute('href', `/academy/${encodeURIComponent(row.slug)}`);
  }
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();

  for (const [name, slug] of TABS) {
    await page.goto(`/academy/${slug}`);
    await expect(pressed(page, name)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('article[data-testid="more-body"]')).toHaveCount(0);
  }
});

/**
 * Academy restarted with its video storage off (blank settings) or back on the stack's TEST video store. The stack
 * serves video by default (J-academy-03 #4 plays one), so this step sets up its own "not configured" first.
 */
const academyVideoStorage = (on) => restartWith('academy', 'LOCAL_STACK_ACADEMY_VIDEO_STORAGE', on);

test(`${J} #7 Videos keeps its full layout and says video storage is not configured`, async ({ page }) => {
  // Two Academy restarts (storage off, then back) can take most of a minute each.
  test.setTimeout(300_000);
  academyVideoStorage(false);
  try {
    await page.goto('/academy/videos');
    await expect(page.getByRole('heading', { name: 'Video library', level: 2 })).toBeVisible();
    await expect(page.getByText('Video storage is not configured, so recordings cannot be listed or played.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Playback', level: 2 })).toBeVisible();
    await expect(page.getByText('This can’t be done right now')).toHaveCount(0);
    // No dead control: no Play button without a video, and every control left either changes tab or signs in.
    const library = panelOf(page, 'Video library');
    const playback = panelOf(page, 'Playback');
    await expect(library.getByRole('button')).toHaveCount(0);
    await expect(playback.getByRole('button')).toHaveCount(0);
    // The panel has drawn (its buttons were counted above); each link it holds opens an Academy tab or signs in.
    for (const href of await library.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href'))))
      expect(href).toMatch(/^\/(academy(\/|$)|login)/);
    const signIn = playback.getByRole('link', { name: 'Sign in' });
    await expect(signIn).toHaveAttribute('href', /^\/login/);
  } finally {
    academyVideoStorage(true);
  }
});

test(`${J} #5 a course card opens the public course page: summary, outcomes, syllabus, instructor and Enrol; an unknown course is not found`, async ({
  page,
}) => {
  const cards = await door('publicCourses');
  expect(cards.length).toBeGreaterThan(0);
  const course = await door('publicCourse', { slug: cards[0].slug });
  await page.goto('/academy/learning');
  const courseCards = page.getByRole('list', { name: 'Courses', exact: true }).getByRole('listitem');
  await expect(courseCards).toHaveCount(cards.length);
  await courseCards.first().getByRole('link').click();
  await expect(page).toHaveURL(`/academy/learning/course/${cards[0].slug}`);
  const pageRoot = page.locator(`[data-academy-course="${cards[0].slug}"]`);
  await expect(pageRoot.getByRole('heading', { name: 'About this course' })).toBeVisible();
  if (course.summary === null) await expect(pageRoot.getByText('No summary is written for this course.')).toBeVisible();
  else await expect(panelOf(pageRoot, 'About this course')).toContainText(course.summary);
  await expect(pageRoot.getByRole('region', { name: 'What you will learn' }).getByRole('listitem')).toHaveCount(course.outcomes.length);
  const syllabus = pageRoot.getByRole('region', { name: 'Syllabus' }).getByRole('listitem');
  await expect(syllabus).toHaveCount(course.syllabus.length);
  await expect(syllabus.first().getByRole('link')).toHaveText(course.syllabus[0].title);
  await expect(pageRoot.getByRole('heading', { name: 'Instructor' })).toBeVisible();
  if (course.instructor === null) await expect(pageRoot.getByText('No instructor is named for this course.')).toBeVisible();
  else await expect(panelOf(pageRoot, 'Instructor')).toContainText(course.instructor);
  await expect(pageRoot.getByRole('link', { name: 'Sign in to enrol' })).toHaveAttribute(
    'href',
    `/login?redirect=${encodeURIComponent(`/academy/learning/course/${cards[0].slug}`)}`,
  );
  // No owner price exists for any course: the page carries none, and the course answer has no price to show.
  expect(Object.keys(course)).not.toContain('price');

  for (const unknown of ['no-such-course', course.syllabus[0].slug]) {
    await page.goto(`/academy/learning/course/${unknown}`);
    await expect(page.getByText('There is no published course at this address.')).toBeVisible();
  }
});
