import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN } from './stack.mjs';

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

/** What the signed-out catalogue door returns for this input, read straight from Edge as the page would. */
async function published(input) {
  const res = await fetch(`${EDGE}/api/academy/trpc/publicCurriculum?input=${encodeURIComponent(JSON.stringify(input))}`, {
    headers: { origin: ORIGIN },
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

const tabStrip = (page) => page.getByRole('group', { name: /academy sections/i }).getByRole('button');
const pressed = (page, name) => tabStrip(page).filter({ hasText: name });

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
  await expect(page.locator('article.more-body')).not.toBeEmpty();
  await expect(pressed(page, 'Learning')).toHaveAttribute('aria-pressed', 'true');
  // Lessons carry no published or updated date in this build, so no date is shown.
  await expect(page.locator('article.more-body time')).toHaveCount(0);
  const related = page.getByRole('heading', { name: 'Related', level: 2 });
  await expect(related).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();

  for (const [name, slug] of TABS) {
    await page.goto(`/academy/${slug}`);
    await expect(pressed(page, name)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('article.more-body')).toHaveCount(0);
  }
});

test(`${J} #7 Videos keeps its full layout and says video storage is not configured`, async ({ page }) => {
  await page.goto('/academy/videos');
  await expect(page.getByRole('heading', { name: 'Video library', level: 2 })).toBeVisible();
  await expect(page.getByText('Video storage is not configured, so recordings cannot be listed or played.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Playback', level: 2 })).toBeVisible();
  await expect(page.getByText('This can’t be done right now')).toHaveCount(0);
});
